import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "@renderer/SettingsModal";
import { setLocale } from "../../src/shared/i18n";
import { parsePresets } from "../../src/main/board-preset-decision";
import presetsJson from "../../src/main/data/board-presets.json";
import type { SettingsPage } from "@renderer/SettingsModal";

const board = {
  id: "board-1",
  name: "Maestro",
  autonomous: false,
  concurrency_cap: null as number | null,
};

function renderSettings(page: SettingsPage = "general", extras: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const onPageChange = vi.fn();
  const onClose = vi.fn();
  const onToggleAutonomous = vi.fn();
  const onSetConcurrencyCap = vi.fn();
  const onApplyPreset = vi.fn();
  const onSetDefaults = vi.fn();
  const view = render(
    <SettingsModal
      page={page}
      onPageChange={onPageChange}
      onClose={onClose}
      board={board}
      shortcutOverrides={{}}
      onRebind={vi.fn()}
      onRestoreDefault={vi.fn()}
      onRestoreAll={vi.fn()}
      locale="pt-BR"
      onLocaleOverrideChange={vi.fn()}
      onToggleAutonomous={onToggleAutonomous}
      onSetConcurrencyCap={onSetConcurrencyCap}
      onApplyPreset={onApplyPreset}
      onSetDefaults={onSetDefaults}
      {...extras}
    />,
  );
  return { ...view, onPageChange, onClose, onToggleAutonomous, onSetConcurrencyCap, onApplyPreset, onSetDefaults };
}

beforeEach(() => {
  setLocale("pt-BR");
  Object.assign(window, {
    i18n: {
      get: vi.fn(async () => ({ locale: "pt-BR", override: null, systemLocale: "pt-BR" })),
      setOverride: vi.fn(async (override: "pt-BR" | "en" | null) => ({
        locale: override ?? "pt-BR",
        override,
        systemLocale: "pt-BR",
      })),
    },
    agents: {
      checkAvailability: vi.fn(async () => []),
      onAvailabilityStale: vi.fn(() => () => {}),
    },
    providerUsage: {
      get: vi.fn(async () => ({ supported: false, reason: "test" })),
    },
    system: {
      homeDir: "/home/test",
      platform: "linux",
      getBuildIdentity: vi.fn(async () => ({
        mode: "dev" as const,
        version: "0.7.0",
        commit: "abc1234",
        builtAt: null,
        dirty: true,
        busProtocol: 2,
        label: "dev abc1234 (dirty tree)",
      })),
      getProvidersConfigPath: vi.fn(async () => "/tmp/providers.json"),
      openProvidersConfig: vi.fn(async () => ({ ok: true, error: null })),
      readProvidersConfig: vi.fn(async () => ({
        path: "/tmp/providers.json",
        rows: [],
        rejected: [],
        skipped: [],
        error: null,
      })),
      addProvider: vi.fn(),
      removeProvider: vi.fn(),
      onProvidersConfigChanged: vi.fn(() => () => {}),
    },
    secrets: {
      isEncryptionAvailable: vi.fn(async () => true),
      hasKey: vi.fn(async () => false),
      getBaseURL: vi.fn(async () => null),
      setKey: vi.fn(async () => ({ ok: true })),
      clearKey: vi.fn(async () => ({ ok: true })),
    },
    remote: {
      devices: vi.fn(async () => []),
      pairNewDevice: vi.fn(async () => ({ id: "", url: "", qrDataUrl: "" })),
      revokeDevice: vi.fn(async () => {}),
      revokeAll: vi.fn(async () => {}),
    },
    cloud: {
      status: vi.fn(async () => ({ state: "logged-out", apiBaseUrl: "", lastError: null })),
      login: vi.fn(),
      logout: vi.fn(),
      cancel: vi.fn(),
      onStatusChanged: vi.fn(() => () => {}),
      plansUrl: vi.fn(async () => "https://example.com/plans"),
      devices: { list: vi.fn(async () => []), disconnect: vi.fn() },
    },
    workhome: {
      status: vi.fn(async () => ({
        loggedIn: false,
        profileId: null,
        enabledTools: [],
        toolRoots: {},
        workFolders: [],
        lastRevision: null,
        lastSyncAt: null,
        lastError: null,
      })),
      syncNow: vi.fn(),
    },
    updater: {
      check: vi.fn(async () => ({ checked: false })),
    },
    store: {
      boardPresets: vi.fn(async () => parsePresets(presetsJson)),
      boardBackgroundStatus: vi.fn(async () => ({
        boards: {},
        backgroundCount: 0,
        maxBackgroundSessions: 4,
        overCap: false,
      })),
      boardAgentRoles: vi.fn(async () => []),
      boardContext: {
        get: vi.fn(async () => ({ ok: true, rulesText: "", gateToolPaths: [], trapCount: 0 })),
        setRules: vi.fn(async () => ({ ok: true })),
        setGateToolPaths: vi.fn(async () => ({ ok: true })),
      },
    },
  });
});

describe("SettingsModal V7", () => {
  it("separates Application vs This board, search, and prototype nav order", () => {
    renderSettings("account");

    const dialog = screen.getByRole("dialog", { name: "Configurações" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Aplicativo")).toBeTruthy();
    expect(screen.getByText(/Este board · Maestro/)).toBeTruthy();
    expect(screen.getByPlaceholderText("Buscar configuração")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Conta e plano/ }).getAttribute("aria-current")).toBe("page");
    expect(
      Array.from(dialog.querySelectorAll("[data-settings-page]")).map((b) => b.getAttribute("data-settings-page")),
    ).toEqual([
      "account",
      "providers",
      "shortcuts",
      "keys",
      "devices",
      "appearance",
      "performance",
      "general",
      "mode",
      "rules",
      "team",
    ]);
  });

  it("scope chip says app vs board", () => {
    const app = renderSettings("providers");
    expect(document.querySelector("[data-settings-scope]")?.textContent).toMatch(/vale para o app inteiro/);
    app.unmount();
    renderSettings("mode");
    expect(document.querySelector("[data-settings-scope]")?.textContent).toMatch(/vale só para o board/);
  });

  it("search filters nav entries", () => {
    renderSettings("account");
    fireEvent.change(screen.getByPlaceholderText("Buscar configuração"), { target: { value: "cota" } });
    const pages = Array.from(document.querySelectorAll("[data-settings-page]")).map((b) => b.getAttribute("data-settings-page"));
    expect(pages).toEqual(["providers"]);
  });

  it("Sobre (general) shows build identity; locale lives on Aparência", async () => {
    const about = renderSettings("general");
    expect(await screen.findByText(/dev abc1234 \(dirty tree\)/)).toBeTruthy();
    expect(screen.queryByLabelText("Idioma")).toBeNull();
    about.unmount();
    renderSettings("appearance");
    expect(screen.getByLabelText("Idioma")).toBeTruthy();
  });

  it("? entry (page=shortcuts) keeps ShortcutsOverlay", () => {
    renderSettings("shortcuts");
    expect(screen.getByRole("button", { name: /Atalhos/ }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".shortcuts-grid")).toBeTruthy();
  });

  it("Modo de trabalho hosts autonomous + concurrency (legacy maestro/agents normalize)", () => {
    const { onToggleAutonomous, onSetConcurrencyCap } = renderSettings("maestro");
    const toggle = screen.getByRole("button", { name: /Modo autônomo|autônomo/i });
    fireEvent.click(toggle);
    expect(onToggleAutonomous).toHaveBeenCalledWith("board-1", true);

    const cap = document.querySelector("#settings-concurrency") as HTMLInputElement;
    expect(cap).toBeTruthy();
    fireEvent.change(cap, { target: { value: "5" } });
    expect(onSetConcurrencyCap).toHaveBeenCalledWith("board-1", 5);
  });

  it("Modo lista presets e mostra diff antes de aplicar", async () => {
    const { onApplyPreset } = renderSettings("mode");
    expect(await screen.findByText("Junto")).toBeTruthy();
    expect(screen.getByText("Orquestrado")).toBeTruthy();
    expect(screen.getByText("Autônomo")).toBeTruthy();
    fireEvent.click(await screen.findByText("Autônomo"));
    const diff = document.querySelector("[data-preset-diff='maximo']");
    expect(diff).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Aplicar/ }));
    expect(onApplyPreset).toHaveBeenCalled();
    expect((onApplyPreset.mock.calls[0]![1] as { id: string }).id).toBe("maximo");
  });

  it("nav switches pages; one modal-root; no thin-scroll", () => {
    const { onPageChange } = renderSettings("general");
    fireEvent.click(screen.getByRole("button", { name: /Chaves de API/ }));
    expect(onPageChange).toHaveBeenCalledWith("keys");
    expect(document.querySelectorAll(".modal-root").length).toBe(1);
    expect(document.querySelector(".thin-scroll")).toBeNull();
  });

  it("closes on Escape and backdrop click", () => {
    const { onClose, container } = renderSettings();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("hides This board when no board; board page redirects to providers", () => {
    renderSettings("general", { board: null });
    expect(screen.queryByText(/Este board/)).toBeNull();
    const { onPageChange } = renderSettings("mode", { board: null });
    expect(onPageChange).toHaveBeenCalledWith("providers");
  });

  it("Dispositivos shows celular em breve", () => {
    renderSettings("devices");
    expect(screen.getByText(/em breve/i)).toBeTruthy();
  });
});
