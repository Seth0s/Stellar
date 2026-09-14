import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deriveTaskStatus } from "../../src/task-status-derive";

/**
 * Fila never showed "em andamento" — derived status is correct, but
 * nothing re-pushed `task:changed` when PTY liveness flipped
 * (measured 2026-09-14). Birth: `spawn_agent` writes `tasks.card_id` and
 * notifies BEFORE `pty:spawn` puts the id in the registry Map. Death:
 * `onExit` never notified. This file pins the registry's single
 * liveness edge (`onLivenessChanged`) and the derive rule the Fila
 * re-reads on that push — not a second copy of task-write detection.
 */

const fsHooks = vi.hoisted(() => ({
  readdirImpl: null as null | ((dir: string) => Promise<string[]>),
  statImpl: null as null | ((path: string) => Promise<{ mtimeMs: number }>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (dir: string) => fsHooks.readdirImpl!(dir),
    stat: (path: string) => fsHooks.statImpl!(path),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: () => true,
    statSync: () => ({ size: 999_999 }) as ReturnType<typeof import("node:fs").statSync>,
  };
});

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return {
    ...actual,
    resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }),
  };
});

type FakeProc = {
  write: (data: string) => void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (data: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose(): void };
  simulateExit: (exitCode?: number) => void;
};

const ptyHooks = vi.hoisted(() => ({
  spawned: [] as FakeProc[],
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    let exitHandler: ((e: { exitCode: number }) => void) | null = null;
    const proc: FakeProc = {
      write: () => {},
      kill: () => {},
      resize: () => {},
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        exitHandler = cb;
        return { dispose() {} };
      },
      simulateExit: (exitCode = 0) => {
        exitHandler?.({ exitCode });
      },
    };
    ptyHooks.spawned.push(proc);
    return proc;
  }),
}));

describe("task liveness invalidate — registry onLivenessChanged", () => {
  beforeEach(() => {
    ptyHooks.spawned.length = 0;
    fsHooks.readdirImpl = async () => [];
    fsHooks.statImpl = async () => ({ mtimeMs: Date.now() });
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function setup() {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const onLivenessChanged = vi.fn();
    const onExit = vi.fn();
    const registry = createPtyRegistry({
      onData: vi.fn(),
      onExit,
      onLivenessChanged,
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
    });
    return { registry, onLivenessChanged, onExit };
  }

  it("birth: Map adopt fires alive=true once — the Fila push that must flip pending→running after the early link notify", async () => {
    const { registry, onLivenessChanged } = await setup();
    // Reproduce the measured order: task row already linked, isAlive still false.
    expect(deriveTaskStatus("pending", false)).toBe("pending");
    expect(registry.isAlive("card-1")).toBe(false);

    const result = registry.spawn("card-1", "bash", "/tmp", 80, 24);
    expect("id" in result).toBe(true);
    expect(registry.isAlive("card-1")).toBe(true);
    expect(onLivenessChanged).toHaveBeenCalledTimes(1);
    expect(onLivenessChanged).toHaveBeenCalledWith("card-1", true);
    expect(deriveTaskStatus("pending", true)).toBe("running");
  });

  it("death: natural exit fires alive=false once — Fila returns to pending without a task-row write", async () => {
    const { registry, onLivenessChanged, onExit } = await setup();
    registry.spawn("card-1", "bash", "/tmp", 80, 24);
    onLivenessChanged.mockClear();

    ptyHooks.spawned[0]!.simulateExit(0);
    expect(registry.isAlive("card-1")).toBe(false);
    expect(onExit).toHaveBeenCalledWith("card-1", 0);
    expect(onLivenessChanged).toHaveBeenCalledTimes(1);
    expect(onLivenessChanged).toHaveBeenCalledWith("card-1", false);
    expect(deriveTaskStatus("pending", false)).toBe("pending");
  });

  it("kill(immediate) then real onExit: one dead edge, not two", async () => {
    const { registry, onLivenessChanged } = await setup();
    registry.spawn("card-1", "bash", "/tmp", 80, 24);
    onLivenessChanged.mockClear();

    registry.kill("card-1", { immediate: true });
    expect(registry.isAlive("card-1")).toBe(false);
    expect(onLivenessChanged).toHaveBeenCalledTimes(1);
    expect(onLivenessChanged).toHaveBeenCalledWith("card-1", false);

    onLivenessChanged.mockClear();
    ptyHooks.spawned[0]!.simulateExit(0);
    expect(onLivenessChanged).not.toHaveBeenCalled();
  });

  it("judgment wins: done stays done when the implementer dies — not a third status", () => {
    expect(deriveTaskStatus("done", false)).toBe("done");
    expect(deriveTaskStatus("failed", false)).toBe("failed");
  });
});
