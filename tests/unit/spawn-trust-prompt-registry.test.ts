import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The trust-prompt actuator through the registry: a recorded screen is fed to a
 * spawned card and the registry decides — answering the dialog when the card is
 * inside its board's declared root and the provider declares a confirm input,
 * leaving it for a human and reporting otherwise. `node-pty` is mocked (no real
 * process) and the data callback is captured so the screen is fed by hand.
 */

let dataCb: ((data: string) => void) | null = null;
const writes: string[] = [];

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return { ...actual, resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }) };
});

vi.mock("node-pty", () => ({
  spawn: () => ({
    write: (data: string) => {
      writes.push(data);
    },
    kill: () => {},
    resize: () => {},
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
  }),
}));

const ANTIGRAVITY_PROMPT = ["Antigravity", "", "Do you trust the contents of this project?", "  Yes, I trust this folder", "  No, exit"].join("\n");

describe("pty-registry: the trust prompt is answered inside the root, reported outside", () => {
  beforeEach(() => {
    dataCb = null;
    writes.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(root: string | null) {
    const { createPtyRegistry } = await import("../../src/main/pty-registry");
    const unconfirmed: { id: string; providerId: string; message: string }[] = [];
    const registry = createPtyRegistry({
      onData: vi.fn(),
      onExit: vi.fn(),
      onSessionFound: vi.fn(),
      onResumeInvalid: vi.fn(),
      onUrlSeen: vi.fn(),
      sockPath: "/tmp/fake.sock",
      binDir: "/tmp/fake-bin",
      mcpUrl: "http://127.0.0.1:0",
      resolveTrustPromptRoot: () => root,
      onTrustPromptUnconfirmed: (id, providerId, message) => unconfirmed.push({ id, providerId, message }),
    });
    return { registry, unconfirmed };
  }

  it("antigravity inside the declared root: the recorded screen makes the registry confirm (writes the declared input)", async () => {
    const { registry, unconfirmed } = await setup("/board");
    registry.spawn("card-1", "antigravity", "/board/sub", 80, 24);
    dataCb!(ANTIGRAVITY_PROMPT);
    vi.advanceTimersByTime(1_000);
    expect(writes).toEqual(["\r"]);
    expect(unconfirmed).toHaveLength(0);
  });

  it("antigravity outside the root: nothing is written and the orchestrator is warned", async () => {
    const { registry, unconfirmed } = await setup("/board");
    registry.spawn("card-1", "antigravity", "/elsewhere", 80, 24);
    dataCb!(ANTIGRAVITY_PROMPT);
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(0);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]).toMatchObject({ id: "card-1", providerId: "antigravity" });
    expect(unconfirmed[0].message).toContain("unconfirmed");
  });

  it("a provider that declares no confirm input is never answered, even inside the root", async () => {
    const { registry, unconfirmed } = await setup("/board");
    registry.spawn("card-1", "claude", "/board/sub", 80, 24);
    dataCb!("Quick safety check: Is this a project you created or one you trust?");
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(0);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0].providerId).toBe("claude");
  });

  it("no dialog on screen writes nothing and warns nobody", async () => {
    const { registry, unconfirmed } = await setup("/board");
    registry.spawn("card-1", "antigravity", "/board/sub", 80, 24);
    dataCb!("lucas@fedora:/board/sub$ ");
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(0);
    expect(unconfirmed).toHaveLength(0);
  });
});
