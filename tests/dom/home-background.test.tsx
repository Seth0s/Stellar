import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { BoardBackgroundStatus, BoardRow, BoardSummary } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * Home background-session UI: the running indicator, the "waiting on you"
 * state, and "Stop session" (with/without confirmation). The decision
 * (`decideStopSessionConfirm`) only confirms when an agent is on the session.
 */

vi.mock("@renderer/useAgentAvailability", () => ({
  useAgentAvailability: () => ({ missing: [], checking: false }),
  useAvailableAgentProviders: () => [],
}));

import { Home } from "@renderer/Home";

const BOARD: BoardRow = {
  id: "b1",
  name: "Sessão 1",
  project: "proj",
  cwd: "/tmp/proj",
  created_at: 1_000,
  updated_at: 1_000,
  last_accessed_at: 1_000,
  autonomous: false,
  concurrency_cap: null,
  orchestrator_card_id: null,
} as unknown as BoardRow;

const SUMMARY: BoardSummary = { providers: [], tasksRunning: 0, tasksAwaitingReview: 0, awaitingReview: [] };

function background(entry: { alive: boolean; agents: number; awaiting: number }): BoardBackgroundStatus {
  return { boards: { b1: entry }, backgroundCount: entry.alive ? 1 : 0, maxBackgroundSessions: 4, overCap: false };
}

beforeEach(() => {
  setLocale("pt-BR");
  (window as unknown as { system: Record<string, unknown> }).system = { homeDir: "/home/u" };
  (window as unknown as { tasks?: unknown }).tasks = {};
});

function renderHome(over: { backgroundStatus?: BoardBackgroundStatus | null; onStopBoard?: (id: string) => void } = {}) {
  const noop = () => {};
  return render(
    <Home
      boards={[BOARD]}
      boardCounts={{ b1: { agents: 2, tasks: 0, archived: 0 } as never }}
      summaries={{ b1: SUMMARY }}
      backgroundStatus={over.backgroundStatus ?? null}
      onStopBoard={over.onStopBoard ?? noop}
      workspaceRoot="/tmp"
      defaultCwd="/tmp/proj"
      onChangeRoot={noop}
      onNavigateRoot={noop}
      onOpenBoard={noop}
      onCreateBoard={noop}
      onUpdateBoard={noop}
      onDeleteBoard={noop}
      onOpenInbox={noop}
    />,
  );
}

describe("Home — background session indicator", () => {
  it("shows 'rodando em segundo plano · N agentes' when the session is live", () => {
    renderHome({ backgroundStatus: background({ alive: true, agents: 2, awaiting: 0 }) });
    const ind = document.querySelector('[data-part="session-background"]') as HTMLElement;
    expect(ind).toBeTruthy();
    expect(ind.textContent).toContain("2 agentes");
  });

  it("shows 'esperando você' and marks the dot when an agent is awaiting", () => {
    renderHome({ backgroundStatus: background({ alive: true, agents: 1, awaiting: 1 }) });
    const ind = document.querySelector('[data-part="session-background"]') as HTMLElement;
    expect(ind.textContent).toContain("esperando você");
    expect(ind.querySelector("[data-awaiting='true']")).toBeTruthy();
  });

  it("no live processes → no indicator", () => {
    renderHome({ backgroundStatus: background({ alive: false, agents: 0, awaiting: 0 }) });
    expect(document.querySelector('[data-part="session-background"]')).toBeNull();
  });

  it("no projection loaded → no indicator (honest absence)", () => {
    renderHome({ backgroundStatus: null });
    expect(document.querySelector('[data-part="session-background"]')).toBeNull();
  });
});

describe("Home — Stop session", () => {
  it("with an agent running, asks for confirmation and stops on confirm", async () => {
    const onStopBoard = vi.fn();
    renderHome({ backgroundStatus: background({ alive: true, agents: 2, awaiting: 0 }), onStopBoard });
    fireEvent.click(document.querySelector('[data-role="stop-session"]')!);

    const dialog = await waitFor(() => {
      const el = document.querySelector('[aria-labelledby="confirm-title"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(dialog.textContent).toContain("Parar sessão?");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Parar sessão")!);
    expect(onStopBoard).toHaveBeenCalledWith("b1");
  });

  it("without an agent running, stops immediately (no confirmation)", () => {
    const onStopBoard = vi.fn();
    renderHome({ backgroundStatus: background({ alive: true, agents: 0, awaiting: 0 }), onStopBoard });
    fireEvent.click(document.querySelector('[data-role="stop-session"]')!);
    expect(onStopBoard).toHaveBeenCalledWith("b1");
    expect(document.querySelector('[aria-labelledby="confirm-title"]')).toBeNull();
  });
});
