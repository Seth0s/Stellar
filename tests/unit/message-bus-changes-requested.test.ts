import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type BoardRow, type CardRow, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { CHANGES_REQUESTED_STATUS, changesRequestedFromResultJson } from "../../src/main/task-changes-requested-decision";
import { deriveTaskPhase } from "../../src/main/task-phase-decision";

/**
 * Return-for-rework (`changes_requested`) + reviewer verdict → status, and
 * the unblock hold bug: answer_blocked must not park a later reviewer done.
 */

function makeBoard(id: string): BoardRow {
  const now = Date.now();
  return {
    id,
    name: `Board ${id}`,
    project: "",
    cwd: "",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
    orchestrator_card_id: null,
  };
}

function makeCard(id: string, boardId: string): CardRow {
  const now = Date.now();
  return {
    id,
    board_id: boardId,
    kind: "terminal",
    provider: "claude",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: now,
    messages_json: null,
    archived_at: null,
    created_at: now,
  };
}

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "pending",
    card_id: "impl-1",
    board_id: "b1",
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
    review: "wanted",
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TaskRow;
}

function callbacksBackedByStore(store: ReturnType<typeof openStore>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "getTaskCards") return (taskId: string) => store.getTaskCards(taskId);
        if (prop === "recordParticipationRound")
          return (cardId: string, verdict: string | null, at: number, taskId?: string | null) =>
            store.recordParticipationRound(cardId, verdict, at, taskId);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "getTask") return (id: string) => store.getTask(id);
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "isCardAlive") return () => true;
        if (prop === "getBoardOrchestratorCardId") return (boardId: string) =>
          store.getBoard(boardId)?.orchestrator_card_id ?? null;
        if (prop === "boardExists") return (boardId: string) => !!store.getBoard(boardId);
        if (prop === "getBoardCwd") return () => null;
        if (prop === "getCardBoardId") return () => "b1";
        if (prop === "getTaskVerdicts") return (taskId: string) => store.getTaskVerdicts?.(taskId) ?? [];
        if (prop === "listLiveImplementersForTask") return (taskId: string) => store.listLiveImplementersForTask?.(taskId) ?? [];
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("changes_requested + reviewer verdict + unblock hold", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(review: "wanted" | null = "wanted") {
    dir = mkdtempSync(join(tmpdir(), "stellar-changes-req-"));
    store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertCard(makeCard("orch-1", "b1"));
    store.upsertCard(makeCard("impl-1", "b1"));
    store.upsertCard(makeCard("rv-1", "b1"));
    store.upsertCard(makeCard("impl-2", "b1"));
    expect(store.setBoardOrchestratorCardId("b1", "orch-1")).toBe(true);
    const task = baseTask("task-1", { review });
    store.upsertTask(task);
    store.linkTaskCard("task-1", "impl-1", "implementer");
    store.linkTaskCard("task-1", "rv-1", "reviewer");
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store));
    return { store, bus };
  }

  it("marked orchestrator returns with review=wanted; implementer cannot", async () => {
    const { store: st, bus: b } = setup("wanted");
    const refused = await b.handleRequest({
      cmd: "update_task",
      taskId: "task-1",
      status: CHANGES_REQUESTED_STATUS,
      requestChanges: { reason: "faltou teste" },
      requesterId: "impl-1",
    } as BusRequest);
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain("implementer");

    const ok = await b.handleRequest({
      cmd: "update_task",
      taskId: "task-1",
      status: CHANGES_REQUESTED_STATUS,
      requestChanges: { reason: "faltou teste" },
      requesterId: "orch-1",
    } as BusRequest);
    expect(ok.ok).toBe(true);
    const row = st.getTask("task-1")!;
    expect(row.status).toBe(CHANGES_REQUESTED_STATUS);
    expect(changesRequestedFromResultJson(row.result_json)?.reason).toBe("faltou teste");
    expect(row.prompt).toContain("[stellar:changes_requested] faltou teste");
    expect(row.diverged_status).toBeNull();
  });

  it("reviewer aprovado writes done; reprovado writes changes_requested", async () => {
    const { store: st, bus: b } = setup("wanted");
    const schemaBody = {
      ok: true,
      estado: "final",
      taskId: "task-1",
      filesChanged: ["/x.ts"],
      decisaoTomada: "ok",
      evidenciaMedida: "tests green",
      oQueNaoFiz: "nada",
      gatesOutput: "n/a",
    };

    const approved = await b.handleRequest({
      cmd: "report",
      requesterId: "rv-1",
      report: schemaBody,
      verdict: "aprovado",
    } as BusRequest);
    expect(approved.ok).toBe(true);
    expect(st.getTask("task-1")!.status).toBe("done");
    expect(st.getTask("task-1")!.diverged_status).toBeNull();

    // Fresh task for reprovado path.
    st.upsertTask(baseTask("task-2", { review: "wanted", card_id: "impl-2" }));
    st.linkTaskCard("task-2", "impl-2", "implementer");
    st.linkTaskCard("task-2", "rv-1", "reviewer");
    const reproved = await b.handleRequest({
      cmd: "report",
      requesterId: "rv-1",
      report: { ...schemaBody, taskId: "task-2", reason: "coverage baixa" },
      verdict: "reprovado",
    } as BusRequest);
    expect(reproved.ok).toBe(true);
    const row = st.getTask("task-2")!;
    expect(row.status).toBe(CHANGES_REQUESTED_STATUS);
    expect(changesRequestedFromResultJson(row.result_json)?.reason).toContain("coverage");
  });

  it("concluding implementer report after return clears status so phase can await review", async () => {
    const { store: st, bus: b } = setup("wanted");
    await b.handleRequest({
      cmd: "update_task",
      taskId: "task-1",
      status: CHANGES_REQUESTED_STATUS,
      requestChanges: { reason: "refazer" },
      requesterId: "orch-1",
    } as BusRequest);
    const final = await b.handleRequest({
      cmd: "report",
      requesterId: "impl-1",
      report: {
        ok: true,
        estado: "final",
        taskId: "task-1",
        filesChanged: ["/y.ts"],
        decisaoTomada: "redone",
        evidenciaMedida: "ok",
        oQueNaoFiz: "nada",
        gatesOutput: "n/a",
      },
    } as BusRequest);
    expect(final.ok).toBe(true);
    const row = st.getTask("task-1")!;
    expect(row.status).toBe("pending");
    expect(changesRequestedFromResultJson(row.result_json)).toBeNull();
    expect(
      deriveTaskPhase({
        status: row.status,
        deps: [],
        hasActiveImplementer: true,
        hasReservedCard: false,
        implementerReportedSinceLastDelivery: true,
        reviewerChangesRequested: false,
      }),
    ).toBe("awaiting_review");
  });

  it("answer_blocked then linked reviewer done → done, no divergence", async () => {
    const { store: st, bus: b } = setup("wanted");
    const question = {
      text: "seguir?",
      options: [
        { id: "sim", label: "Sim" },
        { id: "nao", label: "Não" },
      ],
    };
    await b.handleRequest({
      cmd: "update_task",
      taskId: "task-1",
      status: "blocked",
      question,
      requesterId: "impl-1",
    } as BusRequest);
    expect(st.getTask("task-1")!.status).toBe("blocked");

    const answered = await b.handleRequest({
      cmd: "answer_blocked",
      taskId: "task-1",
      optionId: "sim",
      requesterId: "orch-1",
    } as BusRequest);
    expect(answered.ok).toBe(true);
    expect(st.getTask("task-1")!.status).toBe("pending");

    const done = await b.handleRequest({
      cmd: "update_task",
      taskId: "task-1",
      status: "done",
      requesterId: "rv-1",
    } as BusRequest);
    expect(done.ok).toBe(true);
    const row = st.getTask("task-1")!;
    expect(row.status).toBe("done");
    expect(row.diverged_status).toBeNull();
    expect(row.requested_status ?? null).toBeNull();
  });
});
