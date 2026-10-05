import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * End-to-end of the filter: the environment the registry actually hands to
 * `pty.spawn` must be free of the parent app's identity and still carry every
 * `AGENT_CANVAS_*` key the CLIs rely on.
 */

let capturedEnv: Record<string, string> | null = null;

vi.mock("../../src/main/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/providers")>();
  return { ...actual, resolveSpawn: () => ({ binary: "/bin/true", args: [] as string[] }) };
});

vi.mock("node-pty", () => ({
  spawn: (_bin: string, _args: string[], opts: { env: Record<string, string> }) => {
    capturedEnv = opts.env;
    return {
      write: () => {},
      kill: () => {},
      resize: () => {},
      pid: 4242,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
    };
  },
}));

const POLLUTED: Record<string, string> = {
  CHROME_DESKTOP: "stellar.desktop",
  ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME",
  GIO_LAUNCHED_DESKTOP_FILE: "/usr/share/applications/stellar.desktop",
  GIO_LAUNCHED_DESKTOP_FILE_PID: "6218",
  DESKTOP_STARTUP_ID: "stellar-123_TIME99",
  XDG_ACTIVATION_TOKEN: "token-abc",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
};

describe("pty-registry: o ambiente montado para o PTY", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    capturedEnv = null;
    for (const key of [...Object.keys(POLLUTED), "MY_HOST_VAR", "AGENT_CANVAS_CARD_ID"]) {
      saved[key] = process.env[key];
    }
    Object.assign(process.env, POLLUTED);
    process.env.MY_HOST_VAR = "keep-me";
    // A foreign AGENT_CANVAS_CARD_ID from whatever launched Stellar must not
    // survive: the card's own id is stamped explicitly.
    process.env.AGENT_CANVAS_CARD_ID = "someone-elses-card";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  async function spawnWith(id: string) {
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
    });
    registry.spawn(id, "bash", "/tmp/projeto", 80, 24);
    return capturedEnv!;
  }

  it("não tem CHROME_DESKTOP (o smoke isolado prova o mesmo ao vivo)", async () => {
    const env = await spawnWith("card-env-1");
    expect(env.CHROME_DESKTOP).toBeUndefined();
  });

  it("não tem identidade de launcher nem internos do Electron", async () => {
    const env = await spawnWith("card-env-2");
    for (const key of Object.keys(POLLUTED)) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("preserva o resto do ambiente (PATH, HOME, variável do host)", async () => {
    const env = await spawnWith("card-env-3");
    expect(env.MY_HOST_VAR).toBe("keep-me");
    expect(typeof env.PATH).toBe("string");
  });

  it("AGENT_CANVAS_* continua, e o CARD_ID é o DESTE card", async () => {
    const env = await spawnWith("card-env-4");
    expect(env.AGENT_CANVAS_CARD_ID).toBe("card-env-4");
    expect(env.AGENT_CANVAS_SOCK).toBe("/tmp/fake.sock");
    expect(typeof env.AGENT_CANVAS_NODE).toBe("string");
    expect(env.AGENT_CANVAS_MCP_URL).toBe("http://127.0.0.1:0");
  });
});
