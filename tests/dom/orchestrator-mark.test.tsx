/**
 * Board orchestrator mark — human gesture surface.
 *
 * The mark is a board property (`boards.orchestrator_card_id`); the gesture
 * that writes it lives on the terminal card ⋮ menu. These tests prove the
 * affordances exist and wire to the App.tsx callbacks — not the SQLite
 * write (CDP smoke + live SELECT cover that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";

vi.mock("@renderer/useTerminal", () => ({
  useTerminal: () => ({
    ptyId: "1",
    exitCode: null,
    spawnError: null,
    discoveredResumeId: null,
    resumeInvalidNotice: null,
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
  // O TerminalCard lê o sinal de fim de turno pela projeção do canal de
  // disponibilidade (task 0dd5c145). Lista vazia = nenhum provider sinaliza,
  // que é o estado honesto antes de o main responder.
  useAvailableAgentProviders: () => [],
}));

import { TerminalCard } from "@renderer/TerminalCard";

beforeEach(() => {
  vi.clearAllMocks();
  // TerminalCard reads window controls on mount — preload surface, not jsdom.
  (window as unknown as {
    winControls: {
      isFullscreen: () => Promise<boolean>;
      onFullscreenChange: (cb: (v: boolean) => void) => () => void;
      toggleFullscreen: () => void;
    };
  }).winControls = {
    isFullscreen: () => Promise.resolve(false),
    onFullscreenChange: () => () => {},
    toggleFullscreen: () => {},
  };
  const w = window as unknown as { pty?: Record<string, unknown> };
  w.pty = { ...(w.pty ?? {}), health: async () => null };
});

function terminalStub(overrides: Partial<ComponentProps<typeof TerminalCard>> = {}) {
  const noop = () => {};
  return (
    <TerminalCard
      id="42"
      rect={{ x: 0, y: 0, w: 400, h: 300 }}
      zoom={1}
      zIndex={1}
      providerId="bash"
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
      displayName="Bash"
      onChange={noop}
      onCommit={noop}
      onRaise={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
      onResumeIdDiscovered={noop}
      onOpenUrl={noop}
      shortcutOverridesRef={{ current: {} }}
      {...overrides}
    />
  );
}

describe("orchestrator mark — terminal card menu", () => {
  it("offers Mark as board orchestrator when unmarked, and calls onMarkOrchestrator", () => {
    const onMarkOrchestrator = vi.fn();
    render(terminalStub({ onMarkOrchestrator }));

    const menuBtn = document.querySelector('[data-role="terminal-card-menu"]') as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();
    fireEvent.click(menuBtn);

    const mark = document.querySelector('[data-role="terminal-mark-orchestrator"]') as HTMLButtonElement;
    expect(mark).toBeTruthy();
    fireEvent.click(mark);
    expect(onMarkOrchestrator).toHaveBeenCalledOnce();
  });

  it("offers Remove orchestrator mark when marked, and calls onClearOrchestrator", () => {
    const onClearOrchestrator = vi.fn();
    render(
      terminalStub({
        isBoardOrchestrator: true,
        onClearOrchestrator,
      }),
    );

    const menuBtn = document.querySelector('[data-role="terminal-card-menu"]') as HTMLButtonElement;
    expect(menuBtn).toBeTruthy();
    fireEvent.click(menuBtn);

    const clear = document.querySelector('[data-role="terminal-clear-orchestrator"]') as HTMLButtonElement;
    expect(clear).toBeTruthy();
    fireEvent.click(clear);
    expect(onClearOrchestrator).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-role="terminal-mark-orchestrator"]')).toBeNull();
  });
});
