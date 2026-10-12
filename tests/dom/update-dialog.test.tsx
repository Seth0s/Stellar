/**
 * The update dialog and its title-bar icon, driven through the same IPC
 * surface the app uses (`window.updater`). The hook keeps module-level state
 * (one boot check per app), so each test loads a fresh copy of the modules.
 *
 * What must not regress:
 *  - nothing downloads until the user asks;
 *  - closing the dialog never cancels a download or installs anything;
 *  - the app restarts ONLY from "Reiniciar agora";
 *  - a failure says what it was and offers a retry of the step that failed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";
import type { UpdaterSnapshot } from "../../src/main/update-state";
import { setLocale } from "../../src/shared/i18n";

const IDLE: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  changelog: "",
  downloadBytes: null,
  progress: null,
  error: null,
  manual: null,
};

const AVAILABLE: UpdaterSnapshot = {
  ...IDLE,
  phase: "available",
  version: "0.9.0",
  changelog: "- Novo: a atualização agora tem janela própria\n- Corrigido: a Fila travava",
  downloadBytes: 38_200_000,
};

type Fake = {
  push: (s: UpdaterSnapshot) => void;
  api: Record<string, ReturnType<typeof vi.fn>>;
};

function installFake(over: { remindLaterVersion?: string | null; counts?: unknown; releaseUrl?: string | null } = {}): Fake {
  let listener: (s: UpdaterSnapshot) => void = () => {};
  const api = {
    check: vi.fn(async () => ({
      checked: true,
      install: { canInstall: true, how: "rpm" },
      releaseUrl: over.releaseUrl === undefined ? "https://example.test/releases" : over.releaseUrl,
      currentVersion: "0.8.7",
      remindLaterVersion: over.remindLaterVersion ?? null,
    })),
    getState: vi.fn(async () => IDLE),
    onState: vi.fn((cb: (s: UpdaterSnapshot) => void) => {
      listener = cb;
      return () => {};
    }),
    download: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
    install: vi.fn(async () => ({ ok: true })),
    runningCounts: vi.fn(async () => over.counts ?? { terminals: 3, agents: 2, sessions: 2 }),
    remindLater: vi.fn(async () => ({ ok: true, remindLaterVersion: null })),
  };
  (window as unknown as { updater: unknown }).updater = api;
  return { api, push: (s) => act(() => listener(s)) };
}

async function mount(over: Parameters<typeof installFake>[0] = {}) {
  vi.resetModules();
  const fake = installFake(over);
  const { UpdateBanner } = await import("@renderer/UpdateBanner");
  const { UpdateTitlebarIcon } = await import("@renderer/UpdateDialogIcon");
  render(
    <>
      <UpdateTitlebarIcon />
      <UpdateBanner />
    </>,
  );
  await waitFor(() => expect(fake.api.check).toHaveBeenCalled());
  return fake;
}

const dialog = () => document.querySelector('[data-part="update-dialog"]') as HTMLElement | null;
const primary = () => document.querySelector('[data-part="update-primary"]') as HTMLElement;
const icon = () => document.querySelector('[data-role="update-icon"]') as HTMLElement | null;
const clickText = (text: string) => fireEvent.click(screen.getByText(text));

beforeEach(() => {
  setLocale("pt-BR");
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe("update dialog — offer", () => {
  it("opens by itself for a new version and asks before downloading anything", async () => {
    const fake = await mount();
    expect(dialog()).toBeNull();
    fake.push(AVAILABLE);
    await waitFor(() => expect(dialog()?.getAttribute("data-state")).toBe("available"));
    expect(dialog()!.textContent).toContain("Atualização disponível");
    expect(dialog()!.textContent).toContain("Stellar 0.9.0 · você usa a 0.8.7");
    expect(dialog()!.textContent).toContain("Novo: a atualização agora tem janela própria");
    expect(primary().textContent).toBe("Baixar · 38 MB");
    expect(fake.api.download).not.toHaveBeenCalled();
    fireEvent.click(primary());
    expect(fake.api.download).toHaveBeenCalledOnce();
  });

  it("'Agora não' closes and remembers that version, leaving the icon", async () => {
    const fake = await mount();
    fake.push(AVAILABLE);
    await waitFor(() => expect(dialog()).not.toBeNull());
    clickText("Agora não");
    expect(dialog()).toBeNull();
    expect(fake.api.remindLater).toHaveBeenCalledWith("0.9.0");
    expect(icon()?.getAttribute("data-phase")).toBe("available");
    fireEvent.click(icon()!);
    expect(dialog()).not.toBeNull();
  });

  it("does not open for a version the user already postponed", async () => {
    const fake = await mount({ remindLaterVersion: "0.9.0" });
    await act(async () => {});
    fake.push(AVAILABLE);
    await act(async () => {});
    expect(dialog()).toBeNull();
    expect(icon()).not.toBeNull();
    // A NEWER version asks again.
    fake.push({ ...AVAILABLE, version: "0.9.1" });
    await waitFor(() => expect(dialog()).not.toBeNull());
  });
});

describe("update dialog — download", () => {
  const DOWNLOADING: UpdaterSnapshot = {
    ...AVAILABLE,
    phase: "downloading",
    progress: { percent: 48.3, transferred: 18_400_000, total: 38_200_000, bytesPerSecond: 3_100_000 },
  };

  it("shows the real progress", async () => {
    const fake = await mount();
    fake.push(AVAILABLE);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fake.push(DOWNLOADING);
    const progress = document.querySelector('[data-part="update-progress"]')!;
    expect(progress.textContent).toContain("48%");
    expect(progress.textContent).toContain("18,4 de 38,2 MB");
    expect(progress.textContent).toContain("3,1 MB/s");
    expect(progress.textContent).toContain("faltam cerca de 7 s");
    expect(progress.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("48");
  });

  it("closing it keeps the download going and the icon shows the percentage", async () => {
    const fake = await mount();
    fake.push(DOWNLOADING);
    fake.push(DOWNLOADING);
    fireEvent.click(icon()!);
    clickText("Continuar em segundo plano");
    expect(dialog()).toBeNull();
    expect(fake.api.cancel).not.toHaveBeenCalled();
    expect(fake.api.remindLater).not.toHaveBeenCalled();
    expect(icon()?.getAttribute("data-phase")).toBe("downloading");
    expect(icon()?.getAttribute("title")).toContain("48%");
  });

  it("'Cancelar download' asks main to cancel", async () => {
    const fake = await mount();
    fake.push(DOWNLOADING);
    fireEvent.click(icon()!);
    clickText("Cancelar download");
    expect(fake.api.cancel).toHaveBeenCalledOnce();
  });
});

describe("update dialog — ready, and the restart that only the user triggers", () => {
  const READY: UpdaterSnapshot = { ...AVAILABLE, phase: "ready" };

  async function ready(over: Parameters<typeof installFake>[0] = {}) {
    const fake = await mount(over);
    fake.push(READY);
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()?.getAttribute("data-state")).toBe("ready"));
    return fake;
  }

  it("warns how many terminals and agents a restart would end", async () => {
    await ready();
    const warning = await waitFor(() => {
      const el = document.querySelector('[data-part="update-running-warning"]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(warning.textContent).toContain("Reiniciar encerra o que está rodando");
    expect(warning.textContent).toContain("Há 3 terminais e 2 agentes abertos em 2 sessões.");
    expect(warning.getAttribute("role")).toBe("alert");
  });

  it("says nothing will be lost when nothing is open", async () => {
    await ready({ counts: { terminals: 0, agents: 0, sessions: 0 } });
    const box = await waitFor(() => {
      const el = document.querySelector('[data-part="update-running-warning"]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(box.textContent).toContain("Nenhum terminal ou agente aberto agora");
    expect(box.getAttribute("role")).toBeNull();
  });

  it("uses the singular for one thing", async () => {
    await ready({ counts: { terminals: 0, agents: 1, sessions: 1 } });
    const box = await waitFor(() => document.querySelector('[data-part="update-running-warning"]') as HTMLElement);
    expect(box.textContent).toContain("Há 1 agente aberto em 1 sessão. Ele será encerrado");
  });

  it("'Reiniciar depois' keeps the update and never installs", async () => {
    const fake = await ready();
    clickText("Reiniciar depois");
    expect(dialog()).toBeNull();
    expect(fake.api.install).not.toHaveBeenCalled();
    expect(icon()?.getAttribute("data-phase")).toBe("ready");
  });

  it("restarts only from 'Reiniciar agora'", async () => {
    const fake = await ready();
    expect(fake.api.install).not.toHaveBeenCalled();
    fireEvent.click(primary());
    expect(fake.api.install).toHaveBeenCalledOnce();
  });

  it("never installs on its own: going from downloading to ready does not call install", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "downloading", progress: { percent: 99, transferred: 1, total: 1, bytesPerSecond: 1 } });
    fake.push(READY);
    await act(async () => {});
    expect(fake.api.install).not.toHaveBeenCalled();
  });
});

describe("update dialog — installing", () => {
  it("cannot be closed and shows the restart message", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "installing" });
    await waitFor(() => expect(dialog()?.getAttribute("data-state")).toBe("installing"));
    expect(document.querySelector('[data-part="update-installing"]')).not.toBeNull();
    expect(dialog()!.textContent).toContain("Reiniciando…");
    expect(dialog()!.querySelector("button")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).not.toBeNull();
  });
});

describe("update dialog — failures", () => {
  const baseError = {
    kind: "network" as const,
    stage: "download" as const,
    code: "net::ERR_INTERNET_DISCONNECTED",
    detail: "net::ERR_INTERNET_DISCONNECTED",
    percent: 62,
    transferred: 23_700_000,
    total: 38_200_000,
    neededBytes: null,
    freeBytes: null,
    swapLogPath: null,
  };

  it("explains a network failure, keeps the numbers, and retries the download", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "error", error: baseError });
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()?.getAttribute("data-state")).toBe("error"));
    expect(document.querySelector('[data-part="update-error-message"]')!.textContent).toContain("Falha de rede ao baixar");
    expect(document.querySelector('[data-part="update-error-message"]')!.textContent).toContain("O download parou em 62%");
    expect(document.querySelector('[data-part="update-error-detail"]')!.textContent).toBe(
      "net::ERR_INTERNET_DISCONNECTED (62% · 23,7 de 38,2 MB)",
    );
    expect(dialog()!.textContent).toContain("O Stellar atual continua funcionando normalmente.");
    expect(document.querySelector('[data-part="update-releases-link"]')?.getAttribute("href")).toBe("https://example.test/releases");
    fireEvent.click(primary());
    expect(fake.api.download).toHaveBeenCalledOnce();
    expect(fake.api.install).not.toHaveBeenCalled();
  });

  it("names the other causes", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "error", error: { ...baseError, kind: "signature", code: null, detail: "sha512 checksum mismatch", percent: null } });
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain("A assinatura do arquivo não confere");
    fake.push({ ...AVAILABLE, phase: "error", error: { ...baseError, kind: "disk", code: "ENOSPC", detail: "no space left", neededBytes: 120_000_000, freeBytes: 41_000_000 } });
    expect(dialog()!.textContent).toContain("A atualização precisa de 120 MB livres e há 41 MB no disco.");
  });

  it("retries the INSTALL when that is what failed, and shows the swap log", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "error", error: { ...baseError, kind: "unknown", stage: "install", percent: null, transferred: null, total: null, swapLogPath: "/tmp/swap.log" } });
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(document.querySelector('[data-part="update-swap-log"]')!.textContent).toContain("/tmp/swap.log");
    fireEvent.click(primary());
    expect(fake.api.install).toHaveBeenCalledOnce();
    expect(fake.api.download).not.toHaveBeenCalled();
  });

  it("offers no releases link when the page is not known", async () => {
    const fake = await mount({ releaseUrl: null });
    fake.push({ ...AVAILABLE, phase: "error", error: baseError });
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(document.querySelector('[data-part="update-releases-link"]')).toBeNull();
  });

  it("an error does not pop the dialog open on its own", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "downloading", progress: { percent: 5, transferred: 1, total: 20, bytesPerSecond: 1 } });
    fake.push({ ...AVAILABLE, phase: "error", error: baseError });
    await act(async () => {});
    expect(dialog()).toBeNull();
    expect(icon()?.getAttribute("data-phase")).toBe("error");
  });
});

describe("update dialog — installs that cannot update themselves", () => {
  it("shows the command for the package manager and copies it", async () => {
    const fake = await mount();
    fake.push({
      ...AVAILABLE,
      phase: "manual",
      manual: { manager: "dnf", fileName: "Stellar-0.9.0-x86_64.rpm", command: "sudo dnf install ./Stellar-0.9.0-x86_64.rpm" },
    });
    await waitFor(() => expect(dialog()?.getAttribute("data-state")).toBe("manual"));
    const steps = document.querySelector('[data-part="update-manual-steps"]')!;
    expect(steps.textContent).toContain("sudo dnf install ./Stellar-0.9.0-x86_64.rpm");
    fireEvent.click(screen.getByText("Copiar"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("sudo dnf install ./Stellar-0.9.0-x86_64.rpm");
    await waitFor(() => expect(screen.getByText("Copiado")).not.toBeNull());
    expect(document.querySelector('[data-part="update-primary"]')?.getAttribute("href")).toBe("https://example.test/releases");
    expect(fake.api.download).not.toHaveBeenCalled();
  });

  it("gives only the link when the format cannot be told", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "manual", manual: { manager: null, fileName: null, command: null } });
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.queryByText("Copiar")).toBeNull();
    expect(dialog()!.textContent).toContain("Instale o pacote do jeito que o seu sistema instala pacotes.");
  });
});

describe("update dialog — closing", () => {
  it("Esc closes an offer as 'not now'", async () => {
    const fake = await mount();
    fake.push(AVAILABLE);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(fake.api.remindLater).toHaveBeenCalledWith("0.9.0");
  });

  it("the close button reads 'o download continua' once a download exists", async () => {
    const fake = await mount();
    fake.push({ ...AVAILABLE, phase: "ready" });
    fireEvent.click(icon()!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector("header button")?.getAttribute("aria-label")).toBe("Fechar (o download continua)");
  });
});
