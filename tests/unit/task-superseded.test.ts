import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { deriveTaskPhase } from "../../src/main/task-phase-decision";

/**
 * SUPERSEDED — the REAL path: `update_task` through the bus with a real store
 * behind it (same rig as `message-bus-report-role.test.ts`).
 *
 * Covers the acceptance criteria: a superseded write without `supersededBy`
 * is refused naming the field; an implementer is refused; the orchestrator
 * marks and the target persists; the reservation is released; the dependent
 * is notified to the orchestrator; and the derived phase is `superseded`.
 */

const NOW = 1_000;

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "default",
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
    created_at: NOW,
    updated_at: NOW,
    ...over,
  } as TaskRow;
}

type Write = { target: string; text: string };

function callbacksBackedByStore(
  store: ReturnType<typeof openStore>,
  writes: Write[],
  getBus: () => ReturnType<typeof createMessageBus> | null,
): Parameters<typeof createMessageBus>[1] {
  const readySince = Date.now() - 5_000;
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        switch (prop) {
          case "getTask":
            return (id: string) => store.getTask(id);
          case "upsertTask":
            return (row: TaskRow) => store.upsertTask(row);
          case "applyColumnDrop":
            return (row: TaskRow, sib: { id: string; implicitOrder: number }[]) => store.applyColumnDrop(row, sib);
          case "getTaskCards":
            return (id: string) => store.getTaskCards(id);
          case "listTaskCardsForCard":
            return (id: string) => store.listTaskCardsForCard(id);
          case "listLiveImplementersForTask":
            return (id: string) => store.listLiveImplementersForTask(id);
          case "listReservationsForCard":
            return (id: string) => store.listReservationsForCard(id);
          case "activateReservedTaskCard":
            return (taskId: string, cardId: string) => store.activateReservedTaskCard(taskId, cardId);
          case "releaseAllImplementerLinks":
            return (taskId: string, reason: string, by: string | null) => store.releaseAllImplementerLinks(taskId, reason, by);
          case "linkTaskCard":
            return (taskId: string, cardId: string, role: string) => {
              store.linkTaskCard(taskId, cardId, role);
            };
          case "listTasks":
            return () => store.listTasks();
          case "listTasksByBoard":
            return (boardId: string) => store.listTasksByBoard(boardId);
          case "listTasksSummaryByBoard":
            return (boardId: string) => store.listTasksSummaryByBoard(boardId);
          case "getBoardOrchestratorCardId":
            return (boardId: string) => (boardId === "default" ? "orch" : null);
          case "isCardAlive":
            return () => true;
          case "getCardBoardId":
            return () => "default";
          case "listCards":
            return () => [
              { id: "orch", kind: "terminal", provider: "claude", cwd: "", label: null },
              { id: "impl", kind: "terminal", provider: "claude", cwd: "", label: null },
              { id: "reviewer", kind: "terminal", provider: "claude", cwd: "", label: null },
            ];
          case "writeToCard":
          case "writeToCardWithOrigin":
            return (id: string, text: string) => {
              writes.push({ target: id, text });
            };
          case "beginCardDelivery":
            return () => true;
          case "endCardDelivery":
            return () => undefined;
          case "getCardWriteReadiness":
            return () => ({
              spawnedAtMs: readySince,
              hasReceivedData: true,
              lastActivityAtMs: readySince,
              hasPendingHumanInput: false,
              inputLineLastAtMs: null,
            });
          case "getCardLastActivityAt":
            return () => readySince;
          // `deliverCard` reads the screen BEFORE writing: without answering
          // the read request, the delivery would only happen after the timeout.
          case "onReadCardRequest":
            return (requestId: string) => {
              getBus()?.resolveReadCard(requestId, { ok: true, text: "→ ok\n Working" });
            };
          default:
            return () => undefined;
        }
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("task superseded — caminho real pelo update_task", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let writes: Write[] = [];

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { store: ReturnType<typeof openStore>; bus: ReturnType<typeof createMessageBus> } {
    dir = mkdtempSync(join(tmpdir(), "stellar-superseded-"));
    writes = [];
    store = openStore(dir);
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store, writes, () => bus));
    return { store, bus };
  }

  it("sem supersededBy é RECUSADO, nomeando o campo", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1"));
    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string; field?: string };
    expect(res.ok).toBe(false);
    expect(res.field).toBe("supersededBy");
    expect(res.error).toContain("supersededBy");
    // Nothing was written: the task stays pending with no target.
    expect(s.getTask("t1")!.status).toBe("pending");
    expect(s.getTask("t1")!.superseded_by).toBeNull();
  });

  it("implementer da tarefa é RECUSADO (participação vence o mark)", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1", { card_id: "impl" }));
    s.linkTaskCard("t1", "impl", "implementer");
    s.upsertTask(baseTask("t2"));

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "t2",
      requesterId: "impl",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("implementer");
    expect(s.getTask("t1")!.status).toBe("pending");
  });

  it("orquestrador marca: superseded + supersededBy persistem e a reserva é LIBERADA", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1", { card_id: "impl" }));
    s.reserveTaskCard("t1", "impl");
    s.upsertTask(baseTask("t2"));

    expect(s.listReservationsForCard("impl").map((r) => r.task_id)).toEqual(["t1"]);

    const res = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "t2",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; status?: string };
    expect(res.ok).toBe(true);
    expect(res.status).toBe("superseded");

    const t1 = s.getTask("t1")!;
    expect(t1.status).toBe("superseded");
    expect(t1.superseded_by).toBe("t2");
    // Reservation and territory released: no live link and a cleared pointer.
    expect(s.listReservationsForCard("impl")).toEqual([]);
    expect(s.listLiveImplementersForTask("t1")).toEqual([]);
    expect(t1.card_id).toBeNull();
  });

  it("dependente que apontava para a substituída é AVISADO ao orquestrador", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1"));
    s.upsertTask(baseTask("t2"));
    s.upsertTask(baseTask("t3", { deps_json: JSON.stringify(["t1"]) }));

    await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "t2",
      requesterId: "orch",
    } as BusRequest);

    await new Promise((r) => setTimeout(r, 600));
    const notice = writes.find(
      (w) => w.target === "orch" && w.text.includes("t1") && w.text.includes("t2") && w.text.includes("t3"),
    );
    expect(notice).toBeTruthy();
  });

  it("alvo inexistente, a própria task e outro board são RECUSADOS nomeando o campo", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1"));
    s.upsertTask(baseTask("other", { board_id: "outro" }));

    const unknown = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "nao-existe",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; field?: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.field).toBe("supersededBy");

    const self = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "t1",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(self.ok).toBe(false);
    expect(self.error).toContain("itself");

    const otherBoard = (await b.handleRequest({
      cmd: "update_task",
      taskId: "t1",
      status: "superseded",
      supersededBy: "other",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(otherBoard.ok).toBe(false);
    expect(otherBoard.error).toContain("SAME board");
    expect(s.getTask("t1")!.status).toBe("pending");
  });

  it("get_task/list_tasks carregam supersededBy; a fase derivada é 'superseded'", async () => {
    const { store: s, bus: b } = setup();
    s.upsertTask(baseTask("t1"));
    s.upsertTask(baseTask("t2"));
    await b.handleRequest({ cmd: "update_task", taskId: "t1", status: "superseded", supersededBy: "t2", requesterId: "orch" } as BusRequest);

    const got = (await b.handleRequest({ cmd: "get_task", taskId: "t1" } as BusRequest)) as {
      ok: boolean;
      task: { status: string; supersededBy: string | null; phase: string };
    };
    expect(got.task.status).toBe("superseded");
    expect(got.task.supersededBy).toBe("t2");
    expect(got.task.phase).toBe("superseded");

    const listed = (await b.handleRequest({ cmd: "list_tasks", requesterId: "orch", view: "full" } as BusRequest, { callerCardId: "orch", scopeEnforced: true })) as unknown as {
      tasks: { id: string; supersededBy: string | null }[];
    };
    expect(listed.tasks.find((t) => t.id === "t1")?.supersededBy).toBe("t2");
  });

  it("fase pura: status superseded vence; dep substituída NÃO bloqueia o dependente", () => {
    expect(
      deriveTaskPhase({
        status: "superseded",
        deps: [],
        hasActiveImplementer: false,
        hasReservedCard: false,
        implementerReportedSinceLastDelivery: false,
        reviewerChangesRequested: false,
      }),
    ).toBe("superseded");

    expect(
      deriveTaskPhase({
        status: "pending",
        deps: [{ status: "superseded" }],
        hasActiveImplementer: false,
        hasReservedCard: false,
        implementerReportedSinceLastDelivery: false,
        reviewerChangesRequested: false,
      }),
    ).toBe("ready");
  });
});
