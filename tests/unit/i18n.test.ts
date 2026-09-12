/**
 * Unit tests for shared i18n — pure, `environment: "node"`.
 * DESIGN-BACKLOG.md §2.1 phase 1.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  t,
  setLocale,
  getLocale,
  resolveLocale,
  formatRelativeTime,
  isLocale,
  AGENT_FACING_MODULES,
  type MessageKey,
  ptBR,
  en,
} from "../../src/shared/i18n";

beforeEach(() => {
  setLocale("pt-BR");
});

describe("resolveLocale", () => {
  it("override wins over app locale", () => {
    expect(resolveLocale("en-US", "pt-BR")).toBe("pt-BR");
    expect(resolveLocale("pt-BR", "en")).toBe("en");
  });

  it("maps Portuguese app locales to pt-BR", () => {
    expect(resolveLocale("pt-BR", null)).toBe("pt-BR");
    expect(resolveLocale("pt", null)).toBe("pt-BR");
    expect(resolveLocale("pt_PT", null)).toBe("pt-BR");
  });

  it("maps everything else to en", () => {
    expect(resolveLocale("en-US", null)).toBe("en");
    expect(resolveLocale("de-DE", null)).toBe("en");
    expect(resolveLocale("", null)).toBe("en");
  });
});

describe("t()", () => {
  it("returns the active-locale string", () => {
    expect(t("confirm.cancel")).toBe("Cancelar");
    setLocale("en");
    expect(t("confirm.cancel")).toBe("Cancel");
  });

  it("interpolates {vars}", () => {
    expect(t("app.closeTerminal.message", { name: "Claude 1°" })).toContain("Claude 1°");
    setLocale("en");
    expect(t("app.openUrl.message", { url: "https://example.com" })).toContain("https://example.com");
  });

  it("every pt-BR key exists in en (structural — also enforced by Record<MessageKey, string>)", () => {
    for (const key of Object.keys(ptBR) as MessageKey[]) {
      expect(typeof en[key]).toBe("string");
      expect(en[key].length).toBeGreaterThan(0);
    }
  });
});

describe("formatRelativeTime", () => {
  const T0 = 1_000_000_000_000;

  it("below 1min is 'agora' / 'now' via Intl, not a hand-rolled literal", () => {
    setLocale("pt-BR");
    expect(formatRelativeTime(T0 - 30_000, T0)).toBe("agora");
    setLocale("en");
    expect(formatRelativeTime(T0 - 30_000, T0)).toBe("now");
  });

  it("minutes / hours / days follow the active locale", () => {
    setLocale("pt-BR");
    expect(formatRelativeTime(T0 - 5 * 60_000, T0)).toMatch(/5/);
    expect(formatRelativeTime(T0 - 18 * 3_600_000, T0)).toMatch(/18/);
    expect(formatRelativeTime(T0 - 2 * 86_400_000, T0)).toMatch(/2|anteontem/);

    setLocale("en");
    expect(formatRelativeTime(T0 - 5 * 60_000, T0)).toMatch(/5/);
    expect(formatRelativeTime(T0 - 18 * 3_600_000, T0)).toMatch(/18/);
    expect(formatRelativeTime(T0 - 2 * 86_400_000, T0)).toMatch(/2/);
  });

  it("never combines two units", () => {
    const age = formatRelativeTime(T0 - (25 * 3_600_000 + 30 * 60_000), T0);
    expect(age).not.toMatch(/\d+.*\d+/);
  });
});

describe("isLocale / getLocale", () => {
  it("accepts only supported tags", () => {
    expect(isLocale("pt-BR")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("getLocale mirrors setLocale", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
  });
});

describe("AGENT-FACING boundary checklist", () => {
  it("lists the modules that must stay out of translation sweeps", () => {
    expect(AGENT_FACING_MODULES).toContain("src/main/mcp-server.ts");
    expect(AGENT_FACING_MODULES).toContain("src/main/providers.ts");
    expect(AGENT_FACING_MODULES).toContain("src/main/bash-discovery-decision.ts");
    expect(AGENT_FACING_MODULES).toContain("src/main/message-bus.ts");
    expect(AGENT_FACING_MODULES).toContain("src/main/reach-from-hunks.ts");
  });
});
