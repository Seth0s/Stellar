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

describe("pty-registry: anel de replay + retenção (sessão de fundo)", () => {
  beforeEach(() => {
    dataCb = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(scrollbackMaxBytes?: number) {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const registry = createPtyRegistry({
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
    return registry;
  }

  it("guarda a saída crua e devolve para replay; `null` sem entrada viva", async () => {
    const registry = await setup();
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    expect(registry.getScrollback("card-1")).toBe("");
    expect(registry.getScrollback("nope")).toBeNull();
    dataCb!("linha um\nlinha dois\n");
    expect(registry.getScrollback("card-1")).toBe("linha um\nlinha dois\n");
  });

  it("respeita o teto em bytes: só o histórico recente sobrevive", async () => {
    const registry = await setup(8);
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    dataCb!("aaaa");
    dataCb!("bbbb");
    dataCb!("cccc");
    expect(registry.getScrollback("card-1")).toBe("bbbbcccc");
  });

  it("retido × não retido é um fato por card, limpo no spawn", async () => {
    const registry = await setup();
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    expect(registry.isRetained("card-1")).toBe(false);
    registry.setRetained("card-1", true);
    expect(registry.isRetained("card-1")).toBe(true);
    registry.setRetained("card-1", false);
    expect(registry.isRetained("card-1")).toBe(false);
    // Card with no live entry: never "retained", and marking it does not
    // invent an entry.
    registry.setRetained("ghost", true);
    expect(registry.isRetained("ghost")).toBe(false);
  });

  it("`isAwaitingHuman` é vazio sem ninguém esperando; liga numa linha de input aberta", async () => {
    const registry = await setup();
    registry.spawn("card-1", "bash", "/tmp/projeto", 80, 24);
    expect(registry.isAwaitingHuman("card-1")).toBe(false);
    // Without Enter: the human started typing and stopped — "waiting on you".
    registry.write("card-1", "pergunta sem enter", "human");
    expect(registry.isAwaitingHuman("card-1")).toBe(true);
    // Enter closes the line: it is no longer waiting.
    registry.write("card-1", "\r", "human");
    expect(registry.isAwaitingHuman("card-1")).toBe(false);
  });
});
