import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus } from "../../src/main/message-bus";
import { IDLE_WITHOUT_REPORT_MS, screenReportPointerBody } from "../../src/main/idle-without-report-decision";
import { unreportedUnprovenIdlePointerBody } from "../../src/main/agent-facing-authorship";

/**
 * The idle scan names a report written to the screen: a linked card that goes
 * idle with no delivered report, whose retained output carries the task's
 * reportSchema keys, gets the screen-report pointer instead of the generic one.
 * The output tail comes from the main process (registry), not the renderer.
 */

const SCREEN_POINTER = screenReportPointerBody();
const UNPROVEN_POINTER = unreportedUnprovenIdlePointerBody(IDLE_WITHOUT_REPORT_MS + 1_000);

const RECORDED_SCREEN = ["trabalho concluído", "filesChanged:", "  - a.ts", "gatesOutput:", "  npx vitest run -> ok"].join("\n");
const REPORT_SCHEMA_JSON = JSON.stringify(["filesChanged", "gatesOutput"]);

type FakeTaskRow = {
  id: string;
  card_id: string | null;
  status: string;
  prompt?: string | null;
  result_json?: string | null;
  report_schema_json?: string | null;
  retry_count?: number;
  max_retries?: number | null;
};

describe("message-bus: idle scan recognizes a report written to the screen", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-screen-report-"));
    const written: Array<[string, string]> = [];
    const lastActivity = Date.now() - IDLE_WITHOUT_REPORT_MS - 1_000;
    const tasks: FakeTaskRow[] = [
      { id: "task-1", card_id: "worker-1", status: "pending", prompt: "work", report_schema_json: REPORT_SCHEMA_JSON },
    ];
    const base: Record<string, (...args: never[]) => unknown> = {
      listCards: () => [
        { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
        { id: "worker-1", kind: "terminal", provider: "cursor", cwd: "", label: "worker", displayName: "worker" },
      ],
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
      isCardAlive: (id: string) => id === "spawner-1" || id === "worker-1",
      getCardLastActivityAt: (id: string) => (id === "worker-1" ? lastActivity : Date.now()),
      getCardWriteReadiness: () => ({
        spawnedAtMs: Date.now() - 60_000,
        hasReceivedData: true,
        lastActivityAtMs: lastActivity,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      beginCardDelivery: () => true,
      onReadCardRequest: ((requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" })) as never,
      describeCardLabel: (id: string) => (id === "worker-1" ? "worker" : id === "spawner-1" ? "MASTER" : id),
      listAllConnectors: () => [{ kind: "spawned", from_card_id: "spawner-1", to_card_id: "worker-1", updated_at: Date.now() }],
      listTasks: () => tasks,
      listTasksForIdleScan: () => tasks,
      getTask: (id: string) => tasks.find((t) => t.id === id),
      upsertTask: () => ({
        status: "pending",
        statusChanged: false,
        divergedStatus: null,
        divergedActor: null,
        recordDeclaration: false,
        warnAgent: false,
        declaredStatus: null,
      }),
      ...overrides,
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(base, { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) }) as Parameters<typeof createMessageBus>[1],
    );
    return { bus: bus!, written };
  }

  async function bodies(written: Array<[string, string]>, timeoutMs = 1000): Promise<string[]> {
    await new Promise((r) => setTimeout(r, timeoutMs));
    return written.filter(([, d]) => d !== "\r").map(([, d]) => d);
  }

  it("retained output with the schema keys → the screen-report pointer", async () => {
    const { bus: b, written } = makeBus({ getCardRecentOutput: () => RECORDED_SCREEN });
    b.scanIdleWithoutReport();
    const lines = await bodies(written);
    expect(lines.filter((t) => t.includes(SCREEN_POINTER))).toHaveLength(1);
    expect(lines.filter((t) => t.includes(UNPROVEN_POINTER))).toHaveLength(0);
  });

  it("output without the schema keys → the generic idle pointer (no false positive)", async () => {
    const { bus: b, written } = makeBus({ getCardRecentOutput: () => "só conversa solta, sem as chaves do contrato" });
    b.scanIdleWithoutReport();
    const lines = await bodies(written);
    expect(lines.filter((t) => t.includes(SCREEN_POINTER))).toHaveLength(0);
    expect(lines.filter((t) => t.includes(UNPROVEN_POINTER))).toHaveLength(1);
  });
});
