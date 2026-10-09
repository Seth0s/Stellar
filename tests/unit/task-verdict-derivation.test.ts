import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  deriveVerdictFromReport,
  rebuildDerivedVerdictsTable,
  compareDerivedAgainstStored,
  type ReportSourceRow,
} from "../../src/main/task-verdict-derivation";

describe("task-verdict-derivation: derivador de vereditos a partir de reports (caso de prova da tese)", () => {
  it("deriva veredito de report com taskId explícito e verdict no envelope", () => {
    const report: ReportSourceRow = {
      seq: 1,
      card_id: "card-1",
      report_json: JSON.stringify({ ok: true, taskId: "task-abc", summary: "feita" }),
      verdict: "aprovado",
      role: "reviewer",
      updated_at: 1000,
    };
    const derived = deriveVerdictFromReport(report);
    expect(derived).toEqual({
      taskId: "task-abc",
      cardId: "card-1",
      role: "reviewer",
      verdict: "aprovado",
      at: 1000,
      sourceSeq: 1,
      resolution: "exact",
    });
  });

  it("deriva veredito a partir de payload JSON quando coluna verdict é null (ok: true -> aprovado, ok: false -> reprovado)", () => {
    const r1: ReportSourceRow = {
      seq: 2,
      card_id: "card-2",
      report_json: JSON.stringify({ ok: true, taskId: "task-xyz" }),
      verdict: null,
      role: null,
      updated_at: 2000,
    };
    const d1 = deriveVerdictFromReport(r1);
    expect(d1?.verdict).toBe("aprovado");
    expect(d1?.role).toBe("implementer"); // fallback default

    const r2: ReportSourceRow = {
      seq: 3,
      card_id: "card-2",
      report_json: JSON.stringify({ ok: false, taskId: "task-xyz" }),
      verdict: null,
      role: "reviewer",
      updated_at: 2500,
    };
    const d2 = deriveVerdictFromReport(r2);
    expect(d2?.verdict).toBe("reprovado");
    expect(d2?.role).toBe("reviewer");
  });

  it("resolve taskId por prefixo quando o agente copiou id curto de 8 caracteres e a task existe", () => {
    const report: ReportSourceRow = {
      seq: 4,
      card_id: "card-3",
      report_json: JSON.stringify({ ok: true, taskId: "30d858c5" }),
      verdict: "aprovado",
      role: "reviewer",
      updated_at: 3000,
    };
    const knownTasks = new Set(["30d858c5-315e-4bdf-8f0a-c47946aa20fd", "other-task-uuid"]);
    const derived = deriveVerdictFromReport(report, { taskCatalog: knownTasks });
    expect(derived).toEqual({
      taskId: "30d858c5-315e-4bdf-8f0a-c47946aa20fd",
      cardId: "card-3",
      role: "reviewer",
      verdict: "aprovado",
      at: 3000,
      sourceSeq: 4,
      resolution: "prefix",
    });
  });

  it("retorna null quando o report não declara taskId e não há como vincular", () => {
    const report: ReportSourceRow = {
      seq: 5,
      card_id: "card-4",
      report_json: JSON.stringify({ ok: true, summary: "sem task" }),
      verdict: "aprovado",
      role: "implementer",
      updated_at: 4000,
    };
    const derived = deriveVerdictFromReport(report);
    expect(derived).toBeNull();
  });

  it("lida com JSON malformado sem explodir", () => {
    const report: ReportSourceRow = {
      seq: 6,
      card_id: "card-5",
      report_json: "{corrupted json",
      verdict: "aprovado",
      role: "implementer",
      updated_at: 5000,
    };
    const derived = deriveVerdictFromReport(report);
    expect(derived).toBeNull();
  });

  it("rebuildDerivedVerdictsTable reconstrói o índice e elimina carimbos falsos de fan-out", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE reports (
        seq INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        verdict TEXT,
        role TEXT,
        channel TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE task_verdicts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        role TEXT NOT NULL,
        verdict TEXT,
        at INTEGER NOT NULL
      );
    `);

    // Inserimos tasks
    db.exec("INSERT INTO tasks VALUES ('task-A'), ('task-B'), ('task-C');");

    // Report declara apenas task-A
    const at = 1700000000;
    db.prepare(`
      INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at)
      VALUES (1, 'card-x', '{"taskId":"task-A","ok":true}', 'aprovado', 'reviewer', 'socket', ?)
    `).run(at);

    // O escritor legado com defeito de fan-out carimbou task-A, task-B e task-C na mesma chamada
    const insertTv = db.prepare("INSERT INTO task_verdicts VALUES (?, ?, ?, ?, ?, ?)");
    insertTv.run("tv-1", "task-A", "card-x", "reviewer", "aprovado", at);
    insertTv.run("tv-2", "task-B", "card-x", "reviewer", "aprovado", at); // carimbo falso
    insertTv.run("tv-3", "task-C", "card-x", "reviewer", "aprovado", at); // carimbo falso

    // Rebuild do índice derivado
    const stats = rebuildDerivedVerdictsTable(db, { tableName: "derived_task_verdicts" });
    expect(stats.count).toBe(1); // Só 1 veredito derivado, não 3!

    // Comparador aponta quem está certo e isola os carimbos falsos
    const comparison = compareDerivedAgainstStored(db, "derived_task_verdicts");
    expect(comparison.storedTotal).toBe(3);
    expect(comparison.derivedTotal).toBe(1);
    expect(comparison.exactMatches).toBe(1);
    expect(comparison.fanoutFalseStamps).toBe(2);
    expect(comparison.verdictDivergences).toBe(0);

    db.close();
  });
});
