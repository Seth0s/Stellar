/**
 * O CHIP DE VÍNCULO DO HEADER ABRE A TASK — a corrente inteira (task b3f90d1d).
 *
 * O dono pediu literalmente: "se clicar ela abre o modal da task". O alvo já
 * existia (`TaskDetailModal`, dentro de TaskCard.tsx) mas era estado PRIVADO
 * daquele card: nenhum outro card alcançava. O conserto é um pedido de UI
 * subindo pelo ancestral comum (App.tsx) e sendo consumido pela Fila.
 *
 * POR QUE DOM E NÃO SMOKE: a suíte de CI não roda smoke, e a metade que pode
 * quebrar em silêncio é a ATRIBUIÇÃO — abrir o modal é fácil, abrir o da
 * TASK CERTA é o que precisa ficar preso. Aqui os dois lados são exercitados
 * com ids e prompts DISTINTOS, então trocar um pelo outro falha.
 *
 * METADE 1 (produtor): o chip do TerminalCard entrega o id do vínculo
 * clicado — inclusive o `+N`, que abre o PRIMEIRO que não coube.
 * METADE 2 (consumidor): o TaskCard, ao receber o pedido, abre o
 * `TaskDetailModal` DAQUELA task (provado pelo prompt dela, que é o único
 * texto que distingue uma task da outra dentro do modal) e devolve o
 * "já abri" para o App limpar o pedido.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskBoardItem } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

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

import { TerminalCard } from "@renderer/TerminalCard";
import { TaskCard } from "@renderer/TaskCard";

const T1 = "aaaa1111-1111-4111-8111-111111111111";
const T2 = "bbbb2222-2222-4222-8222-222222222222";
const T3 = "cccc3333-3333-4333-8333-333333333333";

let cardAgentRoles: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  vi.clearAllMocks();
  cardAgentRoles = vi.fn(async () => [
    {
      cardId: "97924195",
      label: "Identidade",
      provider: "cline",
      roles: [
        { taskId: T1, role: "implementer" },
        { taskId: T2, role: "reviewer" },
        { taskId: T3, role: "implementer" },
      ],
    },
  ]);
  (window as unknown as { store: Record<string, unknown> }).store = {
    ...((window as unknown as { store?: Record<string, unknown> }).store ?? {}),
    cardAgentRoles,
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
      id="97924195"
      rect={{ x: 0, y: 0, w: 700, h: 300 }}
      zoom={1}
      zIndex={1}
      providerId="cline"
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
      displayName="Identidade"
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

describe("metade 1 (produtor) — o chip entrega o id do VÍNCULO clicado", () => {
  it("3 vínculos: 2 chips inline + o indicador '+1', e cada um abre o SEU vínculo", async () => {
    const onOpenTask = vi.fn();
    render(terminalStub({ onOpenTask }));

    await waitFor(() => {
      expect(document.querySelectorAll(".card-head-task").length).toBe(2);
    });
    const more = document.querySelector('[data-role="terminal-task-links-more"]') as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent?.trim()).toBe("+1");

    const chips = document.querySelectorAll(".card-head-task");
    fireEvent.click(chips[0]!);
    expect(onOpenTask).toHaveBeenLastCalledWith(T1);
    fireEvent.click(chips[1]!);
    expect(onOpenTask).toHaveBeenLastCalledWith(T2);

    // O indicador não é só um aviso: ele abre o PRIMEIRO que não coube.
    fireEvent.click(more);
    expect(onOpenTask).toHaveBeenLastCalledWith(T3);
    expect(onOpenTask).toHaveBeenCalledTimes(3);
  });

  it("zero vínculos: o grupo NÃO existe (ausência honesta, nada de 'ocioso')", async () => {
    cardAgentRoles.mockResolvedValueOnce([{ cardId: "97924195", label: "Identidade", provider: "cline", roles: [] }]);
    render(terminalStub({ onOpenTask: vi.fn() }));

    await waitFor(() => expect(cardAgentRoles).toHaveBeenCalled());
    expect(document.querySelector('[data-role="terminal-task-links"]')).toBeNull();
  });
});

describe("metade 2 (consumidor) — o pedido abre o modal DA TASK CERTA", () => {
  function task(id: string, prompt: string, status: string): TaskBoardItem {
    return {
      id,
      prompt,
      provider: "cline",
      status,
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
      gates: null,
      territory: [],
      sprintId: null,
      orphan: false,
      statusTransitions: [],
      cardAlive: false,
      verdicts: [],
    } as unknown as TaskBoardItem;
  }

  function taskCardStub(overrides: Record<string, unknown> = {}) {
    const noop = () => {};
    return (
      <TaskCard
        rect={{ x: 0, y: 0, w: 700, h: 400 }}
        zoom={1}
        zIndex={1}
        displayName="Fila"
        tasks={[task(T1, "PROMPT UM", "done"), task(T2, "PROMPT DOIS", "pending")]}
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
        {...overrides}
      />
    );
  }

  it("com o pedido da T2, abre o modal dela (e não o da T1) e avisa que abriu", async () => {
    const onOpenTaskHandled = vi.fn();
    render(taskCardStub({ openTaskRequestId: T2, onOpenTaskHandled }));

    const promptBlock = await waitFor(() => {
      const el = document.querySelector('[data-part="task-detail-prompt-original"]');
      expect(el).toBeTruthy();
      return el!;
    });
    // O discriminador: o prompt da task aberta. Duas tasks diferentes, dois
    // prompts — trocar o id pedido por outro reprova aqui.
    expect(promptBlock.textContent).toContain("PROMPT DOIS");
    expect(promptBlock.textContent).not.toContain("PROMPT UM");
    expect(onOpenTaskHandled).toHaveBeenCalled();
  });

  it("CONTROLE sem pedido: nenhum modal aberto", async () => {
    render(taskCardStub({ openTaskRequestId: null }));
    await waitFor(() => expect(document.querySelector('[data-part="task-detail-prompt-original"]')).toBeNull());
  });

  it("CONTROLE pedido de task que NÃO está no board: não abre modal nenhum (e o pedido é consumido)", async () => {
    const onOpenTaskHandled = vi.fn();
    render(taskCardStub({ openTaskRequestId: T3, onOpenTaskHandled }));

    await waitFor(() => expect(onOpenTaskHandled).toHaveBeenCalled());
    expect(document.querySelector('[data-part="task-detail-prompt-original"]')).toBeNull();
  });
});

