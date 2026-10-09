import { describe, it, expect } from "vitest";
import { PTY_IDENTITY_ENV_EXACT, PTY_IDENTITY_ENV_PREFIXES, isIdentityEnvKey } from "../../src/main/pty-env";

/**
 * The DECLARED policy of which inherited environment keys must not reach a PTY
 * child. Measured leak: a Brave opened by a card's `xdg-open`
 * inherited `CHROME_DESKTOP=stellar.desktop` and the desktop grouped it as
 * Stellar.
 */
describe("pty-env: the parent app's identity does not cross into a card", () => {
  it("drops CHROME_DESKTOP (the measured leak)", () => {
    expect(isIdentityEnvKey("CHROME_DESKTOP")).toBe(true);
  });

  it("drops the launcher/activation identity keys", () => {
    for (const key of [
      "ORIGINAL_XDG_CURRENT_DESKTOP",
      "GIO_LAUNCHED_DESKTOP_FILE",
      "GIO_LAUNCHED_DESKTOP_FILE_PID",
      "DESKTOP_STARTUP_ID",
      "XDG_ACTIVATION_TOKEN",
    ]) {
      expect(isIdentityEnvKey(key), key).toBe(true);
    }
  });

  it("drops ELECTRON_* (Electron runtime internals)", () => {
    expect(isIdentityEnvKey("ELECTRON_RUN_AS_NODE")).toBe(true);
    expect(isIdentityEnvKey("ELECTRON_RENDERER_URL")).toBe(true);
    expect(PTY_IDENTITY_ENV_PREFIXES).toContain("ELECTRON_");
  });

  it("strips inherited card/auth identity keys so a parent cannot forge the child's label", () => {
    for (const key of ["AGENT_CANVAS_CARD_ID", "AGENT_CANVAS_AUTH_TOKEN", "AGENT_CANVAS_MCP_APP_TOKEN"]) {
      expect(isIdentityEnvKey(key), key).toBe(true);
    }
  });

  it("keeps everything else: other AGENT_CANVAS_*, PATH, desktop description", () => {
    for (const key of [
      "AGENT_CANVAS_NODE",
      "AGENT_CANVAS_MCP_URL",
      "PATH",
      "HOME",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_TYPE",
      "DESKTOP_SESSION",
    ]) {
      expect(isIdentityEnvKey(key), key).toBe(false);
    }
  });

  it("the declared list is the source of truth, not a hidden branch", () => {
    // Every exact key the function accepts is in the declared array — adding a
    // case to the function without declaring it here would fail this.
    for (const key of PTY_IDENTITY_ENV_EXACT) {
      expect(isIdentityEnvKey(key), key).toBe(true);
    }
  });
});
