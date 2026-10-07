import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The registry primitives that support background sessions: the per-card replay
 * RING and the retention flag that stops the UI unmount from terminating a
 * process that must stay alive.
 *
 * Same setup as `pty-registry-trace-events.test.ts`: `node-pty` mocked and the
 * output callback CAPTURED, to prove the points without a real process or
 * timing.
 */

let dataCb: ((data: string) => void) | null = null;

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return { ...actual, resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }) };
});

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: () => {},
    kill: () => {},
    resize: () => {},
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
  }),
}));

describe("pty-registry: o replay devolve o modo do terminal no corte do anel", () => {
  beforeEach(() => {
    dataCb = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(scrollbackMaxBytes: number) {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    return createPtyRegistry({
      onData: vi.fn(),
      onExit: vi.fn(),
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
      scrollbackMaxBytes,
    });
  }

  const ESC = "\u001b";

  it("a TUI entrou na tela alternativa e o corte levou a entrada: o replay começa por ela e pelos modos", async () => {
    const registry = await setup(200);
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    dataCb!(`${ESC}[?1049h${ESC}[?25l${ESC}[?1002h${ESC}[?1006h${ESC}[?2004h`);
    for (let i = 0; i < 40; i++) dataCb!(`${ESC}[${(i % 20) + 1};1HREPAINT${i}`);
    const replay = registry.getScrollback("card-1")!;
    expect(replay.startsWith(`${ESC}[?1049h`)).toBe(true);
    expect(replay).toContain(`${ESC}[?1002h`);
    expect(replay).toContain(`${ESC}[?2004h`);
    expect(replay).toContain(`${ESC}[?25l`);
    expect(replay).toContain("REPAINT39");
  });

  it("sem corte nada é acrescentado: o replay é exatamente os bytes recebidos", async () => {
    const registry = await setup(1_000_000);
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    dataCb!(`${ESC}[?1049h`);
    dataCb!("conteudo");
    expect(registry.getScrollback("card-1")).toBe(`${ESC}[?1049hconteudo`);
  });
});
