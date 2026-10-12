// Import from a local board (Import wizard, source "Board deste computador").
// Isolated Electron + fake team API + a throwaway userData seeded THROUGH the
// app's own bridges (boards/tasks). Mock data matches Import.dc.html: 219 open
// tasks over two boards, 6 already in the team, 71 out of scope, 2 batches.
// Screenshots and side-by-side comparisons go ONLY to /tmp/board-import/.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { connectPage, ensureTeamProfile, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROTO_DIR =
  process.env.STELLAR_PROTO_DIR ?? "/home/lucas/Workplace/Projects/StellarCloud/docs/stellar/design/app-v2/prototipo";
const OUT_DIR = "/tmp/board-import";
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";

function startStatic(port, root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "Import.dc.html";
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

// Fake team API. `existing` is the dedupe set (what the team already has).
function startFakeBackend(port) {
  const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z" };
  const members = [
    { team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null, display_name: "Ana Ribeiro", avatar_initials: "AR", email: null },
  ];
  const state = {
    existing: new Set(),
    seedDuplicatesPerPreview: 0,
    previews: [],
    creates: [],
    createDelayMs: [],
    failCreate: false,
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* empty */
      }
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token" && req.method === "POST") {
        return send(200, { access_token: "a:owner", refresh_token: body.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();
      if (!String(req.headers.authorization ?? "").startsWith("Bearer a:")) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });
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
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "GET") return send(200, { invites: [] });
      if (path === "/v1/teams" && req.method === "POST") return send(201, team);
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") return send(200, { sprints: [] });
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") return send(200, { tasks: [], total: 0, limit: 50, offset: 0 });
      if (path === `/v1/teams/${TEAM_ID}/integrations` && req.method === "GET") return send(200, { integrations: [] });
      if (path === `/v1/teams/${TEAM_ID}/webhooks` && req.method === "GET") return send(200, { webhooks: [] });
      if (path === `/v1/teams/${TEAM_ID}/imports` && req.method === "GET") return send(200, { imports: [] });

      if (path === `/v1/teams/${TEAM_ID}/imports/preview` && req.method === "POST") {
        const rows = JSON.parse(body.data || "[]");
        state.previews.push({ body, rows });
        let seeded = 0;
        for (const row of rows) {
          if (seeded >= state.seedDuplicatesPerPreview) break;
          if (!state.existing.has(row.external_id)) {
            state.existing.add(row.external_id);
            seeded += 1;
          }
        }
        const items = rows.map((row) => {
          const duplicate = state.existing.has(row.external_id);
          return { title: row.title, external_id: `json:${row.external_id}`, duplicate, existing_ref: duplicate ? "#58" : null, meta: null };
        });
        return send(200, { kind: body.kind, total: items.length, duplicates: items.filter((i) => i.duplicate).length, items });
      }
      if (path === `/v1/teams/${TEAM_ID}/imports` && req.method === "POST") {
        const rows = JSON.parse(body.data || "[]");
        const index = state.creates.length;
        state.creates.push({ body, rows });
        const wait = state.createDelayMs[index] ?? 0;
        if (wait) await delay(wait);
        if (state.failCreate) return send(500, { error: { code: "internal", message: "import backend unavailable" } });
        let created = 0;
        let skipped = 0;
        for (const row of rows) {
          if (state.existing.has(row.external_id)) skipped += 1;
          else {
            state.existing.add(row.external_id);
            created += 1;
          }
        }
        return send(201, {
          id: randomUUID(),
          kind: body.kind,
          status: "done",
          rule: body.rule ?? {},
          mapping: body.mapping ?? {},
          continue_import: false,
          cursor: "",
          created_count: created,
          skipped_count: skipped,
          error: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return send(404, { error: { code: "not_found", message: path } });
    });
  });
  return {
    state,
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function seedUserData(dir) {
  mkdirSync(join(dir, "profiles", OWNER_P), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({ schemaVersion: 1, defaultProfileId: OWNER_P, profiles: [{ id: OWNER_P, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", OWNER_P, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }));
}

async function waitFor(page, expr, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* mounting */
    }
    await delay(120);
  }
  return false;
}

async function waitForCloud(page) {
  for (let i = 0; i < 80; i++) {
    try {
      const status = JSON.parse(await page.evalJs(`(async () => JSON.stringify(await window.cloud.status()))()`));
      if (status.state === "logged-in") return status;
    } catch {
      /* mounting */
    }
    await delay(250);
  }
  throw new Error("login did not complete");
}

const evalJson = async (page, expr) => JSON.parse(await page.evalJs(`(async () => JSON.stringify(await (${expr})))()`));
const click = (page, sel) => page.evalJs(`document.querySelector(${JSON.stringify(sel)})?.click()`);
const text = (page, sel) => page.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const abs = join(OUT_DIR, name);
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

function sideBySide(left, right, out) {
  execFileSync("magick", [left, right, "+append", "-background", "#05060a", "-gravity", "North", out], { stdio: "pipe" });
}

// ---- seed: the local boards, through the app's own bridges ----------------
const PURPOSES = ["fix", "implement", "investigate", "integrate", "measure", null];
const BOARDS = [
  { id: "board-landing", name: "Landing page", pending: 120, blocked: 28, done: 52 },
  { id: "board-api", name: "API v2", pending: 60, blocked: 11, done: 19 },
  { id: "board-drafts", name: "Rascunhos", pending: 0, blocked: 0, done: 34 },
];

async function seedLocal(page) {
  const expected = []; // { id, prompt, purpose, status, board }
  await page.evalJs(`window.__seedBoards = ${JSON.stringify(BOARDS)}; window.__purposes = ${JSON.stringify(PURPOSES)}; 0`);
  const result = await evalJson(
    page,
    `(async () => {
      const now = Date.now();
      const out = [];
      for (const b of window.__seedBoards) {
        await window.store.boards.upsert({ id: b.id, name: b.name, project: "", cwd: "/tmp", created_at: now, updated_at: now, last_accessed_at: now, autonomous: false, concurrency_cap: null, orchestrator_card_id: null });
        const plan = [
          ...Array.from({ length: b.pending }, () => "pending"),
          ...Array.from({ length: b.blocked }, () => "blocked"),
          ...Array.from({ length: b.done }, () => "done"),
        ];
        for (let i = 0; i < plan.length; i++) {
          const purpose = window.__purposes[i % window.__purposes.length];
          let prompt = b.name + " task " + (i + 1) + "\\n\\nDetails of task " + (i + 1) + ".";
          if (b.id === "board-landing" && i === 0) prompt = "\\n   \\n  " + "L".repeat(260) + "\\nsecond line";
          if (b.id === "board-api" && i === 0) prompt = "Exportar relatórios 📊 com acentuação\\n\\nCorpo.";
          const res = await window.tasks.createFull({ boardId: b.id, prompt, purpose });
          if (!res.ok) throw new Error(res.error);
          if (plan[i] !== "pending") {
            const mv = await window.tasks.moveTask(res.taskId, plan[i], i + 1, []);
            if (!mv.ok) throw new Error(mv.error);
          }
          // The store keeps the prompt as saved (trimmed); that is what is imported.
          const saved = await window.tasks.getPrompt(res.taskId);
          out.push({ id: res.taskId, prompt: saved.prompt, purpose, status: plan[i], board: b.id });
        }
      }
      return out;
    })()`,
  );
  expected.push(...result);
  return expected;
}

// ---- computed-style parity -------------------------------------------------
const MEASURE = `(sel, props) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = {};
  for (const p of props) out[p] = p === "height" || p === "width" ? Math.round(el.getBoundingClientRect()[p] * 10) / 10 + "px" : cs[p];
  return out;
}`;

const TEXT = ["color", "fontSize", "fontWeight"];
const BOX = ["backgroundColor", "borderTopColor", "borderTopWidth", "borderTopLeftRadius"];
const PAD = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

const PARITY = {
  "local-pick": [
    ["aside", "#view-local-pick aside", '[data-part="import-wizard"] aside', ["width", "backgroundColor", "borderRightColor", ...PAD]],
    ["title", "#view-local-pick h1", '[data-part="local-pick"] h1', TEXT],
    ["lead", "#view-local-pick p", '[data-part="local-pick"] p', TEXT],
    ["boards card", '#view-local-pick [data-part="boards"]', '[data-part="local-boards"]', BOX],
    ["board name", "#view-local-pick .brd > span > span:first-child", '[data-part="local-board"] [class*="boardName"]', TEXT],
    ["board sub", "#view-local-pick .brd > span > span:nth-child(2)", '[data-part="local-board"] [class*="boardSub"]', TEXT],
    ["board pill", "#view-local-pick .brd .pill", '[data-part="local-board"] [class*="pillInfo"]', [...TEXT, ...BOX, ...PAD]],
    ["scope box", '#view-local-pick [data-part="scope"]', '[data-part="local-scope"]', [...TEXT, ...BOX, ...PAD]],
    ["cta", "#view-local-pick a.primary", '[data-part="local-to-preview"]', ["height", "backgroundColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
    ["back", "#view-local-pick a.ghost", '[data-part="import-back"]', ["height", "backgroundColor", "borderTopColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
  ],
  "local-preview": [
    ["title", "#view-local-preview h1", '[data-part="local-preview"] h1', TEXT],
    ["count card", '#view-local-preview [data-part="counts"] > div', '[data-part="local-counts"] > div', [...BOX, ...PAD]],
    ["count new", '#view-local-preview [data-part="counts"] > div:nth-child(1) > span:first-child', '[data-part="local-count-new"]', TEXT],
    ["count dup", '#view-local-preview [data-part="counts"] > div:nth-child(2) > span:first-child', '[data-part="local-count-dup"]', TEXT],
    ["count label", '#view-local-preview [data-part="counts"] > div > span:nth-child(2)', '[data-part="local-counts"] > div > span:nth-child(2)', TEXT],
    ["visibility", '#view-local-preview [data-part="visibility"]', '[data-part="local-visibility"]', [...TEXT, ...BOX, ...PAD]],
    ["not-included card", '#view-local-preview [data-part="not-included"]', '[data-part="local-not-included"]', BOX],
    ["chip", '#view-local-preview [data-part="not-included"] .pill', '[data-part="local-not-included"] [class*="pill"]', [...TEXT, "backgroundColor", ...PAD, "borderTopLeftRadius"]],
    ["mapping card", '#view-local-preview [data-part="mapping"]', '[data-part="local-mapping"]', BOX],
    ["mapping row", '#view-local-preview [data-part="mapping"] .mapr:nth-child(2)', '[data-part="local-mapping"] > div:nth-child(2)', [...TEXT, ...PAD, "borderTopColor"]],
    ["sample row", '#view-local-preview [data-part="sample"] .row:nth-child(2)', '[data-part="local-sample"] > label:nth-child(2)', [...PAD, "borderTopColor", "borderTopWidth"]],
    ["sample dup row", '#view-local-preview [data-part="sample"] .row[style*="opacity"]', '[data-part="local-sample"] > label:last-child', ["opacity"]],
    ["cta", "#btn-import", '[data-part="local-run"]', ["height", "backgroundColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
  ],
  "local-running": [
    ["title", "#view-local-running h1", '[data-part="local-running"] h1', TEXT],
    ["progress label", '#view-local-running [data-part="progress"] > div > span:first-child', '[data-part="local-progress"] > div > span:first-child', TEXT],
    ["progress count", '#view-local-running [data-part="progress"] > div > span:last-child', '[data-part="local-progress"] > div > span:last-child', TEXT],
    ["bar", '#view-local-running .bar', '[data-part="local-progress"] [role="progressbar"]', ["height", "backgroundColor", "borderTopLeftRadius"]],
    ["bar fill", '#view-local-running .bar > span', '[data-part="local-progress"] [role="progressbar"] > span', ["backgroundColor"]],
    ["batches card", '#view-local-running [data-part="batches"]', '[data-part="local-batches"]', BOX],
    ["batch row", '#view-local-running [data-part="batches"] > div:first-child', '[data-part="local-batches"] > div:first-child', PAD],
    ["batch pill ok", '#view-local-running [data-part="batches"] .pill-ok', '[data-part="local-batches"] [class*="pillOk"]', [...TEXT, "backgroundColor", ...PAD]],
    ["batch pill live", '#view-local-running [data-part="batches"] .pill-info', '[data-part="local-batches"] [class*="pillInfo"]', [...TEXT, "backgroundColor", ...PAD]],
    ["stop", "#view-local-running button.ghost", '[data-part="local-stop"]', ["height", "backgroundColor", "borderTopColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
  ],
  "local-done": [
    ["title", "#view-local-done h1", '[data-part="local-done"] h1', TEXT],
    ["result", '#view-local-done [data-part="result"]', '[data-part="local-result"]', [...TEXT, ...BOX, ...PAD]],
    ["stat card", '#view-local-done .card', '[data-part="local-done"] [class*="mapCard"]', [...BOX, ...PAD]],
    ["stat value", '#view-local-done .card > span:first-child', '[data-part="local-done-created"]', TEXT],
    ["note box", '#view-local-done .info', '[data-part="local-done"] [class*="boxInfo"]', [...TEXT, ...BOX, ...PAD]],
    ["again", "#view-local-done a.ghost", '[data-part="local-again"]', ["height", "backgroundColor", "borderTopColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
    ["open board", "#view-local-done a.primary", '[data-part="local-open-board"]', ["height", "backgroundColor", ...TEXT, "borderTopLeftRadius", "paddingLeft"]],
  ],
};

async function measureParity(protoPage, appPage, stateName) {
  const mismatches = [];
  const missing = [];
  for (const [label, protoSel, appSel, props] of PARITY[stateName]) {
    const p = JSON.parse((await protoPage.evalJs(`JSON.stringify((${MEASURE})(${JSON.stringify(protoSel)}, ${JSON.stringify(props)}))`)) ?? "null");
    const a = JSON.parse((await appPage.evalJs(`JSON.stringify((${MEASURE})(${JSON.stringify(appSel)}, ${JSON.stringify(props)}))`)) ?? "null");
    if (!p || !a) {
      missing.push(`${label} (${!p ? "proto" : "app"})`);
      continue;
    }
    for (const prop of props) {
      if (p[prop] !== a[prop]) mismatches.push(`${label}.${prop}: proto=${p[prop]} app=${a[prop]}`);
    }
  }
  return { mismatches, missing };
}

const userData = mkdtempSync(join(tmpdir(), "stellar-localimport-"));
const protoUserData = mkdtempSync(join(tmpdir(), "stellar-localimport-proto-"));
let backend;
let staticSrv;
let app;
let protoApp;

try {
  const apiPort = await pickFreePort();
  const staticPort = await pickFreePort();
  backend = startFakeBackend(apiPort);
  staticSrv = startStatic(staticPort, PROTO_DIR);
  await backend.listen();
  await staticSrv.listen();
  const st = backend.state;

  // Prototype page (parity reference).
  const protoCdp = await pickFreePort();
  protoApp = await startApp({ cdpPort: protoCdp, userDataDir: protoUserData, preserveUserData: true, isolatedHome: true });
  const protoPage = await connectPage(protoCdp);
  await protoPage.send("Page.enable");
  await protoPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const protoGo = async (hash) => {
    await protoPage.send("Page.navigate", { url: `${staticSrv.origin}/Import.dc.html#${hash}` });
    await delay(700);
    await protoPage.evalJs(`location.hash = ${JSON.stringify("#" + hash)}`);
    await delay(500);
  };
  const protoShot = async (hash) => {
    await protoGo(hash);
    return shot(protoPage, `proto-${hash}.png`);
  };

  // App.
  seedUserData(userData);
  const cdp = await pickFreePort();
  app = await startApp({
    cdpPort: cdp,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}`, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const page = await connectPage(cdp);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForCloud(page);
  await page.evalJs(`(async () => { await window.team.create({ name: "Idy Platform" }); })()`);

  const expected = await seedLocal(page);
  const byId = new Map(expected.map((e) => [e.id, e]));
  const openIds = new Set(expected.filter((e) => e.status !== "done").map((e) => e.id));
  check("seeded 324 local tasks", expected.length, 324);
  check("seeded 219 open tasks", openIds.size, 219);

  await ensureTeamProfile(page);
  await click(page, '[data-section="team"]');
  check("team section opens", await waitFor(page, `!!document.querySelector('[data-team-sub="import"]')`), true);
  const openWizard = async () => {
    await click(page, '[data-team-sub="import"]');
    return waitFor(page, `!!document.querySelector('[data-part="import-wizard"]')`);
  };
  check("import wizard opens", await openWizard(), true);

  // The source is listed, and picking it moves to the boards step.
  check("local source is offered", await waitFor(page, `!!document.querySelector('[data-part="import-pick-local"]')`), true);
  await click(page, '[data-part="import-pick-local"]');
  await click(page, '[data-part="import-next"]');
  check("pick state shows", await waitFor(page, `!!document.querySelector('[data-part="local-pick"]') && document.querySelectorAll('[data-part="local-board"]').length === 3`), true);
  await delay(400);

  // ---- local-pick ------------------------------------------------------
  const pick = await evalJson(
    page,
    `(() => {
      const rows = [...document.querySelectorAll('[data-part="local-board"]')].map((r) => ({
        text: r.textContent,
        checked: r.querySelector("input").checked,
        disabled: r.querySelector("input").disabled,
      }));
      return {
        rows,
        selection: document.querySelector('[data-part="local-selection"]')?.textContent,
        scope: document.querySelector('[data-part="local-scope"]')?.textContent,
        cta: document.querySelector('[data-part="local-to-preview"]')?.textContent,
        stepStates: [...document.querySelectorAll("[data-step]")].map((s) => s.dataset.stepState),
        stepLabels: [...document.querySelectorAll("[data-step]")].map((s) => s.textContent.replace("✓", "").replace(/^\\d+/, "").trim()),
      };
    })()`,
  );
  check("Landing page: 148 open, checked", pick.rows[0].text.includes("148 abertas") && pick.rows[0].checked && !pick.rows[0].disabled, true);
  check("Landing page: 120 pending, 28 blocked, 52 out", pick.rows[0].text.includes("120 pendentes · 28 bloqueadas · 52 fora"), true);
  check("API v2: 71 open, checked", pick.rows[1].text.includes("71 abertas") && pick.rows[1].checked, true);
  check("Rascunhos: 0 open, disabled and unchecked", pick.rows[2].text.includes("0 abertas") && pick.rows[2].disabled && !pick.rows[2].checked, true);
  check("selection summary", pick.selection, "2 boards · 219 tasks abertas");
  check("scope note names the 71 left out", pick.scope?.includes("71 tasks ficam de fora"), true);
  check("cta carries the open count", pick.cta, "Ver prévia de 219 tasks");
  check("aside steps: Fonte done, Boards active", JSON.stringify(pick.stepStates), JSON.stringify(["done", "active", "todo", "todo"]));
  check("aside step labels are the local ones", JSON.stringify(pick.stepLabels), JSON.stringify(["Fonte", "Boards", "Prévia", "Importar"]));
  const appPick = await shot(page, "app-local-pick.png");

  // ---- local-preview ---------------------------------------------------
  st.seedDuplicatesPerPreview = 3;
  await click(page, '[data-part="local-to-preview"]');
  check("preview state shows", await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`), true);
  const previewInfo = await evalJson(
    page,
    `(() => ({
      created: document.querySelector('[data-part="local-count-new"]').textContent,
      dup: document.querySelector('[data-part="local-count-dup"]').textContent,
      out: document.querySelector('[data-part="local-count-out"]').textContent,
      visibility: document.querySelector('[data-part="local-visibility"]')?.textContent,
      notIncluded: document.querySelector('[data-part="local-not-included"]')?.textContent,
      mapping: document.querySelector('[data-part="local-mapping"]')?.textContent,
      sampleCount: document.querySelectorAll('[data-part="local-sample"] > label').length,
      sampleTitle: document.querySelector('[data-part="local-preview"] h2')?.textContent,
      runDisabled: document.querySelector('[data-part="local-run"]').disabled,
      runLabel: document.querySelector('[data-part="local-run"]').textContent,
      dupText: document.querySelector('[data-part="local-sample"] > label:last-child')?.textContent,
      stepStates: [...document.querySelectorAll("[data-step]")].map((s) => s.dataset.stepState),
    }))()`,
  );
  check("preview: 213 will be created", previewInfo.created, "213");
  check("preview: 6 already exist", previewInfo.dup, "6");
  check("preview: 71 out of scope", previewInfo.out, "71");
  check("preview: visibility warning says every member sees the prompt", previewInfo.visibility?.includes("visível para todos os membros do time"), true);
  check("preview: lists deps, cards, territories, gates", ["Dependências", "Cards", "Territórios", "Gates"].every((w) => previewInfo.notIncluded?.includes(w)), true);
  check("preview: mapping mentions the 200 character title and local id", previewInfo.mapping?.includes("200 caracteres") && previewInfo.mapping?.includes("local:<id>"), true);
  check("preview: sample has 3 new + 2 existing", previewInfo.sampleCount, 5);
  check("preview: sample title counts rows", previewInfo.sampleTitle, "Amostra · 5 de 219");
  check("preview: existing row says so", previewInfo.dupText?.includes("já existe no time como #58"), true);
  check("preview: run blocked until the warning is acknowledged", previewInfo.runDisabled, true);
  check("preview: run label shows new tasks", previewInfo.runLabel, "Importar 213 tasks");
  check("aside steps at preview", JSON.stringify(previewInfo.stepStates), JSON.stringify(["done", "done", "active", "todo"]));
  check("two preview calls (200 + 19 rows)", JSON.stringify(st.previews.map((p) => p.rows.length)), JSON.stringify([200, 19]));
  const appPreviewTop = await shot(page, "app-local-preview.png");
  await page.evalJs(`document.querySelector('[data-part="local-preview"] > div').scrollTop = 99999`);
  await delay(300);
  await shot(page, "app-local-preview-bottom.png");
  await click(page, '[data-part="local-ack"]');
  await delay(200);
  check("acknowledging enables the run", await page.evalJs(`!document.querySelector('[data-part="local-run"]').disabled`), true);
  await shot(page, "app-local-preview-ack.png");

  // What was sent: mapping, scope, ids.
  const sentRows = st.previews.flatMap((p) => p.rows);
  check("preview sent only open tasks", sentRows.every((r) => openIds.has(r.external_id.slice("local:".length))), true);
  check("preview sent every open task once", new Set(sentRows.map((r) => r.external_id)).size, 219);
  const PURPOSE_KIND = { fix: "corrigir", implement: "implementar", investigate: "investigar", integrate: "integrar", measure: "medir" };
  const mapOk = sentRows.every((r) => {
    const e = byId.get(r.external_id.slice("local:".length));
    const firstLine = e.prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
    return (
      r.contract === e.prompt &&
      r.title === Array.from(firstLine).slice(0, 200).join("") &&
      r.kind === (PURPOSE_KIND[e.purpose] ?? "implementar") &&
      r.priority === "media"
    );
  });
  check("rows: contract = full prompt, title = first line (<=200), kind by purpose, priority media", mapOk, true);
  const longTitle = sentRows.find((r) => r.contract.includes("L".repeat(260)));
  check("long prompt title is cut at 200", Array.from(longTitle.title).length, 200);
  check("preview body is the json import with identity mapping", st.previews[0].body.kind === "json" && st.previews[0].body.mapping.external_id === "external_id", true);

  // ---- local-running (batch 2 held back to catch the mid state) ----------
  st.createDelayMs = [0, 3500];
  await click(page, '[data-part="local-run"]');
  check(
    "running state shows with batch 1 done",
    await waitFor(page, `!!document.querySelector('[data-part="local-batches"] [data-batch-status="done"]') && !!document.querySelector('[data-part="local-batches"] [data-batch-status="running"]')`),
    true,
  );
  await delay(300);
  const running = await evalJson(
    page,
    `(() => ({
      title: document.querySelector('[data-part="local-running"] h1').textContent,
      label: document.querySelector('[data-part="local-progress"] > div > span:first-child').textContent,
      count: document.querySelector('[data-part="local-progress"] > div > span:last-child').textContent,
      now: document.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"),
      batch1: document.querySelector('[data-part="local-batches"] > div:nth-child(1)').textContent,
      batch2: document.querySelector('[data-part="local-batches"] > div:nth-child(2)').textContent,
      partial: document.querySelector('[data-part="local-partial"]').textContent,
      stop: document.querySelector('[data-part="local-stop"]').textContent,
      stepStates: [...document.querySelectorAll("[data-step]")].map((s) => s.dataset.stepState),
    }))()`,
  );
  check("running: title counts lines", running.title, "Importando 219 tasks");
  check("running: batch 2 of 2", running.label, "Lote 2 de 2");
  check("running: 200 of 219 lines", running.count, "200 de 219 linhas");
  check("running: progressbar value", running.now, "200");
  check("running: batch 1 result", running.batch1.includes("197 criadas · 3 já existiam e foram puladas"), true);
  check("running: batch 2 in progress", running.batch2.includes("Lote 2 · 19 linhas") && running.batch2.includes("em andamento"), true);
  check("running: partial counter", running.partial, "Parcial até aqui: 197 criadas · 3 puladas");
  check("running: stop button", running.stop, "Parar depois deste lote");
  check("aside steps while running", JSON.stringify(running.stepStates), JSON.stringify(["done", "done", "done", "active"]));
  const appRunning = await shot(page, "app-local-running.png");
  // Parity reference for the running state is mid-flight, so measure NOW.
  const parity = {};
  await protoGo("local-running");
  parity["local-running"] = await measureParity(protoPage, page, "local-running");

  // ---- local-done --------------------------------------------------------
  check("done state shows", await waitFor(page, `!!document.querySelector('[data-part="local-done"]')`, 15000), true);
  await delay(300);
  const done = await evalJson(
    page,
    `(() => ({
      title: document.querySelector('[data-part="local-done"] h1').textContent,
      result: document.querySelector('[data-part="local-result"]').textContent,
      created: document.querySelector('[data-part="local-done-created"]').textContent,
      skipped: document.querySelector('[data-part="local-done-skipped"]').textContent,
      errors: document.querySelector('[data-part="local-done-errors"]').textContent,
      note: document.querySelector('[data-part="local-done"]').textContent,
      stepStates: [...document.querySelectorAll("[data-step]")].map((s) => s.dataset.stepState),
    }))()`,
  );
  check("done: title", done.title, "Importação concluída");
  check("done: result line", done.result, "213 tasks criadas · 6 já existiam e foram puladas · 2 lotes");
  check("done: 213 created, 6 skipped, 0 errors", `${done.created}/${done.skipped}/${done.errors}`, "213/6/0");
  check("done: says what did not come along", done.note.includes("Dependências, cards, territórios e gates não foram levados"), true);
  check("aside steps all done", JSON.stringify(done.stepStates), JSON.stringify(["done", "done", "done", "done"]));
  check("two create calls of 200 + 19 rows", JSON.stringify(st.creates.map((c) => c.rows.length)), JSON.stringify([200, 19]));
  check("every create is a json job", st.creates.every((c) => c.body.kind === "json"), true);
  const appDone = await shot(page, "app-local-done.png");

  // The local board did not change.
  const after = await evalJson(page, `(async () => { const out = {}; for (const id of ["board-landing","board-api","board-drafts"]) { const t = await window.tasks.listByBoard(id); out[id] = t.length; } return out; })()`);
  check("local boards untouched (200 / 90 / 34 tasks)", JSON.stringify(after), JSON.stringify({ "board-landing": 200, "board-api": 90, "board-drafts": 34 }));

  // ---- re-import is a no-op (dedupe) -----------------------------------
  await click(page, '[data-part="local-again"]');
  check("again returns to the board pick", await waitFor(page, `document.querySelectorAll('[data-part="local-board"]').length === 3`), true);
  st.seedDuplicatesPerPreview = 0;
  const createsBefore = st.creates.length;
  await click(page, '[data-part="local-to-preview"]');
  check("re-preview shows", await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`), true);
  check(
    "re-import: nothing new, all 219 exist",
    JSON.stringify(await evalJson(page, `({ n: document.querySelector('[data-part="local-count-new"]').textContent, d: document.querySelector('[data-part="local-count-dup"]').textContent, run: document.querySelector('[data-part="local-run"]').disabled })`)),
    JSON.stringify({ n: "0", d: "219", run: true }),
  );
  check("re-preview created nothing", st.creates.length, createsBefore);

  // ---- stop after this batch ---------------------------------------------
  st.existing.clear();
  st.createDelayMs = [];
  st.createDelayMs[st.creates.length] = 2500; // hold the next job (batch 1)
  await click(page, '[data-part="import-back"]'); // preview → pick
  await waitFor(page, `!!document.querySelector('[data-part="local-to-preview"]')`);
  await click(page, '[data-part="local-to-preview"]');
  await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`);
  check("stop scenario: 219 new again", await text(page, '[data-part="local-count-new"]'), "219");
  await click(page, '[data-part="local-ack"]');
  const stopBase = st.creates.length;
  await click(page, '[data-part="local-run"]');
  check("stop scenario: batch 1 running", await waitFor(page, `!!document.querySelector('[data-part="local-batches"] [data-batch-status="running"]')`), true);
  await click(page, '[data-part="local-stop"]');
  check("stop button acknowledges", await waitFor(page, `document.querySelector('[data-part="local-stop"]')?.textContent.includes("Vai parar")`, 3000), true);
  check("stop scenario ends", await waitFor(page, `!!document.querySelector('[data-part="local-done"]')`, 15000), true);
  const stopped = await evalJson(
    page,
    `(() => ({
      title: document.querySelector('[data-part="local-done"] h1').textContent,
      lead: document.querySelector('[data-part="local-done"] p').textContent,
      created: document.querySelector('[data-part="local-done-created"]').textContent,
      notSent: document.querySelector('[data-part="local-done-errors"]').textContent,
      label: document.querySelector('[data-part="local-done-errors"]').nextElementSibling.textContent,
    }))()`,
  );
  check("stopped: only batch 1 was sent", st.creates.length - stopBase, 1);
  check("stopped: title", stopped.title, "Importação interrompida");
  check("stopped: lead", stopped.lead, "Parou depois de 1 de 2 lotes. O que já foi criado fica no time; importar de novo continua de onde parou.");
  check("stopped: 200 created, 19 not sent", `${stopped.created}/${stopped.notSent}/${stopped.label}`, "200/19/não enviadas");
  await shot(page, "app-local-stopped.png");

  // Continue where it stopped: the sent batch is skipped, the rest is created.
  await click(page, '[data-part="local-again"]');
  await waitFor(page, `document.querySelectorAll('[data-part="local-board"]').length === 3`);
  await click(page, '[data-part="local-to-preview"]');
  await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`);
  check("resume: 19 new, 200 exist", `${await text(page, '[data-part="local-count-new"]')}/${await text(page, '[data-part="local-count-dup"]')}`, "19/200");
  await click(page, '[data-part="local-ack"]');
  await click(page, '[data-part="local-run"]');
  check("resume ends", await waitFor(page, `!!document.querySelector('[data-part="local-done"]')`, 15000), true);
  check("resume: 19 created, 200 skipped", `${await text(page, '[data-part="local-done-created"]')}/${await text(page, '[data-part="local-done-skipped"]')}`, "19/200");

  // ---- failure: one board, API down --------------------------------------
  st.existing.clear();
  st.failCreate = true;
  await click(page, '[data-part="local-again"]');
  await waitFor(page, `document.querySelectorAll('[data-part="local-board"]').length === 3`);
  await click(page, '[data-part="local-board"][data-board-id="board-landing"] input');
  check("failure scenario: 71 open selected", await text(page, '[data-part="local-selection"]'), "1 board · 71 tasks abertas");
  await click(page, '[data-part="local-to-preview"]');
  await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`);
  await click(page, '[data-part="local-ack"]');
  await click(page, '[data-part="local-run"]');
  check("failure shows the error state", await waitFor(page, `!!document.querySelector('[data-part="local-error"]')`, 15000), true);
  const failed = await evalJson(
    page,
    `(() => ({
      title: document.querySelector('[data-part="local-done"] h1').textContent,
      error: document.querySelector('[data-part="local-error"]').textContent,
      notImported: document.querySelector('[data-part="local-done-errors"]').textContent,
    }))()`,
  );
  check("failure: title", failed.title, "Importação com erro");
  check("failure: message from the API is shown", failed.error.includes("import backend unavailable"), true);
  check("failure: 71 lines reported as failed", failed.notImported, "71");
  st.failCreate = false;

  // ---- parity vs. prototype (same mock data, same viewport) ---------------
  st.failCreate = false;
  st.createDelayMs = [];
  await click(page, '[data-part="local-again"]');
  await waitFor(page, `document.querySelectorAll('[data-part="local-board"]').length === 3`);
  await delay(300);
  await protoGo("local-pick");
  parity["local-pick"] = await measureParity(protoPage, page, "local-pick");

  st.existing.clear();
  st.seedDuplicatesPerPreview = 3;
  await click(page, '[data-part="local-to-preview"]');
  await waitFor(page, `!!document.querySelector('[data-part="local-count-new"]')`);
  await delay(300);
  await protoGo("local-preview");
  parity["local-preview"] = await measureParity(protoPage, page, "local-preview");

  st.existing.clear();
  st.seedDuplicatesPerPreview = 0;
  await click(page, '[data-part="local-ack"]');
  await click(page, '[data-part="local-run"]');
  await waitFor(page, `!!document.querySelector('[data-part="local-done"]')`, 15000);
  await delay(300);
  await protoGo("local-done");
  parity["local-done"] = await measureParity(protoPage, page, "local-done");

  for (const [name, res] of Object.entries(parity)) {
    check(`parity ${name}: every compared element found in both`, res.missing.length === 0 ? true : res.missing, true);
    check(`parity ${name}: computed styles match the prototype`, res.mismatches.length === 0 ? true : res.mismatches, true);
  }

  // ---- screenshots, side by side ------------------------------------------
  const protoPick = await protoShot("local-pick");
  const protoPreview = await protoShot("local-preview");
  const protoRunning = await protoShot("local-running");
  const protoDone = await protoShot("local-done");
  sideBySide(protoPick, appPick, join(OUT_DIR, "side-local-pick.png"));
  sideBySide(protoPreview, appPreviewTop, join(OUT_DIR, "side-local-preview.png"));
  sideBySide(protoRunning, appRunning, join(OUT_DIR, "side-local-running.png"));
  sideBySide(protoDone, appDone, join(OUT_DIR, "side-local-done.png"));
  check("side-by-side files written", ["pick", "preview", "running", "done"].every((n) => existsSync(join(OUT_DIR, `side-local-${n}.png`))), true);

  writeFileSync(join(OUT_DIR, "smoke-results.json"), JSON.stringify({ ok: true, parity }, null, 2));
} finally {
  await stopApp(app).catch(() => {});
  await stopApp(protoApp).catch(() => {});
  await backend?.close().catch(() => {});
  await staticSrv?.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
  rmSync(protoUserData, { recursive: true, force: true });
}

finish();
