/**
 * Parity fixture for Graficos.dc.html and Sprints.dc.html.
 * Seeds the same counts, names, and bar inputs the prototypes show.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const MIN = 60_000;
const HOUR = 3_600_000;

function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

function pad(n) {
  return String(n).padStart(12, "0");
}

/**
 * @returns {{ now: number, sprintStart: number }}
 */
export function seedGraficosSprintsMock(dbPath, boardId, sprintId) {
  const now = at(2026, 10, 7);
  const sprintStart = at(2026, 10, 5);
  const inWin = at(2026, 10, 6);
  // Bar shares are the prototype's track percentages. The printed label is
  // the arrival (creation to done) and is not one scale of those shares.
  const phaseByTask = {
    "d97be5aa-aaaa-4000-8000-000000000001": { queue: 10, run: 45, review: 20, label: 110 },
    "ba68ddaa-aaaa-4000-8000-000000000002": { queue: 30, run: 62, review: 6, label: 250 },
    "e0b6b8aa-aaaa-4000-8000-000000000003": { queue: 4, run: 55, review: 8, label: 95 },
    "9012e6aa-aaaa-4000-8000-000000000004": { queue: 18, run: 25, review: 4, label: 55 },
    "104e4faa-aaaa-4000-8000-000000000005": { queue: 8, run: 52, review: 22, label: 125 },
  };
  const prevAt = at(2026, 10, 4);
  const db = new Database(dbPath);

  const approvedQueue = [
    ...Array(21).fill("commandcode"),
    ...Array(9).fill("claude"),
    ...Array(6).fill("cline"),
    ...Array(2).fill("antigravity"),
  ];
  const rejectedQueue = [...Array(4).fill("commandcode"), "claude", ...Array(3).fill("cline")];
  const take = (queue, kind) => {
    const provider = queue.shift();
    if (!provider) throw new Error(`v4 fixture ran out of ${kind} providers`);
    return provider;
  };

  const tasks = [];
  const chart = [
    { id: "d97be5aa-aaaa-4000-8000-000000000001", prompt: "ciclo", doneAt: now - 1 * MIN, verdicts: ["aprovado", "aprovado"] },
    { id: "ba68ddaa-aaaa-4000-8000-000000000002", prompt: "A5b", doneAt: now - 2 * MIN, verdicts: [null, null, null, "aprovado"] },
    { id: "e0b6b8aa-aaaa-4000-8000-000000000003", prompt: "ciclo", doneAt: now - 3 * MIN, verdicts: ["aprovado"] },
    { id: "9012e6aa-aaaa-4000-8000-000000000004", prompt: "ciclo", doneAt: now - 4 * MIN, verdicts: ["aprovado"] },
    { id: "104e4faa-aaaa-4000-8000-000000000005", prompt: "ciclo", doneAt: now - 5 * MIN, verdicts: ["aprovado"] },
  ];
  for (const row of chart) {
    const phase = phasePath(row.doneAt, phaseByTask[row.id]);
    tasks.push({
      id: row.id,
      prompt: row.prompt,
      status: "done",
      card_id: `v4-cycle-${row.id.slice(0, 6)}`,
      sprint_id: sprintId,
      updated_at: row.doneAt,
      requested_status: null,
      verdicts: row.verdicts,
      transitions: phase.transitions,
      phaseVerdictAt: phase.runEnd,
      phaseReportAt: phase.reportAt,
    });
  }
  for (let i = 0; i < 13; i++) {
    const doneAt = now - (40 + i) * MIN;
    // Arrival stays 160 min (the median). The cycle itself stays at or under
    // 100 min so the chart axis is 100 and the five bars keep the prototype shares.
    const transitions = arrivalPath(doneAt, 160, i === 2 ? 100 : 1);
    if (i < 2) transitions.push({ from: "done", to: "pending", at: doneAt + 1000 });
    tasks.push({
      id: `a16000aa-aaaa-4000-8000-${pad(i + 1)}`,
      prompt: "ciclo",
      status: "done",
      card_id: null,
      sprint_id: sprintId,
      updated_at: doneAt,
      requested_status: null,
      verdicts: ["aprovado"],
      transitions,
    });
  }

  const rest = [
    { id: "rev000aa-aaaa-4000-8000-000000000001", status: "pending", card_id: "v4-review-card", verdicts: ["aprovado"], role: "review" },
    { id: "run000aa-aaaa-4000-8000-000000000001", status: "running", card_id: "fila-v3-live-claude", verdicts: ["aprovado"], role: "running" },
    { id: "run000aa-aaaa-4000-8000-000000000002", status: "running", card_id: "fila-v3-live-gemini", verdicts: ["aprovado"], role: "running" },
    { id: "rdy000aa-aaaa-4000-8000-000000000001", status: "pending", verdicts: ["aprovado"] },
    { id: "rdy000aa-aaaa-4000-8000-000000000002", status: "pending", verdicts: ["aprovado"] },
    { id: "rdy000aa-aaaa-4000-8000-000000000003", status: "pending", verdicts: ["reprovado", "aprovado"] },
    { id: "rdy000aa-aaaa-4000-8000-000000000004", status: "pending", verdicts: ["reprovado", "aprovado"] },
    { id: "wait00aa-aaaa-4000-8000-000000000001", status: "pending", requested_status: "pending", verdicts: ["reprovado", "aprovado"] },
    { id: "wait00aa-aaaa-4000-8000-000000000002", status: "pending", requested_status: "pending", verdicts: ["reprovado", "aprovado"] },
    { id: "wait00aa-aaaa-4000-8000-000000000003", status: "pending", requested_status: "pending", verdicts: ["reprovado", "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000001", status: "superseded", verdicts: ["reprovado", "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000002", status: "superseded", verdicts: ["reprovado", "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000003", status: "superseded", verdicts: ["reprovado", "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000004", status: "superseded", verdicts: [null, "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000005", status: "superseded", verdicts: [null, null, "aprovado"] },
    { id: "sup000aa-aaaa-4000-8000-000000000006", status: "superseded", verdicts: [null, null, "aprovado"] },
    { id: "fail00aa-aaaa-4000-8000-000000000001", status: "failed", verdicts: [null, null, "aprovado"] },
    { id: "fail00aa-aaaa-4000-8000-000000000002", status: "failed", verdicts: [null, null, "aprovado"] },
    { id: "d00a03aa-aaaa-4000-8000-000000000010", prompt: "gate no report", status: "failed", verdicts: [null, null, null, "aprovado"] },
  ];
  for (const row of rest) {
    tasks.push({
      prompt: "task",
      card_id: null,
      sprint_id: sprintId,
      updated_at: inWin,
      requested_status: null,
      transitions: row.role === "running" ? runningPath(inWin) : [],
      ...row,
    });
  }
  for (let i = 0; i < 13; i++) {
    tasks.push({
      id: `null00aa-aaaa-4000-8000-${pad(i + 1)}`,
      prompt: "sem veredito",
      status: "failed",
      card_id: null,
      sprint_id: sprintId,
      updated_at: inWin,
      requested_status: null,
      verdicts: [null],
      transitions: [],
    });
  }
  for (let i = 0; i < 14; i++) {
    tasks.push({
      id: `prev00aa-aaaa-4000-8000-${pad(i + 1)}`,
      prompt: "periodo anterior",
      status: "done",
      card_id: null,
      sprint_id: null,
      updated_at: prevAt,
      requested_status: null,
      verdicts: [],
      transitions: [],
    });
  }

  const buckets = { 1: 0, 2: 0, 3: 0, "4": 0 };
  let typed = 0;
  for (const task of tasks) {
    if (task.sprint_id !== sprintId || task.updated_at < sprintStart) continue;
    const idx = task.verdicts.findIndex((v) => v === "aprovado");
    if (idx >= 0) {
      const rounds = idx + 1;
      const key = rounds >= 4 ? "4" : String(rounds);
      buckets[key] += 1;
    }
    for (const v of task.verdicts) if (v === "aprovado" || v === "reprovado") typed += 1;
  }
  if (buckets[1] !== 22 || buckets[2] !== 9 || buckets[3] !== 4 || buckets[4] !== 2) {
    throw new Error(`v4 round buckets ${JSON.stringify(buckets)}`);
  }
  if (typed !== 46) throw new Error(`v4 typed verdicts ${typed}`);
  const currentDone = tasks.filter((t) => t.status === "done" && t.sprint_id === sprintId && t.updated_at >= sprintStart).length;
  const previousDone = tasks.filter((t) => t.status === "done" && t.updated_at >= sprintStart - (now - sprintStart) && t.updated_at < sprintStart).length;
  if (currentDone !== 18 || previousDone !== 14) {
    throw new Error(`v4 done counts current=${currentDone} previous=${previousDone}`);
  }

  const insertTask = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json,
      purpose, review, territory_json, gates_json, allow_commit, report_schema_json,
      spawn_profile, retry_count, attempted_providers_json, max_retries, fallback_providers_json,
      "order", suggested_order, implicit_order, diverged_status, diverged_actor,
      requested_status, requested_reason, requested_by, requested_at, superseded_by,
      sprint_id, created_at, updated_at
    ) VALUES (
      @id, @prompt, NULL, @status, @card_id, @board_id, NULL, NULL, NULL,
      'implement', NULL, NULL, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, NULL,
      @ord, NULL, NULL, NULL, NULL,
      @requested_status, NULL, NULL, NULL, NULL,
      @sprint_id, @created_at, @updated_at
    )
  `);
  const insertTransition = db.prepare(`
    INSERT INTO task_transitions (id, task_id, kind, from_value, to_value, actor, card_id, user_id, at)
    VALUES (?, ?, 'status', ?, ?, 'human', NULL, NULL, ?)
  `);
  const insertVerdict = db.prepare(`
    INSERT INTO task_verdicts (id, task_id, card_id, role, verdict, at)
    VALUES (?, ?, ?, 'reviewer', ?, ?)
  `);
  const insertCard = db.prepare(`
    INSERT OR REPLACE INTO cards (id, provider, cwd, x, y, w, h, updated_at, kind, board_id, label)
    VALUES (?, ?, ?, 4000, 4000, 200, 120, ?, 'terminal', ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR REPLACE INTO task_cards (task_id, card_id, role, linked_at, provider, reservation_state, released_at)
    VALUES (?, ?, 'implementer', ?, ?, NULL, NULL)
  `);
  const insertReport = db.prepare(`
    INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at)
    VALUES (?, ?, ?, NULL, 'implementer', 'report', ?)
  `);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM task_verdicts WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)`).run(boardId);
    db.prepare(`DELETE FROM task_transitions WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)`).run(boardId);
    db.prepare(`DELETE FROM task_cards WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)`).run(boardId);
    db.prepare(`DELETE FROM tasks WHERE board_id = ?`).run(boardId);
    for (const provider of ["commandcode", "claude", "cline", "antigravity"]) {
      insertCard.run(`v4-card-${provider}`, provider, "/tmp", now, boardId, provider);
    }
    insertCard.run("v4-card-null", "bash", "/tmp", now, boardId, "null");
    insertCard.run("v4-review-card", "claude", "/tmp", now, boardId, "review");

    let order = 1;
    let tr = 1;
    let vd = 1;
    let stamp = sprintStart;
    for (const task of tasks) {
      insertTask.run({
        id: task.id,
        prompt: task.prompt,
        status: task.status,
        card_id: task.card_id,
        board_id: boardId,
        ord: order++,
        requested_status: task.requested_status,
        sprint_id: task.sprint_id,
        created_at: task.updated_at - HOUR,
        updated_at: task.updated_at,
      });
      for (const step of task.transitions) {
        insertTransition.run(`v4-tr-${tr++}`, task.id, step.from, step.to, step.at);
      }
      const lastTyped = task.verdicts.reduce((found, verdict, index) => (
        verdict === "aprovado" || verdict === "reprovado" ? index : found
      ), -1);
      task.verdicts.forEach((verdict, index) => {
        const provider = verdict === "aprovado" ? take(approvedQueue, "approved") : verdict === "reprovado" ? take(rejectedQueue, "rejected") : null;
        const cardId = provider ? `v4-card-${provider}` : "v4-card-null";
        const verdictAt = task.phaseVerdictAt != null && index === lastTyped ? task.phaseVerdictAt : stamp++;
        insertVerdict.run(`v4-vd-${vd++}`, task.id, cardId, verdict, verdictAt);
      });
      if (task.phaseReportAt != null && task.card_id) {
        insertReport.run(
          910010 + order,
          task.card_id,
          JSON.stringify({ ok: true, estado: "final", taskId: task.id }),
          task.phaseReportAt,
        );
      }
      if (task.role === "running" && task.card_id) insertLink.run(task.id, task.card_id, inWin, "bash");
      if (task.role === "review" && task.card_id) {
        insertLink.run(task.id, task.card_id, inWin, "claude");
        // Mounting this card grants work at PTY spawn, which is after the
        // seed. A report dated inside the mock window is before that grant,
        // so the phase stays running. This row is the task's own ok:true
        // final report, stamped after any grant this run can produce.
        insertReport.run(
          910001,
          task.card_id,
          JSON.stringify({ ok: true, estado: "final", taskId: task.id }),
          Date.now() + 24 * HOUR,
        );
      }
    }
    db.prepare(
      `UPDATE sprints SET number = 2, name = 'Ciclo 2', started_at = ? WHERE id = ?`,
    ).run(sprintStart, sprintId);
    const insertSprint = db.prepare(`
      INSERT INTO sprints (id, board_id, number, name, started_at, closed_at, count_todo, count_doing, count_done, count_failed, migrated_in, migrated_out, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, NULL)
    `);
    insertSprint.run("v4-ciclo-1", boardId, 1, "Ciclo 1 · backend e app v2", at(2026, 9, 28), at(2026, 10, 5), 0, 41, 3);
    insertSprint.run("v4-site-v2", boardId, 0, "Site v2", at(2026, 9, 20), at(2026, 9, 27), 2, 14, 0);
    insertSprint.run("v4-sem-sprint", boardId, 100, "Sem sprint", at(2026, 9, 1), at(2026, 9, 10), 0, 312, 0);
  });
  tx();
  if (approvedQueue.length || rejectedQueue.length) {
    db.close();
    throw new Error(`v4 providers left approved=${approvedQueue.length} rejected=${rejectedQueue.length}`);
  }
  db.close();
  return { now, sprintStart };
}

function phasePath(doneAt, phase) {
  const start = doneAt - phase.label * MIN;
  const runEnd = start + (phase.queue + phase.run + phase.review) * MIN;
  return {
    // The superseded span is outside queue and running, so the arrival
    // (the row label) can outlast the three bar segments.
    transitions: [
      { from: null, to: "pending", at: start },
      { from: "pending", to: "running", at: start + phase.queue * MIN },
      { from: "running", to: "superseded", at: runEnd },
      { from: "superseded", to: "done", at: doneAt },
    ],
    runEnd,
    reportAt: runEnd - phase.review * MIN,
  };
}

function arrivalPath(doneAt, arrivalMin, cycleMin) {
  const start = doneAt - arrivalMin * MIN;
  const cycleEnd = start + cycleMin * MIN;
  return [
    { from: null, to: "pending", at: start },
    { from: "pending", to: "running", at: start },
    { from: "running", to: "superseded", at: cycleEnd },
    { from: "superseded", to: "done", at: doneAt },
  ];
}

function runningPath(atMs) {
  return [
    { from: null, to: "pending", at: atMs - 20 * MIN },
    { from: "pending", to: "running", at: atMs - 10 * MIN },
  ];
}
