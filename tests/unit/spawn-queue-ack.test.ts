import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { SPAWN_QUEUE_ACK_MS } from "../../src/main/spawn-queue-ack-decision";
import { readBus } from "../helpers/bus-response";

/**
 * Acceptance: autonomous board at cap — spawn_agent returns queued+spawnId
 * under SPAWN_QUEUE_ACK_MS; get_spawn reaches up; idempotencyKey does not
 * duplicate.
 */

type Rig = {
  spawned: string[];
  state: { running: number; cap: number };
  nextCard: number;
};

describe("spawn_agent queue early ack", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function rig(opts: { running?: number; cap?: number } = {}): Rig {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-ack-"));
    const out: Rig = {
      spawned: [],
      state: { running: opts.running ?? 4, cap: opts.cap ?? 4 },
      nextCard: 1,
    };
    const overrides: Record<string, unknown> = {
      onSpawnAgentRequest: (requestId: string) => {
        out.spawned.push(requestId);
        const cardId = `card-${out.nextCard++}`;
        bus?.resolveSpawnAgent(requestId, { ok: true, cardId });
      },
      isCardAlive: () => true,
      getCardBoardId: () => "b1",
      isBoardAutonomous: () => true,
      getBoardOrchestratorCardId: () => "orch",
      boardExists: () => true,
      countRunningAgentsOnBoard: () => out.state.running,
      getBoardConcurrencyCap: () => out.state.cap,
      listCards: () => [],
      listAllConnectors: () => [],
      listSpawnsByParent: () => [],
      findSpawnByChild: () => undefined,
      recordSpawn: () => ({ id: "spawn-stub" }),
      deriveAutoConnectLabel: () => null,
      onAutoConnect: () => undefined,
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy({}, { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) }) as never,
    );
    return out;
  }

  const spawnCall = (key?: string): BusRequest =>
    ({
      cmd: "spawn_agent",
      provider: "claude",
      reason: "ack-test",
      requesterId: "orch",
      ...(key ? { idempotencyKey: key } : {}),
    }) as BusRequest;

  const flush = () => new Promise((r) => setTimeout(r, 15));

  it("4 simultaneous spawns at cap respond under ACK_MS with queued + spawnId", async () => {
    const out = rig({ running: 4, cap: 4 });
    const t0 = performance.now();
    const results = await Promise.all([
      bus!.handleRequest(spawnCall("k1")),
      bus!.handleRequest(spawnCall("k2")),
      bus!.handleRequest(spawnCall("k3")),
      bus!.handleRequest(spawnCall("k4")),
    ]);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(SPAWN_QUEUE_ACK_MS);
    expect(out.spawned).toHaveLength(0);
    for (const raw of results) {
      const res = raw as Record<string, unknown>;
      expect(res.ok).toBe(true);
      expect(res.queued).toBe(true);
      expect(typeof res.spawnId).toBe("string");
      expect(typeof res.position).toBe("number");
      expect(res.queueReasonCode).toBe("concurrency_cap");
      expect(String(res.queueReason)).toMatch(/concurrency cap/);
    }
    const ids = new Set(results.map((r) => (readBus<{ spawnId: string }>(r)).spawnId));
    expect(ids.size).toBe(4);
  });

  it("get_spawn reaches up with cardId after a slot frees", async () => {
    const out = rig({ running: 4, cap: 4 });
    const queued = (await bus!.handleRequest(spawnCall())) as {
      ok: boolean;
      queued?: boolean;
      spawnId: string;
    };
    expect(queued.queued).toBe(true);

    const mid = readBus<{
      status: string;
    }>(await bus!.handleRequest({ cmd: "get_spawn", spawnId: queued.spawnId }));
    expect(mid.status).toBe("queued");

    out.state.running = 3;
    bus!.notifyConcurrencyCapChanged("b1");
    await flush();

    const up = readBus<{
      status: string;
      cardId?: string;
    }>(await bus!.handleRequest({ cmd: "get_spawn", spawnId: queued.spawnId }));
    expect(up.status).toBe("up");
    expect(up.cardId).toMatch(/^card-/);
    expect(out.spawned).toHaveLength(1);
  });

  it("retry with the same idempotencyKey while queued returns the same spawnId (no second card)", async () => {
    const out = rig({ running: 4, cap: 4 });
    const first = readBus<{
      spawnId: string;
      queued?: boolean;
    }>(await bus!.handleRequest(spawnCall("same-key")));
    const retry = readBus<{
      spawnId: string;
      idempotentReplay?: boolean;
      queued?: boolean;
    }>(await bus!.handleRequest(spawnCall("same-key")));
    expect(first.queued).toBe(true);
    expect(retry.spawnId).toBe(first.spawnId);
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.queued).toBe(true);

    out.state.running = 3;
    bus!.notifyConcurrencyCapChanged("b1");
    await flush();
    expect(out.spawned).toHaveLength(1);

    const afterUp = (await bus!.handleRequest(spawnCall("same-key"))) as {
      cardId?: string;
      idempotentReplay?: boolean;
      queued?: boolean;
    };
    expect(afterUp.idempotentReplay).toBe(true);
    expect(afterUp.queued).toBeUndefined();
    expect(afterUp.cardId).toMatch(/^card-/);
    expect(out.spawned).toHaveLength(1);
  });
});
