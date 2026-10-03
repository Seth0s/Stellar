import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore, type CardRow, type ReportRow, type TaskRow } from "../../src/main/store";

/**
 * Task d7fa2d58 — O PONTEIRO DE EVIDÊNCIA POR CARD ID APODRECE EM SILÊNCIO.
 *
 * Medido no banco vivo: 92 card ids reusados (um deles em 54 tasks), 733 de
 * 1000 reports sob um id reusado, e 14 prompts já escritos com
 * `read_report(target=…)`. `card_id` é SLOT; `seq` é do SERVIDOR e não recicla.
 *
 * O que estes testes fecham:
 *  (1) a leitura por SLOT passa a DIZER a que tasks ele pertenceu e marca
 *      `ambiguous` — o ponteiro podre deixa de ser silencioso;
 *  (2) a leitura por `seq` é EXATA e um seq inexistente FALHA alto;
 *  (3) o store responde as duas perguntas (participações do slot; linha do seq).
 */

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>) {
  return new Proxy({}, { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) }) as Parameters<
    typeof createMessageBus
  >[1];
}

describe("get_report: o SLOT diz a que tasks pertence (task d7fa2d58)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const row = (cardId: string, seq: number): ReportRow => ({
    card_id: cardId,
    seq,
    report_json: JSON.stringify({ ok: true, nota: `seq ${seq}` }),
    verdict: null,
    role: "implementer",
    channel: "socket",
    updated_at: 1,
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-pointer-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      // `handleRequest` resolve o `target` (rótulo → id) ANTES do dispatcher:
      // o rig precisa das três listas vazias, como nos testes irmãos.
      callbacksWithOverrides({ listCards: () => [], listTasks: () => [], listTaskCardsForCard: () => [], ...overrides }),
    );
  }

  it("um card_id REUSADO: a resposta diz `cardId`, os `taskIds` e `ambiguous: true`", async () => {
    makeBus({
      getReport: () => row("97924064", 700),
      // O slot 97924064 participou de 54 tasks no banco real; aqui, 2 bastam.
      listTaskIdsForCard: () => ["t-antes", "t-depois"],
    });
    const res = (await bus!.handleRequest({ cmd: "get_report", target: "97924064" } as BusRequest)) as {
      ok: boolean;
      seq: number;
      cardId: string;
      taskIds: string[];
      ambiguous: boolean;
    };
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(700);
    // O ponteiro por card_id continua resolvendo — e agora AVISA.
    expect(res.cardId).toBe("97924064");
    expect(res.taskIds).toEqual(["t-antes", "t-depois"]);
    expect(res.ambiguous).toBe(true);
  });

  it("card_id de participação ÚNICA não é marcado ambíguo (o flag não é ruído)", async () => {
    makeBus({ getReport: () => row("98600001", 1), listTaskIdsForCard: () => ["t-unica"] });
    const res = (await bus!.handleRequest({ cmd: "get_report", target: "98600001" } as BusRequest)) as {
      ambiguous: boolean;
      taskIds: string[];
    };
    expect(res.ambiguous).toBe(false);
    expect(res.taskIds).toEqual(["t-unica"]);
  });

  it("leitura por `seq` é EXATA e não passa por slot nenhum; o inexistente FALHA alto", async () => {
    const asked: number[] = [];
    makeBus({
      getReportBySeq: (seq: number) => {
        asked.push(seq);
        return seq === 700 ? row("97924064", 700) : undefined;
      },
      listTaskIdsForCard: () => ["t-antes", "t-depois"],
      // Se o handler caísse na leitura por slot, este seria usado — e o teste falharia.
      getReport: () => {
        throw new Error("a leitura por `seq` NÃO pode tocar a de slot");
      },
    });

    const found = (await bus!.handleRequest({ cmd: "get_report", seq: 700 } as BusRequest)) as { ok: boolean; cardId: string; seq: number };
    expect(found.ok).toBe(true);
    expect(found.seq).toBe(700);
    expect(found.cardId).toBe("97924064");
    expect(asked).toEqual([700]);

    // Ponteiro que não resolve mais FALHA — nunca devolve "outra coisa".
    const missing = (await bus!.handleRequest({ cmd: "get_report", seq: 999999 } as BusRequest)) as { ok: boolean; error: string };
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("999999");
  });

  it("sem target e sem seq, a recusa NOMEIA as duas formas (não só 'missing target')", async () => {
    makeBus({});
    const res = (await bus!.handleRequest({ cmd: "get_report" } as BusRequest)) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("seq");
  });
});

describe("store: as duas perguntas do ponteiro (SQL real, fixture local)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function card(id: string): CardRow {
    return {
      id, board_id: "64", kind: "terminal", provider: "claude", cwd: "/tmp", x: 0, y: 0, w: 1, h: 1,
      resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null,
      updated_at: 1, messages_json: null, archived_at: null, created_at: 1,
    };
  }
  function task(id: string): TaskRow {
    return {
      id, prompt: "p", provider: null, status: "pending", card_id: null, board_id: "64", cwd: null,
      spawn_profile: null, result_json: null, deps_json: null, purpose: null, review: null,
      territory_json: null, gates_json: null, allow_commit: null, report_schema_json: null,
      retry_count: 0, attempted_providers_json: null, max_retries: null, fallback_providers_json: null,
      order: null, suggested_order: null, implicit_order: null, diverged_status: null, diverged_actor: null,
      requested_status: null, requested_reason: null, requested_by: null, requested_at: null, sprint_id: null,
      created_at: 1, updated_at: 1,
    } as TaskRow;
  }

  it("lista TODAS as participações de um slot reusado, e o seq lê exatamente a linha dele", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-pointer-store-"));
    store = openStore(dir);
    store.upsertCard(card("97924064"));
    store.upsertTask(task("t-antes"));
    store.upsertTask(task("t-depois"));
    // O MESMO slot participou das duas tasks — a reciclagem, em miniatura.
    store.linkTaskCard("t-antes", "97924064", "implementer");
    store.linkTaskCard("t-depois", "97924064", "implementer");
    store.upsertReport({ card_id: "97924064", seq: 700, report_json: JSON.stringify({ ok: true }), verdict: null, role: "implementer", channel: "socket", updated_at: 1 });
    store.upsertReport({ card_id: "98600002", seq: 701, report_json: JSON.stringify({ ok: true }), verdict: null, role: "implementer", channel: "socket", updated_at: 2 });

    expect(store.listTaskIdsForCard("97924064")).toEqual(["t-antes", "t-depois"]);
    expect(store.listTaskIdsForCard("98600002")).toEqual([]);

    // Por `seq`: a linha exata, crua. Não é a "mais recente do slot".
    expect(store.getReportBySeq(700)?.card_id).toBe("97924064");
    expect(store.getReportBySeq(701)?.card_id).toBe("98600002");
    expect(store.getReportBySeq(999999)).toBeUndefined();
  });
});
