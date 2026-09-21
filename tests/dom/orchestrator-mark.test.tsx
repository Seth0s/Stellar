/**
 * Board orchestrator mark — human gesture surface.
 *
 * The mark is a board property (`boards.orchestrator_card_id`); the gesture
 * that writes it lives on the terminal card ⋮ menu. These tests prove the
 * affordances exist and wire to the App.tsx callbacks — not the SQLite
 * write (CDP smoke + live SELECT cover that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Topbar } from "@renderer/Topbar";
import type { Board } from "@renderer/sessions";

vi.mock("@renderer/useTerminal", () => ({
  useTerminal: () => ({
    ptyId: "1",
    exitCode: null,
    spawnError: null,
    discoveredResumeId: null,
    resumeInvalidNotice: null,
    hasReceivedOutput: true,
    isActive: false,
    fitNow: vi.fn(),
    interrupt: vi.fn(),
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
  // Topbar reads fullscreen state on mount — preload surface, not jsdom.
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
});

const baseBoard: Board = {
  id: "b1",
  name: "Maestro",
  project: "Projects",
  cwd: "/tmp",
  created_at: 1,
  updated_at: 1,
  last_accessed_at: 1,
  autonomous: false,
  concurrency_cap: null,
  orchestrator_card_id: null,
};

function topbarStub(overrides: Partial<ComponentProps<typeof Topbar>> = {}) {
  const noop = () => {};
  return (
    <Topbar
      boards={[baseBoard]}
      activeBoardId="b1"
      boardCounts={{}}
      rootName="Workplace"
      workspaceRoot="/tmp"
      defaultCwd="/tmp"
      onChangeRoot={noop}
      onNavigateRoot={noop}
      zoom={1}
      onZoomIn={noop}
      onZoomOut={noop}
      onZoomTo={noop}
      bgStyleLabel="dots"
      onCycleBgStyle={noop}
      onOpenRemote={noop}
      onGoHome={noop}
      onSwitchBoard={noop}
      onCreateBoard={noop}
      onUpdateBoard={noop}
      onDeleteBoard={noop}
      onSuggestInstall={noop}
      {...overrides}
    />
  );
}

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

    expect(document.querySelector('[data-role="terminal-orchestrator-badge"]')).toBeTruthy();

    const menuBtn = document.querySelector('[data-role="terminal-card-menu"]') as HTMLButtonElement;
    fireEvent.click(menuBtn);

    const clear = document.querySelector('[data-role="terminal-clear-orchestrator"]') as HTMLButtonElement;
    expect(clear).toBeTruthy();
    fireEvent.click(clear);
    expect(onClearOrchestrator).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-role="terminal-mark-orchestrator"]')).toBeNull();
  });
});

describe("orchestrator mark — topbar indicator", () => {
  it("shows the board orchestrator badge with the card id when present", () => {
    render(
      topbarStub({
        boards: [{ ...baseBoard, orchestrator_card_id: "330" }],
        orchestratorCardPresent: true,
      }),
    );
    const badge = document.querySelector('[data-role="topbar-orchestrator-badge"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-missing")).toBeNull();
    expect(badge.title).toContain("330");
    // A marca existe: o chip de estado VAZIO não pode estar na tela. As duas
    // metades são complementares por construção (a79a708e) — um teste que
    // afirmasse só o badge descreveria metade da tela.
    expect(document.querySelector('[data-role="topbar-orchestrator-empty"]')).toBeNull();
    expect(screen.getByText(/orquestrador|orchestrator/i)).toBeTruthy();
  });

  it("shows an honest missing badge when the mark points at a dead id — does not hide it", () => {
    render(
      topbarStub({
        boards: [{ ...baseBoard, orchestrator_card_id: "dead-99" }],
        orchestratorCardPresent: false,
      }),
    );
    const badge = document.querySelector('[data-role="topbar-orchestrator-badge"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-missing")).toBe("true");
    expect(badge.textContent?.toLowerCase()).toMatch(/ausente|missing/);
    expect(badge.title).toContain("dead-99");
    // Marca SETADA (apontando para um card que sumiu) não é board SEM marca —
    // o chip vazio não entra; o que se mostra é o órfão, honestamente.
    expect(document.querySelector('[data-role="topbar-orchestrator-empty"]')).toBeNull();
  });

  it("board SEM marca: o chip de estado vazio aparece e o badge NÃO — as duas metades", () => {
    render(topbarStub({ boards: [{ ...baseBoard, orchestrator_card_id: null }] }));
    const empty = document.querySelector('[data-role="topbar-orchestrator-empty"]') as HTMLElement;
    expect(empty).toBeTruthy();
    expect(empty.title.length).toBeGreaterThan(0);
    expect(empty.textContent?.toLowerCase()).toMatch(/orquestrador|orchestrator/);
    expect(document.querySelector('[data-role="topbar-orchestrator-badge"]')).toBeNull();
  });
});
