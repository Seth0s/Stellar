import { describe, expect, it } from "vitest";
import {
  decideTrustPromptAction,
  describeTrustPromptOutsideRootWarning,
  screenShowsTrustPrompt,
} from "../../src/main/spawn-trust-prompt-decision";

/**
 * The provider trust prompt (antigravity here). A newly spawned card stops on
 * "Do you trust the contents of this project?" before reading its brief. The
 * rule: inside the board's declared root the app confirms; outside it (or with
 * no root) it warns the orchestrator and never confirms. The pattern and the
 * confirm input are declared by the provider, passed in as facts.
 */

// The declared pattern plus a recorded screen that shows the dialog.
const TRUST_PATTERN = /Do you trust the contents of this project\?/;
const RECORDED_SCREEN = [
  "Antigravity",
  "",
  "Do you trust the contents of this project?",
  "  Yes, I trust this folder",
  "  No, exit",
].join("\n");

describe("screenShowsTrustPrompt", () => {
  it("casa a tela GRAVADA com o padrão declarado", () => {
    expect(screenShowsTrustPrompt(RECORDED_SCREEN, TRUST_PATTERN)).toBe(true);
  });

  it("padrão ausente / tela vazia → false (nunca um palpite)", () => {
    expect(screenShowsTrustPrompt(RECORDED_SCREEN, null)).toBe(false);
    expect(screenShowsTrustPrompt(RECORDED_SCREEN, undefined)).toBe(false);
    expect(screenShowsTrustPrompt("", TRUST_PATTERN)).toBe(false);
  });

  it("RegExp global não carrega estado entre chamadas", () => {
    const global = /trust the contents of this project\?/g;
    expect(screenShowsTrustPrompt(RECORDED_SCREEN, global)).toBe(true);
    expect(screenShowsTrustPrompt(RECORDED_SCREEN, global)).toBe(true);
  });

  it("tela sem o prompt → false", () => {
    expect(screenShowsTrustPrompt("lucas@fedora:~/proj$ ", TRUST_PATTERN)).toBe(false);
  });
});

describe("decideTrustPromptAction", () => {
  it("prompt matched + cwd inside the declared root → confirm", () => {
    expect(
      decideTrustPromptAction({ patternMatched: true, cwdWithinDeclaredRoot: true, providerConfirmInput: "\r" }),
    ).toEqual({ action: "confirm" });
  });

  it("prompt matched + cwd outside (or no root) → warn, never confirm", () => {
    expect(
      decideTrustPromptAction({ patternMatched: true, cwdWithinDeclaredRoot: false, providerConfirmInput: "\r" }),
    ).toEqual({ action: "warn" });
  });

  it("a provider that declares no confirm input warns even inside the root", () => {
    expect(
      decideTrustPromptAction({ patternMatched: true, cwdWithinDeclaredRoot: true, providerConfirmInput: null }),
    ).toEqual({ action: "warn" });
  });

  it("no prompt on screen → ignore", () => {
    expect(
      decideTrustPromptAction({ patternMatched: false, cwdWithinDeclaredRoot: true, providerConfirmInput: "\r" }),
    ).toEqual({ action: "ignore" });
    expect(
      decideTrustPromptAction({ patternMatched: false, cwdWithinDeclaredRoot: false, providerConfirmInput: "\r" }),
    ).toEqual({ action: "ignore" });
  });
});

describe("describeTrustPromptOutsideRootWarning", () => {
  it("nomeia provider, cwd e a raiz, e diz que NÃO foi confirmado", () => {
    const inside = describeTrustPromptOutsideRootWarning({ providerId: "antigravity", cwd: "/board/sub", root: "/board" });
    expect(inside).toContain("antigravity");
    expect(inside).toContain("/board/sub");
    expect(inside).toContain("unconfirmed");
    const noRoot = describeTrustPromptOutsideRootWarning({ providerId: "antigravity", cwd: "/elsewhere", root: null });
    expect(noRoot).toContain("no declared board root");
  });
});
