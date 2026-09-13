import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Rodada 4 (`49ae26b7`) — `deliverCard` must consult DECSET 2004 state
 * before wrapping. Measured: blind CSI 200~/201~ is echoed as text by any
 * peer that never asked (`cat` PTY).
 */
describe("message-bus: bracketed paste só com DECSET 2004h", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeBus(bracketedPasteMode: boolean) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-bracketed-"));
    const writes: string[] = [];
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    const callbacks = {
      listCards: () => [{ id: "target", kind: "terminal", provider: "claude", cwd: "", label: null, displayName: "Claude" }],
      writeToCard: () => undefined,
      writeToCardWithOrigin: (_id: string, text: string) => {
        writes.push(text);
        lastActivity = Math.max(Date.now(), lastActivity + 1);
      },
      beginCardDelivery: () => true,
      endCardDelivery: () => undefined,
      isCardAlive: () => true,
      getCardLastActivityAt: () => lastActivity,
      getCardWriteReadiness: () => ({
        spawnedAtMs: readySince,
        hasReceivedData: true,
        lastActivityAtMs: readySince,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
        bracketedPasteMode,
      }),
      onReadCardRequest: (requestId: string) =>
        bus?.resolveReadCard(requestId, {
          ok: true,
          // Needle gone + activity → "sent" on first confirm (no Extra Enter).
          text: "Working",
        }),
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];

    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { writes };
  }

  async function waitForDelivery(id: string) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const status = (await bus!.handleRequest({ cmd: "get_delivery", id } as BusRequest)) as { delivery?: string };
      if (status.delivery === "delivered") return;
      if (Date.now() >= deadline) throw new Error("delivery did not settle");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("multi-linha SEM 2004h → bytes crus (sem CSI 200~)", async () => {
    const { writes } = makeBus(false);
    const text = "line1\nline2\nline3 briefing";
    const sent = (await bus!.handleRequest({ cmd: "send", target: "target", text } as BusRequest)) as { id: string };
    await waitForDelivery(sent.id);
    expect(writes[0]).toBe(text);
    expect(writes[0]!.startsWith("\x1b[200~")).toBe(false);
  });

  it("multi-linha COM 2004h → envelopa bracketed paste", async () => {
    const { writes } = makeBus(true);
    const text = "line1\nline2\nline3 briefing";
    const sent = (await bus!.handleRequest({ cmd: "send", target: "target", text } as BusRequest)) as { id: string };
    await waitForDelivery(sent.id);
    expect(writes[0]).toBe(`\x1b[200~${text}\x1b[201~`);
  });
});
