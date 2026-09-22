import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { ChangesCard } from "@renderer/ChangesCard";
import type { GitAttribution } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";

/**
 * O CARD DE DIFFS COM ATRIBUIÇÃO E FATIA (task 56604aca, fase 1).
 *
 * O que estes testes travam, e é o que não pode regredir:
 *   - cada degrau tem o SEU texto (declarado / disputado / janela / pista /
 *     não sei) — a tela nunca diz "é do card X" quando não é;
 *   - o limite da fatia (por ARQUIVO, arrasta hunk de terceiro) aparece NA
 *     HORA da seleção, não num rodapé;
 *   - o aviso de silêncio (card com schema e sem declaração) e o de relatório
 *     ilegível aparecem;
 *   - a verificação é ESCRITA e passa por consentimento antes de rodar — e o
 *     modo orientado (copiar comando) existe sem consentimento nenhum.
 */

const noop = () => {};

function attribution(over: Partial<GitAttribution> = {}): GitAttribution {
  return {
    repo: true,
    root: "/repo",
    branch: "main",
    dirty: [
      { path: "src/a.ts", tracked: true },
      { path: "src/b.ts", tracked: false },
    ],
    files: [
      {
        path: "src/a.ts",
        state: "disputed",
        declared: [
          { cardId: "1111", label: "Spawn limpo", updatedAt: 1 },
          { cardId: "2222", label: "Revisor A", updatedAt: 2 },
        ],
        disputed: true,
        window: null,
        mentions: [],
      },
      {
        path: "src/b.ts",
        state: "unknown",
        declared: [],
        disputed: false,
        window: null,
        mentions: [],
      },
    ],
    silentCards: [{ cardId: "3333", label: "Composer" }],
    unreadableReports: [{ cardId: "4444", shape: "array" }],
    gates: ["npx tsc --noEmit"],
    ...over,
  };
}

let verifySlice: ReturnType<typeof vi.fn>;
let slicePlan: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  vi.clearAllMocks();
  verifySlice = vi.fn(async () => ({
    ok: true as const,
    outcome: {
      verdict: "nao-compila" as const,
      worktree: "/tmp/wt",
      routes: [{ path: "src/a.ts", route: "tracked-patch" as const }],
      steps: [
        {
          kind: "gate",
          file: null,
          command: "npx tsc --noEmit",
          exitCode: 2,
          ok: false,
          stdoutTail: "error TS2339: Property 'x' does not exist",
          stderrTail: "",
          durationMs: 10,
        },
      ],
      cleaned: true,
      cleanupError: null,
      refused: null,
    },
  }));
  slicePlan = vi.fn(async () => ({ ok: true as const, routes: [], commands: [], gates: [] }));
  Object.assign(window, {
    git: {
      status: vi.fn(async () => ({
        repo: true,
        branch: "main",
        insertions: 3,
        deletions: 1,
        entries: [
          { path: "src/a.ts", status: " M", insertions: 2, deletions: 1 },
          { path: "src/b.ts", status: "??", insertions: 1, deletions: 0 },
        ],
      })),
      attribution: vi.fn(async () => attribution()),
      verifySlice,
      slicePlan,
    },
    winControls: {
      isFullscreen: () => Promise.resolve(false),
      onFullscreenChange: () => () => {},
      toggleFullscreen: noop,
    },
  });
});

function card() {
  return render(
    <ChangesCard
      rect={{ x: 0, y: 0, w: 600, h: 400 }}
      zoom={1}
      zIndex={1}
      root="/repo"
      displayName="Mudanças"
      onChange={noop}
      onCommit={noop}
      onRaise={noop}
      onFocus={noop}
      onClose={noop}
      onRename={noop}
    />,
  );
}

describe("ChangesCard — atribuição", () => {
  it("DISPUTADO lista os candidatos e diz o número: nunca escolhe um", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-attribution"]')).toBeTruthy(),
    );

    const disputed = document.querySelector(
      '[data-path="src/a.ts"] [data-role="changes-attribution"]',
    )!;
    expect(disputed.getAttribute("data-state")).toBe("disputed");
    expect(disputed.textContent).toContain("disputado por 2");
    expect(disputed.textContent).toContain("Spawn limpo");
    expect(disputed.textContent).toContain("Revisor A");
  });

  it("sem nada: 'não sei', escrito com todas as letras", async () => {
    card();
    await waitFor(() => expect(document.querySelector('[data-path="src/b.ts"]')).toBeTruthy());

    expect(
      document.querySelector('[data-path="src/b.ts"] [data-role="changes-attribution"]')
        ?.textContent,
    ).toContain("não sei");
  });

  it("os dois avisos aparecem: card que TINHA o campo e não declarou, e relatório ilegível", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-silent-cards"]')).toBeTruthy(),
    );

    expect(document.querySelector('[data-role="changes-silent-cards"]')?.textContent).toContain(
      "Composer",
    );
    expect(document.querySelector('[data-role="changes-unreadable"]')?.textContent).toContain(
      "array",
    );
  });

  it("a COBERTURA dos gates é dita como medida, sem inventar fonte única", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-gate-coverage"]')).toBeTruthy(),
    );

    const coverage =
      document.querySelector('[data-role="changes-gate-coverage"]')?.textContent ?? "";
    expect(coverage).toContain("src/");
    expect(coverage).toContain("SEM tipá-los");
  });
});

describe("ChangesCard — a fatia", () => {
  it("o limite (por ARQUIVO, arrasta hunk de terceiro) aparece NA SELEÇÃO", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-select"]')).toBeTruthy(),
    );

    expect(document.querySelector('[data-role="changes-file-granularity"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-path="src/a.ts"] [data-role="changes-select"]')!);

    const warning = document.querySelector('[data-role="changes-file-granularity"]')!;
    expect(warning.textContent).toContain("ARQUIVO");
    expect(warning.textContent).toContain("hunk de terceiro");
  });

  it("a verificação pede CONSENTIMENTO antes de rodar (é escrita)", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-select"]')).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-path="src/a.ts"] [data-role="changes-select"]')!);

    fireEvent.click(document.querySelector('[data-role="changes-verify"]')!);
    // O modal diz o que vai acontecer; NADA rodou ainda.
    expect(verifySlice).not.toHaveBeenCalled();
    const modal = document.querySelector(".modal");
    expect(modal?.textContent).toContain("/tmp");
    expect(modal?.textContent).toContain("node_modules");

    fireEvent.click(
      Array.from(document.querySelectorAll(".modal button")).find(
        (b) => b.textContent === "Verificar",
      )!,
    );
    await waitFor(() => expect(verifySlice).toHaveBeenCalledWith("/repo", ["src/a.ts"]));
  });

  it("o resultado mostra o veredito, a via de cada arquivo e o passo que falhou", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-select"]')).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-path="src/a.ts"] [data-role="changes-select"]')!);
    fireEvent.click(document.querySelector('[data-role="changes-verify"]')!);
    fireEvent.click(
      Array.from(document.querySelectorAll(".modal button")).find(
        (b) => b.textContent === "Verificar",
      )!,
    );

    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-slice-result"]')).toBeTruthy(),
    );
    const result = document.querySelector('[data-role="changes-slice-result"]')!;
    expect(result.textContent).toContain("NÃO compila sozinho");
    expect(result.textContent).toContain("tracked: patch aplicado");
    expect(result.textContent).toContain("worktree removido");
    expect(document.querySelector('[data-role="changes-slice-step"]')?.textContent).toContain(
      "TS2339",
    );
  });

  it("o modo ORIENTADO existe sem consentimento: pede o plano e copia os comandos", async () => {
    card();
    await waitFor(() =>
      expect(document.querySelector('[data-role="changes-select"]')).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-path="src/b.ts"] [data-role="changes-select"]')!);

    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(document.querySelector('[data-role="changes-orient"]')!);

    await waitFor(() => expect(slicePlan).toHaveBeenCalledWith("/repo", ["src/b.ts"]));
    // O plano NÃO executa nada.
    expect(verifySlice).not.toHaveBeenCalled();
  });
});
