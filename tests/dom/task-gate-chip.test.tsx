import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { TaskBoardItem } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * Gate chip on the Fila V3 tile: live progress ("rodando gates i/N · command")
 * and the final verdict. Verdict labels stay the V3 compact form (✓ / ✕);
 * progress + title match HEAD (prototype omits those states).
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
    promptPreview: "faz X",
    promptTruncated: false,
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
    />
  );
}

function chip(): HTMLElement | null {
  return document.querySelector('[data-part="gate-chip"]');
}

describe("chip do gate na Fila V3", () => {
  it("andamento ao vivo: 'rodando gates i/N · comando' com tom running", () => {
    render(
      stub([task({ gateProgress: { index: 1, total: 2, command: "npm run check:types" } })]),
    );
    const el = chip();
    expect(el).toBeTruthy();
    expect(el!.getAttribute("data-tone")).toBe("running");
    expect(el!.textContent).toContain("rodando gates 1/2");
    expect(el!.textContent).toContain("npm run check:types");
  });

  it("veredito verde: chip 'gates ✓' com tom good", () => {
    render(
      stub([
        task({
          gateRun: { ok: true, passed: 2, total: 2, failedCommand: null, isolation: null, failedOutput: null },
        }),
      ]),
    );
    const el = chip();
    expect(el).toBeTruthy();
    expect(el!.getAttribute("data-tone")).toBe("good");
    expect(el!.textContent).toContain("gates ✓");
  });

  it("veredito vermelho: tom danger, rótulo ✕ e title com comando, modo e final da saída", () => {
    render(
      stub([
        task({
          gateRun: {
            ok: false,
            passed: 1,
            total: 2,
            failedCommand: "npm run check:types",
            isolation: { mode: "isolated", reason: null, undeclaredInTerritory: ["src/b.ts"] },
            failedOutput: "ERRO: tipo inválido",
          },
        }),
      ]),
    );
    const el = chip();
    expect(el).toBeTruthy();
    expect(el!.getAttribute("data-tone")).toBe("danger");
    expect(el!.textContent).toMatch(/check:types/);
    expect(el!.textContent).toContain("✕");
    const title = el!.getAttribute("title")!;
    expect(title).toContain("npm run check:types");
    expect(title).toContain("isolado");
    expect(title).toContain("ERRO: tipo inválido");
  });

  it("sem gate medido e sem andamento: nenhum chip", () => {
    render(stub([task()]));
    expect(chip()).toBeNull();
  });
});
