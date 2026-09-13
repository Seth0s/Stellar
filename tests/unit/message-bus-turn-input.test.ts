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

  it("despejo de entrada humana adiada avisa o turno, como a tecla avisaria", async () => {
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
      endCardDelivery: () => ({ flushedHumanInput: true }),
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
        bus?.resolveReadCard(requestId, { ok: true, text: confirmAttempt++ === 0 ? "Working" : "Working" });
      },
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];

    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    await bus.handleRequest({ cmd: "send", target: "target", text: "brief the worker" } as BusRequest);
    // Body opens the delivered turn; flushed keys open THEIRS. Two
    // notices, not one — the flush is not chrome of the body.
    expect(inputs).toEqual(["target", "target"]);
    expect(writes[0]).toBe("brief the worker");
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

  it("regressão: message-bus PASSA o padrão do provider para decidir se começou", async () => {
    const brief = "brief the worker";
    // O texto da tela contém O NEEDLE VISÍVEL e a palavra afirmativa "Working".
    // - Sem o submitStartedPattern de Claude (a regressão), decideSubmitCheck vê o
    //   needle, não acha submit-started, deduz que o chip está travado, devolve
    //   "unsent" e o bus aperta Enter 4 vezes.
    // - Com o pattern de Claude ("Working"), ele devolve "sent" imediatamente,
    //   mesmo o needle estando lá (é eco do histórico), e para no 1º Enter.
    const { writes } = makeBus({
      screenAfterWrite: (attempt) => attempt === 0 ? "" : `→ ${brief}\n  Working`,
    });
    await bus!.handleRequest({ cmd: "send", target: "target", text: brief } as BusRequest);

    const enters = writes.filter((w) => w === "\r").length;
    // Se o chamador não passar o padrão do provider Claude, enters seria > 1 (retry loop) e falharia.
    expect(enters).toBe(1);
  });
});
