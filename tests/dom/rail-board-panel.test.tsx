/**
 * The "Board" panel took over what the top bar used to say: the autonomous
 * mode, the orchestrator mark and the open agents (with their roles per task).
 *
 * The rules that must not come back — carried over from the top-bar tests:
 *  - the agents list states what is known (open agent cards), never "active";
 *  - a card with no open task shows NO role (never "idle");
 *  - a card without a label shows its id, never an invented name;
 *  - a mark pointing at a dead card is shown honestly, not cleared;
 *  - "no mark" and "mark present" are mutually exclusive on screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { RailBoardPanel, type RailBoardInfo } from "@renderer/RailBoardPanel";
import type { RailCard } from "@renderer/Rail";
import { setLocale } from "../../src/shared/i18n";

const BOARD: RailBoardInfo = {
  boardId: "b1",
  rootName: "Workspace",
  project: "Demo project",
  boardName: "Sprint board",
  autonomous: false,
  orchestratorCardId: null,
  orchestratorPresent: true,
};

const CARDS: RailCard[] = [
  { id: "4242", kind: "terminal", label: "Spawn limpo", statusText: "trabalhando", statusTone: "live", isAgent: true },
  { id: "4243", kind: "terminal", label: null, statusText: "parado", statusTone: "idle", isAgent: true },
  // Not an agent: a plain note never counts.
  { id: "9", kind: "sticky", label: "Nota", statusText: "nota", statusTone: "note" },
];

let boardAgentRoles: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  vi.clearAllMocks();
  boardAgentRoles = vi.fn(async () => [
    {
      cardId: "4242",
      label: "Spawn limpo",
      provider: "commandcode",
      roles: [
        { taskId: "aaaa1111-1111-4111-8111-111111111111", role: "implementer" },
        { taskId: "bbbb2222-2222-4222-8222-222222222222", role: "reviewer" },
      ],
    },
    { cardId: "4243", label: null, provider: "claude", roles: [] },
  ]);
  Object.assign(window, { store: { boardAgentRoles } });
});

function panel(over: Partial<React.ComponentProps<typeof RailBoardPanel>> = {}) {
  return (
    <RailBoardPanel board={BOARD} cards={CARDS} loadAgentRoles onOpenSessions={() => {}} {...over} />
  );
}

describe("Board panel — path and mode", () => {
  it("shows the three-part path and a switch-session control", () => {
    const onOpenSessions = vi.fn();
    render(panel({ onOpenSessions }));
    expect(document.querySelector('[data-role="rail-board-path"]')?.textContent).toContain("Workspace");
    expect(document.querySelector('[data-role="rail-board-path"]')?.textContent).toContain("Sprint board");
    fireEvent.click(document.querySelector('[data-role="rail-switch-session"]')!);
    expect(onOpenSessions).toHaveBeenCalledOnce();
  });

  it("says Autônomo only for an autonomous board", () => {
    const { unmount } = render(panel({ board: { ...BOARD, autonomous: true } }));
    expect(document.querySelector('[data-role="rail-board-autonomous"]')?.textContent).toMatch(/autônomo/i);
    unmount();
    render(panel());
    expect(document.querySelector('[data-role="rail-board-autonomous"]')).toBeNull();
  });
});

describe("Board panel — orchestrator mark", () => {
  it("shows the marked card, with its id in the tooltip", () => {
    render(panel({ board: { ...BOARD, orchestratorCardId: "4242" } }));
    const badge = document.querySelector('[data-role="topbar-orchestrator-badge"]') as HTMLElement;
    expect(badge.textContent).toBe("Spawn limpo");
    expect(badge.getAttribute("data-missing")).toBeNull();
    expect(badge.title).toContain("4242");
    expect(document.querySelector('[data-role="topbar-orchestrator-empty"]')).toBeNull();
  });

  it("shows an orphan mark honestly instead of hiding it", () => {
    render(panel({ board: { ...BOARD, orchestratorCardId: "dead-99", orchestratorPresent: false } }));
    const badge = document.querySelector('[data-role="topbar-orchestrator-badge"]') as HTMLElement;
    expect(badge.getAttribute("data-missing")).toBe("true");
    expect(badge.textContent?.toLowerCase()).toMatch(/ausente/);
    expect(badge.title).toContain("dead-99");
    expect(document.querySelector('[data-role="topbar-orchestrator-empty"]')).toBeNull();
  });

  it("a board with no mark shows the neutral empty state and no badge", () => {
    render(panel());
    const empty = document.querySelector('[data-role="topbar-orchestrator-empty"]') as HTMLElement;
    expect(empty.textContent).toBe("nenhum marcado");
    expect(empty.title.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-role="topbar-orchestrator-badge"]')).toBeNull();
  });
});

describe("Board panel — open agents", () => {
  it("counts open agent cards only, and never says 'ativos'", async () => {
    render(panel());
    const section = document.querySelector('[data-role="rail-board-agents"]')!;
    expect(section.textContent).toContain("Agentes abertos · 2");
    expect(section.textContent).not.toContain("ativos");
    await waitFor(() => expect(boardAgentRoles).toHaveBeenCalledWith("b1"));
  });

  it("lists name and status, with the card id when there is no label", () => {
    render(panel({ loadAgentRoles: false }));
    const rows = Array.from(document.querySelectorAll("[data-role='topbar-agent-row']"));
    expect(rows.map((r) => r.getAttribute("data-card-id"))).toEqual(["4242", "4243"]);
    expect(rows[0].textContent).toContain("Spawn limpo");
    expect(rows[0].textContent).toContain("trabalhando");
    expect(rows[1].textContent).toContain("4243");
  });

  it("adds one role per open task once the main process answers, none for a card with no task", async () => {
    render(panel());
    await waitFor(() =>
      expect(document.querySelectorAll("[data-role='topbar-agent-role']").length).toBe(2),
    );
    const rows = Array.from(document.querySelectorAll("[data-role='topbar-agent-row']"));
    const roles = Array.from(rows[0].querySelectorAll("[data-role='topbar-agent-role']")).map((r) => r.textContent);
    expect(roles[0]).toContain("implementa");
    expect(roles[0]).toContain("aaaa1111");
    expect(roles[1]).toContain("revisa");
    expect(rows[1].querySelectorAll("[data-role='topbar-agent-role']")).toHaveLength(0);
    expect(rows[1].textContent).not.toContain("ocioso");
  });

  it("does not ask the main process for the prototype seed", () => {
    render(panel({ loadAgentRoles: false }));
    expect(boardAgentRoles).not.toHaveBeenCalled();
  });

  it("states an empty board plainly", () => {
    render(panel({ cards: [] }));
    expect(document.querySelector('[data-role="rail-board-agents"]')?.textContent).toContain("nenhum card de agente neste board");
  });
});
