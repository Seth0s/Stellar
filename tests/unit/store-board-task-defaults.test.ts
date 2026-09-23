import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type BoardRow } from "../../src/main/store";

/**
 * BOARD PRESETS — FASE 2: as três colunas novas de `boards`
 * (task 83f4cfa3). `default_review`, `default_report_schema_json` e
 * `default_allow_commit` nascem NULAS e sem backfill: um board que já existia
 * não ganha um default que ninguém escolheu.
 *
 * O que este teste trava contra um banco REAL em disco (não uma fixture):
 *   a) o default é DADO PERSISTIDO — sobrevive a fechar/reabrir o banco, o que
 *      é a diferença entre uma coluna e um literal em memória;
 *   b) as três colunas aceitam NULL e lêem como "não declarado" (nunca como
 *      `false`/'' — a diferença entre "não decidido" e "decidido: não");
 *   c) escrever defaults num board que não existe devolve false e não suja
 *      nenhuma outra linha;
 *   d) um rename/mudança de cwd NÃO apaga os defaults — o `upsertBoard` geral
 *      é o caminho que a UI usa para editar nome/caminho, e passar por ele não
 *      pode zerar uma decisão de contrato em silêncio.
 */

function makeBoard(id: string, name: string): BoardRow {
  return {
    id,
    name,
    project: "",
    cwd: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
    orchestrator_card_id: null,
  };
}

describe("store: defaults de task por board", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function freshDir() {
    dir = mkdtempSync(join(tmpdir(), "stellar-board-defaults-"));
    return dir;
  }

  it("a) o default é persistido de verdade: fecha o banco e relê", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("118", "Presets"));
    expect(store.setBoardDefaults("118", { review: "wanted", reportSchema: ["ok"], allowCommit: false })).toBe(true);
    store.close();

    const reopened = openStore(d);
    const row = reopened.getBoard("118")!;
    expect(row.default_review).toBe("wanted");
    expect(row.default_report_schema_json).toBe('["ok"]');
    expect(row.default_allow_commit).toBe(0);
    reopened.close();
  });

  it("b) board que nunca teve defaults lê NULL nos três — sem backfill", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("118", "Antigo"));
    const row = store.getBoard("118")!;
    expect(row.default_review).toBeNull();
    expect(row.default_report_schema_json).toBeNull();
    expect(row.default_allow_commit).toBeNull();
    store.close();
  });

  it("c) board inexistente: false, e o outro board fica intacto", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("118", "Presets"));
    store.setBoardDefaults("118", { review: "wanted", reportSchema: null, allowCommit: null });

    expect(store.setBoardDefaults("nao-existe", { review: null, reportSchema: null, allowCommit: true })).toBe(false);
    expect(store.getBoard("118")!.default_review).toBe("wanted");
    store.close();
  });

  it("d) rename pelo upsert geral NÃO zera os defaults", () => {
    const d = freshDir();
    const store = openStore(d);
    store.upsertBoard(makeBoard("118", "Presets"));
    store.setBoardDefaults("118", { review: "wanted", reportSchema: ["ok"], allowCommit: true });

    const before = store.getBoard("118")!;
    store.upsertBoard({ ...before, name: "Presets renomeado", cwd: "/tmp/outro", updated_at: Date.now() });

    const after = store.getBoard("118")!;
    expect(after.name).toBe("Presets renomeado");
    expect(after.cwd).toBe("/tmp/outro");
    expect(after.default_review).toBe("wanted");
    expect(after.default_report_schema_json).toBe('["ok"]');
    expect(after.default_allow_commit).toBe(1);
    store.close();
  });
});
