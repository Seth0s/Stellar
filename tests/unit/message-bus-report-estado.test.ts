import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { readBus } from "../helpers/bus-response";
import { CHECKPOINT_WRITE_THRESHOLD } from "../../src/main/report-estado-decision";

/**
 * Report leaves being a terminal event: estado parcial vs final, get_report
 * honesty, and the write-streak checkpoint reminder.
 *
 * RED on a tree that treats any ok:true as conclusion and that returns the
 * latest report without naming estado / latestFinalSeq.
 */

type ReportRes = { ok: boolean; seq?: number; estado?: string; error?: string };
type GetReportRes = {
  ok: boolean;
  seq?: number;
  estado?: string;
  latestFinalSeq?: number | null;
  report?: { note?: string; estado?: string };
  error?: string;
};

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

describe("report estado parcial vs final (contract)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let written: Array<[string, string]> = [];

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    written = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-estado-"));
    store = openStore(dir);
    written = [];
    const s = store;
    bus = createMessageBus(
      join(dir, "a.sock"),
      new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop === "getReport") return (cardId: string, afterSeq?: number) => s.getReport(cardId, afterSeq);
            if (prop === "getReportBySeq") return (seq: number) => s.getReportBySeq?.(seq);
            if (prop === "upsertReport") return (row: ReportRow) => s.upsertReport(row);
            if (prop === "nextReportSeqSeed") return () => s.nextReportSeqSeed();
            if (prop === "listTaskCardsForCard") return (cardId: string) => s.listTaskCardsForCard(cardId);
            if (prop === "listTaskCardsForCardHistory")
              return (cardId: string) => s.listTaskCardsForCardHistory(cardId);
            if (prop === "getTaskCards") return (taskId: string) => s.getTaskCards(taskId);
            if (prop === "recordParticipationRound")
              return (cardId: string, verdict: string | null, at: number, taskId?: string | null) =>
                s.recordParticipationRound(cardId, verdict, at, taskId);
            if (prop === "listTasks") return () => s.listTasks();
            if (prop === "getTask") return (id: string) => s.getTask(id);
            if (prop === "upsertTask") return (row: TaskRow) => s.upsertTask(row);
            if (prop === "listAllConnectors") return () => [];
            if (prop === "listCards") return () => [{ id: "worker", kind: "terminal" }];
            if (prop === "isCardAlive") return () => true;
            if (prop === "describeCardLabel") return (id: string) => id;
            if (prop === "beginCardDelivery") return () => true;
            if (prop === "getCardWriteReadiness") return () => null;
            if (prop === "writeToCard") return (id: string, data: string) => written.push([id, data]);
            if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
            if (prop === "findSpawnByChild") return () => undefined;
            if (prop === "listSpawnsByParent") return () => [];
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    return { store, bus };
  }

  it("report without estado is parcial; final is explicit; get_report names latestFinalSeq", async () => {
    const { store: s, bus: b } = setup();
    const TASK = "task-estado-1";
    const CARD = "worker";
    s.upsertTask(baseTask(TASK, { card_id: CARD, status: "running" }));
    s.linkTaskCard(TASK, CARD, "implementer");

    const mid = readBus<ReportRes>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, taskId: TASK, note: "checkpoint", decisaoTomada: "ship the filter" },
      } as BusRequest),
    );
    expect(mid.ok).toBe(true);
    expect(mid.estado).toBe("parcial");

    const fin = readBus<ReportRes>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: {
          ok: true,
          taskId: TASK,
          estado: "final",
          note: "done",
          decisaoTomada: "done",
        },
      } as BusRequest),
    );
    expect(fin.ok).toBe(true);
    expect(fin.estado).toBe("final");

    const after = readBus<ReportRes>(
      await b.handleRequest({
        cmd: "report",
        requesterId: CARD,
        report: { ok: true, taskId: TASK, note: "oops more", decisaoTomada: "follow-up" },
      } as BusRequest),
    );
    expect(after.estado).toBe("parcial");

    const got = readBus<GetReportRes>(
      await b.handleRequest({ cmd: "get_report", taskId: TASK } as BusRequest),
    );
    expect(got.ok).toBe(true);
    expect(got.estado).toBe("parcial");
    expect(got.report?.note).toBe("oops more");
    expect(got.latestFinalSeq).toBe(fin.seq);
  });

  it("noteCardWrite reminds once at the measured threshold", () => {
    const { bus: b } = setup();
    for (let i = 0; i < CHECKPOINT_WRITE_THRESHOLD - 1; i++) {
      expect(b.noteCardWrite("worker")).toEqual({ reminded: false });
    }
    expect(b.noteCardWrite("worker")).toEqual({ reminded: true });
    expect(b.noteCardWrite("worker")).toEqual({ reminded: false });
  });
});
