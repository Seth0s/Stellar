import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "@renderer/SettingsModal";
import { setLocale } from "../../src/shared/i18n";

const board = {
  id: "board-1",
  name: "Maestro",
  autonomous: false,
  concurrency_cap: null as number | null,
};

function renderSettings(
  page: "general" | "shortcuts" | "keys" | "devices" | "maestro" | "agents" = "general",
  extras: Partial<Parameters<typeof SettingsModal>[0]> = {},
) {
  const onPageChange = vi.fn();
  const onClose = vi.fn();
  const onToggleAutonomous = vi.fn();
  const onSetConcurrencyCap = vi.fn();
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
      {...extras}
    />,
  );
  return { ...view, onPageChange, onClose, onToggleAutonomous, onSetConcurrencyCap };
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
  });
});

describe("SettingsModal", () => {
  it("separates Application vs This board in the nav and shows the board name", () => {
    renderSettings();

    const dialog = screen.getByRole("dialog", { name: "Configurações" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector("[data-settings-board-name]")?.textContent).toBe("Maestro");
    expect(screen.getByText("Aplicativo")).toBeTruthy();
    expect(screen.getByText("Este board")).toBeTruthy();
    // "Sobre", não "Geral" — o rótulo mudou por DECISÃO (task b2a0a4f8: o
    // conteúdo da página é idioma/build/escopo), e o aria-current está nele
    // porque o helper renderiza a página `general` explicitamente.
    expect(screen.getByRole("button", { name: /Sobre/ }).getAttribute("aria-current")).toBe("page");
    // Nova ordem da nav (task b2a0a4f8): Providers primeiro (default da
    // engrenagem), Sobre no fim; páginas de board depois da seção própria.
    expect([...dialog.querySelectorAll(".settings-nav-item")].map((b) => b.getAttribute("data-settings-page"))).toEqual([
      "providers",
      "shortcuts",
      "keys",
      "devices",
      "general",
      "maestro",
      "agents",
    ]);
  });

  it("Sobre (id general, por decisão — ver SettingsModal) is the app-scoped page: locale control + build identity + scope note, no board toggles", async () => {
    renderSettings("general");

    expect(screen.getByLabelText("Idioma")).toBeTruthy();
    expect(screen.getByText(/vale para o aplicativo inteiro/)).toBeTruthy();
    expect(await screen.findByText(/dev abc1234 \(dirty tree\)/)).toBeTruthy();
    expect(document.querySelector("[data-settings-build-identity]")).toBeTruthy();
    expect(screen.queryByLabelText(/Modo autônomo/)).toBeNull();
    expect(screen.queryByLabelText(/Limite de agentes/)).toBeNull();
  });

  it("? entry (page=shortcuts) is the ShortcutsOverlay list, not a copy", () => {
    renderSettings("shortcuts");

    expect(screen.getByRole("button", { name: /Atalhos/ }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelector(".shortcuts-grid")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Configurar" })).toBeTruthy();
  });

  it("Maestro hosts autonomous mode; Agentes hosts the concurrency cap", () => {
    const { onToggleAutonomous, onSetConcurrencyCap, rerender, onPageChange, onClose } = renderSettings("maestro");

    const toggle = document.querySelector(".autonomous-toggle-label input") as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onToggleAutonomous).toHaveBeenCalledWith("board-1", true);

    rerender(
      <SettingsModal
        page="agents"
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
      />,
    );

    const cap = screen.getByLabelText(/Limite de agentes simultâneos/);
    fireEvent.change(cap, { target: { value: "5" } });
    expect(onSetConcurrencyCap).toHaveBeenCalledWith("board-1", 5);
  });

  it("nav switches pages and does not keep a second modal chrome", () => {
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

  it("hides This board when no board is open", () => {
    renderSettings("general", { board: null });

    expect(screen.queryByText("Este board")).toBeNull();
    expect(screen.queryByRole("button", { name: /Maestro/ })).toBeNull();
  });

  it("no board: a board page redirects to the DEFAULT page (providers), which exists without a board", () => {
    // O fallback antigo levava a "general" porque ela era a default; com
    // Providers na default (task b2a0a4f8), o redirecionamento o segue —
    // providers é app-scoped e renderiza sem board.
    const { onPageChange } = renderSettings("maestro", { board: null });
    expect(onPageChange).toHaveBeenCalledWith("providers");
  });
});
