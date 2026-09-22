import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CardRow, type CardTraceRow } from "../../src/main/store";

/**
 * O RASTRO SOBREVIVE AO FECHO — E MORRE NA EXCLUSÃO DE VERDADE (task 4e4ec327).
 *
 * Duas metades, e as duas são limite do desenho, não conveniência:
 *   1. ARQUIVAR preserva o rastro (é isso que faz "fechar" parar de apagar o que
 *      o card fez — a linha de `cards` carrega label/kind/provider e o rastro
 *      carrega o que ele mostrou);
 *   2. APAGAR DE VERDADE (a porta explícita, `deleteCard`) leva o rastro JUNTO.
 *      Arquivamento sem exclusão real seria acumulação forçada de dados sobre o
 *      trabalho do dono — e o rastro tem texto dele dentro.
 */
describe("card_traces — o rastro do fecho", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function rig() {
    dir = mkdtempSync(join(tmpdir(), "fatia-trace-"));
    const store = openStore(dir);
    const now = Date.now();
    const card: CardRow = {
      id: "c1",
      board_id: "b1",
      kind: "terminal",
      provider: "cline",
      cwd: "/repo",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      resume_id: null,
      model: null,
      effort: null,
      system_prompt: null,
      group_id: null,
      label: "Fatia",
      updated_at: now,
      messages_json: null,
      archived_at: null,
      created_at: now,
    };
    store.upsertCard(card);
    const trace: CardTraceRow = {
      card_id: "c1",
      board_id: "b1",
      closed_at: now,
      screen_stored: 0,
      tail: "",
      tail_bytes: 0,
      tail_at_cap: 1,
      redacted: 0,
      spawned_at_ms: now - 60_000,
      last_activity_at: now - 1_000,
      turn_ended_at: now - 2_000,
      quota_death: 0,
      kill_requested: 1,
    };
    return { store, trace };
  }

  /**
   * A ASSERÇÃO QUE O DONO PEDIU, e ela é o TESTE DA PROMESSA do arquivamento: o
   * dano medido não era "os registros sumiram" (eles sobrevivem), era eles
   * ficarem ANÔNIMOS — o nome do card só existe na linha de `cards`, e `spawns`
   * não tem coluna label. Se arquivar preserva a linha, o vínculo volta a ser
   * NOMEADO. E o CONTRASTE é o que prova que a asserção morde: apagando de
   * verdade, o mesmo vínculo volta a ser órfão.
   */
  it("card ARQUIVADO volta a NOMEAR o vínculo; card APAGADO volta a ser órfão anônimo", () => {
    const { store } = rig();
    const now = Date.now();
    store.upsertTask({
      id: "t1",
      prompt: "trabalho",
      provider: "cline",
      status: "running",
      card_id: "c1",
      board_id: "b1",
      cwd: null,
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      purpose: null,
      territory_json: null,
      gates_json: null,
      allow_commit: null,
      report_schema_json: null,
      review: null,
      sprint_id: null,
      created_at: now,
      updated_at: now,
    });
    store.linkTaskCard("t1", "c1", "implementer");
    // O CARD ARQUIVADO — o estado em que o fecho o deixa.
    store.archiveCard("c1", Date.now());

    const archived = store.listTaskCardsForBoard("b1")[0];
    expect(archived.card_orphaned).toBe(0);
    expect(archived.card_label).toBe("Fatia");

    // e agora o MESMO vínculo, com a linha apagada de verdade:
    store.deleteCard("c1");
    const orphaned = store.listTaskCardsForBoard("b1")[0];
    expect(orphaned.card_orphaned).toBe(1);
    expect(orphaned.card_label).toBeNull();
  });

  it("o rastro guarda os FATOS do fecho — e por default NENHUM texto de tela", () => {
    const { store, trace } = rig();
    store.saveCardTrace(trace);
    const got = store.getCardTrace("c1");
    expect(got?.screen_stored).toBe(0);
    expect(got?.tail).toBe("");
    expect(got?.tail_at_cap).toBe(1);
    expect(got?.kill_requested).toBe(1);
    expect(got?.quota_death).toBe(0);
    expect(got?.last_activity_at).toBe(trace.last_activity_at);
  });

  it("ARQUIVAR o card preserva o rastro (a linha sai do board, o rastro fica)", () => {
    const { store, trace } = rig();
    store.saveCardTrace(trace);
    store.archiveCard("c1", Date.now());
    expect(store.getCardTrace("c1")?.card_id).toBe("c1");
    // e o card sai do board, como sempre saiu
    expect(store.listCards("b1").some((c) => c.id === "c1")).toBe(false);
  });

  it("APAGAR DE VERDADE leva o rastro junto — não sobra texto do dono depois de excluir", () => {
    const { store, trace } = rig();
    store.saveCardTrace(trace);
    store.deleteCard("c1");
    expect(store.getCardTrace("c1")).toBeUndefined();
    expect(store.getCard("c1")).toBeUndefined();
  });

  it("um card por rastro: regravar o mesmo card ATUALIZA, não duplica", () => {
    const { store, trace } = rig();
    store.saveCardTrace(trace);
    // a TELA ligada explicitamente — é o caso em que há texto para regravar
    store.saveCardTrace({ ...trace, screen_stored: 1, tail: "outra cauda", tail_bytes: 11 });
    expect(store.listCardTraces("b1")).toHaveLength(1);
    expect(store.getCardTrace("c1")?.tail).toBe("outra cauda");
    expect(store.getCardTrace("c1")?.screen_stored).toBe(1);
  });
});
