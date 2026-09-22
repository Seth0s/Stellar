/**
 * AUDITORIA DO REPARO DE LEITURA contra o banco REAL (task 156e6d08).
 *
 * O que este arquivo é: a versão executável do relatório. Ele abre uma CÓPIA
 * do banco do dono pelo MESMO `openStore` que o app usa (não por SQL paralelo
 * — uma reimplementação da regra aqui só mediria a si mesma), percorre toda
 * linha de `task_verdicts`, e imprime:
 *
 *   - quantas linhas há, quantas têm veredito, e quantas caem em cada regra
 *     de leitura (`declared_this_task` / `declared_other_task` / `sole_link` /
 *     `undeclared_round` / `no_verdict`);
 *   - quantos vereditos DEIXAM de ser exibidos por task (o efeito de borda que
 *     a fatia existe para produzir: onde hoje aparece um nome, passa a
 *     aparecer "não sei");
 *   - um exemplo real de cada regra;
 *   - e a PROVA de que nada foi escrito: as linhas cruas lidas direto da
 *     tabela continuam idênticas (`storedVerdict` == coluna, e a contagem de
 *     linhas não muda depois de ler tudo pelo store).
 *
 * Como rodar (NUNCA aponte para o arquivo vivo: o teste COPIA o que receber
 * para um diretório temporário e só abre a cópia — o original não é tocado,
 * nem por WAL, nem por migração):
 *
 *   rm -rf /tmp/verdict-audit && mkdir -p /tmp/verdict-audit
 *   cp ~/.config/stellar/agent-canvas.db* /tmp/verdict-audit/
 *   STELLAR_VERDICT_AUDIT_DB=/tmp/verdict-audit/agent-canvas.db \
 *     npx vitest run tests/unit/task-verdict-read-live-audit.test.ts
 *
 * Sem a variável, o arquivo é `skip` — a suíte normal não depende do banco de
 * ninguém.
 */

import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, type TaskVerdictReadRule } from "../../src/main/store";

const source = process.env.STELLAR_VERDICT_AUDIT_DB;
const suite = source && existsSync(source) ? describe : describe.skip;

const RULES: TaskVerdictReadRule[] = [
  "declared_this_task",
  "declared_other_task",
  "sole_link",
  "undeclared_round",
  "no_verdict",
];

suite("auditoria: o reparo de leitura contra o banco real (cópia)", () => {
  it("imprime a distribuição por regra e prova que a tabela não foi tocada", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdict-audit-"));
    try {
      // A cópia é do BANCO e dos seus -wal/-shm: sem o WAL, a leitura veria um
      // passado mais velho do que o real.
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`${source}${suffix}`))
          copyFileSync(`${source}${suffix}`, join(dir, `agent-canvas.db${suffix}`));
      }

      // Linhas cruas, direto da tabela — a referência contra a qual o store
      // será conferido.
      const raw = new Database(join(dir, "agent-canvas.db"), { readonly: true });
      const rawRows = raw
        .prepare("SELECT id, task_id, card_id, role, verdict, at FROM task_verdicts")
        .all() as { id: string; task_id: string; card_id: string; role: string; verdict: string | null; at: number }[];
      const taskIds = (raw.prepare("SELECT id FROM tasks").all() as { id: string }[]).map((t) => t.id);
      const taskBoard = new Map(
        (raw.prepare("SELECT id, board_id FROM tasks").all() as { id: string; board_id: string | null }[]).map(
          (t) => [t.id, t.board_id],
        ),
      );
      // `board_id` NULL existe (19 linhas medidas no banco do dono): elas não
      // pertencem a board nenhum e nenhum leitor de board as enxerga — por
      // isso a comparação abaixo as tira dos DOIS lados.
      const boardIds = [...new Set([...taskBoard.values()].filter((b): b is string => b !== null))];
      raw.close();

      const store = openStore(dir);
      const readings = taskIds.flatMap((id) => store.getTaskVerdicts(id));
      const byRule = new Map<TaskVerdictReadRule, number>(RULES.map((r) => [r, 0]));
      const examples = new Map<TaskVerdictReadRule, string>();
      const tasksWhereVerdictDisappears = new Set<string>();
      const hiddenByStoredValue: Record<string, number> = {};
      for (const r of readings) {
        byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
        if (!examples.has(r.rule)) {
          examples.set(
            r.rule,
            `${r.task_id.slice(0, 8)}/${r.card_id} role=${r.role} stored=${r.storedVerdict} declared=${r.declaredTaskId} links=${r.roundLinks} report=${r.reportFound}`,
          );
        }
        if (r.storedVerdict !== null && r.verdict === null) {
          tasksWhereVerdictDisappears.add(r.task_id);
          hiddenByStoredValue[r.storedVerdict] = (hiddenByStoredValue[r.storedVerdict] ?? 0) + 1;
        }
      }

      const typed = rawRows.filter((r) => r.verdict !== null).length;
      console.log("---- REPARO DE LEITURA DA task_verdicts (banco do dono, cópia) ----");
      console.log(`linhas: ${rawRows.length} · com veredito: ${typed} · sem: ${rawRows.length - typed}`);
      for (const rule of RULES) {
        console.log(`  ${rule.padEnd(20)} ${String(byRule.get(rule) ?? 0).padStart(5)}   ex: ${examples.get(rule) ?? "-"}`);
      }
      console.log(`tasks que passam a mostrar "não sei" onde mostravam um nome: ${tasksWhereVerdictDisappears.size}`);
      console.log(`  vereditos que deixam de ser exibidos, por valor gravado: ${JSON.stringify(hiddenByStoredValue)}`);
      console.log(`tasks lidas: ${taskIds.length} · boards: ${boardIds.length}`);
      console.log("-------------------------------------------------------------------");

      // 1. NADA foi escrito: a leitura pelo store devolve exatamente uma linha
      //    por linha da tabela, com o MESMO storedVerdict. Se o reparo tivesse
      //    virado migração, esta contagem mudaria.
      expect(readings).toHaveLength(rawRows.length);
      const storedById = new Map(readings.map((r) => [r.id, r.storedVerdict]));
      for (const row of rawRows) expect(storedById.get(row.id)).toBe(row.verdict);

      // 2. Toda linha caiu em exatamente uma regra, e a soma bate.
      expect([...byRule.values()].reduce((a, b) => a + b, 0)).toBe(rawRows.length);

      // 3. Invariantes da regra: veredito só sobrevive onde a rodada o
      //    sustenta, e `null` na coluna nunca vira veredito.
      for (const r of readings) {
        if (r.rule === "no_verdict") expect(r.verdict).toBeNull();
        else expect(r.storedVerdict).not.toBeNull();
        if (r.rule === "sole_link") expect(r.roundLinks).toBe(1);
        if (r.rule === "declared_other_task") expect(r.declaredTaskId).not.toBe(r.task_id);
        if (r.rule === "undeclared_round") expect(r.roundLinks).toBeGreaterThan(1);
        // O carimbo calado e o indecidível calado: os dois mantêm o valor
        // GRAVADO visível (`storedVerdict`) e zeram o atribuível.
        if (r.rule === "declared_other_task" || r.rule === "undeclared_round") expect(r.verdict).toBeNull();
        // Quem declara uma task que EXISTE continua dela: o veredito real
        // nunca é o que a leitura cala.
        if (r.rule === "declared_other_task") {
          const sameRound = readings.filter((o) => o.card_id === r.card_id && o.at === r.at);
          expect(sameRound.some((o) => o.task_id === r.declaredTaskId)).toBe(true);
        }
      }

      // 4. O board inteiro enxerga a MESMA leitura que o `get_task` — regras
      //    divergentes entre dois leitores da mesma tabela foi, literalmente,
      //    o defeito da task 4fee76d5.
      const inSomeBoard = rawRows.filter((r) => taskBoard.get(r.task_id) != null);
      const boardRows = boardIds.flatMap((b) => store.listVerdictsForBoard(b));
      expect(boardRows).toHaveLength(inSomeBoard.length);
      const ruleById = new Map(boardRows.map((r) => [r.id, r.rule]));
      for (const r of readings) {
        if (taskBoard.get(r.task_id) == null) continue;
        expect(ruleById.get(r.id)).toBe(r.rule);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

