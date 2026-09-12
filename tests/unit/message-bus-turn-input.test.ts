import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { composerClearSequence } from "../../src/main/type-and-submit-decision";

/**
 * 1fcd36b limit: send_to_card writes from main, outside the renderer
 * hook. The bus must notify once on the delivery BODY so the activity
 * bar opens the same turn window as a keystroke. Echo is `"data"` on
 * the renderer side (not a write). Retry Enter and composer clear
 * share writeDelivery but must not notify again.
 */
describe("message-bus: send_to_card abre o turno uma vez", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeBus(opts: {
    screenAfterWrite: string | ((attempt: number) => string);
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-turn-input-"));
    const writes: string[] = [];
    const inputs: string[] = [];
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    let confirmAttempt = 0;
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
      }),
      notifyCardInput: (id: string) => inputs.push(id),
      onReadCardRequest: (requestId: string) => {
        const text =
          typeof opts.screenAfterWrite === "function"
            ? opts.screenAfterWrite(confirmAttempt++)
            : opts.screenAfterWrite;
        bus?.resolveReadCard(requestId, { ok: true, text });
      },
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];

    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { writes, inputs };
  }

  it("entrega por send_to_card avisa uma vez no corpo, não no Enter", async () => {
    const { writes, inputs } = makeBus({ screenAfterWrite: "Working" });
    await bus!.handleRequest({ cmd: "send", target: "target", text: "brief the worker" } as BusRequest);
    expect(writes[0]).toBe("brief the worker");
    expect(writes).toContain("\r");
    expect(inputs).toEqual(["target"]);
  });

  it("Enter de retentativa e limpeza do composer não avisam de novo", async () => {
    const brief = "brief the worker";
    const { writes, inputs } = makeBus({
      // Needle still in the composer every confirm → unsent → retry Enter,
      // then give-up composer clear. Same class as leftover chrome after
      // turn_complete: must not count as a new turn.
      screenAfterWrite: brief,
    });
    await bus!.handleRequest({ cmd: "send", target: "target", text: brief } as BusRequest);
    expect(writes[0]).toBe(brief);
    expect(writes.filter((w) => w === "\r").length).toBeGreaterThan(1);
    expect(writes.at(-1)).toBe(composerClearSequence());
    expect(inputs).toEqual(["target"]);
  });
});
