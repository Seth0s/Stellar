import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { readBus } from "../helpers/bus-response";

/**
 * Report attribution by DECLARED task when the card has or had a link
 * (history), plus get_report(taskId) must not return another task's report
 * from the same multi-link card.
 *
 * RED on a tree that only passes live links into decideReportTaskLink, and
 * that walks a multi-link card's full report stream without filtering by
 * the declared/stamped task id.
 */

type ReportOk = { ok: true; seq: number };
type ReportFail = { ok: false; error: string };
type GetReportOk = {
  ok: true;
  taskId: string;
  report: { note?: string; reviewOf?: string; taskId?: string; task?: string };
};
type GetReportFail = { ok: false; error: string };

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: `work ${id}`,
    provider: "claude",
    status: "running",
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
        if (prop === "getReportBySeq") return (seq: number) => store.getReportBySeq?.(seq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "listTaskCardsForCardHistory")
          return (cardId: string) => store.listTaskCardsForCardHistory(cardId);
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
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("report: declared task uses has-or-had link (5c77938e)", () => {
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

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-decl-hist-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store));
    return { store, bus };
  }

  it("declares A while live link is B → stored under A when the card had a link to A", async () => {
    const { store: s, bus: b } = setup();
    const CARD = "card-97924223";
    const TASK_A = "task-A-49de95ce";
    const TASK_B = "task-B-ba297d23";

    s.upsertTask(baseTask(TASK_A, { card_id: CARD, status: "running" }));
    s.linkTaskCard(TASK_A, CARD, "implementer");
    // Live link moves away: A is released (history only), B is live.
    const released = s.releaseTaskCardFromTask({
      taskId: TASK_A,
      cardId: CARD,
      reason: "moved to next verification",
      releasedBy: "orch",
      actor: "orchestrator",
    });
    expect(released.ok).toBe(true);

    s.upsertTask(baseTask(TASK_B, { card_id: CARD, status: "running" }));
    s.linkTaskCard(TASK_B, CARD, "implementer");

    expect(s.listTaskCardsForCard(CARD).map((l) => l.task_id)).toEqual([TASK_B]);
    expect(s.listTaskCardsForCardHistory(CARD).map((l) => l.task_id).sort()).toEqual(
      [TASK_A, TASK_B].sort(),
    );

    // Agent names A via the `task` field (the measured seq-717 shape).
    const res = readBus<ReportOk | ReportFail>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, task: TASK_A, note: "verification of A" },
      } as BusRequest),
    );
    expect(res.ok).toBe(true);

    const row = s.getReport(CARD);
    expect(row).toBeDefined();
    const body = JSON.parse(row!.report_json) as Record<string, unknown>;
    // fillReportTaskId stamps the RESOLVED task; must be A, not live B.
    expect(body.taskId).toBe(TASK_A);
    expect(body.task).toBe(TASK_A);

    const verdictsA = s.getTaskVerdicts(TASK_A);
    const verdictsB = s.getTaskVerdicts(TASK_B);
    expect(verdictsA).toHaveLength(1);
    expect(verdictsB).toHaveLength(0);

    const readA = readBus<GetReportOk | GetReportFail>(
      await b.handleRequest({ cmd: "get_report", taskId: TASK_A } as BusRequest),
    );
    expect(readA.ok).toBe(true);
    if (!readA.ok) return;
    expect(readA.report.note).toBe("verification of A");

    const readB = readBus<GetReportOk | GetReportFail>(
      await b.handleRequest({ cmd: "get_report", taskId: TASK_B } as BusRequest),
    );
    // B has no report of its own; must not leak A's.
    expect(readB.ok).toBe(false);
  });

  it("read_report(taskId A) does not return a later report that declares B from the same card", async () => {
    const { store: s, bus: b } = setup();
    const CARD = "card-reviewer-98576321";
    const TASK_A = "task-54d82089";
    const TASK_B = "task-5174dca9";

    s.upsertTask(baseTask(TASK_A, { status: "running" }));
    s.upsertTask(baseTask(TASK_B, { status: "running" }));
    s.linkTaskCard(TASK_A, CARD, "reviewer");
    s.linkTaskCard(TASK_B, CARD, "reviewer");

    const first = readBus<ReportOk | ReportFail>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, taskId: TASK_A, reviewOf: "A" },
      } as BusRequest),
    );
    expect(first.ok).toBe(true);

    const second = readBus<ReportOk | ReportFail>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, taskId: TASK_B, reviewOf: "B" },
      } as BusRequest),
    );
    expect(second.ok).toBe(true);

    const readA = readBus<GetReportOk | GetReportFail>(
      await b.handleRequest({ cmd: "get_report", taskId: TASK_A } as BusRequest),
    );
    expect(readA.ok).toBe(true);
    if (!readA.ok) return;
    expect(readA.report.reviewOf).toBe("A");
    expect(readA.report.taskId).toBe(TASK_A);

    const readB = readBus<GetReportOk | GetReportFail>(
      await b.handleRequest({ cmd: "get_report", taskId: TASK_B } as BusRequest),
    );
    expect(readB.ok).toBe(true);
    if (!readB.ok) return;
    expect(readB.report.reviewOf).toBe("B");
  });

  it("declared task the card never participated in is refused", async () => {
    const { store: s, bus: b } = setup();
    const CARD = "card-only-B";
    s.upsertTask(baseTask("task-B-only", { card_id: CARD, status: "running" }));
    s.linkTaskCard("task-B-only", CARD, "implementer");
    s.upsertTask(baseTask("task-never", { status: "pending" }));

    const res = readBus<ReportOk | ReportFail>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, taskId: "task-never" },
      } as BusRequest),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/task-never/);
    expect(s.getReport(CARD)).toBeUndefined();
  });
});
