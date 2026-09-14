/**
 * Live proof: numbers from computeWorkStats === SQL on an ISOLATED copy
 * of a real schema seeded with known transitions (never the owner's DB).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { computeArrivalCycles, computeWorkStats, median } from "../../src/renderer/src/work-stats";

let dir: string | null = null;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function openSeeded(): Database.Database {
  dir = mkdtempSync(join(tmpdir(), "stellar-work-stats-"));
  const db = new Database(join(dir, "agent-canvas.db"));
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, board_id TEXT, status TEXT);
    CREATE TABLE task_transitions (
      id TEXT PRIMARY KEY, task_id TEXT, kind TEXT,
      from_value TEXT, to_value TEXT, actor TEXT, card_id TEXT, at INTEGER
    );
    CREATE TABLE task_cards (
      task_id TEXT, card_id TEXT, role TEXT, provider TEXT, model TEXT,
      PRIMARY KEY (task_id, card_id)
    );
    CREATE TABLE task_verdicts (
      id INTEGER PRIMARY KEY, task_id TEXT, card_id TEXT, role TEXT, verdict TEXT, at INTEGER
    );
    CREATE TABLE cards (id TEXT PRIMARY KEY, provider TEXT);
  `);
  // t-fast: 10 min, 1 round, provider cursor — card deleted (orphan)
  db.prepare(`INSERT INTO tasks VALUES ('t-fast','b1','done')`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('1','t-fast','status',NULL,'pending','agent',NULL,0)`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('2','t-fast','status','pending','done','agent',NULL,600000)`).run();
  db.prepare(`INSERT INTO task_cards VALUES ('t-fast','c1','implementer','cursor',NULL)`).run();
  db.prepare(`INSERT INTO task_verdicts (task_id,card_id,role,verdict,at) VALUES ('t-fast','c1','implementer',NULL,1)`).run();

  // t-slow: 30 min, 3 rounds, no provider, reopened
  db.prepare(`INSERT INTO tasks VALUES ('t-slow','b1','done')`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('3','t-slow','status',NULL,'pending','agent',NULL,0)`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('4','t-slow','status','pending','done','agent',NULL,1800000)`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('5','t-slow','status','done','pending','human',NULL,2000000)`).run();
  db.prepare(`INSERT INTO task_transitions VALUES ('6','t-slow','status','pending','done','agent',NULL,2100000)`).run();
  db.prepare(`INSERT INTO task_cards VALUES ('t-slow','c2','implementer',NULL,NULL)`).run();
  db.prepare(`INSERT INTO task_verdicts (task_id,card_id,role,verdict,at) VALUES ('t-slow','c2','implementer',NULL,1)`).run();
  db.prepare(`INSERT INTO task_verdicts (task_id,card_id,role,verdict,at) VALUES ('t-slow','c2','implementer','reprovado',2)`).run();
  db.prepare(`INSERT INTO task_verdicts (task_id,card_id,role,verdict,at) VALUES ('t-slow','c2','implementer','aprovado',3)`).run();
  return db;
}

describe("work-stats live sqlite proof", () => {
  it("screen aggregates match hand SQL on isolated db", () => {
    const db = openSeeded();

    const sqlCycle = db
      .prepare(
        `
      WITH bounds AS (
        SELECT t.id AS task_id,
          (SELECT MIN(at) FROM task_transitions s WHERE s.task_id=t.id AND s.kind='status' AND s.to_value='pending') AS t0,
          (SELECT MIN(at) FROM task_transitions s WHERE s.task_id=t.id AND s.kind='status' AND s.to_value='done') AS t1,
          EXISTS(
            SELECT 1 FROM task_transitions s
            WHERE s.task_id=t.id AND s.kind='status' AND s.from_value='done' AND s.to_value!='done'
          ) AS reopened
        FROM tasks t WHERE t.board_id='b1' AND t.status='done'
      )
      SELECT task_id, (t1-t0) AS ms, reopened FROM bounds WHERE t0 IS NOT NULL AND t1 IS NOT NULL
    `,
      )
      .all() as { task_id: string; ms: number; reopened: number }[];

    const sqlRounds = db
      .prepare(
        `
      SELECT task_id, COUNT(*) AS rounds
      FROM task_verdicts
      GROUP BY task_id
    `,
      )
      .all() as { task_id: string; rounds: number }[];

    const sqlCoverage = db
      .prepare(
        `
      SELECT
        (SELECT COUNT(*) FROM task_verdicts) AS verdict_rows,
        (SELECT COUNT(*) FROM task_verdicts WHERE verdict IS NOT NULL) AS typed,
        (SELECT COUNT(*) FROM task_verdicts WHERE verdict IS NULL) AS nulls,
        (SELECT COUNT(*) FROM task_cards) AS parts,
        (SELECT COUNT(*) FROM task_cards tc LEFT JOIN cards c ON c.id=tc.card_id WHERE c.id IS NULL) AS orphans,
        (SELECT COUNT(*) FROM task_cards WHERE provider IS NOT NULL) AS with_provider
    `,
      )
      .get() as {
      verdict_rows: number;
      typed: number;
      nulls: number;
      parts: number;
      orphans: number;
      with_provider: number;
    };

    // Same rows the Fila would pass into computeWorkStats
    const tasks = (db.prepare(`SELECT id, status FROM tasks WHERE board_id='b1'`).all() as { id: string; status: string }[]).map(
      (t) => {
        const statusTransitions = (
          db
            .prepare(
              `SELECT from_value as fromValue, to_value as toValue, at FROM task_transitions WHERE task_id=? AND kind='status' ORDER BY at, rowid`,
            )
            .all(t.id) as { fromValue: string | null; toValue: string; at: number }[]
        );
        const verdicts = (
          db
            .prepare(`SELECT verdict, at FROM task_verdicts WHERE task_id=? ORDER BY at, rowid`)
            .all(t.id) as { verdict: string | null; at: number }[]
        ).map((v) => ({ ...v, provider: null as string | null }));
        const cards = (
          db
            .prepare(
              `SELECT tc.card_id as cardId, tc.role, tc.provider, tc.model,
                      CASE WHEN c.id IS NULL THEN 1 ELSE 0 END as orphan
               FROM task_cards tc LEFT JOIN cards c ON c.id=tc.card_id WHERE tc.task_id=?`,
            )
            .all(t.id) as { cardId: string; role: string; provider: string | null; model: string | null; orphan: number }[]
        ).map((c) => ({ ...c, orphan: c.orphan === 1 }));
        // Stamp provider onto verdicts the way COALESCE(task_cards, cards) would
        const profile = cards.find((c) => c.provider)?.provider ?? null;
        return {
          id: t.id,
          status: t.status,
          statusTransitions,
          verdicts: verdicts.map((v) => ({ ...v, provider: profile })),
          cards,
        };
      },
    );

    const stats = computeWorkStats(tasks);
    const sqlMedianMs = median(sqlCycle.map((r) => r.ms));
    const sqlMedianRounds = median(sqlRounds.map((r) => r.rounds));
    const sqlReopened = sqlCycle.filter((r) => r.reopened).length;

    expect(stats.medianCycleMs).toBe(sqlMedianMs);
    expect(stats.medianCycleMs).toBe(((600_000 + 1_800_000) / 2));
    expect(stats.medianRounds).toBe(sqlMedianRounds);
    expect(stats.medianRounds).toBe(2);
    expect(stats.coverage.reopened).toBe(sqlReopened);
    expect(stats.coverage.reopened).toBe(1);
    expect(stats.coverage.verdictRows).toBe(sqlCoverage.verdict_rows);
    expect(stats.coverage.verdictTyped).toBe(sqlCoverage.typed);
    expect(stats.coverage.verdictNull).toBe(sqlCoverage.nulls);
    expect(stats.coverage.participations).toBe(sqlCoverage.parts);
    expect(stats.coverage.orphanParticipations).toBe(sqlCoverage.orphans);
    expect(stats.coverage.withProvider).toBe(sqlCoverage.with_provider);

    // Arrival helper alone vs SQL rows
    const byTask = new Map(tasks.map((t) => [t.id, t.statusTransitions]));
    const cycles = computeArrivalCycles(byTask);
    expect(cycles.map((c) => ({ id: c.taskId, ms: c.ms, reopened: c.reopened }))).toEqual(
      sqlCycle.map((r) => ({ id: r.task_id, ms: r.ms, reopened: r.reopened === 1 })),
    );

    db.close();
  });
});
