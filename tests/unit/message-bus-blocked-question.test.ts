import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageBus,
  blockedQuestionFromResultJson,
  describeBlockedAnswer,
  describeBlockedNotice,
  describeBlockedWithoutQuestion,
  normalizeBlockedQuestion,
  carryBlockedQuestion,
  type BusRequest,
} from "../../src/main/message-bus";
import { blockedQuestionOf, describeBlockedAge } from "../../src/renderer/src/task-board-model";
import type { TaskRow } from "../../src/main/store";

/**
 * Task 22f0a649 — status `blocked` com PERGUNTA ESTRUTURADA.
 *
 * A prova pedida: cria a pergunta → lê por MCP → responde → o ciclo fecha.
 * Aqui o "por MCP" é o MESMO `handleRequest` que o tool do MCP chama
 * (`update_task` com `question`, `get_task`, `answer_blocked`); a Fila usa o
 * mesmo corpo com `actor:"human"`.
 */

const question = {
  text: "Qual das duas rotas de override devo seguir?",
  options: [
    { id: "cascade", label: "Cascata", description: "herda do board" },
    { id: "per-card", label: "Por card" },
  ],
};

describe("blocked: a pergunta estruturada (puros)", () => {
  it("normalize exige texto e ≥ 2 opções com id/label", () => {
    expect(normalizeBlockedQuestion(question, 1, "card-9")).toEqual({ ...question, askedAt: 1, by: "card-9" });
    expect(normalizeBlockedQuestion({ text: "", options: question.options }, 1, null)).toBeNull();
    expect(normalizeBlockedQuestion({ text: "x", options: [{ id: "a", label: "A" }] }, 1, null)).toBeNull(); // 1 opção não é escolha
    expect(normalizeBlockedQuestion({ text: "x", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }, 1, null)).toBeNull(); // id duplicado
    expect(normalizeBlockedQuestion(null, 1, null)).toBeNull();
    expect(normalizeBlockedQuestion("texto solto", 1, null)).toBeNull();
  });

  it("round-trip no result_json: grava, lê e carrega adiante", () => {
    const q = normalizeBlockedQuestion(question, 42, "c1")!;
    const json = JSON.stringify({ keep: 1, blockedQuestion: q });
    expect(blockedQuestionFromResultJson(json)).toEqual(q);
    // Um `result` posterior SEM a pergunta não a apaga (mesmo remédio do gateRun).
    const carried = carryBlockedQuestion(json, JSON.stringify({ ok: true }));
    expect(blockedQuestionFromResultJson(carried)).toEqual(q);
    expect(blockedQuestionFromResultJson(null)).toBeNull();
  });

  it("a resposta e o aviso são linhas curtas com ferramenta para ver os detalhes", () => {
    const q = normalizeBlockedQuestion(question, 1, null)!;
    expect(describeBlockedAnswer("t1")).toContain("get_task");
    expect(describeBlockedAnswer("t1")).not.toMatch(/[\r\n]/);
    expect(describeBlockedWithoutQuestion()).toContain("question");
    expect(describeBlockedNotice("t1", q, 0)).toContain("BLOCKED");
    expect(describeBlockedNotice("t1", q, 0)).toContain("answer_blocked_task");
  });

  it("a Fila lê a pergunta de forma defensiva e mostra a idade", () => {
    expect(blockedQuestionOf({ blockedQuestion: normalizeBlockedQuestion(question, 10, null) })).not.toBeNull();
    expect(blockedQuestionOf({ blockedQuestion: { text: "x", options: [] } })).toBeNull();
    expect(blockedQuestionOf({})).toBeNull();
    expect(blockedQuestionOf(null)).toBeNull();
    expect(describeBlockedAge(1_000, 1_000 + 90_000)).toBe("1m");
    expect(describeBlockedAge(1_000, 1_000 + 3 * 3_600_000)).toBe("3h");
    expect(describeBlockedAge(0, Date.now())).toBeNull();
  });
});

function modernTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    prompt: "faz X",
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "64",
    cwd: null,
    spawn_profile: null,
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
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/** Store FAKE stateful: `getTask` devolve sempre a última linha, `upsertTask`
 * aplica e guarda, e o envio ao card é capturado. */
function stateFor(initial: TaskRow) {
  let task = initial;
  const writesToCard: { cardId: string; data: string }[] = [];
  const callbacks = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "getTask") return (id: string) => (id === task.id ? task : undefined);
        if (prop === "upsertTask")
          return (next: TaskRow) => {
            task = next;
            return {
              status: next.status,
              statusChanged: true,
              divergedStatus: null,
              divergedActor: null,
              recordDeclaration: false,
              warnAgent: false,
              declaredStatus: null,
            };
          };
        if (prop === "getTaskCards") return () => [];
        // O aviso de `blocked` roteia por linhagem/conector: array vazio =
        // sem spawner (a notificação vira no-op, que é o caso do teste).
        if (prop === "listAllConnectors") return () => [];
        if (prop === "findSpawnByChild") return () => null;
        if (prop === "isCardAlive") return () => true;
        if (prop === "writeToCardWithOrigin" || prop === "writeToCard")
          return (cardId: string, data: string) => {
            writesToCard.push({ cardId, data });
          };
        if (prop === "getAnyCard") return () => null;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
  return { get task() { return task; }, writesToCard, callbacks };
}

describe("blocked: o ciclo fecha (update_task → get_task → answer_blocked)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("RECUSA `blocked` sem pergunta (regra dura) e ACEITA com pergunta", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-blocked-"));
    const st = stateFor(modernTask());
    bus = createMessageBus(join(dir, "a.sock"), st.callbacks);

    const refused = await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "blocked" } as BusRequest);
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain("question");

    const ok = await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "blocked", question } as BusRequest);
    expect(ok.ok).toBe(true);
    expect(blockedQuestionFromResultJson(st.task.result_json)?.text).toBe(question.text);
  });

  it("get_task expõe a pergunta; answer_blocked fecha o ciclo e devolve o status", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-blocked-"));
    // card VIVO: a resposta tem de ser entregue ao card.
    const st = stateFor(modernTask({ card_id: "card-7" }));
    bus = createMessageBus(join(dir, "a.sock"), st.callbacks);

    await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "blocked", question } as BusRequest);
    const got = (await bus.handleRequest({ cmd: "get_task", taskId: "t1" } as BusRequest)) as unknown as {
      task?: { blockedQuestion?: unknown };
      blockedQuestion?: unknown;
    };
    const shown = got.task?.blockedQuestion ?? got.blockedQuestion;
    expect(shown).toMatchObject({ text: question.text });

    // opção inválida é RECUSADA nomeando as opções reais.
    const bad = await bus.handleRequest({ cmd: "answer_blocked", taskId: "t1", optionId: "nope" } as BusRequest);
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("cascade");

    const answered = await bus.handleRequest({ cmd: "answer_blocked", taskId: "t1", optionId: "per-card", note: "isso" } as BusRequest);
    expect(answered).toMatchObject({ ok: true, delivered: true, status: "pending" });
    // The selected answer stays in task data; the card receives only a pointer.
    expect(String(answered.answer)).toContain("get_task");
    expect(String(answered.answer)).not.toContain("isso");
    // a pergunta saiu; o status voltou; a resposta ficou registrada na task.
    expect(blockedQuestionFromResultJson(st.task.result_json)).toBeNull();
    expect(st.task.status).toBe("pending");
    expect(String(st.task.result_json)).toContain("per-card");
    expect(String(st.task.result_json)).toContain("isso");
  });

  it("card morto: a resposta NÃO se perde (registrada) e delivered=false", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-blocked-"));
    const st = stateFor(modernTask({ card_id: null }));
    bus = createMessageBus(join(dir, "a.sock"), st.callbacks);
    await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "blocked", question } as BusRequest);
    const res = await bus.handleRequest({ cmd: "answer_blocked", taskId: "t1", optionId: "cascade" } as BusRequest);
    expect(res).toMatchObject({ ok: true, delivered: false });
    expect(String(st.task.result_json)).toContain("blockedAnswer");
  });

  it("responder NÃO é julgamento: um status fora de blocked encerra a pergunta", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-blocked-"));
    const st = stateFor(modernTask());
    bus = createMessageBus(join(dir, "a.sock"), st.callbacks);
    await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "blocked", question } as BusRequest);
    await bus.handleRequest({ cmd: "update_task", taskId: "t1", status: "running" } as BusRequest);
    expect(blockedQuestionFromResultJson(st.task.result_json)).toBeNull();
  });
});
