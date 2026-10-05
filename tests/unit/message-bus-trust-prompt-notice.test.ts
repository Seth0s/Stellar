import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus } from "../../src/main/message-bus";

/**
 * The trust-prompt notice goes to the board orchestrator through the delivery
 * queue — the same path as the other notices. It waits for a human mid-line on
 * the orchestrator card instead of typing straight into its PTY (which would
 * merge the text and send the human's own line).
 */

describe("message-bus: trust-prompt notice respects the human input gate", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("waits while the human is mid-line on the orchestrator, then delivers", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-trust-notice-"));
    const written: Array<[string, string]> = [];
    let pendingHumanInput = true;
    const base: Record<string, (...args: never[]) => unknown> = {
      isCardAlive: (id: string) => id === "worker-1" || id === "orch-1",
      getCardBoardId: (id: string) => (id === "worker-1" || id === "orch-1" ? "b1" : null),
      getBoardOrchestratorCardId: (boardId: string) => (boardId === "b1" ? "orch-1" : null),
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
      beginCardDelivery: () => true,
      onReadCardRequest: ((requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" })) as never,
      getCardWriteReadiness: () => ({
        spawnedAtMs: Date.now() - 5_000,
        hasReceivedData: true,
        lastActivityAtMs: Date.now() - 500,
        hasPendingHumanInput: pendingHumanInput,
        inputLineLastAtMs: pendingHumanInput ? Date.now() : null,
      }),
      getCardLastActivityAt: () => Date.now() - 500,
      notifyCardInput: () => {},
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(base, { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) }) as Parameters<typeof createMessageBus>[1],
    );

    bus.notifyTrustPromptUnconfirmed("worker-1", "[de: stellar] trust prompt outside the board root — NOT confirmed");

    // The human is mid-line: nothing may be written yet.
    await new Promise((r) => setTimeout(r, 600));
    expect(written).toHaveLength(0);

    // The human finishes the line; now the notice is delivered.
    pendingHumanInput = false;
    const start = Date.now();
    while (written.length === 0 && Date.now() - start < 3_000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const notice = written.filter(([id, d]) => id === "orch-1" && d.includes("NOT confirmed"));
    expect(notice.length).toBeGreaterThan(0);
  });

  it("does nothing when there is no orchestrator to tell", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-trust-notice-"));
    const written: Array<[string, string]> = [];
    const base: Record<string, (...args: never[]) => unknown> = {
      isCardAlive: (id: string) => id === "worker-1",
      getCardBoardId: () => "b1",
      getBoardOrchestratorCardId: () => null,
      writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
      beginCardDelivery: () => true,
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(base, { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) }) as Parameters<typeof createMessageBus>[1],
    );
    bus.notifyTrustPromptUnconfirmed("worker-1", "[de: stellar] …");
    await new Promise((r) => setTimeout(r, 200));
    expect(written).toHaveLength(0);
  });
});
