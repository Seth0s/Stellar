import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRow } from "../../src/main/store";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";

/**
 * The main process must recognize a screen turn-end (providers without a hook,
 * commandcode among them). With the renderer as the only detector, a card whose
 * turn ended with no board mounted kept `turnEndedAt` null and the reservation
 * engine never fired. This drives the real pty-registry flush path with the
 * recorded marker and asserts the turn fact plus the reservation delivery,
 * without a renderer.
 */

const hoisted = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
}));

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    kill: () => {},
    resize: () => {},
    onData: (cb: (data: string) => void) => {
      hoisted.onData = cb;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
  }),
}));

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  const bash = actual.providerById("bash");
  // A "commandcode" provider that declares the real screen turn-end. The rest of
  // the capacity mirrors `bash` so the spawn path stays the simple one the other
  // pty-registry tests exercise.
  const commandcode =
    bash === undefined
      ? undefined
      : {
          ...bash,
          id: "commandcode",
          label: "CommandCode",
          capacity: {
            ...bash.capacity,
            delivery: {
              ...bash.capacity.delivery,
              turnEnd: { mechanism: "screen" as const, pattern: /Worked for (?:\d+h\s*)?(?:\d+m\s*)?\d+s/ },
            },
          },
        };
  return {
    ...actual,
    // No process is spawned; node-pty is mocked above.
    resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }),
    providerById: (id: string) => (id === "commandcode" && commandcode ? commandcode : actual.providerById(id)),
    // The spawn gate reads capacity through this, not through `providerById`.
    providerCapacity: (id: string) =>
      id === "commandcode" && commandcode ? commandcode.capacity : actual.providerCapacity(id),
  };
});

function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  } as unknown as TaskRow;
}

const RECORDED_TURN_END = "\u001b[38;5;60m\u273b Worked for 9m 51s\u001b[39m";

describe("pty-registry detects the screen turn-end in the main", () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.onData = null;
    dir = mkdtempSync(join(tmpdir(), "stellar-turn-end-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills turnEndedAt and fires onTurnEnd when the recorded marker arrives", async () => {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const onTurnEnd = vi.fn();
    const registry = createPtyRegistry({
      onData: vi.fn(),
      onExit: vi.fn(),
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      onTurnEnd,
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
    });

    const spawned = registry.spawn("cardA", "commandcode", dir, 80, 24);
    expect("id" in spawned).toBe(true);
    expect(registry.getTurnFacts("cardA")?.turnEndedAt ?? null).toBeNull();

    vi.setSystemTime(50_000);
    hoisted.onData?.(RECORDED_TURN_END);
    vi.advanceTimersByTime(32); // flush is debounced by COALESCE_MS

    const turnEndedAt = registry.getTurnFacts("cardA")?.turnEndedAt ?? null;
    expect(turnEndedAt).not.toBeNull();
    expect(turnEndedAt!).toBeGreaterThanOrEqual(50_000);
    expect(onTurnEnd).toHaveBeenCalledWith("cardA");
  });

  it("delivers a ready reservation once the turn ends, with no renderer and no other trigger", async () => {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const { createMessageBus } = await import("../../src/main/message-bus");

    const tasks = new Map<string, TaskRow>([["t2", baseTask("t2", { deps_json: null })]]);
    const activated: Array<[string, string]> = [];
    const writes: Array<{ target: string; text: string }> = [];
    let registry: ReturnType<typeof createPtyRegistry> | null = null;

    const callbacks = new Proxy(
      {
        listCards: () => [{ id: "cardA", kind: "terminal", provider: "commandcode", cwd: "", label: null, displayName: "A" }],
        describeCardLabel: (id: string) => id,
        writeToCard: (id: string, text: string) => writes.push({ target: id, text }),
        writeToCardWithOrigin: (id: string, text: string) => writes.push({ target: id, text }),
        beginCardDelivery: () => true,
        endCardDelivery: () => undefined,
        isCardAlive: () => true,
        getTask: (id: string) => tasks.get(id),
        listTasks: () => [...tasks.values()],
        upsertTask: (t: TaskRow) => applied(t.status),
        listReservationsForCard: (cardId: string) =>
          cardId === "cardA" ? [{ task_id: "t2", role: "implementer", reserved_order: 0, linked_at: 1 }] : [],
        listTaskCardsForCard: () => [],
        activateReservedTaskCard: (taskId: string, cardId: string) => {
          activated.push([taskId, cardId]);
          return 1;
        },
        linkTaskCard: () => 1,
        getCardTurnEndedAt: (id: string) => registry?.getTurnFacts(id)?.turnEndedAt ?? null,
        getCardLastWorkGrantedAt: (id: string) => registry?.getLastWorkGrantedAt(id) ?? null,
        getBoardOrchestratorCardId: () => null,
      },
      { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
    ) as Parameters<typeof createMessageBus>[1];

    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    registry = createPtyRegistry({
      onData: vi.fn(),
      onExit: vi.fn(),
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      onTurnEnd: (id) => bus.onTurnEnd(id),
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
    });
    try {
      // Spawn first (it grants work), then advance past it so the turn end is
      // genuinely newer than the last work granted.
      vi.setSystemTime(1_000);
      registry.spawn("cardA", "commandcode", dir, 80, 24);

      // The reservation is ready but the card is mid-turn (no turn end yet), so
      // nothing delivers it.
      expect(activated).toEqual([]);

      vi.setSystemTime(50_000);
      hoisted.onData?.(RECORDED_TURN_END);
      vi.advanceTimersByTime(32);

      expect(activated).toEqual([["t2", "cardA"]]);
    } finally {
      bus.close();
    }
  });
});
