import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * The report notice names the task the REPORT declared; with no declaration it
 * names the card's active implementer task — never the first task ever linked
 * to the card. A card that ran A then B must be announced as B, not A: the
 * notice re-derived the task with `listTasks().find(card_id)`, which picks the
 * oldest task pointing at the card.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

type FakeTaskRow = { id: string; card_id: string | null; status: string; prompt?: string | null; result_json?: string | null; retry_count?: number; max_retries?: number | null };

describe("message-bus: report notice names the declared / active task", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(tasks: FakeTaskRow[], activeLinkTaskId: string) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-report-notice-"));
    const written: Array<[string, string]> = [];
    const base: Record<string, (...args: never[]) => unknown> = {
      listCards: () => [
        { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
        { id: "worker-1", kind: "terminal", provider: "cursor", cwd: "", label: "worker", displayName: "worker" },
      ],
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
      isCardAlive: (id: string) => id === "spawner-1" || id === "worker-1",
      getCardWriteReadiness: () => ({
        spawnedAtMs: Date.now() - 60_000,
        hasReceivedData: true,
        lastActivityAtMs: Date.now() - 1_000,
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
      listTaskCardsForCard: (cardId: string) =>
        cardId === "worker-1" ? [{ task_id: activeLinkTaskId, role: "implementer", released_at: null }] : [],
      upsertTask: () => ({
        status: "pending",
        statusChanged: false,
        divergedStatus: null,
        divergedActor: null,
        recordDeclaration: false,
        warnAgent: false,
        declaredStatus: null,
      }),
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(base, { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) }) as Parameters<typeof createMessageBus>[1],
    );
    return { bus: bus!, written };
  }

  async function reportLines(written: Array<[string, string]>): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 400));
    return written.filter(([, d]) => d.includes("report available")).map(([, d]) => d);
  }

  it("a report that DECLARES task B is announced as B, not the older A", async () => {
    // Both A and B are principal to the card (the old task was never cleared):
    // the previous code's `find` would have picked A.
    const tasks: FakeTaskRow[] = [
      { id: A, card_id: "worker-1", status: "pending", prompt: "older work" },
      { id: B, card_id: "worker-1", status: "pending", prompt: "newer work" },
    ];
    const { bus: b, written } = makeBus(tasks, B);
    await b.handleRequest({ cmd: "report", requesterId: "worker-1", report: { ok: true, taskId: B, result: "done" } } as BusRequest);
    const lines = await reportLines(written);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bbbbbbbb");
    expect(lines[0]).not.toContain("aaaaaaaa");
  });

  it("no declaration → the card's current implementer task, never the older one", async () => {
    // A is finished and still points at the card; a bare `find(card_id)` would
    // pick it. The notice must name the task the card is actually on (B).
    const tasks: FakeTaskRow[] = [
      { id: A, card_id: "worker-1", status: "done", prompt: "older work" },
      { id: B, card_id: "worker-1", status: "pending", prompt: "newer work" },
    ];
    const { bus: b, written } = makeBus(tasks, B);
    await b.handleRequest({ cmd: "report", requesterId: "worker-1", report: { ok: true, result: "done" } } as BusRequest);
    const lines = await reportLines(written);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bbbbbbbb");
    expect(lines[0]).not.toContain("aaaaaaaa");
  });
});
