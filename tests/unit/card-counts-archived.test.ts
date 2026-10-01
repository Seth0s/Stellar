import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CardRow } from "../../src/main/store";

/**
 * HOME CONTAVA AGENTES ACUMULADOS DA SESSÃO, NÃO O ATUAL (task cb7244f2).
 *
 * O DEFEITO, medido por leitura: `cardCountsStmt` (main/store.ts) somava TODO
 * terminal com provider != 'bash' sem filtrar `archived_at` — e desde 4e4ec327
 * fechar um card ARQUIVA (`decideCardClose`, card-close-decision.ts), então
 * toda linha já criada continuava contando para sempre. Os irmãos
 * `listCards`/`listAllCards` já filtravam `archived_at IS NULL`; esta era a
 * única leitura viva sem o filtro.
 *
 * O PRIMEIRO CASO NASCE VERMELHO em HEAD: sem o filtro, `agents` fica 2
 * (o card arquivado continua contando) e a asserção `toBe(1)` falha.
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
    w: 100,
    h: 100,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: 1,
    messages_json: null,
    archived_at: null,
    ...overrides,
  };
}

describe("cardCounts ignora cards ARQUIVADOS (task cb7244f2)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    store = null;
    dir = null;
  });

  function boot(): void {
    dir = mkdtempSync(join(tmpdir(), "stellar-card-counts-"));
    store = openStore(dir);
  }

  it("um terminal ARQUIVADO não conta (nasce vermelho: HEAD conta 2)", () => {
    boot();
    store!.upsertCard(card("c1"));
    store!.upsertCard(card("c2"));
    expect(store!.cardCounts()["b1"].agents).toBe(2);

    // O gesto de FECHAR arquiva — é o que `decideCardClose` faz hoje.
    store!.archiveCard("c2", Date.now());

    expect(store!.cardCounts()["b1"].agents).toBe(1);
    // Mesmo critério que as leituras vivas irmãs já aplicavam.
    expect(store!.listCards("b1").map((c) => c.id)).toEqual(["c1"]);
  });

  it("arquivar um terminal bash (que nunca conta) não muda o número", () => {
    boot();
    store!.upsertCard(card("c1"));
    store!.upsertCard(card("bash1", { provider: "bash" }));
    expect(store!.cardCounts()["b1"].agents).toBe(1);

    store!.archiveCard("bash1", Date.now());
    expect(store!.cardCounts()["b1"].agents).toBe(1);
  });

  it("desarquivar volta a contar", () => {
    boot();
    store!.upsertCard(card("c1"));
    store!.archiveCard("c1", Date.now());
    // A board with NO live terminal simply has no row — Home renders that as
    // "0 agentes" (counts undefined), not as a board carrying a zero.
    expect(store!.cardCounts()["b1"]?.agents ?? 0).toBe(0);

    store!.unarchiveCard("c1");
    expect(store!.cardCounts()["b1"].agents).toBe(1);
  });

  it("cada board conta só os seus vivos", () => {
    boot();
    store!.upsertCard(card("a1"));
    store!.upsertCard(card("a2"));
    store!.upsertCard(card("b1v", { board_id: "b2" }));
    store!.archiveCard("a2", Date.now());

    const counts = store!.cardCounts();
    expect(counts["b1"].agents).toBe(1);
    expect(counts["b2"].agents).toBe(1);
  });
});
