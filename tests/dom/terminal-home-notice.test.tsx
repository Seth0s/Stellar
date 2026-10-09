/**
 * AVISO "esta CLI não separa por perfil" NO CARD (task fb6542e6).
 *
 * A A3c (2c6523ba) cabeou o canal `pty:home-notice`: abrir um provider sem
 * pasta de config própria (cursor/antigravity/commandcode) num perfil isolated
 * emite o aviso; faltava MOSTRÁ-LO. Aqui o que fica preso é o que pode quebrar
 * em silêncio: o aviso aparece no card CERTO e SÓ nele.
 *
 * Mocka `useTerminal` (o mesmo padrão de `terminal-header-task-chip.test.tsx`)
 * porque o alvo é a fiação render do card; o `homeNotice` chega por id, então
 * dois cards com ids distintos exercitam "só quem recebeu".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { MutableRefObject } from "react";
import type { ShortcutOverrides } from "@renderer/shortcut-registry";
import { setLocale } from "../../src/shared/i18n";

const h = vi.hoisted(() => ({ notices: new Map<string, { providerId: string } | null>() }));

vi.mock("@renderer/useTerminal", () => ({
  useTerminal: (_containerRef: unknown, id: string) => ({
    ptyId: "1",
    exitCode: null,
    spawnError: null,
    discoveredResumeId: null,
    resumeInvalidNotice: null,
    homeNotice: h.notices.get(id) ?? null,
    hasReceivedOutput: true,
    isActive: false,
    agentStatus: "idle",
    fitNow: vi.fn(),
    interrupt: vi.fn(),
    dropLive: true,
    writeDroppedPaths: () => [],
  }),
}));

vi.mock("@renderer/useAgentAvailability", () => ({
  useAgentAvailability: () => ({ missing: [], checking: false }),
  useAvailableAgentProviders: () => [],
}));

import { TerminalCard } from "@renderer/TerminalCard";

beforeEach(() => {
  setLocale("pt-BR");
  h.notices.clear();
  const w = window as unknown as { pty?: Record<string, unknown> };
  w.pty = { ...(w.pty ?? {}), health: async () => null };
  (window as unknown as { store: Record<string, unknown> }).store = {
    ...((window as unknown as { store?: Record<string, unknown> }).store ?? {}),
    cardAgentRoles: vi.fn(async () => []),
  };
  (window as unknown as { tasks: Record<string, unknown> }).tasks = {
    listSprints: async () => [],
    sprintSnapshot: async () => ({ ok: true }),
    transitionsByBoard: async () => [],
    onChanged: () => () => {},
    onSprintsChanged: () => () => {},
    onScopeChanged: () => () => {},
    updatePrompt: async () => ({ ok: true }),
    respondStatusAsk: async () => ({ ok: true }),
    create: async () => ({ ok: true, taskId: "x" }),
    renameSprint: async () => ({ ok: true }),
    closeSprint: async () => ({ ok: true }),
    deleteSprint: async () => ({ ok: true }),
    move: async () => ({ ok: true }),
  };
});

function terminalStub(overrides: Partial<ComponentProps<typeof TerminalCard>> = {}) {
  const noop = () => {};
  return (
    <TerminalCard
      id="A"
      rect={{ x: 0, y: 0, w: 700, h: 300 }}
      zoom={1}
      zIndex={1}
      providerId="cursor"
      cwd="/tmp"
      resumeId={null}
      continueLast={false}
      model={null}
      effort={null}
      systemPrompt={null}
      initialInput={null}
      brief={null}
      taskId={null}
      visible
      seenUrls={[]}
      displayName="card"
      onChange={noop}
      onCommit={noop}
      onRaise={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
      onResumeIdDiscovered={noop}
      onOpenUrl={noop}
      shortcutOverridesRef={{ current: {} } as MutableRefObject<ShortcutOverrides>}
      {...overrides}
    />
  );
}

describe("TerminalCard — aviso de perfil (homeNotice)", () => {
  it("aparece SÓ no card que recebeu o notice", async () => {
    // O card A recebeu o aviso (provider `cursor` num perfil isolated); o B não.
    h.notices.set("A", { providerId: "cursor" });
    render(<div data-testid="wrap-A">{terminalStub({ id: "A", providerId: "cursor" })}</div>);
    render(<div data-testid="wrap-B">{terminalStub({ id: "B", providerId: "commandcode" })}</div>);

    const a = within(screen.getByTestId("wrap-A"));
    const b = within(screen.getByTestId("wrap-B"));

    await waitFor(() => expect(a.queryByText(/esta CLI não separa por perfil/)).not.toBeNull());
    expect(b.queryByText(/esta CLI não separa por perfil/)).toBeNull();
    // Exatamente UM aviso na tela inteira.
    expect(document.querySelectorAll('[data-role="terminal-home-notice"]')).toHaveLength(1);
  });

  it("sem notice, nenhum aviso é renderizado (ausência honesta)", async () => {
    render(<div data-testid="wrap-A">{terminalStub({ id: "A" })}</div>);
    await waitFor(() => expect(document.querySelectorAll('[data-role="terminal-home-notice"]')).toHaveLength(0));
  });
});
