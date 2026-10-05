import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { TaskBoardItem } from "../../src/preload/index";
import type { DiffCaptureEvidence } from "../../src/main/gate-runner";
import { setLocale } from "../../src/shared/i18n";

/**
 * The detail modal's observed-diff list, past the grouping threshold: rows are
 * grouped by folder, and the untracked note is an icon with its text as tooltip
 * instead of a second line. Below the threshold the list stays flat.
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

const ID = "d00a03fa-1111-2222-3333-444444444444";

function task(over: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: ID,
    prompt: "faz X",
    provider: "claude",
    status: "running",
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
    phase: "running",
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

function evidence(paths: { path: string; status: string }[]): DiffCaptureEvidence {
  return {
    gitRoot: "/repo",
    stat: "",
    patch: "",
    patchTruncated: false,
    files: paths.map((p) => ({ path: p.path, status: p.status, inTerritory: false, territoryDeclared: true })),
    filesTruncated: false,
    total: paths.length,
    outsideTerritory: paths.length,
    territoryDeclared: true,
    note: "nota",
  };
}

let nextEvidence: DiffCaptureEvidence | null = null;

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
    gateDiff: async () => nextEvidence,
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
      openTaskRequestId={ID}
      onOpenTaskHandled={noop}
    />
  );
}

describe("detalhe: lista de arquivos do diff", () => {
  it("acima do limiar: agrupa por pasta e o untracked vira ícone com tooltip na MESMA linha", async () => {
    nextEvidence = evidence([
      ...Array.from({ length: 13 }, (_, i) => ({ path: `src/main/f${i}.ts`, status: " M" })),
      ...Array.from({ length: 12 }, (_, i) => ({ path: `tests/unit/t${i}.ts`, status: " M" })),
      { path: "novo/arquivo.ts", status: "??" },
    ]);
    render(stub([task()]));

    await waitFor(() => {
      expect(document.querySelector('[data-part="task-diff-files"]')).toBeTruthy();
    });

    const groups = document.querySelectorAll('[data-part="task-diff-group"]');
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).toContain("src/main");

    const untracked = document.querySelector('[data-part="task-diff-untracked"]');
    expect(untracked).toBeTruthy();
    expect(untracked!.getAttribute("title")).toContain("patch");
  });

  it("abaixo do limiar: lista plana, sem cabeçalho de pasta", async () => {
    nextEvidence = evidence([
      { path: "src/main/a.ts", status: " M" },
      { path: "src/main/b.ts", status: " M" },
    ]);
    render(stub([task()]));

    await waitFor(() => {
      expect(document.querySelector('[data-part="task-diff-files"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-part="task-diff-group"]')).toBeNull();
    expect(document.querySelectorAll('[data-part="task-diff-file"]').length).toBe(2);
  });
});
