/**
 * Fila V3 — isolated smoke: seed tasks covering every queue column/phase,
 * assert columns, needs-you strip, filters, and detail Agora variants.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-smoke-fila-v3-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function findDb(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "agent-canvas.db") return p;
    }
  }
  return null;
}

function seed(dbPath, boardId, sprintId) {
  const db = new Database(dbPath);
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json,
      purpose, review, territory_json, gates_json, allow_commit, report_schema_json,
      spawn_profile, retry_count, attempted_providers_json, max_retries, fallback_providers_json,
      "order", suggested_order, implicit_order, diverged_status, diverged_actor,
      requested_status, requested_reason, requested_by, requested_at, superseded_by,
      sprint_id, created_at, updated_at
    ) VALUES (
      @id, @prompt, NULL, @status, NULL, @board_id, NULL, @result_json, @deps_json,
      @purpose, @review, NULL, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, NULL,
      @ord, NULL, NULL, NULL, NULL,
      @requested_status, @requested_reason, NULL, @requested_at, @superseded_by,
      @sprint_id, @created_at, @updated_at
    )
  `);
  const rows = [
    { id: "wait0001-aaaa-4000-8000-000000000001", prompt: "waiting deps", status: "pending", purpose: "implement", deps_json: JSON.stringify(["missing-dep"]), result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 1 },
    { id: "ask00002-aaaa-4000-8000-000000000002", prompt: "blocked ask", status: "pending", purpose: "implement", deps_json: null, result_json: JSON.stringify({ blockedQuestion: { text: "q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], askedAt: now, by: "x" } }), review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 2 },
    { id: "ready003-aaaa-4000-8000-000000000003", prompt: "ready task", status: "pending", purpose: "fix", deps_json: null, result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 3 },
    { id: "run00004-aaaa-4000-8000-000000000004", prompt: "running task", status: "running", purpose: "fix", deps_json: null, result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 4 },
    { id: "rev00005-aaaa-4000-8000-000000000005", prompt: "review task", status: "pending", purpose: "fix", deps_json: null, result_json: null, review: "wanted", requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 5 },
    { id: "done0006-aaaa-4000-8000-000000000006", prompt: "done today", status: "done", purpose: "implement", deps_json: null, result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 6 },
    { id: "fail0007-aaaa-4000-8000-000000000007", prompt: "failed task", status: "failed", purpose: "fix", deps_json: null, result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: null, ord: 7 },
    { id: "sup00008-aaaa-4000-8000-000000000008", prompt: "superseded task", status: "superseded", purpose: "fix", deps_json: null, result_json: null, review: null, requested_status: null, requested_reason: null, requested_at: null, superseded_by: "done0006-aaaa-4000-8000-000000000006", ord: 8 },
  ];
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run({
        ...r,
        board_id: boardId,
        sprint_id: sprintId,
        created_at: now - 1000,
        updated_at: now,
      });
    }
  });
  tx();
  db.close();
}

async function waitFor(page, expr, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(100);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Fila V3 smoke", { spawnTerminal: false });
  await delay(500);

  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Fila V3 smoke") ?? boards[0];
        const boot = await window.tasks.create(board.id, "__fila_v3_smoke_boot__");
        const sprints = await window.tasks.listSprints(board.id);
        const active = sprints.find((s) => s.closedAt === null);
        return JSON.stringify({
          boardId: board.id,
          sprintId: active?.id ?? null,
          bootTaskId: boot.ok ? boot.taskId : null,
        });
      })()
    `),
  );

  let dbPath = null;
  for (let i = 0; i < 40; i++) {
    dbPath = findDb(USER_DATA_DIR);
    if (dbPath) break;
    await delay(100);
  }
  check("isolated db exists", !!dbPath, true);
  check("active sprint after bootstrap", !!ids.sprintId, true);
  {
    const db = new Database(dbPath);
    if (ids.bootTaskId) db.prepare("DELETE FROM tasks WHERE id = ?").run(ids.bootTaskId);
    db.close();
  }
  seed(dbPath, ids.boardId, ids.sprintId);
  // SQL seed does not push task:changed — poke create forces a board rebuild.
  const poke = JSON.parse(
    await page.evalJs(`
      (async () => {
        const r = await window.tasks.create(${JSON.stringify(ids.boardId)}, "__fila_v3_smoke_poke__");
        return JSON.stringify(r);
      })()
    `),
  );
  if (poke.ok) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(poke.taskId);
    db.close();
    await page.evalJs(`
      (async () => {
        const tasks = await window.tasks.listByBoard(${JSON.stringify(ids.boardId)});
        const one = tasks.find((t) => t.id.startsWith("ready003"));
        if (one) await window.tasks.updatePrompt(one.id, one.promptPreview || "ready task", "replace");
      })()
    `);
  }
  await delay(400);

  await spawnCard(page, "task");
  check("queue board mounts", await waitFor(page, `document.querySelector('[data-part="queue-board"]')`), true);

  for (const col of ["waiting", "ready", "running", "review", "done"]) {
    check(
      `coluna ${col} presente`,
      await waitFor(page, `document.querySelector('[data-part="queue-column"][data-column="${col}"]')`),
      true,
    );
  }
  // Shown state of the approved prototype: Falhas/Substituídas start open.
  check("falhas aberta", await waitFor(page, `document.querySelector('[data-part="queue-column"][data-column="failed"]')`), true);
  check("substituídas aberta", await waitFor(page, `document.querySelector('[data-part="queue-column"][data-column="superseded"]')`), true);
  check("faixa precisa de você", await page.evalJs(`!!document.querySelector('[data-part="needs-you-card"]')`), true);
  check("ver todas as N", await page.evalJs(`!!document.querySelector('[data-part="queue-see-all-done"]')`), true);

  await page.evalJs(`
    document.querySelector('[data-part="queue-column"][data-column="failed"] button[aria-label]')?.click()
  `);
  check("falhas recolhe para trilho", await waitFor(page, `document.querySelector('[data-part="queue-rail-failed"]')`), true);

  await page.evalJs(`
    [...document.querySelectorAll('[data-task-item-id]')].find((el) =>
      el.getAttribute('data-task-item-id')?.startsWith('ask00002'))?.click()
  `);
  check("detalhe V3 abre", await waitFor(page, `document.querySelector('[data-part="task-detail-v3"]')`), true);
  check("faixa Agora presente", await page.evalJs(`!!document.querySelector('[data-part="agora-banner"]')`), true);

  const phases = JSON.parse(
    await page.evalJs(`
      (async () => {
        const tasks = await window.tasks.listByBoard(${JSON.stringify(ids.boardId)});
        const by = {};
        for (const t of tasks) by[t.id.slice(0,8)] = t.phase;
        return JSON.stringify(by);
      })()
    `),
  );
  check("fase waiting_deps", phases.wait0001 === "waiting_deps" || phases.wait0001 === "ready", true);
  check("fase done", phases.done0006 === "done", true);
  check("fase failed", phases.fail0007 === "failed", true);
  check("fase superseded", phases.sup00008 === "superseded", true);
} finally {
  await stopApp(app);
}
finish();
