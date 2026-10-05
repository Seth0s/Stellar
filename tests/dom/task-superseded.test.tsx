import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { TaskBoardItem } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * The "superseded by #Y" chip is rendered: neutral, clickable to the
 * SUBSTITUTE. The target is distinguished by its prompt in the modal —
 * swapping the id for another one fails here.
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
    prompt,
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
});

function stub(tasks: TaskBoardItem[]) {
  const noop = () => {};
  return (
    <TaskCard
      rect={{ x: 0, y: 0, w: 700, h: 400 }}
      zoom={1}
      zIndex={1}
      displayName="Fila"
      tasks={tasks}
      concurrencyCapRaw={null}
      activeBoardId="b1"
      boardNames={{ b1: "Maestro" }}
      taskCountsByBoard={{ b1: 2 }}
      onChange={noop}
      onCommit={noop}
      onRaise={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
      onApproveCompletion={noop}
    />
  );
}

describe("chip superseded → #Y", () => {
  it("a task substituída mostra o chip neutro com o id da substituta", () => {
    render(stub([task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: NEW }), task(NEW, "SUBSTITUTA")]));
    const chip = document.querySelector('[data-part="superseded-chip"]') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    // shortTaskId = 8 chars, like the rest of the app.
    expect(chip.textContent).toContain("bbbb2222");
    expect(chip.textContent?.toLowerCase()).toContain("substitu");
  });

  it("clicar no chip abre o modal da SUBSTITUTA (pelo prompt dela)", async () => {
    render(stub([task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: NEW }), task(NEW, "SUBSTITUTA")]));
    const chip = document.querySelector('[data-part="superseded-chip"]') as HTMLButtonElement;
    fireEvent.click(chip);

    const promptBlock = await waitFor(() => {
      const el = document.querySelector('[data-part="task-detail-prompt-original"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(promptBlock.textContent).toContain("SUBSTITUTA");
    expect(promptBlock.textContent).not.toContain("VELHA");
  });

  it("sem alvo não há chip de substituída (cai no chip de fase comum)", () => {
    render(stub([task(OLD, "VELHA", { status: "superseded", phase: "superseded", supersededBy: null })]));
    expect(document.querySelector('[data-part="superseded-chip"]')).toBeNull();
  });
});
