/**
 * O contador de agentes do Topbar virou um controle próprio (task 49de95ce).
 *
 * O QUE ELE ERA: a linha afirmava "N agentes · N ativos" a partir de `active`,
 * que no store era A MESMA expressão SQL de `agents` (medido: 11 e 11) e, no
 * `StatusDot`, alimentava cor e tooltip ("N em execução") sem que nada tivesse
 * medido atividade. O que se sabe, e é o que a tela passa a dizer: quantos
 * cards de agente estão ABERTOS, e — no clique — o NOME de cada um e os
 * PAPÉIS dele nas tasks ainda abertas.
 *
 * POR QUE ESTE TESTE EXISTE ALÉM DO SMOKE (`smoke-topbar-agent-roles.mjs`, que
 * prova o mesmo no app real): a suíte de CI não roda smoke. Aqui ficam presas
 * as três regras que não podem voltar — o texto não afirma atividade, o card
 * sem task aparece SEM papel (nunca "ocioso"), e o contador NÃO volta para
 * dentro do `.topbar-title` (um `<button>`, onde um controle dentro do outro é
 * HTML inválido e quebra em leitor de tela antes de quebrar à vista).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Topbar } from "@renderer/Topbar";
import type { Board } from "@renderer/sessions";
import { setLocale } from "../../src/shared/i18n";

vi.mock("@renderer/useAgentAvailability", () => ({
  useAgentAvailability: () => ({ missing: [], checking: false }),
  useAvailableAgentProviders: () => [],
}));

const BOARD: Board = {
  id: "b1",
  name: "Maestro",
  project: "Projects",
  cwd: "/tmp",
  autonomous: false,
  concurrency_cap: null,
  orchestrator_card_id: null,
};

let boardAgentRoles: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  vi.clearAllMocks();
  boardAgentRoles = vi.fn(async () => [
    // Com nome e com papel (um deles por task ABERTA — o main já filtrou as
    // julgadas, então aqui só chega o que é vivo).
    {
      cardId: "4242",
      label: "Spawn limpo",
      provider: "commandcode",
      roles: [
        { taskId: "aaaa1111-1111-4111-8111-111111111111", role: "implementer" },
        { taskId: "bbbb2222-2222-4222-8222-222222222222", role: "reviewer" },
      ],
    },
    // Sem rótulo: a tela mostra o ID, nunca um nome inventado.
    // Sem task aberta: SEM papel — a ausência honesta.
    { cardId: "4243", label: null, provider: "claude", roles: [] },
  ]);
  (
    window as unknown as {
      winControls: {
        isFullscreen: () => Promise<boolean>;
        onFullscreenChange: (cb: (v: boolean) => void) => () => void;
        toggleFullscreen: () => void;
      };
    }
  ).winControls = {
    isFullscreen: () => Promise.resolve(false),
    onFullscreenChange: () => () => {},
    toggleFullscreen: () => {},
  };
  // O Topbar monta o GlobalComposer junto, e ele lê cards/estado de voz no
  // mount: sem estes stubs o teste passa, mas cospe TypeError no log — e log
  // sujo esconde falha de verdade.
  Object.assign(window, {
    store: { boardAgentRoles, list: vi.fn(async () => []) },
    voice: { status: vi.fn(async () => ({ available: false, recording: false })) },
    system: { onProvidersConfigChanged: vi.fn(() => () => {}) },
  });
});

function topbarStub(overrides: Partial<ComponentProps<typeof Topbar>> = {}) {
  const noop = () => {};
  return (
    <Topbar
      boards={[BOARD]}
      activeBoardId="b1"
      boardCounts={{ b1: { agents: 2 } }}
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

describe("contador de agentes do Topbar", () => {
  it("diz o que se sabe — cards de agente ABERTOS — e nunca 'ativos'", () => {
    render(topbarStub());

    const counter = document.querySelector('[data-role="topbar-agents"]')!;
    expect(counter.textContent).toBe("2 agentes abertos");
    expect(counter.textContent).not.toContain("ativos");
    // A linha do board no seletor de sessões fala a MESMA língua (o mesmo
    // texto para o mesmo fato): nada de um segundo jeito de dizer.
    expect(document.querySelector(".topbar")?.textContent).not.toContain("ativos");
  });

  it("NÃO vive dentro do `.topbar-title` (botão dentro de botão é HTML inválido)", () => {
    render(topbarStub());

    expect(document.querySelector(".topbar-title [data-role='topbar-agents']")).toBeNull();
    expect(document.querySelector(".topbar > [data-role='topbar-agents']")).toBeTruthy();
  });

  it("não há mais indicador de board: sobra o número, que já diz o fato", () => {
    render(topbarStub());

    // O `StatusDot` morreu (decisão do dono, 49de95ce): sem estado observável
    // ele era um bullet sempre neutro ao lado da contagem, e a única variação
    // que teve um dia era a AFIRMAÇÃO de atividade. O indicador de verdade de
    // cada card continua no PRÓPRIO card.
    fireEvent.click(document.querySelector(".topbar-title")!);
    const rows = document.querySelector(".popover");
    expect(rows?.textContent).toContain("agentes abertos");
    expect(document.querySelectorAll(".card-status-dot")).toHaveLength(0);
  });

  it("o clique pede a lista ao MAIN e mostra nome + papel por task", async () => {
    render(topbarStub());

    expect(boardAgentRoles).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-role="topbar-agents"]')!);

    await waitFor(() =>
      expect(document.querySelectorAll("[data-role='topbar-agent-row']").length).toBe(2),
    );
    expect(boardAgentRoles).toHaveBeenCalledWith("b1");

    const rows = [...document.querySelectorAll("[data-role='topbar-agent-row']")];
    expect(rows.map((r) => r.getAttribute("data-card-id"))).toEqual(["4242", "4243"]);

    // Nome do card + UM papel por task viva (papel não é atributo do card).
    expect(rows[0].textContent).toContain("Spawn limpo");
    const roles = [...rows[0].querySelectorAll("[data-role='topbar-agent-role']")].map(
      (r) => r.textContent,
    );
    expect(roles).toHaveLength(2);
    expect(roles[0]).toContain("implementa");
    expect(roles[1]).toContain("revisa");
    // Id curto de task, a convenção do quadro (`shortTaskId`), não uma segunda.
    expect(roles[0]).toContain("aaaa1111");

    // Card sem rótulo: o ID no lugar do nome. Card sem task aberta: "sem
    // papel" — "ocioso" seria a afirmação não-verificável que saiu daqui.
    expect(rows[1].textContent).toContain("4243");
    expect(rows[1].textContent).toContain("sem papel");
    expect(rows[1].textContent).not.toContain("ocioso");
  });

  it("o estado de 'ninguém leu ainda' é distinto de 'lista vazia'", async () => {
    let resolveRows: (rows: never[]) => void = () => {};
    boardAgentRoles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRows = resolve as (rows: never[]) => void;
        }),
    );
    render(topbarStub());
    fireEvent.click(document.querySelector('[data-role="topbar-agents"]')!);

    await waitFor(() =>
      expect(document.querySelector(".topbar-agents-note")?.textContent).toBe("lendo…"),
    );
    expect(document.querySelectorAll("[data-role='topbar-agent-row']")).toHaveLength(0);

    resolveRows([]);
    await waitFor(() =>
      expect(document.querySelector(".topbar-agents-note")?.textContent).toBe(
        "nenhum card de agente neste board",
      ),
    );
  });
});
