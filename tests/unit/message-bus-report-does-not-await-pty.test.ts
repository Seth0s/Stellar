import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Live incident 2026-09-13 (cards 449 / 451 / 453): `report` awaited
 * `notifySpawnerOfReport` → `typeAndSubmit` on the orchestrator's PTY.
 * A busy orchestrator made the MCP call sit in `waitForWriteReadiness`
 * (up to 8s) plus Enter confirmation reads. The client timed out, the
 * agent retried, each retry typed another notice — self-amplifying.
 *
 * This file does not inspect source. It installs a PTY double that
 * never becomes ready and never answers a screen read. If anyone
 * `await`s a write/read of that PTY on the `report` path, `report`
 * cannot return before `REPORT_MUST_RETURN_MS`. `send_to_card` is the
 * control: it still goes through `typeAndSubmit`, so the same double
 * MUST swallow it. If both return, the double is broken and the test
 * is not proving anything.
 *
 * Run against `6239269^` (pre-fix `message-bus.ts`) to confirm this
 * fails on the old `await notifySpawnerOfReport`.
 */

const REPORT_MUST_RETURN_MS = 250;

type ConnectorRow = { kind: string | null; from_card_id: string; to_card_id: string; updated_at: number };
type FakeReportRow = { card_id: string; seq: number; report_json: string; updated_at: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstOf<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

describe("message-bus: report não espera PTY (regressão do timeout MCP)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let hangPty = true;

  afterEach(async () => {
    hangPty = false;
    // Give a hung `typeAndSubmit` one poll to see the released gate
    // before we close the socket — otherwise the suite leaks timers.
    await delay(50);
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(opts: { stuckPty: boolean }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-pty-"));
    hangPty = opts.stuckPty;
    const spawnedAtMs = Date.now();
    const rounds: Array<[string, string | null, number]> = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [
          { id: "orchestrator-1", kind: "terminal", provider: "claude" },
          { id: "worker-1", kind: "terminal", provider: "claude" },
        ],
        listAllConnectors: () =>
          [{ kind: "spawned", from_card_id: "orchestrator-1", to_card_id: "worker-1", updated_at: Date.now() }] satisfies ConnectorRow[],
        isCardAlive: () => true,
        describeCardLabel: (id: string) => id,
        // Occupied orchestrator: never quiet, never past the 8s spawn cap
        // for the duration of the assertion. `waitForWriteReadiness` sits
        // here if `report` (or `send`) enters `typeAndSubmit`.
        getCardWriteReadiness: () =>
          hangPty
            ? {
                spawnedAtMs,
                hasReceivedData: false,
                lastActivityAtMs: spawnedAtMs,
                hasPendingHumanInput: true,
                inputLineLastAtMs: Date.now(),
              }
            : null,
        onReadCardRequest: (requestId: string) => {
          if (!hangPty) bus?.resolveReadCard(requestId, { ok: true, text: "" });
        },
        writeToCard: () => undefined,
        beginCardDelivery: () => !hangPty,
        recordParticipationRound: ((cardId: string, verdict: string | null, at: number) => {
          rounds.push([cardId, verdict, at]);
        }) as never,
      }),
    );
    return { bus, rounds };
  }

  it("orquestrador ocupado: report devolve na hora; send_to_card no mesmo PTY não", async () => {
    const { bus: b } = makeBus({ stuckPty: true });

    const waiter = b.handleRequest({
      cmd: "get_report",
      target: "worker-1",
      wait: true,
      timeoutMs: 2000,
    } as BusRequest) as Promise<{ ok: boolean; report: unknown; seq: number }>;

    const reportRes = await firstOf(
      b.handleRequest({
        cmd: "report",
        requesterId: "worker-1",
        report: { ok: true, result: "done" },
      } as BusRequest) as Promise<{ ok: boolean; seq: number }>,
      REPORT_MUST_RETURN_MS,
    );

    expect(reportRes).not.toBe("timeout");
    if (reportRes === "timeout") return;
    expect(reportRes.ok).toBe(true);
    expect(reportRes.seq).toBe(1);

    const waited = await waiter;
    expect(waited.ok).toBe(true);
    expect(waited.report).toEqual({ ok: true, result: "done" });
    expect(waited.seq).toBe(1);

    const sendRes = await firstOf(
      b.handleRequest({ cmd: "send", target: "orchestrator-1", text: "hello" } as BusRequest) as Promise<unknown>,
      REPORT_MUST_RETURN_MS,
    );
    expect(sendRes).toBe("timeout");
  });

  it("dois reports idênticos do mesmo card: duas linhas, dois seq, duas rodadas; waiter de afterSeq acorda no segundo", async () => {
    const { bus: b, rounds } = makeBus({ stuckPty: false });
    const payload = { ok: true, result: "same-bytes" };

    const r1 = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: payload,
    } as BusRequest)) as { ok: boolean; seq: number };
    expect(r1.ok).toBe(true);

    const waiter = b.handleRequest({
      cmd: "get_report",
      target: "worker-1",
      wait: true,
      afterSeq: r1.seq,
      timeoutMs: 2000,
    } as BusRequest) as Promise<{ ok: boolean; report: unknown; seq: number }>;

    await delay(10);
    const r2 = (await b.handleRequest({
      cmd: "report",
      requesterId: "worker-1",
      report: payload,
    } as BusRequest)) as { ok: boolean; seq: number };

    expect(r2.ok).toBe(true);
    expect(r2.seq).toBeGreaterThan(r1.seq);
    expect(rounds).toHaveLength(2);
    expect(rounds[0][0]).toBe("worker-1");
    expect(rounds[1][0]).toBe("worker-1");

    const waited = await waiter;
    expect(waited.ok).toBe(true);
    expect(waited.seq).toBe(r2.seq);
    expect(waited.report).toEqual(payload);
  });
});
