import type Database from "better-sqlite3";

export type ReportSourceRow = {
  seq: number;
  card_id: string;
  report_json: string;
  verdict: string | null;
  role: string | null;
  updated_at: number;
};

export type DerivedTaskVerdict = {
  taskId: string;
  cardId: string;
  role: string;
  verdict: string | null;
  at: number;
  sourceSeq: number;
  resolution: "exact" | "prefix";
};

export type DerivationOptions = {
  taskCatalog?: Set<string> | Map<string, string> | readonly string[];
};

export function normalizeDeclaredTaskId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Deriva um veredito por (task, card) a partir de um registro append-only de `reports`.
 * A fonte da verdade é o relatório enviado pelo agente; o veredito é um índice derivado.
 */
export function deriveVerdictFromReport(
  report: ReportSourceRow,
  options: DerivationOptions = {},
): DerivedTaskVerdict | null {
  let parsed: Record<string, unknown> | null;
  try {
    const raw = JSON.parse(report.report_json);
    parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  if (!parsed) return null;

  const rawTaskId = normalizeDeclaredTaskId(parsed.taskId ?? parsed.task_id);
  if (!rawTaskId) return null;

  let resolvedTaskId = rawTaskId;
  let resolution: "exact" | "prefix" = "exact";

  if (options.taskCatalog) {
    const catalog =
      options.taskCatalog instanceof Set
        ? options.taskCatalog
        : options.taskCatalog instanceof Map
          ? new Set(options.taskCatalog.keys())
          : new Set(options.taskCatalog);

    if (catalog.has(rawTaskId)) {
      resolvedTaskId = rawTaskId;
      resolution = "exact";
    } else if (rawTaskId.length >= 6) {
      const candidates: string[] = [];
      for (const t of catalog) {
        if (t.startsWith(rawTaskId)) {
          candidates.push(t);
        }
      }
      if (candidates.length === 1) {
        resolvedTaskId = candidates[0]!;
        resolution = "prefix";
      }
    }
  }

  const verdict =
    report.verdict ??
    (typeof parsed.verdict === "string" && parsed.verdict.trim().length > 0
      ? parsed.verdict.trim()
      : parsed.ok === true
        ? "aprovado"
        : parsed.ok === false
          ? "reprovado"
          : null);

  const role =
    report.role ??
    (typeof parsed.role === "string" && parsed.role.trim().length > 0
      ? parsed.role.trim()
      : "implementer");

  return {
    taskId: resolvedTaskId,
    cardId: report.card_id,
    role,
    verdict,
    at: report.updated_at,
    sourceSeq: report.seq,
    resolution,
  };
}

export function deriveVerdictsFromReports(
  reports: readonly ReportSourceRow[],
  options: DerivationOptions = {},
): DerivedTaskVerdict[] {
  const list: DerivedTaskVerdict[] = [];
  for (const r of reports) {
    const derived = deriveVerdictFromReport(r, options);
    if (derived) list.push(derived);
  }
  return list;
}

export type RebuildStats = {
  count: number;
  durationMs: number;
};

/**
 * Reconstrói a tabela derivada de vereditos a partir da tabela fonte `reports` (e `tasks` para catálogo).
 * Esta operação é puramente derivada e descartável.
 */
export function rebuildDerivedVerdictsTable(
  db: Database.Database,
  options: { tableName?: string } = {},
): RebuildStats {
  const tableName = options.tableName ?? "derived_task_verdicts";
  const t0 = performance.now();

  const taskRows = db.prepare("SELECT id FROM tasks").all() as { id: string }[];
  const taskCatalog = new Set(taskRows.map((t) => t.id));

  const reports = db.prepare(
    "SELECT seq, card_id, report_json, verdict, role, updated_at FROM reports ORDER BY seq ASC",
  ).all() as ReportSourceRow[];

  db.exec(`
    DROP TABLE IF EXISTS ${tableName};
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      role TEXT NOT NULL,
      verdict TEXT,
      at INTEGER NOT NULL,
      source_seq INTEGER NOT NULL,
      resolution TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${tableName}_task ON ${tableName}(task_id, at);
  `);

  const insert = db.prepare(`
    INSERT INTO ${tableName} (id, task_id, card_id, role, verdict, at, source_seq, resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    let inserted = 0;
    for (const r of reports) {
      const d = deriveVerdictFromReport(r, { taskCatalog });
      if (!d) continue;
      insert.run(`dv-${d.sourceSeq}`, d.taskId, d.cardId, d.role, d.verdict, d.at, d.sourceSeq, d.resolution);
      inserted++;
    }
    return inserted;
  });

  const count = tx();
  const durationMs = performance.now() - t0;
  return { count, durationMs };
}

export type ComparisonSummary = {
  storedTotal: number;
  derivedTotal: number;
  exactMatches: number;
  fanoutFalseStamps: number;
  prunedFromReports: number;
  exitWithoutReport: number;
  undeclaredReports: number;
  verdictDivergences: number;
};

/**
 * Compara a tabela de vereditos escrita à mão (`task_verdicts`) contra o índice derivado.
 */
export function compareDerivedAgainstStored(
  db: Database.Database,
  derivedTableName = "derived_task_verdicts",
): ComparisonSummary {
  const storedTotal = (db.prepare("SELECT count(*) as c FROM task_verdicts").get() as { c: number }).c;
  const derivedTotal = (db.prepare(`SELECT count(*) as c FROM ${derivedTableName}`).get() as { c: number }).c;

  // Exact matches: (task_id, card_id, at) matches
  const exactMatches = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      JOIN ${derivedTableName} dv ON dv.task_id = tv.task_id AND dv.card_id = tv.card_id AND dv.at = tv.at
    `).get() as { c: number }
  ).c;

  // Fan-out false stamps: stored tv row where the report at that timestamp exists and declared a DIFFERENT task
  const fanoutFalseStamps = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      JOIN ${derivedTableName} dv ON dv.card_id = tv.card_id AND dv.at = tv.at
      WHERE tv.task_id != dv.task_id
    `).get() as { c: number }
  ).c;

  // Pruned: stored rows where report timestamp is older than minimum report in reports table
  const minReportAtRow = db.prepare("SELECT min(updated_at) as min_at FROM reports").get() as { min_at: number | null };
  const minReportAt = minReportAtRow?.min_at ?? Infinity;

  const prunedFromReports = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      WHERE tv.at < ?
    `).get(minReportAt) as { c: number }
  ).c;

  // Exit without report: stored rows with verdict IS NULL and no report exists at all
  const exitWithoutReport = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      LEFT JOIN reports r ON r.card_id = tv.card_id AND r.updated_at = tv.at
      WHERE r.seq IS NULL AND tv.at >= ?
    `).get(minReportAt) as { c: number }
  ).c;

  // Undeclared: reports that exist but declared no taskId
  const undeclaredReports = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      JOIN reports r ON r.card_id = tv.card_id AND r.updated_at = tv.at
      LEFT JOIN ${derivedTableName} dv ON dv.card_id = tv.card_id AND dv.at = tv.at
      WHERE dv.id IS NULL
    `).get() as { c: number }
  ).c;

  // Verdict divergences: where task, card, at match, but verdict values differ
  const verdictDivergences = (
    db.prepare(`
      SELECT count(*) as c
      FROM task_verdicts tv
      JOIN ${derivedTableName} dv ON dv.task_id = tv.task_id AND dv.card_id = tv.card_id AND dv.at = tv.at
      WHERE (tv.verdict IS NOT NULL OR dv.verdict IS NOT NULL)
        AND (tv.verdict != dv.verdict OR tv.verdict IS NULL OR dv.verdict IS NULL)
    `).get() as { c: number }
  ).c;

  return {
    storedTotal,
    derivedTotal,
    exactMatches,
    fanoutFalseStamps,
    prunedFromReports,
    exitWithoutReport,
    undeclaredReports,
    verdictDivergences,
  };
}
