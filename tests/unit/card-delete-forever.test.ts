import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, type CardRow } from "../../src/main/store";
import { deleteCardForever } from "../../src/main/card-delete";

/**
 * APAGAR DE VERDADE APAGA O MESMO CONJUNTO, VENHA DE ONDE VIER (task d3c005dc).
 *
 * O DEFEITO, MEDIDO ANTES: as duas portas que apagam card tinham corpos
 * diferentes. A do AGENTE (`delete_card` → `deleteCardDirect`) levava os
 * CONECTORES junto; a da UI (`store:delete`, o gesto explícito do dono) não —
 * deixava o conector apontando para um card que não existe mais. No board do
 * dono isso já tinha produzido **2 conectores órfãos**, medidos numa cópia
 * read-only do banco (SELECT de `connectors` cujo `from_card_id`/`to_card_id`
 * não existe em `cards`).
 *
 * A FORMA DO CONSERTO: um corpo só (`card-delete.ts`), chamado pelas duas
 * portas. Este arquivo pina o CONJUNTO desse corpo com o store REAL.
 *
 * SOBRE "NASCER VERMELHO": este teste não pode ser vermelho contra o
 * `index.ts` de hoje porque o `index.ts` é a entrada do Electron — importá-lo
 * num teste sobe o app. O que ele faz é (a) reproduzir o comportamento da
 * porta antiga como CONTROLE DOCUMENTADO (um `store.deleteCard` sozinho deixa
 * o conector vivo — é exatamente o defeito medido no banco) e (b) prender o
 * corpo compartilhado. A prova de que ele MORDE é por mutação: apagando a
 * linha `deleteConnectorsForCard` de `card-delete.ts`, o caso principal fica
 * vermelho (ver gatesOutput do relatório).
 */

function baseCard(id: string, overrides: Partial<CardRow> = {}): CardRow {
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

describe("apagar de verdade: o conjunto é um só (task d3c005dc)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    store = null;
    dir = null;
  });

  function boot(): void {
    dir = mkdtempSync(join(tmpdir(), "stellar-card-delete-"));
    store = openStore(dir);
  }

  /** Conectores que apontam para um card que não existe mais — a medição do
   * defeito, agora como função reutilizável pelos dois casos. */
  function orphanConnectors(): number {
    const raw = new Database(join(dir!, "agent-canvas.db"), { readonly: true });
    try {
      return (
        raw
          .prepare(
            `SELECT COUNT(*) AS n FROM connectors c
             WHERE (c.from_card_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards x WHERE x.id = c.from_card_id))
                OR (c.to_card_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards x WHERE x.id = c.to_card_id))`,
          )
          .get() as { n: number }
      ).n;
    } finally {
      raw.close();
    }
  }

  it("CONTROLE DOCUMENTADO — o corpo da porta antiga deixava conector órfão (o defeito medido)", () => {
    boot();
    store!.upsertCard(baseCard("pai"));
    store!.upsertCard(baseCard("filho"));
    store!.upsertConnector({
      id: "k1",
      board_id: "b1",
      from_card_id: "pai",
      to_card_id: "filho",
      kind: "spawned",
      updated_at: 1,
    } as never);

    // O que a porta da UI fazia ATÉ esta task: só `store.deleteCard`.
    store!.deleteCard("filho");

    expect(orphanConnectors()).toBe(1);
  });

  it("O CONSERTO — `deleteCardForever` (o corpo que as DUAS portas passam a usar) não deixa órfão", () => {
    boot();
    store!.upsertCard(baseCard("pai"));
    store!.upsertCard(baseCard("filho"));
    store!.upsertConnector({
      id: "k1",
      board_id: "b1",
      from_card_id: "pai",
      to_card_id: "filho",
      kind: "spawned",
      updated_at: 1,
    } as never);

    deleteCardForever(store!, "filho");

    expect(orphanConnectors()).toBe(0);
    expect(store!.getCard("filho")).toBeUndefined();
    // O card do outro lado do conector continua vivo: o apagamento é do
    // card, não do vizinho.
    expect(store!.getCard("pai")).toBeTruthy();
  });

  it("o rastro do fecho morre junto, e as tasks NÃO (identidade separada)", () => {
    boot();
    store!.upsertCard(baseCard("c1"));
    store!.saveCardTrace({
      card_id: "c1",
      board_id: "b1",
      closed_at: 2,
      screen_stored: 0,
      tail: "",
      tail_bytes: 0,
      tail_at_cap: 0,
      redacted: 0,
      spawned_at_ms: null,
      last_activity_at: null,
      turn_ended_at: null,
      quota_death: 0,
      kill_requested: 0,
    });
    store!.upsertTask({
      id: "t1",
      prompt: "p",
      provider: "cline",
      status: "running",
      card_id: "c1",
      board_id: "b1",
      cwd: null,
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: 1,
      updated_at: 1,
    } as never);

    deleteCardForever(store!, "c1");

    expect(store!.getCardTrace("c1")).toBeUndefined();
    // A task sobrevive ao apagamento do card: `tasks.card_id` guarda história
    // de propósito (é assim que a Fila mostra card órfão).
    expect(store!.getTask("t1")?.card_id).toBe("c1");
  });
});
