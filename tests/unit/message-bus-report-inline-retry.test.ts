import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";
import {
  describeRetryableFailureRefusal,
  describeExitWithoutAcceptedReport,
  LAST_REFUSED_REPORT_KEY,
} from "../../src/main/report-retry-decision";
import { failureKindFromResultJson } from "../../src/main/failure-kind-decision";

/**
 * In-line `report` retry: same session, no spawn. The four cases the
 * owner asked for — (a) must fail if anyone reintroduces a spawn on
 * a refused declared failure.
 */

type FakeReportRow = { card_id: string; seq: number; report_json: string; verdict?: string | null; updated_at: number };
type ConnectorRow = { kind: string | null; from_card_id: string; to_card_id: string; updated_at: number };

function applied(status: string): StatusWriteDecision {
  return {
    status,
    statusChanged: true,
    divergedStatus: null,
    divergedActor: null,
    recordDeclaration: false,
    warnAgent: false,
    declaredStatus: null,
  };
}

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    prompt: "do the work",
    provider: "claude",
    status: "running",
    card_id: "worker-1",
    board_id: "b1",
    cwd: "/tmp/repo",
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: JSON.stringify(["claude"]),
    max_retries: 2,
    fallback_providers_json: JSON.stringify(["codex"]),
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

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  const reportsByCard = new Map<string, FakeReportRow[]>();
  const reportDefaults: Record<string, (...args: never[]) => unknown> = {
    getReport: ((cardId: string, afterSeq?: number) => {
      const rows = reportsByCard.get(cardId) ?? [];
      if (afterSeq === undefined) return rows.length ? rows[rows.length - 1] : undefined;
      return rows.find((r) => r.seq > afterSeq);
    }) as never,
    upsertReport: ((row: FakeReportRow) => {
      const rows = reportsByCard.get(row.card_id) ?? [];
      rows.push(row);
      reportsByCard.set(row.card_id, rows);
    }) as never,
    nextReportSeqSeed: (() => 0) as never,
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? reportDefaults[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: report in-line retry (no spawn)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function harness(task: TaskRow) {
    dir = mkdtempSync(join(tmpdir(), "stellar-inline-retry-"));
    const spawnRequests: unknown[] = [];
    const upserts: TaskRow[] = [];
    const live = task;
    const written: unknown[][] = [];
    const connectors: ConnectorRow[] = [
      { kind: "spawned", from_card_id: "spawner-1", to_card_id: live.card_id ?? "worker-1", updated_at: Date.now() },
    ];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listTasks: () => [live],
        listTaskCardsForCard: () => [],
        listAllConnectors: () => connectors,
        isCardAlive: (id: string) => id === "spawner-1" || id === "worker-1",
        describeCardLabel: (id: string) => id,
        writeToCard: (...args: unknown[]) => written.push(args),
        listCards: () => [{ id: "spawner-1", kind: "terminal" }],
        isBoardAutonomous: () => true,
        countRunningAgentsOnBoard: () => 0,
        getBoardConcurrencyCap: () => 4,
        getCardBoardId: () => "b1",
        upsertTask: (row: TaskRow) => {
          Object.assign(live, row);
          upserts.push({ ...row });
          return applied(row.status);
        },
        onSpawnAgentRequest: (...args: unknown[]) => {
          spawnRequests.push(args);
        },
      }),
    );
    return { bus, live, spawnRequests, upserts, written };
  }

  it("a: declared failure with budget — refuses in-line, task stays running, retry_count rises, no spawn", async () => {
    const { bus: b, live, spawnRequests, written } = harness(baseTask());
    const waiter = b.handleRequest({
      cmd: "get_report",
      target: "worker-1",
      wait: true,
      timeoutMs: 120,
    } as BusRequest);

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "tests failed" },
    } as BusRequest)) as {
      ok: boolean;
      error?: string;
      retryCount?: number;
      retriesRemaining?: number;
      seq?: number;
    };

    expect(res.ok).toBe(false);
    expect(res.seq).toBeUndefined();
    expect(res.retryCount).toBe(1);
    expect(res.retriesRemaining).toBe(1);
    expect(res.error).toBe(describeRetryableFailureRefusal(1));
    expect(res.error).toContain("ok: true");
    expect(res.error).toContain("retryable: false");
    expect(res.error).toContain("Attempts remaining: 1");
    expect(res.error?.toLowerCase()).not.toMatch(/fix|corrija|correct the/);

    expect(live.status).toBe("running");
    expect(live.retry_count).toBe(1);
    const refused = JSON.parse(live.result_json ?? "{}") as Record<string, unknown>;
    expect(refused[LAST_REFUSED_REPORT_KEY]).toEqual({ ok: false, error: "tests failed" });
    expect(refused.failureKind).toBeUndefined();
    expect(failureKindFromResultJson(live.result_json)).toBeNull();
    expect(spawnRequests).toHaveLength(0);
    expect(written).toHaveLength(0);

    const waited = (await waiter) as { ok: boolean };
    expect(waited.ok).toBe(false);
  });

  it("stash after refusal is not a status: still running, no failureKind", async () => {
    const { bus: b, live } = harness(baseTask());
    await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "não consegui X porque Y" },
    } as BusRequest);

    expect(live.status).toBe("running");
    expect(failureKindFromResultJson(live.result_json)).toBeNull();
    expect(JSON.parse(live.result_json ?? "{}").failureKind).toBeUndefined();
  });

  it("b: declared failure without budget — accepts, stores, task becomes failed, waiter gets JSON, no PTY write, no spawn", async () => {
    const { bus: b, live, spawnRequests, written } = harness(baseTask({ retry_count: 2 }));
    const waiter = b.handleRequest({
      cmd: "get_report",
      target: "worker-1",
      wait: true,
      timeoutMs: 2000,
    } as BusRequest);

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "still failing" },
    } as BusRequest)) as { ok: boolean; seq?: number };

    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    expect(live.status).toBe("failed");
    expect(live.retry_count).toBe(2);
    expect(JSON.parse(live.result_json ?? "{}").failureKind).toBe("julgada");
    expect(spawnRequests).toHaveLength(0);
    expect(written).toHaveLength(0);

    const waited = (await waiter) as { ok: boolean; report?: { error?: string }; seq?: number };
    expect(waited.ok).toBe(true);
    expect(waited.seq).toBe(1);
    expect(waited.report?.error).toBe("still failing");
  });

  it("c: agent exits without reporting — exit_without_report stamps the failure, no PTY write, no spawn", async () => {
    const { bus: b, live, spawnRequests, written } = harness(baseTask({ retry_count: 0, max_retries: 2 }));

    b.resolveCardExit("worker-1", 1);
    await new Promise((r) => setTimeout(r, 50));

    // Existing typed-failure mapping: exit_without_report → interrompida → pending.
    expect(live.status).toBe("pending");
    expect(JSON.parse(live.result_json ?? "{}").failureKind).toBe("interrompida");
    expect(JSON.parse(live.result_json ?? "{}").error).toBe(describeExitWithoutAcceptedReport(1, null));
    expect(JSON.parse(live.result_json ?? "{}").error).toContain("without ever calling report");
    expect(written).toHaveLength(0);
    expect(spawnRequests).toHaveLength(0);
  });

  it("d: declared terminal failure — accepted immediately, no refusal, no retry spent, no spawn", async () => {
    const { bus: b, live, spawnRequests, written } = harness(baseTask({ retry_count: 0 }));

    const res = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, retryable: false, error: "no credits" },
    } as BusRequest)) as { ok: boolean; seq?: number; error?: string };

    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    expect(res.error).toBeUndefined();
    expect(live.status).toBe("failed");
    expect(live.retry_count).toBe(0);
    expect(JSON.parse(live.result_json ?? "{}").error).toBe("no credits");
    expect(JSON.parse(live.result_json ?? "{}").failureKind).toBe("julgada");
    expect(spawnRequests).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("exit after a refused report names the death and the last declared failure; get_report stays empty, waiter sleeps, no spawn", async () => {
    const { bus: b, live, spawnRequests, written } = harness(baseTask());
    const waiter = b.handleRequest({
      cmd: "get_report",
      target: "worker-1",
      wait: true,
      timeoutMs: 150,
    } as BusRequest);

    const refused = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "não consegui X porque Y" },
    } as BusRequest)) as { ok: boolean; seq?: number };
    expect(refused.ok).toBe(false);
    expect(refused.seq).toBeUndefined();
    expect(live.status).toBe("running");
    expect(failureKindFromResultJson(live.result_json)).toBeNull();

    b.resolveCardExit("worker-1", 129);
    await new Promise((r) => setTimeout(r, 50));

    const result = JSON.parse(live.result_json ?? "{}") as Record<string, unknown>;
    expect(result.error).toBe(describeExitWithoutAcceptedReport(129, "não consegui X porque Y"));
    expect(result.error).toContain("code 129");
    expect(result.error).toContain("refused report");
    expect(result.error).toContain("não consegui X porque Y");
    expect(String(result.error)).not.toContain("without ever calling report");
    expect(result[LAST_REFUSED_REPORT_KEY]).toBeUndefined();
    expect(live.status).toBe("pending");
    expect(result.failureKind).toBe("interrompida");
    expect(written).toHaveLength(0);
    expect(spawnRequests).toHaveLength(0);

    const peeked = (await b.handleRequest({ cmd: "get_report", target: "worker-1" } as BusRequest)) as { ok: boolean };
    expect(peeked.ok).toBe(false);

    const waited = (await waiter) as { ok: boolean };
    expect(waited.ok).toBe(false);
  });

  it("accepted report clears a superseded stash so a later exit does not revive it", async () => {
    const { bus: b, live, spawnRequests } = harness(baseTask());

    await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: false, error: "old refused reason" },
    } as BusRequest);
    expect(JSON.parse(live.result_json ?? "{}")[LAST_REFUSED_REPORT_KEY]).toEqual({
      ok: false,
      error: "old refused reason",
    });

    const accepted = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: { ok: true, result: "fixed" },
    } as BusRequest)) as { ok: boolean; seq?: number };
    expect(accepted.ok).toBe(true);
    expect(accepted.seq).toBe(1);
    expect(live.status).toBe("running");
    expect(live.result_json).toBeNull();
    expect(failureKindFromResultJson(live.result_json)).toBeNull();

    b.resolveCardExit("worker-1", 1);
    await new Promise((r) => setTimeout(r, 50));

    // Accepted report exists — exit_without_report must not fire, and the
    // old stash must not come back as the cause.
    expect(live.status).toBe("running");
    expect(live.result_json).toBeNull();
    expect(spawnRequests).toHaveLength(0);
  });
});
