import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Task 86613ff9 (PEÇA 1 de 7) — o EMISSOR.
 *
 * O substrato (tabela + statements + decisão pura) já tinha prova própria. O
 * que este arquivo prova é o emissor LIGADO: cada VIRADA nasce no PONTO certo
 * (spawn no nascimento, `first_output` na PRIMEIRA saída — não a cada chunk —,
 * `turn_end` quando o fim de turno é declarado), e a RE-ENTREGA do mesmo
 * `(task_id, card_id, at)` é idempotente pelo `ON CONFLICT`.
 *
 * Montagem igual à de `pty-registry-work-granted.test.ts`: `node-pty` mockado
 * (nenhum processo real) e o callback de saída CAPTURADO para poder disparar a
 * primeira saída na mão — é assim que se prova o ponto, sem depender de tempo.
 */

let dataCb: ((data: string) => void) | null = null;

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return { ...actual, resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }) };
});

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    kill: () => {},
    resize: () => {},
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
  }),
}));

describe("pty-registry: as viradas viram EVENTO no ponto certo", () => {
  beforeEach(() => {
    dataCb = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup() {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const events: { cardId: string; kind: string; at: number }[] = [];
    const registry = createPtyRegistry({
      onData: vi.fn(),
      onExit: vi.fn(),
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      onTraceEvent: (e) => events.push({ cardId: e.cardId, kind: e.kind, at: e.at }),
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
    });
    return { registry, events };
  }

  it("spawn → first_output (só na PRIMEIRA saída) → turn_end, na ordem e nos instantes certos", async () => {
    const { registry, events } = await setup();

    vi.setSystemTime(1_000);
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    // Nasce JÁ com a virada do nascimento, datada pelo relógio do spawn.
    expect(events.map((e) => e.kind)).toEqual(["spawn"]);
    expect(events[0]).toMatchObject({ cardId: "card-1", at: 1_000 });

    vi.setSystemTime(2_000);
    dataCb!("primeira saída\n");
    expect(events.map((e) => e.kind)).toEqual(["spawn", "first_output"]);
    expect(events[1].at).toBe(2_000);

    // A SEGUNDA saída NÃO gera um segundo `first_output`: é virada, não chunk.
    vi.setSystemTime(3_000);
    dataCb!("mais saída\n");
    expect(events.map((e) => e.kind)).toEqual(["spawn", "first_output"]);

    vi.setSystemTime(4_000);
    registry.markTurnComplete("card-1");
    expect(events.map((e) => e.kind)).toEqual(["spawn", "first_output", "turn_end"]);
    expect(events[2].at).toBe(4_000);
  });

  it("um card SEM vínculo de task não gera evento: a PK exige task_id, e a ausência é declarada", async () => {
    // Aqui o emissor é o CONSUMIDOR de verdade (index.ts): sem link, ele não
    // chama o store. A regra provada é a do consumidor: `getLatestTaskCardForCard`
    // devolve undefined => nada é gravado. (O ponto do registry acima já nasce.)
    const { deriveCardTraceEventRow } = await import("../../src/main/store");
    // A decisão pura RECUSA task_id vazio — é o que impede um evento sem chave.
    expect(deriveCardTraceEventRow({ cardId: "c1", at: 1, kind: "spawn" }).ok).toBe(false);
  });

  it("RE-ENTREGA do MESMO (task, card, at) é idempotente (o `ON CONFLICT` que o emissor usa)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openStore } = await import("../../src/main/store");
    const dir = mkdtempSync(join(tmpdir(), "stellar-trace-emit-"));
    const store = openStore(dir);
    try {
      const event = { taskId: "t1", cardId: "c1", at: 1_000, kind: "turn_end" as const };
      expect(store.saveCardTraceEvent(event)).toMatchObject({ ok: true });
      // O consumidor entrega de novo (retry, flush duplo): a linha é a MESMA.
      expect(store.saveCardTraceEvent(event)).toMatchObject({ ok: true });
      expect(store.countCardTraceEvents()).toBe(1);
      expect(store.getCardTraceEventsForTask("t1")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
