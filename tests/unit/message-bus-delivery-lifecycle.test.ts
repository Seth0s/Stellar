/**
 * Bus-real gate for delivery lifecycle (2026-09-14 live incident):
 * origin enqueues N sends to destination; origin exits → pending cancel;
 * in-flight (started) survives; system pointer without requesterId survives;
 * rate ceiling refuses a loop. Does NOT touch card 330 or any live human PTY —
 * doubles write to an in-memory list and assert on get_delivery / list_deliveries.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { ORIGIN_DELIVERY_RATE_LIMIT } from "../../src/main/delivery-lifecycle-decision";

type DeliveryStatus = {
  ok: boolean;
  delivery?: string;
  id?: string;
  error?: string;
  cancelledIds?: string[];
  deliveries?: Array<{ id: string; delivery: string; requesterId?: string; started?: boolean }>;
};

describe("message-bus: lifecycle da fila quando a origem morre", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function boot(opts: {
    writes: string[];
    /** When set, beginCardDelivery returns false until released — holds in-flight as started. */
    holdDelivery?: { released: () => boolean };
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-delivery-lifecycle-"));
    const readySince = Date.now() - 1_000;
    let lastActivity = readySince;
    // Plain object (not Proxy): deliverCard uses hasOwnProperty for
    // beginCardDelivery / writeToCardWithOrigin — Proxy empty-target lies.
    const overrides: Record<string, (...args: never[]) => unknown> = {
      listCards: (() => [
        { id: "origin", kind: "terminal", provider: "cursor", cwd: "", label: null, displayName: "Origin" },
        { id: "dest", kind: "terminal", provider: "codex", cwd: "", label: null, displayName: "Dest" },
        { id: "spawner", kind: "terminal", provider: "claude", cwd: "", label: null, displayName: "Spawner" },
      ]) as never,
      writeToCard: ((_id: string, text: string) => {
        opts.writes.push(text);
        lastActivity = Math.max(Date.now(), lastActivity + 1);
      }) as never,
      writeToCardWithOrigin: ((_id: string, text: string) => {
        opts.writes.push(text);
        lastActivity = Math.max(Date.now(), lastActivity + 1);
      }) as never,
      beginCardDelivery: (() => {
        if (opts.holdDelivery && !opts.holdDelivery.released()) return false;
        return true;
      }) as never,
      endCardDelivery: () => undefined,
      isCardAlive: () => true,
      getCardLastActivityAt: (() => lastActivity) as never,
      getCardWriteReadiness: (() => ({
        spawnedAtMs: readySince,
        hasReceivedData: true,
        lastActivityAtMs: readySince,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      })) as never,
      onReadCardRequest: ((requestId: string) => {
        const body = [...opts.writes].reverse().find((w) => w !== "\r" && !w.includes("\u0015"));
        bus?.resolveReadCard(requestId, { ok: true, text: body ? `> ${body}` : "> " });
      }) as never,
      onAutoConnect: () => undefined,
      nextReportSeqSeed: (() => 0) as never,
      describeCardLabel: ((id: string) => id) as never,
      getCardBoardId: (() => "board") as never,
      listTasks: (() => []) as never,
      getReport: (() => null) as never,
      listTaskCardsForCard: (() => []) as never,
      getAnyCard: () => undefined,
    };
    const callbacks = new Proxy(overrides, {
      get: (target, prop: string) => target[prop] ?? (() => undefined),
      has: (target, prop: string) => prop in target,
    }) as Parameters<typeof createMessageBus>[1];

    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return bus;
  }

  it("A enfileira N para B; resolveCardExit(A) cancela as que ainda não começaram a escrever", async () => {
    const writes: string[] = [];
    let released = false;
    const b = boot({ writes, holdDelivery: { released: () => released } });

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = (await b.handleRequest({
        cmd: "send",
        target: "dest",
        text: `probe-${i}`,
        requesterId: "origin",
        steer: false,
      } as BusRequest)) as DeliveryStatus;
      expect(res.ok).toBe(true);
      expect(res.id).toBeTruthy();
      ids.push(res.id!);
    }

    for (let i = 0; i < 50; i++) {
      const listed = (await b.handleRequest({
        cmd: "list_deliveries",
        requesterId: "origin",
        delivery: "queued",
      } as BusRequest)) as DeliveryStatus;
      if (listed.deliveries?.some((d) => d.id === ids[0] && d.started)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    b.resolveCardExit("origin", 0);

    const after = (await b.handleRequest({
      cmd: "list_deliveries",
      requesterId: "origin",
    } as BusRequest)) as DeliveryStatus;
    const byId = new Map(after.deliveries?.map((d) => [d.id, d]) ?? []);
    expect(byId.get(ids[0]!)?.started).toBe(true);
    expect(byId.get(ids[0]!)?.delivery).toBe("queued");
    for (const id of ids.slice(1)) {
      expect(byId.get(id)?.delivery).toBe("cancelled");
    }

    released = true;
    // Confirm-loop verdict depends on screen doubles; the lifecycle gate is
    // that cancelled probes never type. Wait until the in-flight item leaves queued.
    const deadline = Date.now() + 4000;
    for (;;) {
      const st = (await b.handleRequest({ cmd: "get_delivery", id: ids[0]! } as BusRequest)) as DeliveryStatus;
      if (st.delivery !== "queued") break;
      if (Date.now() >= deadline) throw new Error("in-flight delivery never left queued");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(writes.some((w) => w.includes("probe-0"))).toBe(true);
    expect(writes.some((w) => w.includes("probe-1"))).toBe(false);
    expect(writes.some((w) => w.includes("probe-2"))).toBe(false);
    expect(writes.some((w) => w.includes("probe-3"))).toBe(false);
  });

  it("ponteiro de sistema (sem requesterId) sobrevive ao exit do autor", async () => {
    const writes: string[] = [];
    let released = false;
    const b = boot({ writes, holdDelivery: { released: () => released } });

    const blocker = (await b.handleRequest({
      cmd: "send",
      target: "dest",
      text: "blocker",
      requesterId: "origin",
      steer: false,
    } as BusRequest)) as DeliveryStatus;

    for (let i = 0; i < 50; i++) {
      const listed = (await b.handleRequest({
        cmd: "list_deliveries",
        target: "dest",
        delivery: "queued",
      } as BusRequest)) as DeliveryStatus;
      if (listed.deliveries?.some((d) => d.id === blocker.id && d.started)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const sys = (await b.handleRequest({
      cmd: "send",
      target: "dest",
      text: "system-pointer",
      steer: false,
    } as BusRequest)) as DeliveryStatus;
    expect(sys.ok).toBe(true);

    b.resolveCardExit("origin", 0);

    const sysAfter = (await b.handleRequest({ cmd: "get_delivery", id: sys.id } as BusRequest)) as DeliveryStatus;
    expect(sysAfter.delivery).toBe("queued");

    released = true;
    const deadline = Date.now() + 4000;
    for (;;) {
      const a = (await b.handleRequest({ cmd: "get_delivery", id: blocker.id! } as BusRequest)) as DeliveryStatus;
      const c = (await b.handleRequest({ cmd: "get_delivery", id: sys.id! } as BusRequest)) as DeliveryStatus;
      if (a.delivery !== "queued" && c.delivery !== "queued") break;
      if (Date.now() >= deadline) throw new Error(`blocker=${a.delivery} sys=${c.delivery}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(writes.some((w) => w.includes("system-pointer"))).toBe(true);
    expect(writes.some((w) => w.includes("blocker"))).toBe(true);
  });

  it("teto por origem×destino recusa o laço com erro visível", async () => {
    const writes: string[] = [];
    const b = boot({ writes });
    for (let i = 0; i < ORIGIN_DELIVERY_RATE_LIMIT.max; i++) {
      const res = (await b.handleRequest({
        cmd: "send",
        target: "dest",
        text: `burst-${i}`,
        requesterId: "origin",
        steer: false,
      } as BusRequest)) as DeliveryStatus;
      expect(res.ok).toBe(true);
    }
    const refused = (await b.handleRequest({
      cmd: "send",
      target: "dest",
      text: "burst-over",
      requesterId: "origin",
      steer: false,
    } as BusRequest)) as DeliveryStatus;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/rate limit/);

    const other = (await b.handleRequest({
      cmd: "send",
      target: "spawner",
      text: "other-target",
      requesterId: "origin",
      steer: false,
    } as BusRequest)) as DeliveryStatus;
    expect(other.ok).toBe(true);

    const cancel = (await b.handleRequest({
      cmd: "cancel_deliveries",
      requesterId: "origin",
    } as BusRequest)) as DeliveryStatus;
    expect(cancel.ok).toBe(true);
    expect((cancel.cancelledIds ?? []).length).toBeGreaterThan(0);
  });
});
