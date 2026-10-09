import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { TaskBoardItem } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * Superseded on Fila V3: the old task sits in the superseded rail with a
 * phrase naming the substitute id; opening it shows the Agora "open successor"
 * action, which opens the SUBSTITUTE's detail (prompt distinguishes them).
 */

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
  useAvailableAgentProviders: () => [],
}));

import { TaskCard } from "@renderer/TaskCard";

const OLD = "aaaa1111-1111-4111-8111-111111111111";
const NEW = "bbbb2222-2222-4222-8222-222222222222";

function task(id: string, prompt: string, over: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id,
    promptPreview: prompt,
    promptTruncated: false,
    provider: "claude",
    status: "pending",
    cardId: null,
    boardId: "b1",
    order: 0,
    suggestedOrder: null,
    implicitOrder: null,
    retryCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActor: null,
    cards: [],
    report: null,
    deps: [],
    depStatuses: {},
    purpose: null,
    review: null,
    depPurposes: {},
    cardAlive: false,
    phase: "ready",
    statusTransitions: [],
    divergedStatus: null,
    divergedActor: null,
    requestedStatus: null,
    requestedReason: null,
    requestedBy: null,
    requestedAt: null,
    supersededBy: null,
    blockedQuestion: null,
    verdicts: [],
    firstActor: null,
    interruptionReason: null,
    gateRun: null,
    gateProgress: null,
    ...over,
  } as unknown as TaskBoardItem;
}

beforeEach(() => {
  setLocale("pt-BR");
  (window as unknown as { tasks: Record<string, unknown> }).tasks = {
    listSprints: async () => [],
    sprintSnapshot: async () => ({ ok: false }),
    transitionsByBoard: async () => [],
    onChanged: () => () => {},
    onSprintsChanged: () => () => {},
    onScopeChanged: () => () => {},
    getPrompt: async (taskId: string) => ({ ok: true, prompt: taskId === NEW ? "SUBSTITUTA" : "VELHA" }),
    updatePrompt: async () => ({ ok: true }),
    respondStatusAsk: async () => ({ ok: true }),
    create: async () => ({ ok: true, taskId: "x" }),
    renameSprint: async () => ({ ok: true }),
    closeSprint: async () => ({ ok: true }),
    deleteSprint: async () => ({ ok: true }),
    move: async () => ({ ok: true }),
    gateDiff: async () => null,
  };
  (window as unknown as { bus?: Record<string, unknown> }).bus = {
    gateLockStatus: async () => ({ ok: true, locks: [] }),
  };
  (window as unknown as { pty?: Record<string, unknown> }).pty = {
    health: async () => null,
  };
});

function stub(tasks: TaskBoardItem[], openId?: string | null) {
  const noop = () => {};
  return (
    <TaskCard
      cardId="fila-test"
      rect={{ x: 0, y: 0, w: 700, h: 400 }}
      zoom={1}
      zIndex={1}
      displayName="Fila"
      tasks={tasks}
      concurrencyCapRaw={null}
      activeBoardId="b1"
      boardNames={{ b1: "Maestro" }}
      onChange={noop}
      onCommit={noop}
      onRaise={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
      onApproveCompletion={noop}
      openTaskRequestId={openId ?? null}
      onOpenTaskHandled={noop}
    />
  );
}

describe("superseded na Fila V3", () => {
  it("a task substituída aparece no trilho com o id da substituta na frase", () => {
    render(stub([task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: NEW }), task(NEW, "SUBSTITUTA")]));
    const tile = document.querySelector('[data-part="queue-tile"][data-column="superseded"]') as HTMLElement;
    expect(tile).toBeTruthy();
    expect(tile.textContent).toContain("bbbb2222");
    expect(tile.textContent?.toLowerCase()).toMatch(/substitu|→/);
  });

  it("Abrir a nova task no detalhe abre o modal da SUBSTITUTA (pelo prompt)", async () => {
    render(
      stub(
        [task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: NEW }), task(NEW, "SUBSTITUTA")],
        OLD,
      ),
    );

    const openBtn = await waitFor(() => {
      const el = Array.from(document.querySelectorAll("button")).find((b) =>
        /Abrir a nova task/i.test(b.textContent ?? ""),
      );
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(openBtn);

    const promptBlock = await waitFor(() => {
      const el = document.querySelector('[data-part="task-detail-prompt-original"]');
      expect(el).toBeTruthy();
      expect(el!.textContent).toContain("SUBSTITUTA");
      return el!;
    });
    expect(promptBlock.textContent).not.toContain("VELHA");
  });

  it("sem alvo: tile superseded sem id de substituta inventado", () => {
    render(stub([task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: null })]));
    const tile = document.querySelector('[data-part="queue-tile"][data-column="superseded"]');
    expect(tile).toBeTruthy();
    expect(document.querySelector('[data-part="superseded-chip"]')).toBeNull();
  });
});
