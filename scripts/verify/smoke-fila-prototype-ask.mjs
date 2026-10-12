// The Fila's prototype-to-approve card, in a real isolated app.
//
// A card shows up ONLY when an agent declared a prototype and asked for approval
// (a `parcial` report with prototype: { path, approval: "requested" }); a task
// that merely lacks a reviewer must not. Opening shows the file in a browser
// card, approving stores the approval and tells the card doing the work
// (without touching the task's status), dismissing only takes the card off the
// strip and can be undone. Isolated userData and port; never the
// owner's app. Screenshots go to FILA_PROTO_OUT (default /tmp/fila-proto).
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const OUT_DIR = process.env.FILA_PROTO_OUT ?? "/tmp/fila-proto";
mkdirSync(OUT_DIR, { recursive: true });

const CDP_PORT = await pickFreePort();
// Short on purpose: the profile's unix socket path must stay under ~108 bytes.
const USER_DATA_DIR = `/tmp/sfpa-${CDP_PORT}`;
const FAKE_BIN = `/tmp/sfpa-bin-${CDP_PORT}`;
mkdirSync(FAKE_BIN, { recursive: true });
// A stand-in agent binary that stays alive, so the implementer card is a live
// agent that can be told to go on — without launching a real one.
writeFileSync(`${FAKE_BIN}/claude`, "#!/bin/sh\nexec sleep 600\n");
chmodSync(`${FAKE_BIN}/claude`, 0o755);

const T_PROTO = "a550a7ae-aaaa-4000-8000-000000000015";
const T_REVIEW = "ee22c748-aaaa-4000-8000-000000000016";
const T_ASK = "70584525-aaaa-4000-8000-000000000017";
const AGENT = "fila-proto-agent";
const FILA = "fila-proto-board";

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

const { check, finish } = makeChecker();
let app;
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, isolatedHome: true, extraEnv: { PATH: `${FAKE_BIN}:${process.env.PATH}` } });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
  await delay(1000);
  await bootIntoFreshSession(page, "Fila proto ask", { spawnTerminal: false });
  await delay(500);

  const ids = JSON.parse(
    await page.evalJs(`(async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Fila proto ask") ?? boards[0];
      const boot = await window.tasks.create(board.id, "__boot__");
      const sprints = await window.tasks.listSprints(board.id);
      return JSON.stringify({ boardId: board.id, cwd: board.cwd, sprintId: sprints.find((s) => s.closedAt === null)?.id ?? null, boot: boot.ok ? boot.taskId : null });
    })()`),
  );
  let dbPath = null;
  for (let i = 0; i < 40 && !dbPath; i++) {
    dbPath = findDb(USER_DATA_DIR);
    if (!dbPath) await delay(100);
  }
  check("isolated db exists", !!dbPath, true);
  check("the board's folder is inside the isolated home (the prototype file is written there)", ids.cwd.startsWith("/tmp/"), true);

  // The prototype file the agent declared lives in the board's prototypes/.
  mkdirSync(join(ids.cwd, "prototypes"), { recursive: true });
  writeFileSync(join(ids.cwd, "prototypes", "demo.dc.html"), "<!doctype html><title>demo</title><h1>demo prototype</h1>");

  const now = Date.now();
  const db = new Database(dbPath);
  if (ids.boot) db.prepare("DELETE FROM tasks WHERE id = ?").run(ids.boot);
  const insertTask = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json,
      purpose, review, territory_json, gates_json, allow_commit, report_schema_json,
      spawn_profile, retry_count, attempted_providers_json, max_retries, fallback_providers_json,
      "order", suggested_order, implicit_order, diverged_status, diverged_actor,
      requested_status, requested_reason, requested_by, requested_at, superseded_by,
      sprint_id, created_at, updated_at
    ) VALUES (
      @id, @prompt, NULL, 'pending', @card_id, @board_id, NULL, @result_json, NULL,
      'implement', @review, NULL, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, NULL,
      @ord, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      @sprint_id, @created_at, @updated_at
    )
  `);
  const base = { board_id: ids.boardId, sprint_id: ids.sprintId, created_at: now - 10_000, updated_at: now };
  // The task that declared a prototype (implemented by the live agent card).
  insertTask.run({ ...base, id: T_PROTO, prompt: "Detalhe da task no card Fila, mais organizado", card_id: AGENT, result_json: null, review: null, ord: 1 });
  // The kind of task the owner saw by mistake: review wanted, no reviewer, NO prototype.
  insertTask.run({ ...base, id: T_REVIEW, prompt: "RAÍZES DECLARADAS PELO USUÁRIO — falta só o revisor", card_id: null, result_json: null, review: "wanted", ord: 2 });
  // A question, so the strip also holds a card that is not a prototype.
  insertTask.run({
    ...base,
    id: T_ASK,
    prompt: "pergunta",
    card_id: null,
    result_json: JSON.stringify({ blockedQuestion: { text: "q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], askedAt: now, by: "x" } }),
    review: null,
    ord: 3,
  });
  db.prepare(`INSERT OR REPLACE INTO task_cards (task_id, card_id, role, linked_at, provider, reservation_state, reserved_order, released_at) VALUES (?, ?, 'implementer', ?, 'claude', NULL, NULL, NULL)`).run(T_PROTO, AGENT, now);
  const insertReport = db.prepare(`INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at) VALUES (?, ?, ?, NULL, 'implementer', 'mcp', ?)`);
  const askReport = (path) => JSON.stringify({ estado: "parcial", taskId: T_PROTO, decisaoTomada: "protótipo pronto", prototype: { path, approval: "requested" } });
  insertReport.run(910001, AGENT, askReport("prototypes/demo.dc.html"), now - 3 * 3_600_000);
  db.close();

  // The agent card and the Fila card exist as rows; the board reads them on open.
  const cardRow = (id, kind, provider, x, y, w, h) => ({
    id, board_id: ids.boardId, kind, provider, cwd: kind === "terminal" ? ids.cwd : "", x, y, w, h,
    resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null,
    updated_at: Date.now(), messages_json: null, archived_at: null,
  });
  for (const row of [cardRow(AGENT, "terminal", "claude", 1560, 20, 220, 160), cardRow(FILA, "task", "", 20, 20, 1520, 900)]) {
    await page.evalJs(`window.store.upsert(${JSON.stringify(row)}).then(() => true)`);
  }
  const reopen = async () => {
    await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
    for (let i = 0; i < 80 && !(await page.evalJs(`!!document.querySelector(".home-session-card")`)); i++) await delay(100);
    await page.evalJs(`(() => { const n = [...document.querySelectorAll(".home-session-name")].find((x) => x.textContent.includes("Fila proto ask")); (n?.closest("button") ?? document.querySelector(".home-session-card"))?.click(); return true; })()`);
    for (let i = 0; i < 100 && !(await page.evalJs(`!!document.querySelector('[data-part="queue-board"]')`)); i++) await delay(100);
    await delay(700);
  };
  await reopen();
  check("the Fila mounts", await page.evalJs(`!!document.querySelector('[data-part="queue-board"]')`), true);
  const strip = () =>
    page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-part="needs-you-card"]')].map((c) => ({ head: c.querySelector('[data-part="needs-you-head"]').innerText, body: c.querySelector('[data-part="needs-you-body"]').innerText.slice(0, 60), proto: !!c.querySelector('[data-part="prototype-open"]') })))`).then(JSON.parse);
  const chip = () => page.evalJs(`document.querySelector('[data-part="queue-filter-needsYou-count"]')?.innerText`);
  const has = (sel) => page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
  const shot = async (name) => {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
  };

  // -- which tasks are in the strip --
  let cards = await strip();
  check("the strip has the question and the prototype, and nothing for the task that only lacks a reviewer", cards.length, 2);
  check("exactly one card is a prototype", cards.filter((c) => c.proto).length, 1);
  const protoCard = cards.find((c) => c.proto);
  check("its head says Protótipo para aprovar with the age (3 h)", protoCard?.head, "Protótipo para aprovar · há 3 h");
  check("its body is the task's #id and title", protoCard?.body.startsWith("#a550a7ae"), true);
  check("the card shows the file path", await page.evalJs(`document.querySelector('[data-part="prototype-file"]')?.innerText`), "prototypes/demo.dc.html");
  check("no card mentions the reviewer-only task", cards.some((c) => c.body.includes("ee22c748")), false);
  check("the 'Precisa de você' count is 2 (question + prototype)", await chip(), "2");
  check("the reviewer-only task is still on the board, in a column", await has(`[data-task-item-id="${T_REVIEW}"]`), true);
  await shot("app-prototipo");

  // -- the open button shows the prototype, not the task detail --
  const browsersBefore = await page.evalJs(`document.querySelectorAll('.card-frame[data-kind="browser"]').length`);
  await page.evalJs(`document.querySelector('[data-part="prototype-open"]').click()`);
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) {
    opened = (await page.evalJs(`document.querySelectorAll('.card-frame[data-kind="browser"]').length`)) > browsersBefore;
    if (!opened) await delay(150);
  }
  check("Abrir protótipo opens a browser card", opened, true);
  check("...and does not open the task detail", await has('[data-part="task-detail-v3"]'), false);
  const urlOfBrowser = await page.evalJs(`(async () => { const cards = await window.store.listCards?.(); return null; })()`).catch(() => null);
  void urlOfBrowser;

  // -- Ver task is the secondary link: it opens the detail --
  await page.evalJs(`document.querySelector('[data-part="prototype-task-link"]').click()`);
  check("Ver task opens the task detail", await page.evalJs(`new Promise((r) => { let n = 0; const t = setInterval(() => { if (document.querySelector('[data-part="task-detail-v3"]') || ++n > 40) { clearInterval(t); r(!!document.querySelector('[data-part="task-detail-v3"]')); } }, 100); })`), true);
  await page.evalJs(`document.querySelector('[data-part="task-detail-v3"] [aria-label="Fechar"], [data-part="task-detail-v3-close"]')?.click()`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await delay(300);

  // -- Dispensar only removes the card; Desfazer brings it back --
  const statusOf = (id) => {
    const handle = new Database(dbPath, { readonly: true });
    const row = handle.prepare("SELECT status, result_json FROM tasks WHERE id = ?").get(id);
    handle.close();
    return row;
  };
  await page.evalJs(`document.querySelector('[data-part="prototype-dismiss"]').click()`);
  await delay(400);
  check("Dispensar takes the card off the strip", (await strip()).filter((c) => c.proto).length, 0);
  check("...and the 'Precisa de você' count drops to 1", await chip(), "1");
  check("...and the task's status is untouched", statusOf(T_PROTO).status, "pending");
  check("...and nothing was stored on the task", (statusOf(T_PROTO).result_json ?? "").includes("prototypeApproval"), false);
  check("the dismissal is remembered by board and ask (localStorage)", await page.evalJs(`(localStorage.getItem("stellar.fila.prototypeDismissed.${ids.boardId}") ?? "").includes("${T_PROTO}:")`), true);
  await shot("app-dispensado");
  await page.evalJs(`document.querySelector('.toast-action')?.click()`);
  await delay(400);
  check("Desfazer brings the prototype card back", (await strip()).filter((c) => c.proto).length, 1);

  // A dismissal survives a reopen of the board.
  await page.evalJs(`document.querySelector('[data-part="prototype-dismiss"]').click()`);
  await delay(300);
  await reopen();
  check("a dismissed card stays off after the board is reopened", (await strip()).filter((c) => c.proto).length, 0);
  // A NEW ask (a later report) shows again: the dismissal belonged to the old one.
  {
    const handle = new Database(dbPath);
    handle.prepare(`INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at) VALUES (?, ?, ?, NULL, 'implementer', 'mcp', ?)`).run(910002, AGENT, askReport("demo.dc.html"), Date.now() - 1_000);
    handle.close();
  }
  await reopen();
  check("a newer ask for the same task shows the card again", (await strip()).filter((c) => c.proto).length, 1);

  // -- Aprovar stores the approval, tells the card, and never changes the task --
  await page.evalJs(`document.querySelector('[data-part="prototype-approve"]').click()`);
  let stored = false;
  for (let i = 0; i < 40 && !stored; i++) {
    stored = (statusOf(T_PROTO).result_json ?? "").includes("prototypeApproval");
    if (!stored) await delay(150);
  }
  check("Aprovar stores prototypeApproval on the task", stored, true);
  check("...without changing the task's status", statusOf(T_PROTO).status, "pending");
  await delay(300);
  check("...and the card leaves the strip", (await strip()).filter((c) => c.proto).length, 0);
  check("...and the toast says the live agent card was told", await page.evalJs(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('foi avisada para seguir com a fase 2'))`), true);
  await shot("app-aprovado");
  const approval = JSON.parse(statusOf(T_PROTO).result_json).prototypeApproval;
  check("the stored approval names the file and the report it answers", `${approval.path}|${typeof approval.askedAt}|${typeof approval.approvedAt}`, "demo.dc.html|number|number");
  // The approval is idempotent and survives a reopen.
  await reopen();
  check("an approved prototype does not come back", (await strip()).filter((c) => c.proto).length, 0);
  check("the reviewer-only task never became a prototype card", (await strip()).some((c) => c.body.includes("ee22c748")), false);
  check("the prototype file is where the server looks for it", existsSync(join(ids.cwd, "prototypes", "demo.dc.html")), true);
} finally {
  if (app) await stopApp(app);
}
finish();
