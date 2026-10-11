// A5d — board quick task (screen 15). Four states 1:1 with BoardQuickTask.dc.html
// mock data. Prints ONLY in /tmp/a5d/.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  bootIntoFreshSession,
  connectPage,
  makeChecker,
  pickFreePort,
  spawnCard,
  startApp,
  stopApp,
} from "./cdp-client.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OUT_DIR = "/tmp/a5d";
mkdirSync(OUT_DIR, { recursive: true });
const PROTO_DIR = "/home/lucas/Workplace/Projects/StellarCloud/docs/stellar/design/app-v2/prototipo";
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_P = "11111111-1111-4111-8111-111111111111";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";

function startStatic(port, root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "BoardQuickTask.dc.html";
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" });
    res.end(readFileSync(file));
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
    origin: `http://127.0.0.1:${port}`,
  };
}

function startFakeTeamApi(port) {
  const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z" };
  const members = [
    { team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null, display_name: "Ana Ribeiro", avatar_initials: "AR", email: "ana@example.com" },
  ];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (path === "/v1/auth/token" && req.method === "POST") {
        return send(200, { access_token: "a:owner", refresh_token: "owner-refresh", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: OWNER_ACC, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [],
          profiles: [{ id: OWNER_P, account_id: OWNER_ACC, kind: "personal", team_id: null, name: "Pessoal", created_at: null }],
          teams: [team],
          plan: {
            account_plan: "team",
            account_expires_at: null,
            rights: {
              sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
              team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM_ID, expires_at: null },
            },
          },
        });
      }
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") return send(200, { team, members });
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") {
        const tasks = Array.from({ length: 5 }, (_, i) => ({
          id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`,
          team_id: TEAM_ID,
          short_id: i + 1,
          ref: `#${i + 1}`,
          title: `Task sem dono ${i + 1}`,
          kind: "corrigir",
          priority: "media",
          state: "sem_dono",
          sprint_id: null,
          assignee_id: null,
          session_label: "",
          reviewer_id: null,
          provider: "",
          territory: [],
          gates: [],
          allow_commit: false,
          report_schema: [],
          max_retries: 0,
          auto_dispatch: false,
          origin_kind: "manual",
          origin_external_id: null,
          created_by: OWNER_ACC,
          version: 1,
          created_at: "2026-10-05T00:00:00Z",
          updated_at: "2026-10-05T00:00:00Z",
        }));
        return send(200, { tasks, total: tasks.length, limit: 50, offset: 0 });
      }
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") return send(200, { sprints: [] });
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "POST") {
        return send(201, { id: randomUUID(), team_id: TEAM_ID, title: "x", ref: "#1", state: "sem_dono", kind: "corrigir", short_id: 99 });
      }
      if (path === "/v1/teams" && req.method === "POST") return send(201, team);
      res.writeHead(404).end();
    });
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function seedCloud(dir) {
  mkdirSync(join(dir, "profiles", OWNER_P), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: OWNER_P,
      profiles: [{ id: OWNER_P, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }],
    }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", OWNER_P, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }));
}

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

/** Seed the two prototype Fila rows (REVISÃO / RODANDO) with matching titles. */
function seedMockTasks(dbPath, boardId, sprintId) {
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
      @id, @prompt, NULL, @status, NULL, @board_id, NULL, NULL, NULL,
      @purpose, @review, NULL, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, NULL,
      @ord, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      @sprint_id, @created_at, @updated_at
    )
  `);
  const rows = [
    {
      id: "a5drev01-aaaa-4000-8000-000000000001",
      prompt: "Lista de membros com papéis",
      status: "pending",
      purpose: "fix",
      review: "wanted",
      ord: 1,
    },
    {
      id: "a5drun02-aaaa-4000-8000-000000000002",
      prompt: "Testes do convite por login",
      status: "running",
      purpose: "fix",
      review: null,
      ord: 2,
    },
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

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* */
    }
    await delay(120);
  }
  return false;
}

async function shot(page, name) {
  const abs = join(OUT_DIR, name);
  writeFileSync(abs, Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  return abs;
}

async function cropEl(page, selector, name) {
  const box = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "null";
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`),
  );
  check(`crop target ${selector}`, !!box && box.width > 0, true);
  const out = join(OUT_DIR, name);
  const res = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, 1440 - box.x),
      height: Math.min(box.height, 900 - box.y),
      scale: 1,
    },
  });
  writeFileSync(out, Buffer.from(res.data, "base64"));
  return out;
}

function sideBySide(left, right, out) {
  execFileSync("magick", [left, right, "+append", "-background", "#05060a", "-gravity", "North", out], { stdio: "pipe" });
}

function csSnippet() {
  return `(el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      width: s.width, height: s.height, fontSize: s.fontSize, fontWeight: s.fontWeight,
      padding: s.padding, gap: s.gap, borderRadius: s.borderRadius, borderColor: s.borderColor,
      background: s.backgroundColor, color: s.color, letterSpacing: s.letterSpacing,
    };
  }`;
}

const userData = mkdtempSync(join(tmpdir(), "stellar-a5d-"));
const protoUser = mkdtempSync(join(tmpdir(), "stellar-a5d-proto-"));
let app;
let protoApp;
let staticSrv;
let api;

try {
  check("prototype present", existsSync(join(PROTO_DIR, "BoardQuickTask.dc.html")), true);
  seedCloud(userData);

  const apiPort = await pickFreePort();
  api = startFakeTeamApi(apiPort);
  await api.listen();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const staticPort = await pickFreePort();
  staticSrv = startStatic(staticPort, PROTO_DIR);
  await staticSrv.listen();

  // ---- Prototype page: prepare per-state crops ----
  const protoCdp = await pickFreePort();
  protoApp = await startApp({ cdpPort: protoCdp, userDataDir: protoUser, preserveUserData: true, isolatedHome: true });
  const protoPage = await connectPage(protoCdp);
  await protoPage.send("Page.enable");
  await protoPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await protoPage.send("Page.navigate", { url: `${staticSrv.origin}/BoardQuickTask.dc.html` });
  await delay(800);

  // Inject a faux context menu on the proto for state (c) comparison.
  await protoPage.evalJs(`(() => {
    const host = document.querySelector('x-dc') || document.body;
    const menu = document.createElement('div');
    menu.id = 'proto-canvas-menu';
    menu.setAttribute('data-part', 'proto-canvas-menu');
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'display:none;position:absolute;left:520px;top:420px;z-index:20;min-width:220px;padding:4px;border-radius:10px;background:#151924;border:1px solid #2a3042;box-shadow:0 16px 40px rgba(0,0,0,.5);font-family:Space Grotesk,system-ui,sans-serif';
    menu.innerHTML = '<button type="button" style="display:flex;width:100%;padding:8px 10px;border:0;border-radius:7px;background:#1a1f2c;color:#fff;font:inherit;font-size:13px;text-align:left;cursor:pointer">Nova task aqui</button>';
    host.appendChild(menu);
  })()`);

  // (a) dialog only — hide palette
  await protoPage.evalJs(`(() => {
    document.querySelectorAll('[role="dialog"]').forEach((d) => {
      if (d.getAttribute('aria-label') === 'Comandos') d.style.display = 'none';
      if (d.getAttribute('aria-label') === 'Nova task rápida') d.style.display = '';
    });
    document.getElementById('proto-canvas-menu').style.display = 'none';
  })()`);
  await delay(200);
  const protoDialog = await cropEl(protoPage, '[role="dialog"][aria-label="Nova task rápida"]', "proto-crop-dialog.png");
  await shot(protoPage, "proto-state-dialog.png");

  // (b) palette only — hide dialog, show palette with value task
  await protoPage.evalJs(`(() => {
    document.querySelectorAll('[role="dialog"]').forEach((d) => {
      if (d.getAttribute('aria-label') === 'Nova task rápida') d.style.display = 'none';
      if (d.getAttribute('aria-label') === 'Comandos') d.style.display = '';
    });
    const inp = document.querySelector('#cp');
    if (inp) { inp.value = 'task'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await delay(200);
  const protoPalette = await cropEl(protoPage, '[role="dialog"][aria-label="Comandos"]', "proto-crop-palette.png");
  await shot(protoPage, "proto-state-palette.png");

  // (c) context menu — hide both dialogs, show injected menu + Fila
  await protoPage.evalJs(`(() => {
    document.querySelectorAll('[role="dialog"]').forEach((d) => { d.style.display = 'none'; });
    document.getElementById('proto-canvas-menu').style.display = 'block';
  })()`);
  await delay(200);
  const protoMenu = await cropEl(protoPage, "#proto-canvas-menu", "proto-crop-menu.png");
  await shot(protoPage, "proto-state-menu.png");

  // (d) Fila region (header + rows) — hide overlays
  await protoPage.evalJs(`(() => {
    document.querySelectorAll('[role="dialog"]').forEach((d) => { d.style.display = 'none'; });
    document.getElementById('proto-canvas-menu').style.display = 'none';
  })()`);
  await delay(200);
  const protoFila = await cropEl(protoPage, 'section[aria-label="Fila"]', "proto-crop-fila.png");
  await shot(protoPage, "proto-state-fila.png");

  const protoStyles = JSON.parse(
    await protoPage.evalJs(`(() => {
      // restore dialog+palette for style read
      document.querySelectorAll('[role="dialog"]').forEach((d) => { d.style.display = ''; });
      const cs = ${csSnippet()};
      const dialog = document.querySelector('[role="dialog"][aria-label="Nova task rápida"]');
      const palette = document.querySelector('[role="dialog"][aria-label="Comandos"]');
      const pillOn = dialog?.querySelector('[role="radio"][aria-checked="true"]');
      const pills = [...(dialog?.querySelectorAll('[role="radio"]') || [])];
      const destOn = dialog?.querySelector('[aria-pressed="true"]');
      const dests = [...(dialog?.querySelectorAll('[aria-pressed]') || [])];
      const section = palette?.querySelector('div[style*="letter-spacing"]') || [...(palette?.querySelectorAll('div') || [])].find(d => d.textContent === 'TASKS');
      const cmds = [...(palette?.querySelectorAll('button.cmd') || [])];
      const head = palette?.querySelector('div');
      return JSON.stringify({
        dialog: cs(dialog),
        input: cs(dialog?.querySelector('#qt')),
        pillOn: cs(pillOn),
        pill: cs(pills[0]),
        destOn: cs(destOn),
        dest: cs(dests[0]),
        palette: cs(palette),
        paletteHead: cs(head),
        tasksSection: cs(section),
        cmdActive: cs(cmds[0]),
        cmdRow: cs(cmds[1]),
        kbd: cs(palette?.querySelector('.k')),
      });
    })()`),
  );

  // ---- App ----
  const cdp = await pickFreePort();
  app = await startApp({
    cdpPort: cdp,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const page = await connectPage(cdp);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(1000);
  await bootIntoFreshSession(page, "A5d Quick", { spawnTerminal: false });
  await delay(500);
  await spawnCard(page, "task");
  check("Fila mounts", await waitFor(page, `!!document.querySelector('[data-part="queue-board"]')`), true);

  // Seed mock tasks (titles + REVISÃO/RODANDO phases from prototype).
  const boot = JSON.parse(
    await page.evalJs(`(async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "A5d Quick") ?? boards[0];
      const created = await window.tasks.create(board.id, "__a5d_boot__");
      const sprints = await window.tasks.listSprints(board.id);
      const active = sprints.find((s) => s.closedAt === null);
      return JSON.stringify({
        boardId: board.id,
        sprintId: active?.id ?? null,
        bootTaskId: created.ok ? created.taskId : null,
      });
    })()`),
  );
  let dbPath = null;
  for (let i = 0; i < 40; i++) {
    dbPath = findDb(userData);
    if (dbPath) break;
    await delay(100);
  }
  check("isolated db exists", !!dbPath, true);
  check("active sprint", !!boot.sprintId, true);
  if (dbPath && boot.bootTaskId) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(boot.bootTaskId);
    db.close();
  }
  seedMockTasks(dbPath, boot.boardId, boot.sprintId);
  // SQL seed does not push task:changed — poke create forces a board rebuild.
  const poke = JSON.parse(
    await page.evalJs(`(async () => {
      const r = await window.tasks.create(${JSON.stringify(boot.boardId)}, "__a5d_poke__");
      return JSON.stringify(r);
    })()`),
  );
  if (poke.ok && dbPath) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(poke.taskId);
    db.close();
    await page.evalJs(`(async () => {
      const tasks = await window.tasks.listByBoard(${JSON.stringify(boot.boardId)});
      const one = tasks.find((t) => t.id.startsWith("a5drev01"));
      if (one) await window.tasks.updatePrompt(one.id, one.promptPreview || "Lista de membros com papéis", "replace");
    })()`);
  }
  await delay(500);
  check(
    "mock tasks visible",
    await waitFor(
      page,
      `(() => {
        const tiles = [...document.querySelectorAll('[data-part="queue-tile-title"], [data-task-item-id]')];
        const text = tiles.map((el) => el.textContent || '').join('\\n');
        return tiles.length >= 2
          && text.includes('Lista de membros com papéis')
          && text.includes('Testes do convite por login');
      })()`,
      15000,
    ),
    true,
  );

  // Palette meta "2 cards selecionados" — fake ids (no sticky covering the board).
  await page.evalJs(`window.__stellarSelectCardIds?.(['a5d-sel-1', 'a5d-sel-2'])`);
  await delay(100);

  // Bring Fila into view (center its chrome pill / card).
  await page.evalJs(`(() => {
    const fila = document.querySelector('[data-part="queue-board"]')?.closest('[data-card-id], .card-base');
    fila?.scrollIntoView?.({ block: 'center', inline: 'center' });
    fila?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  })()`);
  await delay(300);

  // Warm team ctx
  await page.evalJs(`(async () => { try { await window.team.overview(); } catch {} })()`);
  await delay(300);

  // ===== State A: quick dialog Corrigir + Time + mock title + territory =====
  await page.evalJs(`(async () => {
    await window.team.overview();
    window.__stellarOpenQuickTask({
      title: "Corrigir timezone do relatório de presença",
      kind: "corrigir",
      destination: "team",
      territory: ["src/reports/**"],
      contract: "",
    });
  })()`);
  check("quick dialog opens", await waitFor(page, `!!document.querySelector('[data-part="board-quick-task"]')`), true);
  check(
    "team label Idy Platform",
    await waitFor(page, `(document.querySelector('[data-part="board-quick-dest-team"]')?.textContent || '').includes('Idy Platform')`, 8000),
    true,
  );
  await delay(300);
  check("territory line", await page.evalJs(`!!document.querySelector('[data-part="board-quick-territory"]')`), true);
  check("dest team pressed", await page.evalJs(`document.querySelector('[data-part="board-quick-dest-team"]')?.getAttribute('aria-pressed') === 'true'`), true);
  check("kind corrigir", await page.evalJs(`document.querySelector('[data-part="board-quick-kind-corrigir"]')?.getAttribute('aria-checked') === 'true'`), true);

  const appDialogStyles = JSON.parse(
    await page.evalJs(`(() => {
      const cs = ${csSnippet()};
      const dialog = document.querySelector('[data-part="board-quick-task"]');
      return JSON.stringify({
        dialog: cs(dialog),
        input: cs(dialog?.querySelector('[data-part="board-quick-title"]')),
        pillOn: cs(dialog?.querySelector('[data-part="board-quick-kind-corrigir"]')),
        pill: cs(dialog?.querySelector('[data-part="board-quick-kind-investigar"]')),
        destOn: cs(dialog?.querySelector('[data-part="board-quick-dest-team"]')),
        dest: cs(dialog?.querySelector('[data-part="board-quick-dest-board"]')),
      });
    })()`),
  );
  // Design intent (Master): content height 231px = kids 183 + 4×12 gap.
  // Proto getBoundingClientRect in Electron omits flex gap (~217 border-box);
  // content-box getComputedStyle.height on the app is the right metric.
  const heightProbe = JSON.parse(
    await page.evalJs(`(() => {
      const dialog = document.querySelector('[data-part="board-quick-task"]');
      const r = dialog.getBoundingClientRect();
      const cs = getComputedStyle(dialog);
      const kids = [...dialog.children].map((el) => ({
        part: el.getAttribute('data-part') || el.tagName,
        h: Math.round(el.getBoundingClientRect().height * 1000) / 1000,
      }));
      return JSON.stringify({
        borderBox: r.height,
        csHeight: cs.height,
        gap: cs.gap,
        boxSizing: cs.boxSizing,
        kids,
      });
    })()`),
  );
  const protoHeightProbe = JSON.parse(
    await protoPage.evalJs(`(() => {
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        if (d.getAttribute('aria-label') === 'Nova task rápida') d.style.display = '';
        else d.style.display = 'none';
      });
      const dialog = document.querySelector('[role="dialog"][aria-label="Nova task rápida"]');
      const r = dialog.getBoundingClientRect();
      const cs = getComputedStyle(dialog);
      return JSON.stringify({
        borderBox: r.height,
        csHeight: cs.height,
        gap: cs.gap,
        boxSizing: cs.boxSizing,
      });
    })()`),
  );
  const dialogH = parseFloat(heightProbe.csHeight || "0");
  const protoH = 231; // Master / design: kids 183 + gaps 48
  writeFileSync(join(OUT_DIR, "height-probe.json"), JSON.stringify({ proto: protoHeightProbe, app: heightProbe, target: protoH }, null, 2));
  check("dialog height within 2px of 231", Math.abs(dialogH - protoH) <= 2, true);

  await shot(page, "app-state-dialog.png");
  const appDialogCrop = await cropEl(page, '[data-part="board-quick-task"]', "app-crop-dialog.png");
  sideBySide(protoDialog, appDialogCrop, join(OUT_DIR, "side-by-side-dialog.png"));
  sideBySide(join(OUT_DIR, "proto-state-dialog.png"), join(OUT_DIR, "app-state-dialog.png"), join(OUT_DIR, "side-by-side-dialog-full.png"));

  await page.evalJs(`document.querySelector('[data-part="board-quick-cancel"]')?.click()`);
  await delay(200);

  // ===== State B: Ctrl+K palette filter "task" =====
  await page.evalJs(`(async () => { try { await window.team.overview(); } catch {} })()`);
  await delay(400);
  await page.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await waitFor(page, `!!document.querySelector('[data-part="board-cmd-input"]')`);
  // Wait for Distribuir row (team ctx loaded).
  check(
    "palette has Distribuir",
    await waitFor(page, `!!document.querySelector('[data-part="board-cmd-distribute"]')`, 8000),
    true,
  );
  await page.evalJs(`(() => {
    const el = document.querySelector('[data-part="board-cmd-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'task');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(300);
  check("palette filter task", await page.evalJs(`document.querySelector('[data-part="board-cmd-input"]')?.value === 'task'`), true);
  check("palette width ~560", await page.evalJs(`Math.abs(document.querySelector('[data-part="board-cmd-palette"]').getBoundingClientRect().width - 560) < 2`), true);
  check(
    "palette order Distribuir before Transformar",
    await page.evalJs(`(() => {
      const ids = [...document.querySelectorAll('button[data-part^="board-cmd-"]')].map((b) => b.getAttribute('data-part'));
      const d = ids.indexOf('board-cmd-distribute');
      const i = ids.indexOf('board-cmd-import');
      const s = ids.indexOf('board-cmd-selection-to-task');
      return d >= 0 && i >= 0 && s >= 0 && d < i && i < s;
    })()`),
    true,
  );
  check(
    "palette rows have icons",
    await page.evalJs(`[...document.querySelectorAll('button[data-part^="board-cmd-"]')].every((b) => !!b.querySelector('svg'))`),
    true,
  );
  check(
    "first palette row highlighted",
    await page.evalJs(`document.querySelector('[data-part="board-cmd-new-board"]')?.getAttribute('data-active') === 'true'`),
    true,
  );
  check(
    "Distribuir shows real N",
    await page.evalJs(`(document.querySelector('[data-part="board-cmd-distribute"]')?.textContent || '').includes('(5)')`),
    true,
  );

  const appPaletteStyles = JSON.parse(
    await page.evalJs(`(() => {
      const cs = ${csSnippet()};
      const palette = document.querySelector('[data-part="board-cmd-palette"]');
      const section = [...palette.querySelectorAll('div')].find((d) => d.textContent === 'TASKS');
      const cmds = [...palette.querySelectorAll('button[data-part^="board-cmd-"]')];
      return JSON.stringify({
        palette: cs(palette),
        paletteHead: cs(palette.querySelector('div')),
        tasksSection: cs(section),
        cmdActive: cs(cmds[0]),
        cmdRow: cs(cmds[1]),
        kbd: cs(palette.querySelector('[data-part="board-cmd-kbd"]')),
      });
    })()`),
  );

  await shot(page, "app-state-palette.png");
  const appPaletteCrop = await cropEl(page, '[data-part="board-cmd-palette"]', "app-crop-palette.png");
  sideBySide(protoPalette, appPaletteCrop, join(OUT_DIR, "side-by-side-palette.png"));
  sideBySide(join(OUT_DIR, "proto-state-palette.png"), join(OUT_DIR, "app-state-palette.png"), join(OUT_DIR, "side-by-side-palette-full.png"));

  await page.evalJs(`document.querySelector('[data-part="board-cmd-overlay"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await delay(200);

  // ===== State C: right-click menu =====
  // Direct hook — synthetic contextmenu races with the menu's mousedown-dismiss.
  await page.evalJs(`window.__stellarOpenCanvasMenu?.(720, 360)`);
  check("canvas menu opens", await waitFor(page, `!!document.querySelector('[data-part="board-canvas-menu"]')`), true);
  check("menu has Nova task aqui", await page.evalJs(`(document.querySelector('[data-part="board-canvas-new-task"]')?.textContent || '').includes('Nova task aqui')`), true);
  await delay(150);
  await shot(page, "app-state-menu.png");
  const appMenuCrop = await cropEl(page, '[data-part="board-canvas-menu"]', "app-crop-menu.png");
  sideBySide(protoMenu, appMenuCrop, join(OUT_DIR, "side-by-side-menu.png"));
  sideBySide(join(OUT_DIR, "proto-state-menu.png"), join(OUT_DIR, "app-state-menu.png"), join(OUT_DIR, "side-by-side-menu-full.png"));
  await page.evalJs(`window.__stellarOpenCanvasMenu && document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await delay(200);

  // ===== State D: Fila header "+ Nova task" → quick dialog; inline input remains =====
  await page.evalJs(`document.querySelector('[data-part="queue-new-task"]')?.click()`);
  check("Fila + Nova task opens quick dialog", await waitFor(page, `!!document.querySelector('[data-part="board-quick-task"]')`), true);
  await delay(200);
  await shot(page, "app-state-fila-header-quick.png");
  const appFilaQuickCrop = await cropEl(page, '[data-part="board-quick-task"]', "app-crop-fila-header-quick.png");
  sideBySide(protoDialog, appFilaQuickCrop, join(OUT_DIR, "side-by-side-fila-header-quick.png"));
  sideBySide(join(OUT_DIR, "proto-state-dialog.png"), join(OUT_DIR, "app-state-fila-header-quick.png"), join(OUT_DIR, "side-by-side-fila-header-quick-full.png"));
  await page.evalJs(`document.querySelector('[data-part="board-quick-cancel"]')?.click()`);
  await delay(200);

  // Bottom title+Enter form stays mounted under the Fila board.
  check("inline create open", await waitFor(page, `!!document.querySelector('[data-part="create-task-input"]')`), true);
  check("mais opções", await page.evalJs(`!!document.querySelector('[data-part="create-task-more"]')`), true);
  await page.evalJs(`(() => {
    const el = document.querySelector('[data-part="create-task-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Corrigir timezone do relatório de presença');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(200);
  await shot(page, "app-state-fila-input.png");
  const filaSel = await page.evalJs(`(() => {
    const el = document.querySelector('[data-part="queue-board"]')?.closest('[data-card-id]') || document.querySelector('[data-part="create-task-inline"]')?.parentElement;
    if (!el) return '';
    el.setAttribute('data-part', 'fila-shot-root');
    return '[data-part="fila-shot-root"]';
  })()`);
  const appFilaCrop = filaSel ? await cropEl(page, filaSel, "app-crop-fila.png") : await shot(page, "app-crop-fila.png");
  sideBySide(protoFila, appFilaCrop, join(OUT_DIR, "side-by-side-fila.png"));
  sideBySide(join(OUT_DIR, "proto-state-fila.png"), join(OUT_DIR, "app-state-fila-input.png"), join(OUT_DIR, "side-by-side-fila-full.png"));

  writeFileSync(
    join(OUT_DIR, "parity-styles.json"),
    JSON.stringify(
      {
        proto: protoStyles,
        app: { ...appDialogStyles, ...appPaletteStyles },
        dialogHeight: { target: 231, app: dialogH, delta: dialogH - 231, protoRect: protoHeightProbe },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(OUT_DIR, "smoke-results.json"),
    JSON.stringify(
      {
        ok: true,
        screenshots: [
          "proto-crop-dialog.png",
          "app-crop-dialog.png",
          "side-by-side-dialog.png",
          "proto-crop-palette.png",
          "app-crop-palette.png",
          "side-by-side-palette.png",
          "proto-crop-menu.png",
          "app-crop-menu.png",
          "side-by-side-menu.png",
          "proto-crop-fila.png",
          "app-crop-fila.png",
          "side-by-side-fila.png",
          "app-state-fila-header-quick.png",
          "side-by-side-fila-header-quick.png",
          "side-by-side-dialog-full.png",
          "side-by-side-palette-full.png",
          "side-by-side-menu-full.png",
          "side-by-side-fila-full.png",
          "side-by-side-fila-header-quick-full.png",
        ].map((f) => join(OUT_DIR, f)),
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await stopApp(app).catch(() => {});
  if (protoApp) await stopApp(protoApp).catch(() => {});
  if (staticSrv) await staticSrv.close().catch(() => {});
  if (api) await api.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
  rmSync(protoUser, { recursive: true, force: true });
}

finish();
