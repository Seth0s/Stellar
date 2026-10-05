import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnWatchReservation, watchForSession, kebabSlug } from "../../src/main/session-watch";

/**
 * Task ea71065e (2026-10-04). DEFEITO: 5 cards `commandcode` no MESMO cwd
 * (`/Projects/StellarPage`) ficaram com `session_id` null. O watcher de spawn
 * rodava SEM reserva de posse; com vários `<id>.meta.json` na mesma pasta o
 * claim vira `ambiguous` para sempre — e o brief do dispatch vai por argv, então
 * nenhum `write()` gerava a reserva de rearm que desambiguaria.
 *
 * A CORREÇÃO: ancorar a posse no instante do SPAWN (derivada da declaração:
 * store presente E NÃO em `REARM_ON_INPUT_PROVIDERS`), e NÃO-SILÊNCIO
 * (`onStuck`) quando o desempate por instante não separa — `ambiguous` segue
 * recusa, nunca chute.
 */

const HOME = "/tmp/stellar-spawn-reservation-home";
const CWD = "/tmp/Fixture/SpawnRes";
/** Instantes da MESMA SEGUNDO, em ordem — o cenário do auto-dispatch. */
const BASE = 1_700_000_000_000;
const SPAWN_A = BASE;
const SPAWN_B = BASE + 120;
const SPAWN_C = BASE + 240;

function write(path: string, content: string, mtimeMs: number): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

const ccDir = `${HOME}/.commandcode/projects/${kebabSlug(CWD)}`;

function sessionFile(id: string, mtimeMs: number, prompt?: string): void {
  write(join(ccDir, `${id}.meta.json`), JSON.stringify({ traceIds: [], title: id }), mtimeMs);
  write(join(ccDir, `${id}.jsonl`), "x".repeat(200), mtimeMs);
  if (prompt !== undefined) {
    write(join(ccDir, `${id}.checkpoints.jsonl`), JSON.stringify({ prompt, turnNumber: 1 }), mtimeMs);
  }
}

const REAL_HOME = process.env.HOME;

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  process.env.HOME = HOME;
  const { loadDynamicProviders } = await import("../../src/main/providers-dynamic");
  loadDynamicProviders("/tmp/stellar-spawn-reservation-no-userdata");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});

/** Awaits this watcher's `onFound`, with a ceiling. Records whether the claim
 * came back low-confidence (order pairing). */
function watchOnce(
  ownerId: string,
  spawnAtMs: number,
  brief?: string,
): Promise<{ id: string | null; low: boolean }> {
  return new Promise((resolve) => {
    let low = false;
    const stop = watchForSession(
      "commandcode",
      CWD,
      spawnAtMs,
      (id) => {
        stop();
        resolve({ id, low });
      },
      undefined,
      {
        ...(spawnWatchReservation("commandcode", ownerId, spawnAtMs, brief) ?? {}),
        onLowConfidence: () => {
          low = true;
        },
      },
    );
    setTimeout(() => {
      stop();
      resolve({ id: null, low });
    }, 6_000);
  });
}

describe("spawnWatchReservation — a posse no spawn, derivada da declaração", () => {
  it("commandcode (store, registro pós-prompt entregue por argv): ganha reserva ancorada no spawn", () => {
    expect(spawnWatchReservation("commandcode", "cardA", SPAWN_A)).toEqual({
      ownerId: "cardA",
      rearmAtMs: SPAWN_A,
      matchStartMs: SPAWN_A,
    });
  });

  it("antigravity/opencode seguem SEM reserva de spawn (nascem só depois de input real)", () => {
    expect(spawnWatchReservation("antigravity", "cardA", SPAWN_A)).toBeUndefined();
    expect(spawnWatchReservation("opencode", "cardA", SPAWN_A)).toBeUndefined();
  });

  it("provider sem store declarado (bash) — nada a observar, sem reserva", () => {
    expect(spawnWatchReservation("bash", "cardA", SPAWN_A)).toBeUndefined();
  });
});

describe("o caso real do auto-dispatch: três cards no MESMO cwd, na MESMA segundo", () => {
  it("cada card reivindica a SUA sessão — o desempate pelo instante separa", async () => {
    rmSync(ccDir, { recursive: true, force: true });
    // Cada arquivo nasce depois do spawn do SEU card e antes do próximo spawn.
    sessionFile("cc-a", SPAWN_A + 30);
    sessionFile("cc-b", SPAWN_B + 30);
    sessionFile("cc-c", SPAWN_C + 30);

    const [a, b, c] = await Promise.all([
      watchOnce("card-a", SPAWN_A),
      watchOnce("card-b", SPAWN_B),
      watchOnce("card-c", SPAWN_C),
    ]);
    expect(a.id).toBe("cc-a");
    expect(b.id).toBe("cc-b");
    expect(c.id).toBe("cc-c");
    expect([a.low, b.low, c.low]).toEqual([false, false, false]);
  }, 20_000);

  it("instante NÃO separa + briefs DIFERENTES, arquivos FORA de ordem: posse exata por CONTEÚDO", async () => {
    rmSync(ccDir, { recursive: true, force: true });
    // All files AFTER the last spawn AND created out of spawn order: the
    // instant cannot separate them, so the first prompt (the brief the app
    // handed to each card) is what proves ownership.
    const late = SPAWN_C + 500;
    sessionFile("cc-pb", late, "Brief for task B");
    sessionFile("cc-pa", late, "Brief for task A");
    sessionFile("cc-pc", late, "Brief for task C");

    const [a, b, c] = await Promise.all([
      watchOnce("card-a", SPAWN_A, "Brief for task A"),
      watchOnce("card-b", SPAWN_B, "Brief for task B"),
      watchOnce("card-c", SPAWN_C, "Brief for task C"),
    ]);
    expect(a.id).toBe("cc-pa");
    expect(b.id).toBe("cc-pb");
    expect(c.id).toBe("cc-pc");
    expect([a.low, b.low, c.low]).toEqual([false, false, false]);
  }, 20_000);

  it("briefs IDÊNTICOS (card mudo): pareamento por ORDEM, com confiança BAIXA", async () => {
    rmSync(ccDir, { recursive: true, force: true });
    const late = SPAWN_C + 500;
    sessionFile("cc-1", late, "Same brief");
    sessionFile("cc-2", late, "Same brief");

    const [a, b] = await Promise.all([
      watchOnce("card-1", SPAWN_A, "Same brief"),
      watchOnce("card-2", SPAWN_B, "Same brief"),
    ]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    // The first claimer pairs by order (low confidence); the second then sees a
    // single remaining file and claims it by uniqueness. The warning fires.
    expect(a.low || b.low).toBe(true);
  }, 20_000);

  it("candidatos além das reservas (contagem não casa): recusa e `onStuck` — nunca um chute", async () => {
    rmSync(ccDir, { recursive: true, force: true });
    // ONE watcher, THREE fresh files: no bijection (1 owner ≠ 3 files), so the
    // refusal is kept and the no-silence notice fires. Ids are unique across
    // this file: the module-level claimed set is never cleared.
    sessionFile("cc-stuck-1", SPAWN_A + 500);
    sessionFile("cc-stuck-2", SPAWN_A + 500);
    sessionFile("cc-stuck-3", SPAWN_A + 500);

    const stuck: string[] = [];
    const found = await new Promise<string | null>((resolve) => {
      const stop = watchForSession(
        "commandcode",
        CWD,
        SPAWN_A,
        (id) => {
          stop();
          resolve(id);
        },
        undefined,
        { ...(spawnWatchReservation("commandcode", "card-a", SPAWN_A) ?? {}), onStuck: (reason) => stuck.push(reason) },
      );
      setTimeout(() => {
        stop();
        resolve(null);
      }, 6_000);
    });
    expect(found).toBeNull();
    expect(stuck.length).toBeGreaterThan(0);
    expect(["ambiguous", "not-ours"]).toContain(stuck[0]);
  }, 20_000);
});
