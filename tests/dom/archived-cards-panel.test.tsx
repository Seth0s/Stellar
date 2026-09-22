import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { CardRow } from "../../src/preload/index";
import { setLocale } from "../../src/shared/i18n";
import { ArchivedCardsPanel } from "@renderer/ArchivedCardsPanel";

/**
 * A VISTA DOS ARQUIVADOS (task d3c005dc).
 *
 * O dono não via o que foi arquivado (desde 3e5fe1d fechar ARQUIVA) nem tinha
 * como apagar de verdade pela UI. Este painel é a vista, e o apagar dele usa a
 * MESMA porta que o resto da UI (`store:delete` → `deleteCardDirect` →
 * `deleteCardForever`), corrigida nesta task para levar os conectores junto.
 *
 * O QUE ESTE TESTE PRENDE, e por que cada um:
 *   1. a linha diz o que se sabe: tipo, nome (ou o id — nunca um nome
 *      inventado), provider e QUANDO foi arquivado;
 *   2. RESTAURAR chama `unarchiveCard` no card CERTO, e a frase da sessão sai
 *      do `resume_id` DO PRÓPRIO CARD: com resume id a tela diz que retoma,
 *      sem resume id diz que volta sem processo — as duas frases existem e são
 *      diferentes, porque "volta" e "volta retomando" não são a mesma promessa;
 *   3. APAGAR não apaga no primeiro clique: abre uma confirmação que NOMEIA o
 *      que se perde, e só o segundo clique chama o `delete`. É a diferença
 *      entre um botão e uma armadilha.
 *
 * A FIXTURE usa kinds NÃO-CHAT de propósito: 7 dos 7 arquivados do board de
 * hoje são chat (e o chat já tem a sidebar dele), então uma fixture de chat
 * provaria o caminho que já existia em vez do que esta task abre.
 */

function card(id: string, overrides: Partial<CardRow> = {}): CardRow {
  return {
    id,
    board_id: "b1",
    kind: "terminal",
    provider: "cline",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 700,
    h: 400,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: 1,
    messages_json: null,
    archived_at: 1789000000000,
    created_at: 1,
    ...overrides,
  } as CardRow;
}

let listArchivedCards: ReturnType<typeof vi.fn>;
let unarchiveCard: ReturnType<typeof vi.fn>;
let deleteCard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLocale("pt-BR");
  vi.clearAllMocks();
  listArchivedCards = vi.fn(async () => [
    card("t-1", { kind: "terminal", label: "Sessão antiga", provider: "cline", resume_id: "1790084894395_2jj9i" }),
    card("s-1", { kind: "sticky", label: null, provider: "", resume_id: null }),
  ]);
  unarchiveCard = vi.fn(async () => undefined);
  deleteCard = vi.fn(async () => undefined);
  (window as unknown as { store: Record<string, unknown> }).store = {
    listArchivedCards,
    unarchiveCard,
    delete: deleteCard,
  };
});

describe("painel de cards arquivados (d3c005dc)", () => {
  it("lista os arquivados do board com tipo, nome (ou id), provider e quando", async () => {
    render(<ArchivedCardsPanel boardId="b1" onClose={() => {}} />);

    await waitFor(() => expect(document.querySelectorAll('[data-role="archived-row"]').length).toBe(2));
    expect(listArchivedCards).toHaveBeenCalledWith("b1");
    const rows = [...document.querySelectorAll('[data-role="archived-row"]')].map((r) => r.textContent ?? "");
    // O card COM rótulo mostra o rótulo; o SEM rótulo mostra o ID — nunca um
    // nome inventado (mesma ausência honesta do chip da Fila).
    expect(rows[0]).toContain("Sessão antiga");
    expect(rows[1]).toContain("s-1");
    // O kind aparece nos dois (a fixture é não-chat de propósito).
    expect(rows[0]).toContain("terminal");
    expect(rows[1]).toContain("sticky");
  });

  it("a frase da sessão sai do resume_id do PRÓPRIO card: retoma vs. volta sem processo", async () => {
    render(<ArchivedCardsPanel boardId="b1" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('[data-role="archived-row"]').length).toBe(2));

    const rows = [...document.querySelectorAll('[data-role="archived-row"]')];
    const comSessao = rows[0]!.textContent ?? "";
    const semSessao = rows[1]!.textContent ?? "";

    expect(comSessao).toContain("1790084894395_2jj9i"); // retoma ESTA sessão
    expect(comSessao).not.toBe(semSessao);
    expect(semSessao.toLowerCase()).toContain("sem processo");
  });

  it("RESTAURAR chama unarchiveCard no card certo", async () => {
    render(<ArchivedCardsPanel boardId="b1" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('[data-role="archived-row"]').length).toBe(2));

    const restore = document.querySelectorAll('[data-role="archived-restore"]')[1]!;
    fireEvent.click(restore);

    await waitFor(() => expect(unarchiveCard).toHaveBeenCalledWith("s-1"));
    expect(deleteCard).not.toHaveBeenCalled();
  });

  it("APAGAR não apaga no primeiro clique: a confirmação NOMEIA o que se perde", async () => {
    render(<ArchivedCardsPanel boardId="b1" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('[data-role="archived-row"]').length).toBe(2));

    fireEvent.click(document.querySelectorAll('[data-role="archived-delete"]')[0]!);

    // Nada apagado ainda, e o texto diz o conjunto.
    expect(deleteCard).not.toHaveBeenCalled();
    const confirm = await waitFor(() => {
      const el = document.querySelector('[data-role="archived-delete-confirm"]');
      expect(el).toBeTruthy();
      return el!.textContent ?? "";
    });
    expect(confirm.toLowerCase()).toContain("conectores");
    expect(confirm.toLowerCase()).toContain("rastro");
    // E diz o que SOBREVIVE — a parte que evita a leitura de que "apaga tudo".
    expect(confirm).toMatch(/tasks|reports/);

    // Só o segundo clique apaga, no card certo.
    fireEvent.click(document.querySelector('[data-role="archived-delete-confirm-yes"]')!);
    await waitFor(() => expect(deleteCard).toHaveBeenCalledWith("t-1"));
  });
});
