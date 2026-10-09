import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { ReportRow, TaskCardRow, TaskRow } from "../../src/main/store";

/**
 * Task 6266d3e7 — `read_report` por TASK: aceita `taskId` (ou prefixo), devolve
 * o último report daquela task, aceita `round` para andar o histórico e inclui
 * o resumo do gateRun que o APP mediu (`result_json.gateRun`).
 */

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: "t",
    provider: "claude",
    status: "pending",
    card_id: null,
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
    created_at: 1,
    updated_at: 1,
    ...over,
  } as unknown as TaskRow;
}

function report(cardId: string, seq: number, body: unknown, role: string): ReportRow {
  return { card_id: cardId, seq, report_json: JSON.stringify(body), verdict: null, role, channel: "socket", updated_at: seq, authorship: null } as unknown as ReportRow;
}

const TASK_ID = "feedbeef-0000-4000-8000-000000000001";
const NO_REPORT_TASK = "deadbeef-0000-4000-8000-000000000002";

describe("read_report por task (task 6266d3e7)", () => {
  let ctx: { bus: ReturnType<typeof createMessageBus>; dir: string } | null = null;

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function rig() {
    const dir = mkdtempSync(join(tmpdir(), "stellar-read-report-task-"));
    const reports = new Map<string, ReportRow[]>([
      ["card1", [report("card1", 10, { ok: true, step: "one" }, "implementer"), report("card1", 12, { ok: true, step: "two" }, "implementer")]],
      ["card2", [report("card2", 11, { ok: true, review: "lgtm" }, "reviewer")]],
    ]);
    const result = { gateRun: { ok: false, commands: [{ command: "npm test", exitCode: 0 }, { command: "npm run lint", exitCode: 1 }] } };
    const theTask = task(TASK_ID, { result_json: JSON.stringify(result) });
    const emptyTask = task(NO_REPORT_TASK);
    const callbacks = new Proxy(
      {
        getTask: (id: string) => (id === TASK_ID ? theTask : id === NO_REPORT_TASK ? emptyTask : undefined),
        listTasks: () => [theTask, emptyTask],
        getTaskCards: (taskId: string): TaskCardRow[] =>
          taskId === TASK_ID
            ? ([{ task_id: TASK_ID, card_id: "card1", role: "implementer" }, { task_id: TASK_ID, card_id: "card2", role: "reviewer" }] as unknown as TaskCardRow[])
            : [],
        getReport: (cardId: string, afterSeq?: number): ReportRow | undefined => {
          const rows = (reports.get(cardId) ?? []).slice().sort((a, b) => a.seq - b.seq);
          if (afterSeq === undefined) return rows[rows.length - 1];
          return rows.find((r) => r.seq > afterSeq);
        },
      },
      { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
    ) as Parameters<typeof createMessageBus>[1];
    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, dir };
  }

  it("devolve o ÚLTIMO report da task, com round/totalRounds e o resumo do gateRun", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "get_report", taskId: TASK_ID } as BusRequest)) as {
      ok: boolean;
      seq: number;
      round: number;
      totalRounds: number;
      cardId: string;
      report: { step?: string };
      gateRun: { ok: boolean; passed: number; total: number; failedCommand: string | null };
    };
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(12);
    expect(res.round).toBe(3);
    expect(res.totalRounds).toBe(3);
    expect(res.cardId).toBe("card1");
    expect(res.report.step).toBe("two");
    expect(res.gateRun).toEqual({ ok: false, passed: 1, total: 2, failedCommand: "npm run lint" });
  });

  it("round escolhe a rodada (1-based, ordem cronológica por seq entre TODOS os cards)", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "get_report", taskId: TASK_ID, round: 2 } as BusRequest)) as { ok: boolean; seq: number; role: string; report: { review?: string } };
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(11);
    expect(res.role).toBe("reviewer");
    expect(res.report.review).toBe("lgtm");
  });

  it("round fora da faixa é RECUSADO nomeando o total", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "get_report", taskId: TASK_ID, round: 9 } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("3 report");
    expect(res.error).toContain("out of range");
  });

  it("task sem report nenhum → recusa honesta", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "get_report", taskId: NO_REPORT_TASK } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no report yet");
  });
});
