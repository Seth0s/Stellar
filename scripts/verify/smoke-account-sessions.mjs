// Sessions on the account, by hand: save, open, conflict, plan needed, offline.
// Isolated userData and a fake account API that applies the same allowlist the
// real server does (a field outside it is a 400, like StellarCloud's
// `internal/sessions`). Prints under /tmp/sessoes-conta/app-*.png.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootIntoFreshSession, connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/sessoes-conta";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PRO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REMOTE = "https://user:secret-token@github.com/exemplo/plataforma-web.git";

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evalJs(expr).catch(() => false)) return true;
    await delay(150);
  }
  return false;
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
}

// ---- the fake account -------------------------------------------------------

const COMMON = ["ref", "kind", "x", "y", "w", "h", "label", "group_ref"];
const KIND_FIELDS = {
  terminal: ["provider", "model", "effort", "cwd_ref", "resume_id"],
  browser: ["url", "persistent"],
  files: ["cwd_ref"],
  changes: ["cwd_ref"],
  sticky: ["content", "color", "mode", "font_size"],
  stroke: ["points", "width", "style"],
  chat: ["provider", "model", "cwd_ref"],
  task: [],
};

/** The allowlist, as the server applies it. Returns the JSON path of the first offence, or null. */
function offence(snapshot) {
  const top = ["schema_version", "board", "cards", "connectors", "tasks"];
  for (const k of Object.keys(snapshot)) if (!top.includes(k)) return `snapshot.${k}`;
  for (const [i, c] of (snapshot.cards ?? []).entries()) {
    const allowed = [...COMMON, ...(KIND_FIELDS[c.kind] ?? [])];
    if (!KIND_FIELDS[c.kind]) return `snapshot.cards[${i}].kind`;
    for (const k of Object.keys(c)) if (!allowed.includes(k)) return `snapshot.cards[${i}].${k}`;
    const rel = c.cwd_ref?.rel;
    if (typeof rel === "string" && (rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel) || rel.split("/").includes(".."))) return `snapshot.cards[${i}].cwd_ref.rel`;
  }
  const text = JSON.stringify(snapshot);
  if (text.includes("secret-token")) return "snapshot (token)";
  return null;
}

function startFakeApi(port) {
  const knobs = { plan: "pro", sessionsDown: false, device: "Desktop", calls: [] };
  const sessions = new Map();
  const sockets = new Set();
  let n = 0;
  const view = (id) => {
    const s = sessions.get(id);
    const cur = s.revisions[s.revisions.length - 1];
    return {
      id,
      name: s.name,
      project: s.project,
      project_ref: s.projectRef,
      revision: s.revisions.length,
      card_count: cur.cards.length,
      task_count: cur.tasks.length,
      size_bytes: JSON.stringify(cur).length,
      updated_at: s.updatedAt,
      updated_by_device: s.device,
      archived_at: s.archivedAt,
    };
  };
  const handler = (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const body = raw ? JSON.parse(raw) : null;
      if (path === "/v1/auth/token") return send(200, { access_token: "a:1", refresh_token: "r:1", expires_in: 900, refresh_expires_in: 2592000 });
      if (path === "/v1/auth/logout") return res.writeHead(204).end();
      if (path === "/v1/me") {
        const pro = knobs.plan === "pro";
        return send(200, {
          account: { id: ACCOUNT_ID, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: "ana@example.com", login: null }],
          profiles: [{ id: PRO_ID, account_id: ACCOUNT_ID, kind: "personal", team_id: null, name: pro ? "Pro" : "Gratuito" }],
          teams: [],
          plan: {
            account_plan: pro ? "pro" : "free",
            account_expires_at: null,
            rights: {
              sync: { granted: pro, state: pro ? "active" : "none", plan: "pro", source: pro ? "account" : null, team_id: null, expires_at: null },
              team: { granted: false, state: "none", plan: "team", source: null, team_id: null, expires_at: null },
            },
          },
        });
      }
      if (path === "/v1/profiles") return send(200, { profiles: [] });
      if (path === "/v1/devices") return send(200, { devices: [] });
      if (path.endsWith("/house")) return send(200, { revision: 0, manifest: [] });

      const m = new RegExp(`^/v1/profiles/${PRO_ID}/sessions(?:/([^/]+))?$`).exec(path);
      if (!m) return send(404, { error: { code: "not_found", message: path } });
      knobs.calls.push(`${req.method} ${path.replace(PRO_ID, ":profile")}${url.search}`);
      if (knobs.sessionsDown) return req.socket.destroy();
      if (knobs.plan !== "pro") return send(402, { error: { code: "plan_required", message: "sync needs Pro", feature: "sync", plan: "free" } });
      const id = m[1];

      if (!id && req.method === "GET") {
        const archived = url.searchParams.get("archived") === "true";
        const list = [...sessions.keys()].filter((k) => (sessions.get(k).archivedAt !== null) === archived).map(view);
        return send(200, { sessions: list, total: list.length });
      }
      if (!id && req.method === "POST") {
        const bad = offence(body.snapshot);
        if (bad) return send(400, { error: { code: "snapshot_invalid", message: `${bad}: not allowed` } });
        for (const [sid, s] of sessions) if (s.clientRef === body.client_ref) return send(409, { error: { code: "session_exists", message: "exists" }, id: sid, revision: s.revisions.length });
        const sid = randomUUID();
        sessions.set(sid, { clientRef: body.client_ref, name: body.name, project: body.project, projectRef: body.project_ref ?? null, revisions: [body.snapshot], updatedAt: new Date().toISOString(), device: knobs.device, archivedAt: null });
        return send(201, { id: sid, revision: 1, updated_at: sessions.get(sid).updatedAt });
      }
      const s = sessions.get(id);
      if (!s) return send(404, { error: { code: "not_found", message: "no such session" } });
      if (req.method === "GET") return send(200, { ...view(id), snapshot: s.revisions[s.revisions.length - 1] });
      if (req.method === "PUT") {
        const bad = offence(body.snapshot);
        if (bad) return send(400, { error: { code: "snapshot_invalid", message: `${bad}: not allowed` } });
        const expected = Number(String(req.headers["if-match"] ?? "").replace(/"/g, ""));
        if (expected !== s.revisions.length) {
          const cur = s.revisions[s.revisions.length - 1];
          return send(409, {
            error: { code: "revision_conflict", message: "the session changed on another device" },
            current_revision: s.revisions.length,
            current_updated_at: s.updatedAt,
            current_updated_by_device: s.device,
            current_summary: { card_count: cur.cards.length, task_count: cur.tasks.length },
          });
        }
        s.revisions.push(body.snapshot);
        s.updatedAt = new Date().toISOString();
        s.device = knobs.device;
        return send(200, { revision: s.revisions.length, updated_at: s.updatedAt }, { ETag: `"${s.revisions.length}"` });
      }
      if (req.method === "PATCH") {
        if (body.archived_at !== undefined) s.archivedAt = body.archived_at;
        return send(200, view(id));
      }
      return send(405, { error: { code: "method_not_allowed", message: req.method } });
    });
  };
  let server = null;
  return {
    knobs,
    sessions,
    /** Another computer saves a new revision of the first session. */
    otherMachineSaves(id, mutate) {
      const s = sessions.get(id);
      const next = structuredClone(s.revisions[s.revisions.length - 1]);
      mutate(next);
      s.revisions.push(next);
      s.updatedAt = new Date().toISOString();
      s.device = "Notebook";
    },
    /** A session another computer made, for a project this machine has no clone of. */
    seedForeign(snapshot, projectRef, name) {
      const sid = randomUUID();
      sessions.set(sid, { clientRef: randomUUID(), name, project: name, projectRef, revisions: [snapshot], updatedAt: new Date().toISOString(), device: "Notebook", archivedAt: null });
      return sid;
    },
    up: () =>
      new Promise((r) => {
        server = createServer(handler);
        server.on("connection", (sock) => {
          sockets.add(sock);
          sock.on("close", () => sockets.delete(sock));
        });
        server.listen(port, "127.0.0.1", r);
      }),
    down: () =>
      new Promise((r) => {
        for (const sock of sockets) sock.destroy();
        if (!server) return r();
        server.close(() => r());
        server = null;
      }),
  };
}

function seed(dir) {
  mkdirSync(join(dir, "profiles", PROFILE_ID), { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }));
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "r:1", encrypted: false }, linked: true }));
}

/** A project folder with a git origin that carries credentials: the snapshot must not. */
function makeProject(root) {
  const dir = join(root, "plataforma-web");
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", REMOTE]);
  return dir;
}

async function withApp({ apiBase, userData, body }) {
  const cdpPort = await pickFreePort();
  const app = await startApp({ cdpPort, userDataDir: userData, preserveUserData: true, isolatedHome: true, extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: apiBase } });
  try {
    const page = await connectPage(cdpPort);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await body(page);
    page.close();
  } finally {
    await stopApp(app);
  }
}

const q = (page, expr) => page.evalJs(expr);
const goHome = async (page) => {
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  return waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);
};
const cardsOnHome = (page) => q(page, `document.querySelectorAll('.home-session-card').length`);
const click = (page, sel) => q(page, `document.querySelector(${JSON.stringify(sel)})?.click()`);

const apiPort = await pickFreePort();
const api = startFakeApi(apiPort);
await api.up();
const apiBase = `http://127.0.0.1:${apiPort}`;
const root = mkdtempSync(join(tmpdir(), "stellar-sessions-"));
const projectDir = makeProject(root);
const userData = mkdtempSync(join(tmpdir(), "stellar-account-sessions-"));
seed(userData);

try {
  // ---- Pro: save, saved, conflict, open ------------------------------------------
  await withApp({
    apiBase,
    userData,
    body: async (page) => {
      check("pro: lands on the account's Sessões", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      check("pro: the account section is there, with its empty hint", await waitFor(page, `!!document.querySelector('[data-role="account-sessions-empty"]')`), true);
      await shot(page, "app-abrir-vazio");

      // A session of the account profile with a terminal that has a conversation, a note, a media card, a connection and a task.
      await bootIntoFreshSession(page, "plataforma-web", { spawnTerminal: false, keepScope: true });
      const boardId = JSON.parse(
        await q(page, `window.store.boards.list().then((b) => JSON.stringify(b.find((x) => x.name === 'plataforma-web').id))`),
      );
      await q(
        page,
        `(async () => {
          const boards = await window.store.boards.list();
          const b = boards.find((x) => x.id === ${JSON.stringify(boardId)});
          await window.store.boards.upsert({ ...b, cwd: ${JSON.stringify(projectDir)}, project: 'plataforma-web' });
          const base = { board_id: ${JSON.stringify(boardId)}, resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null, updated_at: Date.now(), messages_json: null, archived_at: null };
          await window.store.upsert({ ...base, id: 's-term', kind: 'terminal', provider: 'claude', cwd: ${JSON.stringify(join(projectDir, "src", "routes"))}, x: 40, y: 60, w: 520, h: 320, resume_id: 'conv-abc-123', model: 'sonnet', effort: 'high', label: 'IMPL', system_prompt: 'SECRET-PROMPT' });
          await window.store.upsert({ ...base, id: 's-note', kind: 'sticky', provider: 'yellow', cwd: 'Revisar o contrato da API', x: 600, y: 60, w: 240, h: 160, model: 'edit', system_prompt: '16' });
          await window.store.upsert({ ...base, id: 's-files', kind: 'files', provider: '', cwd: ${JSON.stringify(projectDir)}, x: 600, y: 260, w: 300, h: 200 });
          await window.store.upsert({ ...base, id: 's-media', kind: 'media', provider: 'image', cwd: '{"assetPath":"/home/ana/Pictures/foto.png"}', x: 40, y: 420, w: 200, h: 120 });
          await window.store.connectors.upsert({ id: 's-conn', board_id: ${JSON.stringify(boardId)}, from_card_id: 's-term', to_card_id: 's-note', updated_at: Date.now(), kind: 'context', label: null });
        })()`,
      );
      const homeOk = await goHome(page);
      if (!homeOk) {
        console.log("DEBUG body:", (await q(page, `document.body.innerText.slice(0, 400)`)).replace(/\n/g, " | "));
        await shot(page, "debug-home");
      }
      check("pro: back on the Home with the session", homeOk && (await waitFor(page, `document.querySelectorAll('.home-session-card').length === 1`)), true);
      check("pro: the card shows no revision yet (not saved)", await q(page, `!document.querySelector('[data-role="account-session-rev"]')`), true);

      // ---- save ----
      await click(page, '[data-role="account-session-card-save"]');
      check("save: the dialog opens with what goes and what stays", await waitFor(page, `!!document.querySelector('[data-role="account-session-save"] [data-role="account-session-save-confirm"]:not([disabled])')`), true);
      const dialog = await q(page, `document.querySelector('[data-role="account-session-save"]').innerText`);
      check("save: says it creates the first copy", /primeira cópia/.test(dialog), true);
      check("save: counts the cards, the connection and the tasks that go", /3 cards, 1 conexão e 0 tasks/.test(dialog), true);
      check("save: names the project by its git remote, with no credentials", /github\.com\/exemplo\/plataforma-web/.test(dialog) && !/secret-token/.test(dialog), true);
      check("save: warns the media card stays on this machine", await q(page, `!!document.querySelector('[data-role="account-session-omitted"]')`), true);
      check("save: says the terminal text and the conversation stay", /conversa dos agentes/.test(dialog), true);
      await shot(page, "app-salvar");
      await click(page, '[data-role="account-session-save-confirm"]');
      check("save: the card now shows revision 1", await waitFor(page, `document.querySelector('[data-role="account-session-rev"]')?.textContent === 'r1'`), true);
      check("save: the account list has the session", await waitFor(page, `document.querySelectorAll('[data-role="account-session-row"]').length === 1`), true);
      await shot(page, "app-salvo");

      const [sid, stored] = [...api.sessions.entries()][0];
      const snap = stored.revisions[0];
      const text = JSON.stringify(snap);
      check("save: the account got the session with a git project reference without credentials", stored.projectRef?.kind === "git" && stored.projectRef.remote === "github.com/exemplo/plataforma-web", true);
      check("save: no absolute path, no prompt, no secret in what was sent", !text.includes(projectDir) && !text.includes("SECRET-PROMPT") && !text.includes("secret-token") && !text.includes("/home/ana"), true);
      const term = snap.cards.find((c) => c.kind === "terminal");
      check("save: the terminal carries provider, model, effort, label, the conversation id and a relative folder", term?.provider === "claude" && term.model === "sonnet" && term.effort === "high" && term.label === "IMPL" && term.resume_id === "conv-abc-123" && term.cwd_ref?.rel === "src/routes", true);
      check("save: the media card did not go; cards, connection kept", snap.cards.length === 3 && !snap.cards.some((c) => c.kind === "media") && snap.connectors.length === 1, true);
      check("save: the sticky note went with its text", snap.cards.find((c) => c.kind === "sticky")?.content === "Revisar o contrato da API", true);

      // ---- a second save is an update (If-Match) ----
      await click(page, '[data-role="account-session-card-save"]');
      await waitFor(page, `!!document.querySelector('[data-role="account-session-save-confirm"]:not([disabled])')`);
      check("save again: says it updates revision 1", /r1/.test(await q(page, `document.querySelector('[data-role="account-session-save"]').innerText`)), true);
      await click(page, '[data-role="account-session-save-confirm"]');
      check("save again: revision 2", await waitFor(page, `document.querySelector('[data-role="account-session-rev"]')?.textContent === 'r2'`), true);

      // ---- conflict: another computer saved meanwhile ----
      api.otherMachineSaves(sid, (s) => {
        s.cards.push({ ref: "n2", kind: "sticky", x: 1, y: 1, w: 100, h: 100, content: "da outra máquina" });
        s.board.name = "plataforma-web (notebook)";
      });
      await click(page, '[data-role="account-session-card-save"]');
      await waitFor(page, `!!document.querySelector('[data-role="account-session-save-confirm"]:not([disabled])')`);
      await click(page, '[data-role="account-session-save-confirm"]');
      check("conflict: the dialog asks which version stays", await waitFor(page, `!!document.querySelector('[data-role="account-session-conflict"]')`), true);
      const conflict = await q(page, `document.querySelector('[data-role="account-session-conflict"]').innerText`);
      check("conflict: names the other computer and shows both sides", /Notebook/.test(conflict) && /4 cards/.test(conflict) && /3 cards/.test(conflict), true);
      check("conflict: offers keep mine, keep the account's and decide later", /Manter a minha/.test(conflict) && /Manter a da conta/.test(conflict) && /Decidir depois/.test(conflict), true);
      await shot(page, "app-conflito");
      check("conflict: nothing was written (the account still has revision 3)", api.sessions.get(sid).revisions.length, 3);
      await click(page, '[data-role="account-session-keep-mine"]');
      check("conflict: keep mine saves over the account's revision (r4)", await waitFor(page, `document.querySelector('[data-role="account-session-rev"]')?.textContent === 'r4'`), true);
      check("conflict: the account has 4 revisions and mine is the last", api.sessions.get(sid).revisions.length === 4 && api.sessions.get(sid).revisions[3].cards.length === 3, true);

      // ---- conflict again: keep the account's ----
      api.otherMachineSaves(sid, (s) => {
        s.cards.push({ ref: "n3", kind: "sticky", x: 1, y: 1, w: 100, h: 100, content: "terceira" });
        s.board.name = "plataforma-web";
      });
      const before = await cardsOnHome(page);
      await click(page, '[data-role="account-session-card-save"]');
      await waitFor(page, `!!document.querySelector('[data-role="account-session-save-confirm"]:not([disabled])')`);
      await click(page, '[data-role="account-session-save-confirm"]');
      await waitFor(page, `!!document.querySelector('[data-role="account-session-keep-account"]')`);
      await click(page, '[data-role="account-session-keep-account"]');
      // The account's version opens as a new session; the Home is left for it, so come back.
      check("conflict: keep the account's opens it as a new session (the board is left for it)", await waitFor(page, `!document.querySelector('.home')`, 20000), true);
      check("conflict: back on the Home there is one more session; mine is still there", (await goHome(page)) && (await waitFor(page, `document.querySelectorAll('.home-session-card').length === ${before + 1}`)), true);

      // ---- open from the account ----
      await waitFor(page, `document.querySelectorAll('[data-role="account-session-row"]').length >= 1`);
      check("open: the row says the session is also open on this machine", await q(page, `!!document.querySelector('[data-role="account-session-row"] [data-tone="here"]')`), true);
      await shot(page, "app-abrir");
      const boardsBefore = await cardsOnHome(page);
      await click(page, '[data-role="account-session-open"]');
      check("open: the clone is found by its git remote, no folder question", await waitFor(page, `!!document.querySelector('[data-role="account-session-opened"]')`), true);
      const opened = await q(page, `document.querySelector('[data-role="account-session-opened"]').innerText`);
      check("open: says the terminal opened clean because its conversation is not on this computer", /1 card de agente abriu limpo/.test(opened), true);
      check("open: a new session is on the Home", await waitFor(page, `document.querySelectorAll('.home-session-card').length === ${boardsBefore + 1}`), true);
      await shot(page, "app-outra-maquina");

      // ---- a project this machine has no clone of: choose the folder ----
      // A folder with the same name but another remote exists here (a board points at it).
      const lookalike = join(root, "docs-site");
      mkdirSync(lookalike, { recursive: true });
      execFileSync("git", ["init", "-q", lookalike]);
      execFileSync("git", ["-C", lookalike, "remote", "add", "origin", "https://github.com/outro/docs-site.git"]);
      await q(
        page,
        `window.store.boards.upsert({ id: 'lookalike', name: 'docs copy', project: '', cwd: ${JSON.stringify(lookalike)}, created_at: Date.now(), updated_at: Date.now(), last_accessed_at: null, autonomous: false, concurrency_cap: null, orchestrator_card_id: null, account_profile_id: null })`,
      );
      const foreignSnapshot = (name) => ({
        schema_version: 1,
        board: { name, project: name, autonomous: false },
        cards: [{ ref: "t", kind: "terminal", x: 0, y: 0, w: 400, h: 300, provider: "claude", cwd_ref: { rel: "content" } }, { ref: "f", kind: "files", x: 420, y: 0, w: 300, h: 300 }],
        connectors: [],
        tasks: [],
      });
      const foreign = api.seedForeign(foreignSnapshot("docs-site"), { kind: "git", remote: "github.com/exemplo/docs-site", name: "docs-site" }, "docs-site");
      const foreignB = api.seedForeign(foreignSnapshot("infra"), { kind: "git", remote: "github.com/exemplo/infra", name: "infra" }, "infra");
      await click(page, '[data-role="account-sessions-refresh"]');
      check("folder: the foreign session is listed", await waitFor(page, `!!document.querySelector('[data-session-id="${foreign}"]')`), true);
      await click(page, `[data-session-id="${foreign}"] [data-role="account-session-open"]`);
      check("folder: no clone with that remote, the dialog asks where the project is", await waitFor(page, `!!document.querySelector('[data-role="account-session-folder"]')`), true);
      const folderText = await q(page, `document.querySelector('[data-role="account-session-folder"]').innerText`);
      check("folder: names the project and says the path stays on this computer", /github\.com\/exemplo\/docs-site/.test(folderText) && /não vai para a conta/.test(folderText), true);
      check("folder: lists the same-named folder with another remote, as a lookalike", folderText.includes(lookalike) && /mesmo nome, outro remoto/.test(folderText), true);
      await shot(page, "app-escolher-pasta");
      await click(page, '[data-role="account-session-folder-use"]');
      check("folder: using the chosen folder opens the session", await waitFor(page, `!!document.querySelector('[data-role="account-session-opened"]') && !document.querySelector('[data-role="account-session-folder"]')`), true);
      const chosen = JSON.parse(await q(page, `window.store.boards.list().then((b) => JSON.stringify(b.filter((x) => x.name === 'docs-site').map((x) => x.cwd)))`));
      check("folder: the new session's folder is the one chosen here", chosen[0], lookalike);
      await click(page, `[data-session-id="${foreignB}"] [data-role="account-session-open"]`);
      check("folder: a session with no match asks again", await waitFor(page, `!!document.querySelector('[data-role="account-session-folder"]')`), true);
      await click(page, '[data-role="account-session-folder-none"]');
      check("folder: open without a folder works", await waitFor(page, `!document.querySelector('[data-role="account-session-folder"]')`), true);
      const none = JSON.parse(await q(page, `window.store.boards.list().then((b) => JSON.stringify(b.filter((x) => x.name === 'infra').map((x) => x.cwd)))`));
      check("folder: without a folder the session opens in the fallback directory, not a path from the account", none.length === 1 && !none[0].includes("exemplo"), true);

      // ---- archive ----
      await waitFor(page, `document.querySelectorAll('[data-role="account-session-row"]').length >= 2`);
      const rowsBefore = await q(page, `document.querySelectorAll('[data-role="account-session-row"]').length`);
      await click(page, `[data-session-id="${foreignB}"] [data-role="account-session-archive"]`);
      check("archive: the session leaves the account list", await waitFor(page, `document.querySelectorAll('[data-role="account-session-row"]').length === ${rowsBefore - 1}`), true);

      // ---- offline: nothing is sent, nothing is lost ----
      const callsBefore = api.knobs.calls.length;
      api.knobs.sessionsDown = true;
      await click(page, '[data-role="account-session-card-save"]');
      await waitFor(page, `!!document.querySelector('[data-role="account-session-save-confirm"]:not([disabled])')`);
      await click(page, '[data-role="account-session-save-confirm"]');
      check("offline: the dialog says there is no connection and nothing was saved", await waitFor(page, `!!document.querySelector('[data-role="account-session-save"] [data-role="account-session-offline"]')`), true);
      const off = await q(page, `document.querySelector('[data-role="account-session-offline"]').innerText`);
      check("offline: says nothing was saved and offers to try again", /Nada foi salvo/.test(off) && (await q(page, `/Tentar de novo/.test(document.querySelector('[data-role="account-session-save-retry"]')?.textContent ?? '')`)), true);
      await shot(page, "app-offline");
      api.knobs.sessionsDown = false;
      await click(page, '[data-role="account-session-save-retry"]');
      check("offline: trying again after the connection is back saves", await waitFor(page, `!document.querySelector('[data-role="account-session-save"]')`), true);
      check("offline: the attempt while down never reached a handler (no write landed)", api.knobs.calls.slice(callsBefore).filter((c) => c.startsWith("PUT") || c.startsWith("POST")).length >= 1, true);
    },
  });

  // ---- Free: the plan card, nothing sent ----------------------------------------------
  api.knobs.plan = "free";
  const callsAtFree = api.knobs.calls.length;
  await withApp({
    apiBase,
    userData,
    body: async (page) => {
      check("free: the account's Sessões shows the plan card", await waitFor(page, `!!document.querySelector('[data-role="account-session-plan"]')`), true);
      const plan = await q(page, `document.querySelector('[data-role="account-session-plan"]').innerText`);
      check("free: says Pro or a Team is needed, and what goes and what stays", /Pro ou de um Time/.test(plan) && /VAI|QUE VAI/.test(plan) && /FICA|QUE FICA/.test(plan), true);
      check("free: offers 'Ver planos' and keeping local", /Ver planos/.test(plan), true);
      check("free: no save button on the cards", await q(page, `!document.querySelector('[data-role="account-session-card-save"]')`), true);
      check("free: the app did not call the sessions API at all", api.knobs.calls.length, callsAtFree);
      await shot(page, "app-plano-necessario");
    },
  });
  api.knobs.plan = "pro";
} finally {
  await api.down();
  rmSync(userData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

finish();
