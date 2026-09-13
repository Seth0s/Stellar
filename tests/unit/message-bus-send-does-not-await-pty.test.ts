import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Live incident 2026-09-13: `send_to_card` awaited `typeAndSubmit`, so a
 * busy target (human-input gate up to 30s, or write-readiness up to 8s)
 * sat inside the MCP RPC. The client timed out, the agent retried, and
 * the same text was typed twice. Same class as `report` (f073f59 /
 * 6239269) — the tool's job is to enqueue, not to sit at human rhythm.
 *
 * The PTY double is the one f073f59 already used as a control: never
 * ready, never answers a screen read. Before this fix, `send` could not
 * return before `SEND_MUST_RETURN_MS`. That hang was confirmed by running
 * the report test's control case on the pre-fix tree. After the fix,
 * `send` returns a queued receipt and `get_delivery` is how the caller
 * learns the FIFO item settled.
 */

const SEND_MUST_RETURN_MS = 250;

type SendReceipt = {
  ok: boolean;
  delivery?: "queued" | "delivered";
  reason?: "human-input" | "card-busy";
  id?: string;
  error?: string;
};

type DeliveryStatus = SendReceipt & { target?: string };

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

describe("message-bus: send não espera PTY (regressão do timeout MCP)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let hangDelivery = true;

  afterEach(async () => {
    hangDelivery = false;
    await delay(50);
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(opts: {
    hangDelivery: boolean;
    humanInput?: boolean;
    hasReceivedData?: boolean;
    quiet?: boolean;
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-send-pty-"));
    hangDelivery = opts.hangDelivery;
    const spawnedAtMs = opts.quiet === false ? Date.now() : Date.now() - 1_000;
    const writes: string[] = [];
    let lastActivity = spawnedAtMs;
    const callbacks = {
      listCards: () => [{ id: "target-1", kind: "terminal", provider: "claude" }],
      isCardAlive: () => true,
      describeCardLabel: (id: string) => id,
      getCardWriteReadiness: () => ({
        spawnedAtMs,
        hasReceivedData: opts.hasReceivedData ?? true,
        lastActivityAtMs: spawnedAtMs,
        hasPendingHumanInput: opts.humanInput === true,
        inputLineLastAtMs: opts.humanInput === true ? Date.now() : null,
      }),
      getCardLastActivityAt: () => lastActivity,
      onReadCardRequest: (requestId: string) => {
        if (!hangDelivery) bus?.resolveReadCard(requestId, { ok: true, text: "Working" });
      },
      writeToCard: () => undefined,
      writeToCardWithOrigin: (_id: string, text: string) => {
        writes.push(text);
        lastActivity = Math.max(Date.now(), lastActivity + 1);
      },
      beginCardDelivery: () => !hangDelivery,
      endCardDelivery: () => undefined,
      nextReportSeqSeed: () => 0,
    } as unknown as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, writes };
  }

  async function waitForDelivery(b: NonNullable<typeof bus>, id: string, ms = 2000): Promise<DeliveryStatus> {
    const deadline = Date.now() + ms;
    for (;;) {
      const status = (await b.handleRequest({ cmd: "get_delivery", id } as BusRequest)) as DeliveryStatus;
      if (status.delivery === "delivered") return status;
      if (Date.now() >= deadline) return status;
      await delay(20);
    }
  }

  it("PTY ocupado (humano digitando): send devolve queued na hora; get_delivery consulta depois", async () => {
    const { bus: b, writes } = makeBus({ hangDelivery: true, humanInput: true });

    const sendRes = await firstOf(
      b.handleRequest({ cmd: "send", target: "target-1", text: "hello" } as BusRequest) as Promise<SendReceipt>,
      SEND_MUST_RETURN_MS,
    );

    expect(sendRes).not.toBe("timeout");
    if (sendRes === "timeout") return;
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivery).toBe("queued");
    expect(sendRes.reason).toBe("human-input");
    expect(typeof sendRes.id).toBe("string");
    expect(writes).toEqual([]);

    const peeked = (await b.handleRequest({ cmd: "get_delivery", id: sendRes.id } as BusRequest)) as DeliveryStatus;
    expect(peeked.ok).toBe(true);
    expect(peeked.delivery).toBe("queued");
    expect(peeked.reason).toBe("human-input");
    expect(peeked.target).toBe("target-1");
    expect(peeked.id).toBe(sendRes.id);
  });

  it("PTY ainda subindo (sem tecla humana): reason é card-busy, não human-input", async () => {
    const { bus: b } = makeBus({
      hangDelivery: true,
      humanInput: false,
      hasReceivedData: false,
      quiet: false,
    });

    const sendRes = await firstOf(
      b.handleRequest({ cmd: "send", target: "target-1", text: "hello" } as BusRequest) as Promise<SendReceipt>,
      SEND_MUST_RETURN_MS,
    );

    expect(sendRes).not.toBe("timeout");
    if (sendRes === "timeout") return;
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivery).toBe("queued");
    expect(sendRes.reason).toBe("card-busy");
  });

  it("card pronto: send ainda devolve queued; get_delivery vira delivered depois da digitação", async () => {
    const { bus: b, writes } = makeBus({ hangDelivery: false });

    const sendRes = await firstOf(
      b.handleRequest({ cmd: "send", target: "target-1", text: "hello" } as BusRequest) as Promise<SendReceipt>,
      SEND_MUST_RETURN_MS,
    );

    expect(sendRes).not.toBe("timeout");
    if (sendRes === "timeout") return;
    expect(sendRes.ok).toBe(true);
    expect(sendRes.delivery).toBe("queued");
    expect(sendRes.reason).toBeUndefined();
    expect(typeof sendRes.id).toBe("string");

    const settled = await waitForDelivery(b, sendRes.id!);
    expect(settled.delivery).toBe("delivered");
    expect(settled.reason).toBeUndefined();
    expect(writes[0]).toBe("hello");
    expect(writes).toContain("\r");
  });

  it("segunda entrega na mesma fila: reason card-busy, FIFO não atropela", async () => {
    const { bus: b, writes } = makeBus({ hangDelivery: true, humanInput: false });

    const first = await firstOf(
      b.handleRequest({ cmd: "send", target: "target-1", text: "first" } as BusRequest) as Promise<SendReceipt>,
      SEND_MUST_RETURN_MS,
    );
    expect(first).not.toBe("timeout");
    if (first === "timeout") return;
    expect(first.delivery).toBe("queued");

    const second = await firstOf(
      b.handleRequest({ cmd: "send", target: "target-1", text: "second" } as BusRequest) as Promise<SendReceipt>,
      SEND_MUST_RETURN_MS,
    );
    expect(second).not.toBe("timeout");
    if (second === "timeout") return;
    expect(second.delivery).toBe("queued");
    expect(second.reason).toBe("card-busy");
    expect(second.id).not.toBe(first.id);
    expect(writes).toEqual([]);

    hangDelivery = false;
    const settledSecond = await waitForDelivery(b, second.id!, 3000);
    expect(settledSecond.delivery).toBe("delivered");
    expect(writes.filter((w) => w === "first" || w === "second")).toEqual(["first", "second"]);
  });

  it("get_delivery de id desconhecido recusa", async () => {
    const { bus: b } = makeBus({ hangDelivery: false });
    const res = (await b.handleRequest({ cmd: "get_delivery", id: "no-such" } as BusRequest)) as SendReceipt;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no-such");
  });
});
