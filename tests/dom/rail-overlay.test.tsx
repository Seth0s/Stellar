/**
 * The rail floats over the board, hides on request and comes back from the
 * left edge. jsdom has no layout, so these tests cover state and events —
 * geometry (44 px strip, 296 px panel, no board shift) is measured in the app
 * by scripts/verify/smoke-rail-overlay.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { Rail } from "@renderer/Rail";
import {
  RAIL_HIDDEN_KEY,
  HIDE_DELAY_MS,
  OPEN_BOARD_PANEL_EVENT,
  OPEN_SESSIONS_EVENT,
  REVEAL_DELAY_MS,
  SESSION_CREATE_EVENT,
  SESSION_EDIT_EVENT,
  ARCHIVED_OPEN_EVENT,
} from "@renderer/rail-visibility-decision";
import { setLocale } from "../../src/shared/i18n";

vi.mock("@renderer/useAgentAvailability", () => ({
  useAgentAvailability: () => ({ missing: [], checking: false }),
  useAvailableAgentProviders: () => [],
}));
vi.mock("@renderer/useProviderClassification", () => ({
  useProviderClassification: () => ({ dynamicIds: [], skippedIds: [] }),
}));

const noop = () => {};

function rail(over: Partial<React.ComponentProps<typeof Rail>> = {}) {
  return (
    <Rail
      tool="pointer"
      setTool={noop}
      strokeColors={["#fff", "#f00", "#0f0", "#00f", "#ff0"]}
      strokeColor="#fff"
      setStrokeColor={noop}
      strokeWidth={4}
      setStrokeWidth={noop}
      providers={["claude", "bash"]}
      newProvider="claude"
      setNewProvider={noop}
      newResumeId=""
      setNewResumeId={noop}
      newContinueLast={false}
      setNewContinueLast={noop}
      newModel=""
      setNewModel={noop}
      newEffort=""
      setNewEffort={noop}
      newSystemPrompt=""
      setNewSystemPrompt={noop}
      newCwd=""
      setNewCwd={noop}
      onCreateTerminal={noop}
      onCreate={noop}
      onCreateMedia={noop}
      aiBusy={false}
      summarizeDisabled={false}
      onReorganize={noop}
      onSummarize={noop}
      cards={[]}
      onJumpToCard={noop}
      onOpenSettings={noop}
      onOpenShortcuts={noop}
      onGoHome={noop}
      onOpenPalette={noop}
      paletteOpen={false}
      board={{
        boardId: "b1",
        rootName: "Workspace",
        project: "Demo project",
        boardName: "Sprint board",
        autonomous: false,
        orchestratorCardId: null,
        orchestratorPresent: true,
      }}
      boards={[
        { id: "b1", name: "Sprint board", project: "Demo project", cwd: "", autonomous: false, concurrency_cap: null, orchestrator_card_id: null },
        { id: "b2", name: "Backlog", project: "Demo project", cwd: "", autonomous: false, concurrency_cap: null, orchestrator_card_id: null },
        { id: "b3", name: "Notes", project: "Estudos", cwd: "", autonomous: false, concurrency_cap: null, orchestrator_card_id: null },
      ]}
      boardCounts={{ b1: { agents: 3 }, b2: { agents: 1 } }}
      onSwitchBoard={noop}
      {...over}
    />
  );
}

const dock = () => document.querySelector('[data-role="rail-dock"]') as HTMLElement;
const panelEl = () => document.querySelector('[data-role="rail-panel"]');
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;

beforeEach(() => {
  setLocale("pt-BR");
  localStorage.clear();
  Object.assign(window, {
    providerUsage: { get: vi.fn(async () => undefined) },
    store: { boardAgentRoles: vi.fn(async () => []), boards: { list: vi.fn(async () => []) } },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("provider usage reads", () => {
  it("reads each provider's usage once, not on every render", async () => {
    const get = window.providerUsage.get as ReturnType<typeof vi.fn>;
    render(rail());
    await act(async () => {});
    const first = get.mock.calls.length;
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(get.mock.calls.length).toBe(first);
  });
});

describe("rail strip", () => {
  it("starts as the strip alone, with no star and no 'open' button", () => {
    render(rail());
    expect(panelEl()).toBeNull();
    expect(dock().getAttribute("data-rail-step")).toBe("closed");
    expect(document.querySelector(".rail-toggle")).toBeNull();
    expect(document.querySelector('[data-role="rail-hide"]')).toBeTruthy();
    // The old logo mark is gone: the first control is Home.
    expect(document.querySelector(".rail > :first-child")?.getAttribute("data-role")).toBe("rail-home");
  });

  it("Home goes back to the sessions", () => {
    const onGoHome = vi.fn();
    render(rail({ onGoHome }));
    fireEvent.click(document.querySelector('[data-role="rail-home"]')!);
    expect(onGoHome).toHaveBeenCalledOnce();
  });

  it("the palette button opens the palette and lights while it is open", () => {
    const onOpenPalette = vi.fn();
    const { rerender } = render(rail({ onOpenPalette }));
    const btn = document.querySelector('[data-role="rail-palette"]') as HTMLElement;
    fireEvent.click(btn);
    expect(onOpenPalette).toHaveBeenCalledOnce();
    const off = btn.className;
    rerender(rail({ onOpenPalette, paletteOpen: true }));
    expect((document.querySelector('[data-role="rail-palette"]') as HTMLElement).className).not.toBe(off);
  });

  it("an autonomous board leaves an amber dot on the Board button", () => {
    const { rerender } = render(rail());
    expect(document.querySelector('[data-role="rail-board-dot"]')).toBeNull();
    rerender(
      rail({
        board: {
          boardId: "b1",
          rootName: "Workspace",
          project: "Demo project",
          boardName: "Sprint board",
          autonomous: true,
          orchestratorCardId: null,
          orchestratorPresent: true,
        },
      }),
    );
    expect(document.querySelector('[data-role="rail-board-dot"]')).toBeTruthy();
  });
});

describe("panel over the board", () => {
  it("a strip button opens its panel and a second press closes it", () => {
    render(rail());
    fireEvent.click(byLabel("Novo card"));
    expect(panelEl()).toBeTruthy();
    expect(dock().getAttribute("data-panel-open")).toBe("1");
    fireEvent.click(byLabel("Novo card"));
    expect(panelEl()).toBeNull();
  });

  it("a press outside the rail dismisses the panel and a press inside does not", () => {
    render(rail());
    fireEvent.click(byLabel("Novo card"));
    fireEvent.pointerDown(panelEl()!);
    expect(panelEl()).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(panelEl()).toBeNull();
  });

  it("Esc dismisses it too", () => {
    render(rail());
    fireEvent.click(byLabel("Achar card (Ctrl F)"));
    expect(panelEl()).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelEl()).toBeNull();
  });

  it("the tools panel is gone: the pointer button selects the tool and opens nothing", () => {
    const setTool = vi.fn();
    render(rail({ setTool }));
    fireEvent.click(byLabel("Ponteiro (V)"));
    expect(setTool).toHaveBeenCalledWith("pointer");
    expect(panelEl()).toBeNull();
  });

  it("the Board button opens the Board panel", () => {
    render(rail());
    fireEvent.click(document.querySelector('[data-role="rail-board"]')!);
    expect(panelEl()?.getAttribute("aria-label")).toBe("Board");
    expect(document.querySelector('[data-role="rail-board-panel"]')).toBeTruthy();
  });

  it("the pen opens its options", () => {
    const { rerender } = render(rail());
    rerender(rail({ tool: "pen" }));
    expect(panelEl()?.getAttribute("aria-label")).toBe("Caneta");
  });
});

describe("hide and edge reveal", () => {
  function hide() {
    fireEvent.click(document.querySelector('[data-role="rail-hide"]')!);
  }

  it("hides the strip, persists the choice and leaves an edge band with a 3 px hint", () => {
    render(rail());
    hide();
    expect(localStorage.getItem(RAIL_HIDDEN_KEY)).toBe("1");
    expect(dock().getAttribute("data-rail-hidden")).toBe("1");
    expect(document.querySelector(".rail")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector('[data-role="rail-edge"]')).toBeTruthy();
    expect(document.querySelector('[data-role="rail-edge-hint"]')).toBeTruthy();
  });

  it("starts hidden when the preference was saved", () => {
    localStorage.setItem(RAIL_HIDDEN_KEY, "1");
    render(rail());
    expect(dock().getAttribute("data-rail-hidden")).toBe("1");
  });

  it("closes an open panel when it hides", () => {
    render(rail());
    fireEvent.click(byLabel("Novo card"));
    hide();
    expect(panelEl()).toBeNull();
  });

  it("a pointer dwell on the edge reveals it after the delay, then it leaves again", () => {
    vi.useFakeTimers();
    render(rail());
    hide();
    const edge = document.querySelector('[data-role="rail-edge"]') as HTMLElement;

    fireEvent.pointerMove(edge, { pointerType: "mouse", clientX: 4 });
    expect(dock().getAttribute("data-rail-revealed")).toBe("0");
    act(() => {
      vi.advanceTimersByTime(REVEAL_DELAY_MS);
    });
    expect(dock().getAttribute("data-rail-revealed")).toBe("1");
    // Revealed does not touch the saved preference.
    expect(localStorage.getItem(RAIL_HIDDEN_KEY)).toBe("1");

    // Nothing holds it: it goes away after the grace period.
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS);
    });
    expect(dock().getAttribute("data-rail-revealed")).toBe("0");
  });

  it("a pointer outside the band does not reveal it", () => {
    vi.useFakeTimers();
    render(rail());
    hide();
    const edge = document.querySelector('[data-role="rail-edge"]') as HTMLElement;
    fireEvent.pointerMove(edge, { pointerType: "mouse", clientX: 14 });
    act(() => {
      vi.advanceTimersByTime(REVEAL_DELAY_MS * 3);
    });
    expect(dock().getAttribute("data-rail-revealed")).toBe("0");
  });

  it("a touch drag from the edge reveals it", () => {
    render(rail());
    hide();
    const edge = document.querySelector('[data-role="rail-edge"]') as HTMLElement;
    fireEvent.pointerDown(edge, { pointerType: "touch", clientX: 3 });
    fireEvent.pointerMove(edge, { pointerType: "touch", clientX: 12 });
    expect(dock().getAttribute("data-rail-revealed")).toBe("0");
    fireEvent.pointerMove(edge, { pointerType: "touch", clientX: 40 });
    expect(dock().getAttribute("data-rail-revealed")).toBe("1");
  });

  it("a revealed rail stays while a panel is open", () => {
    vi.useFakeTimers();
    render(rail());
    hide();
    const edge = document.querySelector('[data-role="rail-edge"]') as HTMLElement;
    fireEvent.pointerMove(edge, { pointerType: "mouse", clientX: 2 });
    act(() => {
      vi.advanceTimersByTime(REVEAL_DELAY_MS);
    });
    fireEvent.click(byLabel("Novo card"));
    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS * 3);
    });
    expect(dock().getAttribute("data-rail-revealed")).toBe("1");
    expect(panelEl()).toBeTruthy();
  });
});

describe("board path in the title strip", () => {
  const fire = () => act(() => void window.dispatchEvent(new Event(OPEN_BOARD_PANEL_EVENT)));

  it("opens the Board panel and a second request closes it", () => {
    render(rail());
    fire();
    expect(panelEl()?.getAttribute("aria-label")).toBe("Board");
    fire();
    expect(panelEl()).toBeNull();
  });

  it("brings a hidden rail in to hold the panel", () => {
    render(rail());
    fireEvent.click(document.querySelector('[data-role="rail-hide"]')!);
    expect(dock().getAttribute("data-rail-revealed")).toBe("0");
    fire();
    expect(dock().getAttribute("data-rail-revealed")).toBe("1");
    expect(panelEl()?.getAttribute("aria-label")).toBe("Board");
    // It stays while the panel is open.
    expect(localStorage.getItem(RAIL_HIDDEN_KEY)).toBe("1");
  });

  it("a press on the path button does not close the panel before its click toggles it", () => {
    render(rail());
    const anchor = document.createElement("button");
    anchor.setAttribute("data-rail-anchor", "");
    document.body.appendChild(anchor);
    fire();
    expect(panelEl()).toBeTruthy();
    fireEvent.pointerDown(anchor);
    expect(panelEl()).toBeTruthy();
    anchor.remove();
  });
});

describe("session list", () => {
  const openList = () => {
    fireEvent.click(byLabel("Board e sessão"));
    fireEvent.click(document.querySelector('[data-role="rail-switch-session"]')!);
  };
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-role="session-row"]'));

  it("'Trocar de sessão…' swaps the Board panel for the list; Board goes back", () => {
    render(rail());
    openList();
    expect(panelEl()?.getAttribute("aria-label")).toBe("Sessões");
    expect(document.querySelector(".board-list")).toBeNull();
    fireEvent.click(document.querySelector('[data-role="rail-sessions-back"]')!);
    expect(panelEl()?.getAttribute("aria-label")).toBe("Board");
  });

  it("lists the sessions of the scope grouped by project, active marked, with agent counts", () => {
    render(rail());
    openList();
    expect(rows().map((r) => r.textContent)).toEqual([
      "Sprint board3 agentes abertos",
      "Backlog1 agente aberto",
      "Notesnenhum agente aberto",
    ]);
    expect(rows().map((r) => r.getAttribute("data-active"))).toEqual(["true", null, null]);
    expect(document.querySelector('[data-role="rail-sessions"]')?.textContent).toContain("Estudos");
  });

  it("shows only the sessions of the open board's scope (owners read from the database)", async () => {
    (window.store.boards.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "b1", account_profile_id: null },
      { id: "b2", account_profile_id: "p1" },
      { id: "b3", account_profile_id: null },
    ]);
    render(rail());
    openList();
    await act(async () => {});
    expect(rows().map((r) => r.getAttribute("data-board-id"))).toEqual(["b1", "b3"]);
  });

  it("picking a session switches and closes the panel", () => {
    const onSwitchBoard = vi.fn();
    render(rail({ onSwitchBoard }));
    openList();
    fireEvent.click(rows()[1]!.querySelector("button")!);
    expect(onSwitchBoard).toHaveBeenCalledWith("b2");
    expect(panelEl()).toBeNull();
  });

  it("the pencil, '+ Nova sessão' and the archived button ask the top bar's modals", () => {
    render(rail());
    const seen: string[] = [];
    const on = (name: string) => window.addEventListener(name, (e) => seen.push(`${name}:${(e as CustomEvent).detail?.boardId ?? ""}`), { once: true });
    openList();
    on(SESSION_EDIT_EVENT);
    fireEvent.click(rows()[2]!.querySelector('[data-role="edit-session"]')!);
    openList();
    on(SESSION_CREATE_EVENT);
    fireEvent.click(document.querySelector('[data-role="session-new"]')!);
    openList();
    on(ARCHIVED_OPEN_EVENT);
    fireEvent.click(document.querySelector('[data-role="open-archived"]')!);
    expect(seen).toEqual([`${SESSION_EDIT_EVENT}:b3`, `${SESSION_CREATE_EVENT}:`, `${ARCHIVED_OPEN_EVENT}:`]);
  });

  it("the open-sessions event shows the list even from a hidden rail", () => {
    render(rail());
    fireEvent.click(document.querySelector('[data-role="rail-hide"]')!);
    act(() => void window.dispatchEvent(new Event(OPEN_SESSIONS_EVENT)));
    expect(dock().getAttribute("data-rail-revealed")).toBe("1");
    expect(panelEl()?.getAttribute("aria-label")).toBe("Sessões");
  });
});
