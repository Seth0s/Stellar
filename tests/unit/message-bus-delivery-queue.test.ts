import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

describe("message-bus: entrega programática FIFO por card", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("não deixa a segunda entrega atravessar texto+Enter+confirmação da primeira", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-delivery-queue-"));
    const writes: string[] = [];
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    const callbacks = {
      listCards: () => [{ id: "target", kind: "terminal", provider: "codex", cwd: "", label: null, displayName: "Codex" }],
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
      }),
      onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];

    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    const first = (await bus.handleRequest({ cmd: "send", target: "target", text: "first" } as BusRequest)) as {
      id: string;
    };

    // Wait until the first text crossed the PTY, then queue another message
    // while the first one is still between Enter and confirmation.
    for (let i = 0; i < 20 && writes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual(["first"]);
    const second = (await bus.handleRequest({ cmd: "send", target: "target", text: "second" } as BusRequest)) as {
      id: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writes).toEqual(["first", "\r"]);

    const deadline = Date.now() + 2000;
    for (;;) {
      const a = (await bus.handleRequest({ cmd: "get_delivery", id: first.id } as BusRequest)) as { delivery?: string };
      const b = (await bus.handleRequest({ cmd: "get_delivery", id: second.id } as BusRequest)) as { delivery?: string };
      if (a.delivery === "delivered" && b.delivery === "delivered") break;
      if (Date.now() >= deadline) throw new Error("deliveries did not settle");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(writes).toEqual(["first", "\r", "second", "\r"]);
  });
});
