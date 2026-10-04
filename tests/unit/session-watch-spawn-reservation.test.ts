import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnWatchReservation, watchForSession } from "../../src/main/session-watch";

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

const slug = CWD.replace(/\//g, "-").replace(/^-/, "").toLowerCase();
const ccDir = `${HOME}/.commandcode/projects/${slug}`;

function sessionFile(id: string, mtimeMs: number): void {
  write(join(ccDir, `${id}.meta.json`), JSON.stringify({ traceIds: [], title: id }), mtimeMs);
  write(join(ccDir, `${id}.jsonl`), "x".repeat(200), mtimeMs);
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

/** Espera o `onFound` deste watcher, com teto. `null` = não achou. */
function watchOnce(ownerId: string, spawnAtMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = watchForSession(
      "commandcode",
      CWD,
      spawnAtMs,
      (id) => {
        stop();
        resolve(id);
      },
      undefined,
      { ...(spawnWatchReservation("commandcode", ownerId, spawnAtMs) ?? {}) },
    );
    setTimeout(() => {
      stop();
      resolve(null);
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
    expect(a).toBe("cc-a");
    expect(b).toBe("cc-b");
    expect(c).toBe("cc-c");
  }, 20_000);

  it("quando o instante NÃO separa (os três arquivos depois de todos os spawns): recusa e `onStuck`", async () => {
    rmSync(ccDir, { recursive: true, force: true });
    // Todos os arquivos DEPOIS do último spawn → a reserva mais recente domina
    // todos os candidatos: nunca um chute de id.
    const late = SPAWN_C + 500;
    sessionFile("cc-x", late);
    sessionFile("cc-y", late);
    sessionFile("cc-z", late);

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
