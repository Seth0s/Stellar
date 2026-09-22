import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openStore, type TaskRow } from "../../src/main/store";

/**
 * A LEITURA DA LINHA CARIMBADA, contra um banco de verdade (task 156e6d08).
 *
 * O DEFEITO É HISTÓRICO: antes de 7315c53, `recordParticipationRound`
 * carimbava o veredito de UM report em TODOS os vínculos vivos do card, com o
 * mesmo `at`. Aquelas linhas estão no banco e NÃO serão reescritas — a fatia
 * conserta a leitura. Medido no banco do dono: 1965 linhas, 545 com veredito,
 * 386 delas (70,8%) apontando para uma task que o report não nomeou (mais 39
 * indecidíveis).
 *
 * Por que o fixture escreve `task_verdicts` por SQL direto: porque o caminho
 * que produzia aquelas linhas NÃO EXISTE MAIS (o conserto da escrita recusa
 * veredito sem task declarada — é a linha
 * `if (verdict !== null && !taskId) throw` em `recordParticipationRound`).
 * Reproduzir o formato antigo pelo caminho novo é impossível por construção,
 * e é isso que o teste 5 registra. Os bytes gravados aqui são os mesmos que o
 * banco do dono tem.
 */

const CARD = "card-revisor";
const AT = 1_700_000_000_000;
const BOARD = "default";

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: BOARD,
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
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TaskRow;
}

/** Grava a rodada como o escritor ANTIGO gravava: uma linha por vínculo vivo. */
function writeLegacyRound(dir: string, taskIds: readonly string[], verdict: string, at = AT): void {
  const raw = new Database(join(dir, "agent-canvas.db"));
  const insert = raw.prepare("INSERT INTO task_verdicts (id, task_id, card_id, role, verdict, at) VALUES (?,?,?,?,?,?)");
  for (const taskId of taskIds) insert.run(randomUUID(), taskId, CARD, "reviewer", verdict, at);
  raw.close();
}

describe("store.ts: a leitura de `task_verdicts` (task 156e6d08)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Card com TRÊS vínculos vivos — o menor fan-out que ainda é fan-out. */
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "stellar-verdict-read-"));
    const store = openStore(dir);
    const tasks = ["task-a", "task-b", "task-c"].map((id) => baseTask(id));
    for (const task of tasks) store.upsertTask(task);
    for (const task of tasks) store.linkTaskCard(task.id, CARD, "reviewer");
    return { store, tasks, a: tasks[0]!, b: tasks[1]!, c: tasks[2]! };
  }

  function writeReport(store: ReturnType<typeof openStore>, payload: Record<string, unknown>, at = AT): void {
    store.upsertReport({
      card_id: CARD,
      seq: 1,
      report_json: JSON.stringify(payload),
      verdict: "aprovado",
      role: "reviewer",
      channel: "socket",
      updated_at: at,
    });
  }

  it("report declarando A: só A mostra o aprovado; B e C mostram o carimbo — com o valor gravado e a task nomeada", () => {
    const { store, a, b, c } = setup();
    writeReport(store, { ok: true, taskId: a.id });
    writeLegacyRound(dir, [a.id, b.id, c.id], "aprovado");

    const onA = store.getTaskVerdicts(a.id);
    expect(onA).toHaveLength(1);
    expect(onA[0]).toMatchObject({
      verdict: "aprovado",
      storedVerdict: "aprovado",
      rule: "declared_this_task",
      roundLinks: 3,
      reportFound: true,
    });

    for (const task of [b, c]) {
      const [row] = store.getTaskVerdicts(task.id);
      expect(row).toMatchObject({
        // O que a task PODE reivindicar...
        verdict: null,
        // ...e o que a coluna diz, que ninguém apagou.
        storedVerdict: "aprovado",
        rule: "declared_other_task",
        declaredTaskId: a.id,
        roundLinks: 3,
      });
    }
  });

  it("o MESMO grupo sem `taskId` no payload: as três dizem desconhecido — nenhuma herda o veredito", () => {
    const { store, a, b, c } = setup();
    writeReport(store, { ok: true });
    writeLegacyRound(dir, [a.id, b.id, c.id], "aprovado");

    for (const task of [a, b, c]) {
      const [row] = store.getTaskVerdicts(task.id);
      expect(row).toMatchObject({ verdict: null, storedVerdict: "aprovado", rule: "undeclared_round", roundLinks: 3 });
      expect(row.declaredTaskId).toBeNull();
    }
  });

  it("id declarado que não é task deste banco (truncado de briefing): desconhecido, e o id fica registrado", () => {
    const { store, a, b, c } = setup();
    writeReport(store, { ok: true, taskId: "task-a"[0] + "sk-a" });
    writeLegacyRound(dir, [a.id, b.id, c.id], "reprovado");

    for (const task of [a, b, c]) {
      const [row] = store.getTaskVerdicts(task.id);
      expect(row).toMatchObject({ verdict: null, rule: "undeclared_round", declaredTaskId: "tsk-a" });
      expect(row.declaredNamesTask).toBe(false);
    }
  });

  it("rodada de UM vínculo: o veredito sobrevive sem declaração nenhuma (não havia outra candidata)", () => {
    const { store, a } = setup();
    writeLegacyRound(dir, [a.id], "aprovado");

    const [row] = store.getTaskVerdicts(a.id);
    expect(row).toMatchObject({ verdict: "aprovado", rule: "sole_link", roundLinks: 1, reportFound: false });
  });

  it("o caminho da escrita que produzia o carimbo NÃO EXISTE MAIS (o fixture precisa escrever por SQL)", () => {
    const { store, a, b } = setup();
    // É o par do teste acima: a mesma chamada que gerou as 386 linhas do banco
    // do dono hoje RECUSA — por isso o reparo não pode ser uma migração, e é
    // por isso que o passado precisa de uma regra de LEITURA.
    expect(() => store.recordParticipationRound(CARD, "aprovado", AT)).toThrow(/declared taskId/);
    // Com a task declarada, grava — e agora só nela.
    const written = store.recordParticipationRound(CARD, "aprovado", AT, a.id);
    expect(written.map((r) => r.task_id)).toEqual([a.id]);
    expect(store.getTaskVerdicts(b.id)).toEqual([]);
  });

  it("NADA foi escrito: depois de ler tudo, a tabela continua com as mesmas linhas e os mesmos vereditos", () => {
    const { store, a, b, c } = setup();
    writeReport(store, { ok: true, taskId: a.id });
    writeLegacyRound(dir, [a.id, b.id, c.id], "aprovado");
    store.getTaskVerdicts(a.id);
    store.getTaskVerdicts(b.id);
    store.listVerdictsForBoard(BOARD);
    store.getTask(a.id);

    const raw = new Database(join(dir, "agent-canvas.db"), { readonly: true });
    const rows = raw.prepare("SELECT verdict FROM task_verdicts ORDER BY task_id").all() as { verdict: string | null }[];
    raw.close();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.verdict === "aprovado")).toBe(true);
  });

  it("a rodada SEM report não herda a declaração de OUTRA rodada do mesmo card (o par é `(card_id, at)`)", () => {
    const { store, a, b } = setup();
    // Rodada 1 (com report) declarou A. Rodada 2, noutro instante e SEM report
    // (é o caso do report podado), carimbou um vínculo só: o par certo é
    // `at === updated_at`, não "algum report deste card".
    writeReport(store, { ok: true, taskId: a.id }, AT);
    writeLegacyRound(dir, [a.id], "aprovado", AT);
    writeLegacyRound(dir, [b.id], "aprovado", AT + 1);

    expect(store.getTaskVerdicts(a.id)[0]).toMatchObject({ rule: "declared_this_task", verdict: "aprovado" });
    const [later] = store.getTaskVerdicts(b.id);
    expect(later).toMatchObject({ verdict: "aprovado", rule: "sole_link", reportFound: false, declaredTaskId: null });
  });

  it("o leitor do BOARD e o `get_task` respondem IGUAL — mesma regra, uma implementação só", () => {
    const { store, a, b } = setup();
    writeReport(store, { ok: true, taskId: a.id });
    writeLegacyRound(dir, [a.id, b.id], "aprovado");

    const board = store.listVerdictsForBoard(BOARD);
    expect(board).toHaveLength(2);
    const byTask = new Map(board.map((r) => [r.task_id, r.rule]));
    expect(byTask.get(a.id)).toBe("declared_this_task");
    expect(byTask.get(b.id)).toBe("declared_other_task");
    expect(board.map((r) => r.verdict)).toEqual(store.listVerdictsForBoard(BOARD).map((r) => r.verdict));
    // `getTask` (o caminho do MCP) carrega os mesmos campos.
    const task = store.getTask(a.id);
    expect(task?.verdicts?.[0]).toMatchObject({ rule: "declared_this_task", verdict: "aprovado" });
  });

  it("FORMAS DE PAYLOAD: só string não-vazia em `taskId` declara — e payload malformado não derruba a consulta", () => {
    const { store, a, b, c } = setup();
    const raw = new Database(join(dir, "agent-canvas.db"));
    const insert = raw.prepare("INSERT INTO reports (card_id, seq, report_json, verdict, role, channel, updated_at) VALUES (?,?,?,?,?,?,?)");
    // `declared_raw` vem de `json_extract(report_json, '$.taskId')` no SQL; o
    // parser de TS (`declaredTaskIdFromReportBody`) passou a compartilhar a
    // MESMA normalização (`normalizeDeclaredTaskId`) — estes casos são a prova
    // de que as duas rotas respondem igual, formato por formato.
    const shapes: [string, string | null][] = [
      [JSON.stringify({ ok: true, taskId: a.id }), a.id], // objeto + string
      [JSON.stringify({ ok: true, taskId: `  ${a.id}  ` }), a.id], // aparado
      [JSON.stringify({ ok: true, taskId: 5 }), null], // número não declara
      [JSON.stringify({ ok: true, taskId: "" }), null], // vazio não declara
      [JSON.stringify({ ok: true, TaskId: a.id }), null], // chave errada (case)
      [JSON.stringify({ ok: true }), null], // ausente
      [JSON.stringify(JSON.stringify({ ok: true, taskId: a.id })), null], // duplo-encode legado
      ['{"ok":true,"taskId":', null], // JSON malformado: `json_valid` segura
      [JSON.stringify([{ taskId: a.id }]), null], // array não é objeto
    ];
    shapes.forEach(([json], i) => {
      insert.run(CARD, 100 + i, json, "aprovado", "reviewer", "socket", AT + i);
      writeLegacyRound(dir, [a.id, b.id, c.id], "aprovado", AT + i);
    });
    raw.close();

    shapes.forEach(([, expected], i) => {
      const [row] = store.getTaskVerdicts(a.id).filter((r) => r.at === AT + i);
      expect(row?.declaredTaskId ?? null, `forma ${i}`).toBe(expected);
      // Sem declaração utilizável e com 3 vínculos: desconhecido — nunca um
      // veredito herdado por conveniência.
      if (expected === null) expect(row?.rule).toBe("undeclared_round");
      else expect(row?.rule).toBe("declared_this_task");
    });
  });
});

