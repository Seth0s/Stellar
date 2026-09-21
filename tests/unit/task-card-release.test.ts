import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { decideTaskCardRelease } from "../../src/main/judgment-write-decision";

/**
 * TROCA DE CARD EM TASK ABERTA (task e8802e32) — o terceiro mundo que o guard
 * da ecd36437 não conhecia: "a task continua e é OUTRO card que a fará".
 * A liberação é explícita (coluna em `task_cards`, motivo obrigatório), sai do
 * conjunto VIVO sem apagar a história, e move o ponteiro principal junto.
 */
function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: `prompt of ${id}`,
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "board-a",
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
    created_at: now,
    updated_at: now,
    ...over,
  } as TaskRow;
}

describe("troca de card (e8802e32) — store", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "release-"));
    const store = openStore(dir);
    store.upsertTask(baseTask("t1", { card_id: "old", status: "running", review: "wanted" }));
    store.linkTaskCard("t1", "old", "implementer");
    return store;
  }

  it("O CENÁRIO DO BRIEF: implementer vivo que nunca reportou troca de card, e a task volta a `pending` visível", () => {
    const store = setup();
    const res = store.releaseTaskCardFromTask({
      taskId: "t1",
      cardId: "old",
      reason: "provider commandcode inviável — trocando para claude",
      releasedBy: "orch",
      actor: "agent",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.liveImplementersLeft).toBe(0);
    expect(res.taskStatus).toBe("pending");
    // 5) nunca limbo: status e ponteiro principal acompanham, na MESMA transação.
    expect(store.getTask("t1")?.card_id).toBeNull();
    expect(store.getTask("t1")?.status).toBe("pending");
  });

  it("4) COM SUCESSOR o ponteiro PRINCIPAL vai para o novo card (é o que a porta MCP lê)", () => {
    const store = setup();
    const res = store.releaseTaskCardFromTask({
      taskId: "t1",
      cardId: "old",
      reason: "morte por cota",
      releasedBy: "orch",
      actor: "agent",
      nextImplementerCardId: "new",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.nextPrincipalCardId).toBe("new");
    expect(res.liveImplementersLeft).toBe(1);
    // `taskStatus: null` = NÃO houve escrita de status: sobrou implementer.
    // (O status EFETIVO é derivado da vivacidade do card pelo store —
    // `deriveTaskStatus` —, e aqui os ids são fictícios, nunca "vivos"; o
    // que importa é não ter sido forçado a `pending`.)
    expect(res.taskStatus).toBeNull();
    expect(store.getTask("t1")?.card_id).toBe("new");
    expect(store.listTaskCardsForCard("new").map((l) => l.card_id)).toContain("new");
  });

  it("3) a linha liberada sai do VIVO e CONTINUA no histórico (getTaskCards)", () => {
    const store = setup();
    store.releaseTaskCardFromTask({ taskId: "t1", cardId: "old", reason: "troca de provider", releasedBy: "orch" });
    expect(store.listTaskCardsForCard("old")).toEqual([]);
    const hist = store.getTaskCards("t1");
    expect(hist.map((l) => l.card_id)).toContain("old");
    expect(hist.find((l) => l.card_id === "old")?.released_reason).toBe("troca de provider");
  });

  it("7) MOTIVO é obrigatório: sem motivo nada é escrito", () => {
    const store = setup();
    const res = store.releaseTaskCardFromTask({ taskId: "t1", cardId: "old", reason: "   ", releasedBy: "orch" });
    expect(res.ok).toBe(false);
    expect(store.listTaskCardsForCard("old")).toHaveLength(1); // continua viva
    expect(store.getTask("t1")?.card_id).toBe("old");
  });

  it("liberar duas vezes RECUSA (idempotência silenciosa esconderia erro de quem chama)", () => {
    const store = setup();
    store.releaseTaskCardFromTask({ taskId: "t1", cardId: "old", reason: "primeira", releasedBy: "orch" });
    const again = store.releaseTaskCardFromTask({ taskId: "t1", cardId: "old", reason: "segunda", releasedBy: "orch" });
    expect(again.ok).toBe(false);
  });

  it("re-linkar um card LIBERADO o devolve à participação viva", () => {
    const store = setup();
    store.releaseTaskCardFromTask({ taskId: "t1", cardId: "old", reason: "pausa", releasedBy: "orch" });
    store.linkTaskCard("t1", "old", "implementer");
    const live = store.listTaskCardsForCard("old");
    expect(live.map((l) => l.card_id)).toContain("old");
    expect(live.find((l) => l.card_id === "old")?.released_at ?? null).toBeNull();
  });
});

describe("troca de card (e8802e32) — quem pode liberar (porta dos fundos da ecd36437)", () => {
  it("6) IMPLEMENTER NÃO se auto-libera — recusa nomeando o papel", () => {
    const decision = decideTaskCardRelease({ taskId: "t1", requesterRoleOnTask: "implementer" });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.error).toContain("implementer");
    expect(decision.error).toContain("Nada foi gravado");
  });

  it("reviewer e outsider (humano/sem vínculo) liberam", () => {
    expect(decideTaskCardRelease({ taskId: "t1", requesterRoleOnTask: "reviewer" }).action).toBe("allow");
    expect(decideTaskCardRelease({ taskId: "t1", requesterRoleOnTask: null }).action).toBe("allow");
  });
});
