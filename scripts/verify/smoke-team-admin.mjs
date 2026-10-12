// Team administration and invites against the approved prototype
// (docs/design/app-v2/prototipo/TeamAdmin.dc.html and Invite.dc.html).
//
// Two things are measured, on isolated Electron instances (own userData and
// ports) talking to a MOCK API with the prototype's own data:
//   1. BEHAVIOR through the real IPC: seats, role change, remove, leave
//      blocked for the last owner, invite by link (URL shown once) and by email
//      (503 -> copy link), rename, delete with the slug, the beta create
//      screen, and the guest's path through the invite dialog.
//   2. VISUAL PARITY: getComputedStyle of the same elements in the prototype
//      and in the app, state by state. A difference is a failure unless it is
//      listed in KNOWN_DELTAS with its reason (an owner decision, not ours).
// Prints/screenshots under /tmp/team-impl/. Never touches the owner's app.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v2/prototipo");
const OUT_DIR = process.env.TEAM_ADMIN_OUT ?? "/tmp/team-impl";
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock data: the prototype's own -----------------------------------------------

// Ids chosen so each person gets the prototype's avatar tone (blue / purple / green).
const ME = "33333333-3333-4333-8333-333333333335";
const RIO = "44444444-4444-4444-8444-444444444441";
const SAM = "55555555-5555-4555-8555-555555555551";
const KAI = "66666666-6666-4666-8666-666666666666";
const JORDAN = "77777777-7777-4777-8777-777777777777";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const INVITE_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "ex_tok_7f3a9c2e1b";
const INVITE_URL = `https://api.stellar.idyplatform.com/invite#t=${TOKEN}`;
const DAY = 24 * 60 * 60 * 1000;

const ACCOUNTS = {
  owner: { id: ME, name: "Maya Chen", email: "maya@example.com", refresh: "owner-refresh" },
  guest: { id: KAI, name: "Kai Kim", email: "kai@example.com", refresh: "guest-refresh" },
  stranger: { id: JORDAN, name: "Jordan Lee", email: "jordan@example.com", refresh: "stranger-refresh" },
};

function member(accountId, role, displayName, initials, email) {
  return { team_id: TEAM_ID, account_id: accountId, role, joined_at: "2026-10-05T00:00:00Z", display_name: displayName, avatar_initials: initials, email };
}

function task(n, state, assignee) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    team_id: TEAM_ID,
    short_id: n,
    ref: `#${n}`,
    title: `Task ${n}`,
    kind: "implementar",
    priority: "media",
    state,
    assignee_id: assignee,
    version: 1,
    updated_at: new Date(Date.now() - n * 60000).toISOString(),
  };
}

/** 17 tasks: 11 open (2 without an owner), and the per-person counts of the prototype (4 / 6 / 5). */
function protoTasks() {
  const out = [];
  let n = 1;
  const add = (state, who, count) => {
    for (let i = 0; i < count; i++) out.push(task(n++, state, who));
  };
  add("rodando", ME, 3); add("concluida", ME, 1);
  add("rodando", RIO, 4); add("concluida", RIO, 2);
  add("rodando", SAM, 2); add("concluida", SAM, 3);
  add("sem_dono", null, 2);
  return out;
}

function newState(scenario) {
  const team = { id: TEAM_ID, name: "Nebula Labs", slug: "nebula-labs", share_file_paths: false, created_by: ME, created_at: "2026-10-05T00:00:00Z" };
  return {
    scenario,
    team,
    teams: scenario === "create-beta" || scenario === "create-error" ? [] : [team],
    members: [
      member(ME, "owner", "Maya Chen", "MC", "maya@example.com"),
      member(RIO, "admin", "Rio Alvarez", "RA", "rio@example.com"),
      member(SAM, "member", "Sam Okonkwo", "SO", "github: samok"),
    ],
    seats: { used: 3, total: 5, expires_at: null },
    invites: [{ id: INVITE_ID, team_id: TEAM_ID, target: "kai@example.com", role: "member", expires_at: new Date(Date.now() + 5 * DAY - 3600_000).toISOString() }],
    tasks: protoTasks(),
    teamPlan: scenario !== "create-beta",
    email503: false,
    guestJoined: false,
    log: [],
  };
}

function startFakeBackend(port, S) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const err = (status, code, message) => send(status, { error: { code, message } });
      S.log.push({ method: req.method, path, body });

      if (path === "/v1/auth/token" && req.method === "POST") {
        const who = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].refresh === body.refresh_token) ?? "owner";
        return send(200, { access_token: `a:${who}`, refresh_token: body.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();
      // Email sign-in: the server mails a one-time link; nothing to read back here.
      if (path === "/v1/auth/email" && req.method === "POST") return res.writeHead(204).end();

      // Public: the invite preview needs no login.
      const preview = path.match(/^\/v1\/invites\/([^/]+)\/preview$/);
      if (preview && req.method === "GET") {
        if (decodeURIComponent(preview[1]) !== TOKEN) return err(404, "not_found", "not found");
        return send(200, {
          team_name: "Nebula Labs",
          invited_by_name: "Maya Chen",
          role: "member",
          target_masked: "k***@example.com",
          expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
        });
      }

      const auth = req.headers.authorization ?? "";
      const who = auth.startsWith("Bearer a:") ? auth.slice("Bearer a:".length) : null;
      if (!who || !ACCOUNTS[who]) return err(401, "unauthorized", "missing bearer");
      const acc = ACCOUNTS[who];
      const isOwner = who === "owner";

      if (path === "/v1/me" && req.method === "GET") {
        const teams = isOwner ? S.teams : S.guestJoined && who === "guest" ? [S.team] : [];
        const granted = (isOwner && S.teamPlan) || (who === "guest" && S.guestJoined);
        return send(200, {
          account: { id: acc.id, display_name: acc.name, created_at: "2026-10-05T00:00:00Z" },
          identities: [{ id: acc.id, account_id: acc.id, kind: "email", subject: acc.email, verified_at: null, created_at: null, login: null }],
          profiles: [{ id: PROFILE_ID, account_id: acc.id, kind: "personal", team_id: null, name: "Pessoal", created_at: null }],
          teams,
          plan: {
            account_plan: granted ? "team" : "free",
            account_expires_at: null,
            rights: {
              sync: { granted: false, state: "none", plan: "pro", source: null, team_id: null, expires_at: null },
              team: granted
                ? { granted: true, state: "active", plan: "team", source: "team", team_id: TEAM_ID, expires_at: null }
                : { granted: false, state: "none", plan: "team", source: null, team_id: null, expires_at: null },
            },
          },
        });
      }
      if (path === "/v1/teams" && req.method === "POST") {
        if (S.scenario === "create-error") return err(402, "plan_required", "o plano desta conta não inclui times");
        return send(201, S.team);
      }
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") {
        return send(200, { team: S.team, members: S.members, seats: S.seats });
      }
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "PATCH") {
        if (typeof body.name === "string") S.team.name = body.name.trim();
        return send(200, S.team);
      }
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "DELETE") {
        if (body.confirm !== S.team.slug) return err(400, "bad_request", "confirm must be the team slug");
        S.teams = [];
        return res.writeHead(204).end();
      }
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") return send(200, { tasks: S.tasks, total: S.tasks.length, limit: 100, offset: 0 });
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") return send(200, { sprints: [] });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "GET") return send(200, { invites: S.invites });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "POST") {
        if (body.delivery === "email" && S.email503) return err(503, "email_unavailable", "o serviço de e-mail está indisponível agora");
        if (S.seats.used >= S.seats.total) return err(402, "seats_exceeded", "o time já usa todos os assentos");
        const invite = { id: randomUUID(), team_id: TEAM_ID, target: body.target, role: body.role, expires_at: new Date(Date.now() + 7 * DAY).toISOString() };
        S.invites.push(invite);
        return send(201, { ...invite, delivery: body.delivery, ...(body.delivery === "link" ? { invite_url: INVITE_URL } : {}) });
      }
      const inviteDel = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/invites/([^/]+)$`));
      if (inviteDel && req.method === "DELETE") {
        S.invites = S.invites.filter((i) => i.id !== inviteDel[1]);
        return res.writeHead(204).end();
      }
      const role = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/members/([^/]+)/role$`));
      if (role && req.method === "PATCH") {
        const m = S.members.find((x) => x.account_id === role[1]);
        if (!m) return err(404, "not_found", "not found");
        m.role = body.role;
        return send(200, m);
      }
      const rm = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/members/([^/]+)$`));
      if (rm && req.method === "DELETE") {
        const m = S.members.find((x) => x.account_id === rm[1]);
        if (!m) return err(404, "not_found", "not found");
        if (m.role === "owner" && S.members.filter((x) => x.role === "owner").length <= 1) return err(409, "last_owner", "o último owner não pode sair");
        S.members = S.members.filter((x) => x.account_id !== rm[1]);
        S.seats.used = S.members.length;
        return res.writeHead(204).end();
      }
      const accept = path.match(/^\/v1\/invites\/([^/]+)\/accept$/);
      if (accept && req.method === "POST") {
        if (who !== "guest") return err(403, "invite_target_mismatch", "this invite is for another identity");
        S.guestJoined = true;
        S.seats.used = 4;
        return send(200, { team: S.team, membership: member(KAI, "member", "Kai Kim", "KK", "kai@example.com") });
      }
      if (path.startsWith("/v1/profiles/") && path.endsWith("/house") && req.method === "GET") return send(200, { revision: 0, manifest: [] });
      if (path === "/v1/devices" && req.method === "GET") return send(200, { devices: [] });
      if (path === "/v1/events") return send(200, {});
      return err(404, "not_found", path);
    });
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function seedCloud(dir, refresh) {
  mkdirSync(join(dir, "profiles", PROFILE_ID), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({ schemaVersion: 1, defaultProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: refresh, encrypted: false }, linked: true }));
}

function seedLocal(dir) {
  seedCloud(dir, "none");
  rmSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), { force: true });
}

// ---- prototype server (local fonts, no network) ------------------------------------

function localFontCss() {
  const faces = [
    ...[400, 500, 600, 700].map((w) => ["Space Grotesk", w, `@fontsource/space-grotesk/files/space-grotesk-latin-${w}-normal.woff2`]),
    ...[400, 500].map((w) => ["JetBrains Mono", w, `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`]),
  ];
  return faces
    .map(([family, weight, rel]) => {
      const b64 = readFileSync(join(PROJECT_ROOT, "node_modules", rel)).toString("base64");
      return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    })
    .join("");
}

function startProtoServer() {
  const fontCss = localFontCss();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const abs = resolve(PROTO_DIR, decodeURIComponent(url.pathname.replace(/^\//, "")));
    if (!abs.startsWith(PROTO_DIR) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = readFileSync(abs);
    let type = "application/octet-stream";
    if (abs.endsWith(".html")) {
      type = "text/html; charset=utf-8";
      let html = body.toString("utf8")
        .replace(/<link rel="preconnect"[^>]*>/g, "")
        .replace(/<link href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>/g, "")
        .replace('<script src="./support.js"></script>', "");
      html = html.replace("<style>", `<style>${fontCss}`);
      body = Buffer.from(html, "utf8");
    } else if (abs.endsWith(".js")) type = "text/javascript; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// ---- measurement -------------------------------------------------------------------

const TEXT = ["color", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "fontKind"];
const BOX = [
  "backgroundColor",
  "borderTopColor",
  "borderTopWidth",
  "borderTopStyle",
  "borderTopLeftRadius",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "rowGap",
  "columnGap",
];
const KINDS = {
  text: TEXT,
  box: [...BOX, "color"],
  card: [...BOX, "color", "width"],
  control: [...BOX, ...TEXT, "height"],
  fixed: [...BOX, ...TEXT, "width", "height"],
};

/** Reads the listed props of one element (a JS expression) in the current page. */
function readerSource(items) {
  const fns = items.map(({ key, expr }) => `${JSON.stringify(key)}: () => (${expr})`).join(",\n");
  const kinds = JSON.stringify(KINDS);
  const kindOf = JSON.stringify(Object.fromEntries(items.map((i) => [i.key, i.kind])));
  return `(() => {
    const finders = {${fns}};
    const kinds = ${kinds};
    const kindOf = ${kindOf};
    const out = {};
    for (const key of Object.keys(finders)) {
      let el = null;
      try { el = finders[key](); } catch { el = null; }
      if (!el) { out[key] = null; continue; }
      const cs = getComputedStyle(el);
      const r = {};
      for (const p of kinds[kindOf[key]]) {
        if (p === "fontKind") r[p] = /JetBrains|mono/i.test(cs.fontFamily) ? "mono" : "ui";
        else if (p === "height") r[p] = Math.round(el.getBoundingClientRect().height * 100) / 100 + "px";
        else if (p === "width") r[p] = Math.round(el.getBoundingClientRect().width * 100) / 100 + "px";
        else r[p] = cs[p];
      }
      out[key] = r;
    }
    return JSON.stringify(out);
  })()`;
}

async function readAll(page, items) {
  return JSON.parse(await page.evalJs(readerSource(items)));
}

/**
 * Differences the prototype and the app are KNOWN to have, each with its reason.
 * Matched on "<state>/<pair>/<prop>" (a RegExp). Anything else that differs
 * fails the smoke: a visual difference needs the owner's approval first.
 */
/**
 * `<a class="ghost">` in the prototype is content-box (36px + 1px borders = 38px); the app's
 * buttons are 36px, like the primary button beside them. APPROVED by the owner as the one
 * accepted visual delta. Every other difference fails the smoke.
 */
const GHOST_ANCHOR_PAIRS = ["team/btn-settings", "invite/btn-link", "invite-copied/btn-done", "invite-full/btn-back"];

function isKnown(state, pair, prop) {
  if (GHOST_ANCHOR_PAIRS.includes(`${state}/${pair}`) && prop === "height") {
    return { kind: "approved", reason: "secondary button stays 36px (owner-approved delta: the prototype anchor is content-box, 38px)" };
  }
  return null;
}

const parityRows = [];
function compare(state, pairs, proto, app) {
  for (const { key } of pairs) {
    const p = proto[key];
    const a = app[key];
    if (p === null || a === null) {
      check(`parity ${state}/${key}: element found (proto=${p !== null}, app=${a !== null})`, p !== null && a !== null, true);
      continue;
    }
    for (const prop of Object.keys(p)) {
      // The prototype's content-box panels land on 0.67px fractions of their 1px borders.
      const sub = (prop === "width" || prop === "height") && Math.abs(parseFloat(p[prop]) - parseFloat(a[prop])) < 1;
      const same = p[prop] === a[prop] || sub;
      parityRows.push({ state, pair: key, prop, proto: p[prop], app: a[prop], same, known: same ? null : (isKnown(state, key, prop) ?? null) });
    }
  }
}

// ---- driver helpers ---------------------------------------------------------------

async function waitFor(page, expr, timeoutMs = 15000) {
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

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const abs = join(OUT_DIR, `${name}.png`);
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

function sideBySide(protoPath, appPath, outPath) {
  for (const bin of ["convert", "magick"]) {
    const r = spawnSync(bin, [protoPath, appPath, "+append", outPath], { encoding: "utf8" });
    if (r.status === 0 && existsSync(outPath)) return true;
  }
  return false;
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (page, sel) => page.evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
const exists = (page, sel) => page.evalJs(`!!${q(sel)}`);
const text = (page, sel) => page.evalJs(`(${q(sel)}?.textContent || "").replace(/\\s+/g, " ").trim()`);
const isDisabled = (page, sel) => page.evalJs(`!!${q(sel)}?.disabled`);

function setValue(page, sel, value) {
  return page.evalJs(`(() => {
    const el = ${q(sel)};
    if (!el) return false;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return true;
  })()`);
}

async function viewport(page) {
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}

async function withApp({ seed, S, args = [], body }) {
  const apiPort = await pickFreePort();
  const api = startFakeBackend(apiPort, S);
  await api.listen();
  const userData = mkdtempSync(join(tmpdir(), "stellar-team-admin-"));
  seed(userData);
  const cdpPort = await pickFreePort();
  const app = await startApp({
    cdpPort,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    // Native scale 1: otherwise a 1px border snaps to 0.667px on a 1.5x display and
    // the readings would depend on the machine.
    extraArgs: ["--force-device-scale-factor=1", ...args],
    extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}` },
  });
  try {
    const page = await connectPage(cdpPort);
    await viewport(page);
    await body(page);
    page.close();
  } finally {
    await stopApp(app);
    await api.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

async function dismissFirstRun(page) {
  if (await exists(page, '[data-role="firstrun-local"]')) {
    await click(page, '[data-role="firstrun-local"]');
    await waitFor(page, `!!${q('[data-role="profile-trigger"]')}`);
  }
}

async function waitLoggedIn(page) {
  for (let i = 0; i < 80; i++) {
    if ((await page.evalJs(`(async () => (await window.cloud.status()).state)()`)) === "logged-in") return true;
    await delay(250);
  }
  return false;
}

async function openTeam(page) {
  await waitFor(page, `!!(${q('[data-role="profile-trigger"]')} || ${q('[data-role="firstrun-local"]')})`);
  await dismissFirstRun(page);
  await waitLoggedIn(page);
  await waitFor(page, `!!${q('[data-section="team"]')}`);
  await click(page, '[data-section="team"]');
}

async function reopenTeam(page) {
  // Leave the Team screen through another account-scope section.
  await click(page, '[data-section="workhome"]');
  await delay(250);
  await click(page, '[data-section="team"]');
}

/** Loads one prototype state in the SAME page, reads and screenshots it, returns the readings. */
async function protoState(page, origin, file, hash, items, shotName) {
  await page.send("Page.navigate", { url: `${origin}/${file}#${hash}` });
  await waitFor(page, `document.readyState === "complete"`);
  await page.evalJs(`document.fonts.ready.then(() => true)`);
  await page.evalJs(`(() => { if (location.hash !== "#${hash}") location.hash = "#${hash}"; window.dispatchEvent(new HashChangeEvent("hashchange")); return true; })()`);
  await delay(250);
  const readings = await readAll(page, items);
  await shot(page, `${shotName}-proto`);
  return readings;
}

// ---- the pairs: one expression per side -------------------------------------------

const P = {
  main: `document.querySelector("#main-team")`,
};

/** TeamAdmin overview (#team / #team-full): proto expression vs app expression. */
const TEAM_PAIRS = [
  { key: "nav-time", kind: "control", proto: `document.querySelectorAll("#view-shell aside nav a.nav")[1]`, app: `document.querySelector('[data-section="team"]')` },
  { key: "nav-sub-active", kind: "control", proto: `document.querySelector('a.sub[aria-current="page"]')`, app: `document.querySelector('[data-team-sub="overview"]')` },
  { key: "nav-sub-idle", kind: "control", proto: `document.querySelectorAll("#view-shell aside nav a.sub")[2]`, app: `document.querySelector('[data-team-sub="members"]')` },
  { key: "title", kind: "text", proto: `${P.main}.querySelector("h1")`, app: `document.querySelector('[data-part="team-title"]')` },
  { key: "pill", kind: "control", proto: `document.querySelector("#seats-pill")`, app: `document.querySelector('[data-part="seats-pill"]')` },
  { key: "slug", kind: "text", proto: `document.querySelector("#seats-pill").nextElementSibling`, app: `document.querySelector('[data-part="seats-pill"]').nextElementSibling` },
  { key: "slug-mono", kind: "text", proto: `document.querySelector("#seats-pill").nextElementSibling.querySelector("span")`, app: `document.querySelector('[data-part="seats-pill"]').nextElementSibling.querySelector("span")` },
  { key: "btn-settings", kind: "control", proto: `${P.main}.querySelector('a.ghost[href="#settings"]')`, app: `document.querySelector('[data-part="team-open-settings"]')` },
  { key: "btn-invite", kind: "control", proto: `document.querySelector("#btn-invite")`, app: `document.querySelector('[data-part="team-open-invite"]')` },
  { key: "stat-members-card", kind: "box", proto: `document.querySelector("#stat-members").parentElement`, app: `document.querySelector('[data-part="stat-members"]')` },
  { key: "stat-members-label", kind: "text", proto: `document.querySelector("#stat-members").previousElementSibling`, app: `document.querySelector('[data-part="stat-members"]').children[0]` },
  { key: "stat-members-value", kind: "text", proto: `document.querySelector("#stat-members")`, app: `document.querySelector('[data-part="stat-members"]').children[1]` },
  { key: "stat-members-hint", kind: "text", proto: `document.querySelector("#stat-pending")`, app: `document.querySelector('[data-part="stat-members"]').children[2]` },
  { key: "stat-seats-value", kind: "text", proto: `document.querySelector("#stat-seats")`, app: `document.querySelector('[data-part="stat-seats"]').children[1]` },
  { key: "stat-seats-hint", kind: "text", proto: `document.querySelector("#stat-seats").nextElementSibling`, app: `document.querySelector('[data-part="stat-seats"]').children[2]` },
  { key: "stat-open-card", kind: "box", proto: `document.querySelector("#stat-seats").parentElement.nextElementSibling`, app: `document.querySelector('[data-part="stat-open"]')` },
  { key: "members-card", kind: "box", proto: `${P.main}.querySelector("section")`, app: `document.querySelector('[data-part="members-card"]')` },
  { key: "members-head", kind: "box", proto: `${P.main}.querySelector("section > div")`, app: `document.querySelector('[data-part="members-card"] > div')` },
  { key: "members-h2", kind: "text", proto: `document.querySelector("#mb")`, app: `document.querySelector("#team-members")` },
  { key: "members-hint", kind: "text", proto: `${P.main}.querySelector("section > div .hint")`, app: `document.querySelector('[data-part="members-card"] > div > span')` },
  { key: "table", kind: "text", proto: `${P.main}.querySelector("table")`, app: `document.querySelector('[data-part="members-table"]')` },
  { key: "th", kind: "control", proto: `${P.main}.querySelector("th")`, app: `document.querySelector('[data-part="members-table"] th')` },
  { key: "td", kind: "control", proto: `${P.main}.querySelector("tbody td")`, app: `document.querySelector('[data-part="members-table"] tbody td')` },
  { key: "avatar", kind: "fixed", proto: `${P.main}.querySelector("tbody td > span > span")`, app: `document.querySelector('[data-part="members-table"] tbody td > span > span')` },
  { key: "person-name", kind: "text", proto: `${P.main}.querySelector("tbody td > span > span:nth-child(2) > span:nth-child(1)")`, app: `document.querySelector('[data-part="members-table"] tbody td > span > span:nth-child(2) > span:nth-child(1)')` },
  { key: "person-meta", kind: "text", proto: `${P.main}.querySelector("tbody td > span > span:nth-child(2) > span:nth-child(2)")`, app: `document.querySelector('[data-part="members-table"] tbody td > span > span:nth-child(2) > span:nth-child(2)')` },
  { key: "role-select", kind: "control", proto: `${P.main}.querySelector('select[aria-label="Papel de Rio"]')`, app: `document.querySelector('select[aria-label="Papel de Rio Alvarez"]')` },
  { key: "role-select-locked", kind: "control", proto: `${P.main}.querySelector('select[aria-label="Papel de Maya"]')`, app: `document.querySelector('select[aria-label="Papel de Maya Chen"]')` },
  { key: "btn-leave", kind: "control", proto: `${P.main}.querySelector("tbody tr:nth-child(1) td:last-child button")`, app: `document.querySelector('[data-part="members-table"] tbody tr:nth-child(1) td:last-child button')` },
  { key: "btn-remove", kind: "control", proto: `${P.main}.querySelector("tbody tr:nth-child(2) td:last-child button")`, app: `document.querySelector('[data-part="members-table"] tbody tr:nth-child(2) td:last-child button')` },
  { key: "pending-avatar", kind: "fixed", proto: `document.querySelector("#pending-row td > span > span")`, app: `document.querySelector('[data-part="pending-row"] td > span > span')` },
  { key: "pending-meta", kind: "text", proto: `document.querySelector("#pending-row td > span > span:nth-child(2) > span:nth-child(2)")`, app: `document.querySelector('[data-part="pending-row"] td > span > span:nth-child(2) > span:nth-child(2)')` },
  { key: "pending-role", kind: "text", proto: `document.querySelector("#pending-row td:nth-child(2)")`, app: `document.querySelector('[data-part="pending-row"] td:nth-child(2)')` },
  { key: "btn-revoke", kind: "control", proto: `document.querySelector("#pending-row td:last-child button")`, app: `document.querySelector('[data-part="pending-row"] td:last-child button')` },
  { key: "last-owner-hint", kind: "box", proto: `${P.main}.querySelector("section > .hint")`, app: `document.querySelector('[data-part="last-owner-hint"]')` },
];

const FULL_PAIRS = [
  { key: "pill", kind: "control", proto: `document.querySelector("#seats-pill")`, app: `document.querySelector('[data-part="seats-pill"]')` },
  { key: "banner", kind: "box", proto: `document.querySelector("#seats-full-banner")`, app: `document.querySelector('[data-part="seats-full-banner"]')` },
  { key: "banner-text", kind: "text", proto: `document.querySelector("#seats-full-banner")`, app: `document.querySelector('[data-part="seats-full-banner"]')` },
  { key: "stat-seats-value", kind: "text", proto: `document.querySelector("#stat-seats")`, app: `document.querySelector('[data-part="stat-seats"]').children[1]` },
  { key: "btn-invite", kind: "control", proto: `document.querySelector("#btn-invite")`, app: `document.querySelector('[data-part="team-open-invite"]')` },
];

const MODAL = `document.querySelector("#modal-invite .modal")`;
const AMODAL = `document.querySelector('[data-part="invite-modal"] > div')`;
const INVITE_PAIRS = [
  { key: "modal", kind: "card", proto: MODAL, app: AMODAL },
  { key: "title", kind: "text", proto: `document.querySelector("#inv-form-t")`, app: `document.querySelector('[data-part="invite-title"]')` },
  { key: "close", kind: "fixed", proto: `document.querySelector("#modal-invite .icon")`, app: `document.querySelector('[data-part="invite-close"]')` },
  { key: "hint", kind: "text", proto: `${MODAL}.querySelector(":scope > p")`, app: `${AMODAL}.querySelector(":scope > p")` },
  { key: "label", kind: "text", proto: `document.querySelector('label[for="inv-target"]')`, app: `document.querySelector('label[for="inv-target"]')` },
  { key: "input", kind: "control", proto: `document.querySelector("#inv-target")`, app: `document.querySelector("#inv-target")` },
  { key: "role-select", kind: "control", proto: `document.querySelector("#inv-role")`, app: `document.querySelector("#inv-role")` },
  { key: "btn-email", kind: "control", proto: `document.querySelector("#invite-actions .primary")`, app: `document.querySelector('[data-part="invite-send-email"]')` },
  { key: "btn-link", kind: "control", proto: `document.querySelector("#invite-actions .ghost")`, app: `document.querySelector('[data-part="invite-copy-link"]')` },
];

const COPIED_PAIRS = [
  { key: "modal", kind: "card", proto: MODAL, app: AMODAL },
  { key: "form-hint", kind: "text", proto: `${MODAL}.querySelector(":scope > p")`, app: `${AMODAL}.querySelector(":scope > p")` },
  { key: "input", kind: "control", proto: `document.querySelector("#inv-target")`, app: `document.querySelector("#inv-target")` },
  { key: "role-select", kind: "control", proto: `document.querySelector("#inv-role")`, app: `document.querySelector("#inv-role")` },
  { key: "linkbox", kind: "control", proto: `document.querySelector(".linkbox")`, app: `document.querySelector('[data-part="invite-url"]')` },
  { key: "btn-copy", kind: "control", proto: `document.querySelector("#invite-copied-block button")`, app: `document.querySelector('[data-part="invite-copy"]')` },
  { key: "hint", kind: "text", proto: `document.querySelector("#invite-copied-block > .hint")`, app: `document.querySelector('[data-part="invite-copied"] > p')` },
  { key: "link-warn", kind: "box", proto: `document.querySelector("#invite-copied-block .warn")`, app: `document.querySelector('[data-part="invite-link-warn"]')` },
  { key: "link-warn-text", kind: "text", proto: `document.querySelector("#invite-copied-block .warn")`, app: `document.querySelector('[data-part="invite-link-warn"]')` },
  { key: "btn-done", kind: "control", proto: `document.querySelector("#invite-copied-block a.ghost")`, app: `document.querySelector('[data-part="invite-done"]')` },
];

const INVITE_FULL_PAIRS = [
  { key: "modal", kind: "card", proto: MODAL, app: AMODAL },
  { key: "form-hint", kind: "text", proto: `${MODAL}.querySelector(":scope > p")`, app: `${AMODAL}.querySelector(":scope > p")` },
  { key: "input", kind: "control", proto: `document.querySelector("#inv-target")`, app: `document.querySelector("#inv-target")` },
  { key: "role-select", kind: "control", proto: `document.querySelector("#inv-role")`, app: `document.querySelector("#inv-role")` },
  { key: "invite-full", kind: "box", proto: `document.querySelector("#invite-full-block")`, app: `document.querySelector('[data-part="invite-full"]')` },
  { key: "invite-full-text", kind: "text", proto: `document.querySelector("#invite-full-block")`, app: `document.querySelector('[data-part="invite-full"]')` },
  { key: "btn-email", kind: "control", proto: `document.querySelector("#invite-full-actions .primary")`, app: `document.querySelector('[data-part="invite-send-email"]')` },
  { key: "btn-back", kind: "control", proto: `document.querySelector("#invite-full-actions a.ghost")`, app: `document.querySelector('[data-part="invite-back"]')` },
];

const SETTINGS_PAIRS = [
  { key: "back", kind: "text", proto: `document.querySelector("#main-settings a.hint")`, app: `document.querySelector('[data-part="settings-back"]')` },
  { key: "title", kind: "text", proto: `document.querySelector("#main-settings h1")`, app: `document.querySelector('[data-part="settings-title"]')` },
  { key: "subtitle", kind: "text", proto: `document.querySelector("#main-settings h1").nextElementSibling`, app: `document.querySelector('[data-part="settings-title"]').nextElementSibling` },
  { key: "settings-card", kind: "card", proto: `document.querySelector("#main-settings section:nth-of-type(1)")`, app: `document.querySelector('[data-part="settings-rename"]')` },
  { key: "name-h2", kind: "text", proto: `document.querySelector("#main-settings section:nth-of-type(1) h2")`, app: `document.querySelector("#set-name-t")` },
  { key: "name-label", kind: "text", proto: `document.querySelector('label[for="rename"]')`, app: `document.querySelector('label[for="set-rename"]')` },
  { key: "name-input", kind: "control", proto: `document.querySelector("#rename")`, app: `document.querySelector("#set-rename")` },
  { key: "slug-hint", kind: "text", proto: `document.querySelector("#main-settings section:nth-of-type(1) > .hint")`, app: `document.querySelector('[data-part="settings-rename"] > div:nth-child(3)')` },
  { key: "btn-save", kind: "control", proto: `document.querySelector("#main-settings section:nth-of-type(1) .primary")`, app: `document.querySelector('[data-part="rename-save"]')` },
  { key: "settings-danger", kind: "card", proto: `document.querySelector("#main-settings section:nth-of-type(2)")`, app: `document.querySelector('[data-part="settings-danger"]')` },
  { key: "danger-h2", kind: "text", proto: `document.querySelector("#main-settings section:nth-of-type(2) h2")`, app: `document.querySelector("#set-danger-t")` },
  { key: "danger-text", kind: "text", proto: `document.querySelector("#main-settings section:nth-of-type(2) > p")`, app: `document.querySelector('[data-part="settings-danger"] > p')` },
  { key: "danger-label", kind: "text", proto: `document.querySelector('label[for="del-slug"]')`, app: `document.querySelector('label[for="set-del-slug"]')` },
  { key: "danger-input", kind: "control", proto: `document.querySelector("#del-slug")`, app: `document.querySelector("#set-del-slug")` },
  { key: "btn-delete", kind: "control", proto: `document.querySelector("#btn-delete")`, app: `document.querySelector('[data-part="delete-team"]')` },
];

const CREATE_PAIRS = [
  { key: "card", kind: "card", proto: `document.querySelector("#view-create-beta main > div")`, app: `document.querySelector('[data-part="team-create"] > div')` },
  { key: "title", kind: "text", proto: `document.querySelector("#view-create-beta h1")`, app: `document.querySelector('[data-part="create-title"]')` },
  { key: "info", kind: "box", proto: `document.querySelector('[data-part="beta-notice"]')`, app: `document.querySelector('[data-part="beta-notice"]')` },
  { key: "info-text", kind: "text", proto: `document.querySelector('[data-part="beta-notice"]')`, app: `document.querySelector('[data-part="beta-notice"]')` },
  { key: "label", kind: "text", proto: `document.querySelector('label[for="new-team"]')`, app: `document.querySelector('label[for="team-new-name"]')` },
  { key: "input", kind: "control", proto: `document.querySelector("#new-team")`, app: `document.querySelector("#team-new-name")` },
  { key: "btn-create", kind: "fixed", proto: `document.querySelector("#view-create-beta .primary")`, app: `document.querySelector('[data-part="create-submit"]')` },
  { key: "foot", kind: "text", proto: `document.querySelector("#view-create-beta p.hint")`, app: `document.querySelector('[data-part="team-create"] > div > p')` },
];

/** Invite.dc.html: panel selector per state in the prototype; `[data-invite-dialog] section` in the app. */
const IP = (id) => `document.querySelector("#${id}")`;
const AP = `document.querySelector("[data-invite-dialog] section")`;
const INVITE_STATES = {
  signin: {
    proto: "signin",
    pairs: [
      { key: "panel", kind: "card", proto: IP("panel-signin"), app: AP },
      { key: "brand-name", kind: "text", proto: `${IP("panel-signin")}.querySelector(".brand span")`, app: `${AP}.querySelector(":scope > div > span")` },
      { key: "title", kind: "text", proto: IP("t-signin"), app: `document.querySelector("#invite-title")` },
      { key: "lead", kind: "text", proto: `${IP("panel-signin")}.querySelector("p.hint")`, app: `document.querySelector('[data-part="signin-lead"]')` },
      { key: "lead-strong", kind: "text", proto: `${IP("panel-signin")}.querySelector("p.hint strong")`, app: `document.querySelector('[data-part="signin-lead"] span:nth-child(1)')` },
      { key: "info", kind: "box", proto: `${IP("panel-signin")}.querySelector(".info")`, app: `document.querySelector('[data-part="signin-info"]')` },
      { key: "info-text", kind: "text", proto: `${IP("panel-signin")}.querySelector(".info")`, app: `document.querySelector('[data-part="signin-info"]')` },
      { key: "btn-github", kind: "control", proto: `${IP("panel-signin")}.querySelector("a.ghost")`, app: `document.querySelector('[data-part="signin-github"]')` },
      { key: "divider", kind: "text", proto: `${IP("panel-signin")}.querySelector(".divider")`, app: `${AP}.querySelector('[class*="divider"]')` },
      { key: "label", kind: "text", proto: `document.querySelector('label[for="email"]')`, app: `document.querySelector('label[for="invite-email"]')` },
      { key: "input", kind: "control", proto: `document.querySelector("#email")`, app: `document.querySelector("#invite-email")` },
      { key: "btn-submit", kind: "control", proto: `${IP("panel-signin")}.querySelector("a.primary")`, app: `document.querySelector('[data-part="signin-submit"]')` },
      { key: "foot", kind: "text", proto: `${IP("panel-signin")}.querySelector("p.hint:last-child")`, app: `${AP}.querySelector(":scope > p:last-child")` },
    ],
  },
  accept: {
    proto: "accept",
    pairs: [
      { key: "panel", kind: "card", proto: IP("panel-accept"), app: AP },
      { key: "team-avatar", kind: "fixed", proto: `${IP("panel-accept")}.querySelector(".brand > span:first-child")`, app: `${AP}.querySelector(":scope > div > span:first-child")` },
      { key: "brand-label", kind: "text", proto: `${IP("panel-accept")}.querySelector(".brand > span:last-child > span:first-child")`, app: `${AP}.querySelector(":scope > div > span:last-child > span:first-child")` },
      { key: "brand-name", kind: "text", proto: `${IP("panel-accept")}.querySelector(".brand > span:last-child > span:last-child")`, app: `${AP}.querySelector(":scope > div > span:last-child > span:last-child")` },
      { key: "title", kind: "text", proto: IP("t-accept"), app: `document.querySelector("#invite-title")` },
      { key: "lead", kind: "text", proto: `${IP("panel-accept")}.querySelector("p.hint")`, app: `document.querySelector('[data-part="accept-lead"]')` },
      { key: "identity", kind: "box", proto: `${IP("panel-accept")}.children[2]`, app: `document.querySelector('[data-part="accept-identity"]')` },
      { key: "identity-avatar", kind: "fixed", proto: `${IP("panel-accept")}.children[2].children[0]`, app: `document.querySelector('[data-part="accept-identity"]').children[0]` },
      { key: "identity-name", kind: "text", proto: `${IP("panel-accept")}.children[2].children[1].children[0]`, app: `document.querySelector('[data-part="accept-identity"]').children[1].children[0]` },
      { key: "identity-hint", kind: "text", proto: `${IP("panel-accept")}.children[2].children[1].children[1]`, app: `document.querySelector('[data-part="accept-identity"]').children[1].children[1]` },
      { key: "accept-ok", kind: "box", proto: `${IP("panel-accept")}.querySelector(".ok")`, app: `${AP}.querySelector('[class*="ok"]')` },
      { key: "accept-ok-text", kind: "text", proto: `${IP("panel-accept")}.querySelector(".ok")`, app: `${AP}.querySelector('[class*="ok"]')` },
      { key: "btn-accept", kind: "control", proto: `${IP("panel-accept")}.querySelector("a.primary")`, app: `document.querySelector('[data-part="accept-submit"]')` },
      { key: "btn-decline", kind: "control", proto: `${IP("panel-accept")}.querySelector("a.ghost")`, app: `document.querySelector('[data-part="accept-decline"]')` },
    ],
  },
  "wrong-id": {
    proto: "wrong-id",
    pairs: [
      { key: "panel", kind: "card", proto: IP("panel-wrong"), app: AP },
      { key: "title", kind: "text", proto: IP("t-wrong"), app: `document.querySelector("#invite-title")` },
      { key: "lead", kind: "text", proto: `${IP("panel-wrong")}.querySelector("p.hint")`, app: `${AP}.querySelector("p")` },
      { key: "wrong-id-err", kind: "box", proto: `${IP("panel-wrong")}.querySelector(".err")`, app: `document.querySelector('[data-part="wrong-identity"]')` },
      { key: "wrong-id-err-text", kind: "text", proto: `${IP("panel-wrong")}.querySelector(".err")`, app: `document.querySelector('[data-part="wrong-identity"]')` },
      { key: "btn-switch", kind: "control", proto: `${IP("panel-wrong")}.querySelector("a.primary")`, app: `document.querySelector('[data-part="wrong-switch"]')` },
      { key: "btn-close", kind: "control", proto: `${IP("panel-wrong")}.querySelector("a.ghost")`, app: `${AP}.querySelector("button:last-child")` },
    ],
  },
  joined: {
    proto: "joined",
    pairs: [
      { key: "panel", kind: "card", proto: IP("panel-joined"), app: AP },
      { key: "title", kind: "text", proto: IP("t-joined"), app: `document.querySelector("#invite-title")` },
      { key: "lead", kind: "text", proto: `${IP("panel-joined")}.querySelector("p.hint")`, app: `document.querySelector('[data-part="joined-lead"]')` },
      { key: "joined-ok", kind: "box", proto: `${IP("panel-joined")}.querySelector(".ok")`, app: `${AP}.querySelector('[class*="ok"]')` },
      { key: "joined-ok-text", kind: "text", proto: `${IP("panel-joined")}.querySelector(".ok")`, app: `${AP}.querySelector('[class*="ok"]')` },
      { key: "btn-open", kind: "control", proto: `${IP("panel-joined")}.querySelector("a.primary")`, app: `document.querySelector('[data-part="joined-open"]')` },
    ],
  },
};

const side = (pairs, which) => pairs.map((p) => ({ key: p.key, kind: p.kind, expr: p[which] }));

async function measureApp(page, state, pairs, protoReadings, shotName) {
  // A focused control paints its focus border; the prototype is read unfocused.
  await page.evalJs(`document.activeElement?.blur?.(); true`);
  await delay(120);
  const app = await readAll(page, side(pairs, "app"));
  await shot(page, `${shotName}-app`);
  compare(state, pairs, protoReadings, app);
  const p = join(OUT_DIR, `${shotName}-proto.png`);
  const a = join(OUT_DIR, `${shotName}-app.png`);
  sideBySide(p, a, join(OUT_DIR, `${shotName}-side.png`));
}

// ---- run --------------------------------------------------------------------------

const proto = await startProtoServer();
const protoReadings = {};

try {
  // ============ OWNER: overview, members, invite, settings ============
  const S = newState("owner");
  await withApp({
    seed: (dir) => seedCloud(dir, ACCOUNTS.owner.refresh),
    S,
    body: async (page) => {
      await waitFor(page, `!!(${q('[data-role="profile-trigger"]')} || ${q('[data-role="firstrun-local"]')})`);
      const appUrl = await page.evalJs(`location.href`);

      // -- prototype readings first (same page, navigated away and back) --
      protoReadings.team = await protoState(page, proto.origin, "TeamAdmin.dc.html", "team", side(TEAM_PAIRS, "proto"), "team");
      protoReadings["team-full"] = await protoState(page, proto.origin, "TeamAdmin.dc.html", "team-full", side(FULL_PAIRS, "proto"), "team-full");
      protoReadings.invite = await protoState(page, proto.origin, "TeamAdmin.dc.html", "invite", side(INVITE_PAIRS, "proto"), "invite");
      protoReadings["invite-copied"] = await protoState(page, proto.origin, "TeamAdmin.dc.html", "invite-copied", side(COPIED_PAIRS, "proto"), "invite-copied");
      protoReadings["invite-full"] = await protoState(page, proto.origin, "TeamAdmin.dc.html", "invite-full", side(INVITE_FULL_PAIRS, "proto"), "invite-full");
      protoReadings.settings = await protoState(page, proto.origin, "TeamAdmin.dc.html", "settings", side(SETTINGS_PAIRS, "proto"), "settings");
      protoReadings["create-beta"] = await protoState(page, proto.origin, "TeamAdmin.dc.html", "create-beta", side(CREATE_PAIRS, "proto"), "create-beta");
      for (const [name, def] of Object.entries(INVITE_STATES)) {
        protoReadings[`invite-${name}`] = await protoState(page, proto.origin, "Invite.dc.html", def.proto, side(def.pairs, "proto"), `invite-${name}`);
      }
      await page.send("Page.navigate", { url: appUrl });
      await waitFor(page, `document.readyState === "complete"`);

      // -- #team --
      await openTeam(page);
      check("team: page shows the seats pill", await waitFor(page, `!!${q('[data-part="seats-pill"]')} && !!${q('[data-part="members-table"] tbody td')}`), true);
      await waitFor(page, `!!${q('[data-part="pending-row"]')}`);
      await delay(300);
      check(
        "nav: the team sections are nested under Time in the sidebar, in the prototype's order",
        await page.evalJs(`JSON.stringify([...document.querySelectorAll("nav [data-team-sub]")].map((b) => b.dataset.teamSub))`),
        JSON.stringify(["overview", "board", "members", "home", "import", "integrations", "audit", "settings"]),
      );
      check("nav: the first section sits right after the Time item", await page.evalJs(`${q('[data-section="team"]')}?.nextElementSibling?.dataset.teamSub`), "overview");
      check("nav: no section column inside the page content", await exists(page, '[data-part="team-content"] nav'), false);
      check("team: pill says 3 de 5 assentos", await text(page, '[data-part="seats-pill"]'), "3 de 5 assentos");
      check("team: open tasks stat is the prototype's 11 with 2 without owner", `${await text(page, '[data-part="stat-open"] span:nth-child(2)')}|${await text(page, '[data-part="stat-open"] span:nth-child(3)')}`, "11|2 sem dono");
      check("team: per-person task counts are 4 / 6 / 5", await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-part="member-row"]')].map((r) => r.children[2].textContent))`), JSON.stringify(["4", "6", "5"]));
      check("team: seats stat 3 / 5", await text(page, '[data-part="stat-seats"] span:nth-child(2)'), "3 / 5");
      check("team: sole owner Sair is disabled with the reason", await isDisabled(page, '[data-part="members-table"] tbody tr:nth-child(1) td:last-child button'), true);
      check(
        "team: last-owner reason is the button title",
        await page.evalJs(`${q('[data-part="members-table"] tbody tr:nth-child(1) td:last-child button')}?.title`),
        "Você é o único owner. Promova outra pessoa a owner antes de sair.",
      );
      check("team: role select of the sole owner is locked", await isDisabled(page, 'select[aria-label="Papel de Maya Chen"]'), true);
      check("team: the last-owner hint is shown", await exists(page, '[data-part="last-owner-hint"]'), true);
      check("team: pending invite shows 5 days left", (await text(page, '[data-part="pending-row"]')).includes("expira em 5 dias"), true);
      check("team: no banner while seats are free", await exists(page, '[data-part="seats-full-banner"]'), false);
      await measureApp(page, "team", TEAM_PAIRS, protoReadings.team, "team");

      // -- the board is a nested section: same head as Visão geral, inside the shell --
      const headBox = `(() => { const r = ${q('[data-part="team-title"]')}.getBoundingClientRect(); return JSON.stringify([Math.round(r.left), Math.round(r.top)]); })()`;
      const overviewHead = await page.evalJs(headBox);
      await click(page, '[data-team-sub="board"]');
      check("board: opens inside the team page", await waitFor(page, `!!${q('[data-part="team-page"] [data-part="team-content"] [data-part="team-board"]')}`), true);
      await delay(400);
      check("board: keeps the team head (title, slug, invite)", `${await text(page, '[data-part="team-title"]')}|${await exists(page, '[data-part="team-open-invite"]')}`, "Nebula Labs|true");
      check("board: the head sits where Visão geral puts it", await page.evalJs(headBox), overviewHead);
      check("board: a single h1 (the team name)", await page.evalJs(`JSON.stringify([...document.querySelectorAll("h1")].map((h) => h.textContent))`), JSON.stringify(["Nebula Labs"]));
      check("board: the sidebar entry is the active one", await page.evalJs(`${q('[data-team-sub="board"]')}?.getAttribute("aria-current")`), "page");
      check("board: no back-to-team button (the sidebar is the way back)", await exists(page, '[data-part="board-back"]'), false);
      check(
        "board: flows inside the content area, not a fixed overlay",
        await page.evalJs(`(() => { const b = ${q('[data-part="team-board"]')}; const p = b.closest('[data-part="team-page"]'); const m = p.parentElement.getBoundingClientRect(); const r = b.getBoundingClientRect(); return JSON.stringify([getComputedStyle(p).position !== "fixed", r.left >= m.left, r.right <= m.right + 1, r.bottom <= window.innerHeight + 1]); })()`),
        JSON.stringify([true, true, true, true]),
      );
      check(
        "board: the four columns fit without horizontal scroll at 1440",
        await page.evalJs(`(() => { const c = ${q('[data-part="team-board"] [data-column]')}.parentElement; return JSON.stringify([c.scrollWidth <= c.clientWidth, document.querySelectorAll('[data-part="team-board"] [data-column]').length]); })()`),
        JSON.stringify([true, 4]),
      );
      await shot(page, "board-nested");
      await click(page, '[data-team-sub="overview"]');
      check("board: leaving it brings the overview back", await waitFor(page, `!${q('[data-part="team-board"]')} && !!${q('[data-part="members-table"]')}`), true);

      // -- #invite and #invite-copied --
      await click(page, '[data-part="team-open-invite"]');
      await waitFor(page, `!!${q('[data-part="invite-modal"]')}`);
      await setValue(page, "#inv-target", "kai@example.com");
      await delay(200);
      check("invite: both actions locked until a target exists, then open", await isDisabled(page, '[data-part="invite-send-email"]'), false);
      await measureApp(page, "invite", INVITE_PAIRS, protoReadings.invite, "invite");

      await click(page, '[data-part="invite-copy-link"]');
      check("invite: the link is shown once", await waitFor(page, `!!${q('[data-part="invite-url"]')}`), true);
      check("invite: the URL is the server's invite_url", await text(page, '[data-part="invite-url"]'), INVITE_URL);
      const linkPost = S.log.filter((r) => r.method === "POST" && r.path === `/v1/teams/${TEAM_ID}/invites`).at(-1);
      check("invite: the request asked for delivery link, role member, the typed target", JSON.stringify(linkPost?.body), JSON.stringify({ target: "kai@example.com", role: "member", delivery: "link" }));
      check("invite: nominal 7-day notice", (await text(page, '[data-part="invite-link-warn"]')).includes("Vale 7 dias"), true);
      await measureApp(page, "invite-copied", COPIED_PAIRS, protoReadings["invite-copied"], "invite-copied");
      await click(page, '[data-part="invite-copy"]');
      await delay(400);
      const copyLabel = await text(page, '[data-part="invite-copy"]');
      check("invite: Copiar turns into Copiado (or says it could not copy)", copyLabel === "Copiado" || (await exists(page, '[data-part="invite-copied"] [class*="errorBox"]')), true);
      await click(page, '[data-part="invite-done"]');
      await click(page, '[data-part="team-open-invite"]');
      await waitFor(page, `!!${q('[data-part="invite-modal"]')}`);
      check("invite: the URL does not come back after closing", await exists(page, '[data-part="invite-url"]'), false);

      // -- email 503: message + Copiar link stays available --
      S.email503 = true;
      await setValue(page, "#inv-target", "kai@example.com");
      await click(page, '[data-part="invite-send-email"]');
      check("invite: email 503 shows the server message", await waitFor(page, `!!${q('[data-part="invite-error"]')}`), true);
      check("invite: 503 message is the server's", (await text(page, '[data-part="invite-error"]')).includes("o serviço de e-mail está indisponível agora"), true);
      check("invite: 503 offers Copiar link", (await text(page, '[data-part="invite-error"]')).includes("Copiar link") && !(await isDisabled(page, '[data-part="invite-copy-link"]')), true);
      S.email503 = false;
      // email OK: closes and notes
      await click(page, '[data-part="invite-send-email"]');
      check("invite: email sent closes the modal", await waitFor(page, `!${q('[data-part="invite-modal"]')}`), true);
      const emailPost = S.log.filter((r) => r.method === "POST" && r.path === `/v1/teams/${TEAM_ID}/invites`).at(-1);
      check("invite: email request carried delivery email", emailPost?.body?.delivery, "email");

      // -- #team-full and #invite-full --
      S.invites = S.invites.slice(0, 1);
      S.seats = { used: 5, total: 5, expires_at: null };
      await reopenTeam(page);
      check("full: pill turns to 5 de 5", await waitFor(page, `${q('[data-part="seats-pill"]')}?.textContent === "5 de 5 assentos"`), true);
      check("full: banner is shown", await exists(page, '[data-part="seats-full-banner"]'), true);
      await waitFor(page, `!!${q('[data-part="pending-row"]')}`);
      await measureApp(page, "team-full", FULL_PAIRS, protoReadings["team-full"], "team-full");
      await click(page, '[data-part="team-open-invite"]');
      check("full: the invite opens blocked", await waitFor(page, `!!${q('[data-part="invite-full"]')}`), true);
      check("full: no invite request was made", S.log.filter((r) => r.method === "POST" && r.path.endsWith("/invites")).length, 3);
      check("full: both actions are disabled", `${await isDisabled(page, '[data-part="invite-send-email"]')}|${await isDisabled(page, '[data-part="invite-copy-link"]')}`, "true|true");
      await measureApp(page, "invite-full", INVITE_FULL_PAIRS, protoReadings["invite-full"], "invite-full");
      await click(page, '[data-part="invite-back"]');

      // -- members: role, remove, leave --
      S.seats = { used: 3, total: 5, expires_at: null };
      await page.evalJs(`window.confirm = () => true`);
      await reopenTeam(page);
      await waitFor(page, `!!${q('select[aria-label="Papel de Rio Alvarez"]')}`);
      await page.evalJs(`window.confirm = () => true`);
      await setValue(page, 'select[aria-label="Papel de Sam Okonkwo"]', "admin");
      await delay(900);
      const rolePatch = S.log.find((r) => r.method === "PATCH" && r.path === `/v1/teams/${TEAM_ID}/members/${SAM}/role`);
      check("members: role change reached the server with the new role", rolePatch?.body?.role, "admin");
      check("members: role reloaded from the server", await page.evalJs(`${q('select[aria-label="Papel de Sam Okonkwo"]')}?.value`), "admin");
      await click(page, `[data-member="${SAM}"] [data-part="member-remove"]`);
      await delay(800);
      check("members: remove reached the server", S.log.some((r) => r.method === "DELETE" && r.path === `/v1/teams/${TEAM_ID}/members/${SAM}`), true);
      check("members: the removed member left the table", await exists(page, `[data-member="${SAM}"]`), false);

      // -- sidebar sections drive the content --
      await click(page, '[data-team-sub="members"]');
      check("nav: Membros (sidebar) shows the members without the stats", `${await exists(page, '[data-part="members-card"]')}|${await exists(page, '[data-part="team-stats"]')}`, "true|false");
      await click(page, '[data-team-sub="audit"]');
      check("nav: Auditoria (sidebar) shows the role matrix, not the members", `${await exists(page, '[data-part="members-card"]')}|${(await text(page, '[data-part="team-content"]')).includes("O que cada papel pode")}`, "false|true");
      await click(page, '[data-team-sub="overview"]');

      // -- settings --
      await click(page, '[data-part="team-open-settings"]');
      check("nav: the sidebar marks Configurações as the open section", await page.evalJs(`${q('[data-team-sub="settings"]')}?.getAttribute("aria-current")`), "page");
      check("settings: page opens", await waitFor(page, `!!${q('[data-part="team-settings"]')}`), true);
      await delay(250);
      check("settings: delete is locked before the slug", await isDisabled(page, '[data-part="delete-team"]'), true);
      await setValue(page, "#set-del-slug", "nebula-labs");
      check("settings: delete unlocks on the exact slug", await waitFor(page, `${q('[data-part="delete-team"]')}?.disabled === false`), true);
      await setValue(page, "#set-del-slug", "");
      await measureApp(page, "settings", SETTINGS_PAIRS, protoReadings.settings, "settings");
      await setValue(page, "#set-rename", "Nebula");
      await click(page, '[data-part="rename-save"]');
      await delay(700);
      const renamePatch = S.log.find((r) => r.method === "PATCH" && r.path === `/v1/teams/${TEAM_ID}` && r.body?.name);
      check("settings: rename sent only the name", JSON.stringify(renamePatch?.body), JSON.stringify({ name: "Nebula" }));
      check("settings: the title follows the rename and the slug stays", `${await text(page, '[data-part="team-title"]')}|${S.team.slug}`, "Nebula|nebula-labs");
      await setValue(page, "#set-del-slug", "nebula-labs");
      await delay(200);
      await click(page, '[data-part="delete-team"]');
      await delay(900);
      const del = S.log.find((r) => r.method === "DELETE" && r.path === `/v1/teams/${TEAM_ID}`);
      check("settings: delete sent the slug as confirm", JSON.stringify(del?.body), JSON.stringify({ confirm: "nebula-labs" }));
      check("settings: after deleting it goes back to the team list (create screen, last team)", await waitFor(page, `!!${q('[data-part="team-create"]')}`), true);
      check("settings: the deletion is stated", (await page.evalJs(`document.body.innerText`)).includes("Time Nebula apagado."), true);
    },
  });

  // ============ CREATE: beta notice, no upsell ============
  const SB = newState("create-beta");
  await withApp({
    seed: (dir) => seedCloud(dir, ACCOUNTS.owner.refresh),
    S: SB,
    body: async (page) => {
      await openTeam(page);
      check("create-beta: the beta notice is shown", await waitFor(page, `!!${q('[data-part="beta-notice"]')}`), true);
      check("create-beta: no upsell notice, no plans link", await page.evalJs(`!/Faça upgrade|Fazer upgrade/i.test(document.body.innerText) && !document.querySelector('[data-part="team-create"] a[href]')`), true);
      check("create-beta: name and create are locked", `${await isDisabled(page, '[data-part="create-name"]')}|${await isDisabled(page, '[data-part="create-submit"]')}`, "true|true");
      await delay(250);
      await measureApp(page, "create-beta", CREATE_PAIRS, protoReadings["create-beta"], "create-beta");
    },
  });

  // ============ CREATE: the create error is visible ============
  const SE = newState("create-error");
  await withApp({
    seed: (dir) => seedCloud(dir, ACCOUNTS.owner.refresh),
    S: SE,
    body: async (page) => {
      await openTeam(page);
      check("create-error: the form is open when the plan right is granted", await waitFor(page, `!!${q('[data-part="create-name"]')} && ${q('[data-part="create-name"]')}.disabled === false`), true);
      await setValue(page, '[data-part="create-name"]', "Nebula Labs");
      await click(page, '[data-part="create-submit"]');
      check("create-error: the server's refusal is shown", await waitFor(page, `!!${q('[data-part="create-error"]')}`), true);
      check("create-error: it is the server message", await text(page, '[data-part="create-error"]'), "o plano desta conta não inclui times");
    },
  });

  // ============ GUEST: signed out → preview, sign-in starts ============
  const SG = newState("guest");
  await withApp({
    seed: seedLocal,
    S: SG,
    args: [`stellar://invite?token=${TOKEN}`],
    body: async (page) => {
      check("guest: the invite dialog opens from the link (no first-run in the way)", await waitFor(page, `!!${q("[data-invite-dialog]")}`, 25000), true);
      check("guest: signed out shows the sign-in step", await waitFor(page, `${q("[data-invite-dialog]")}?.dataset.step === "signin"`), true);
      check("guest: the public preview was fetched without a token", SG.log.some((r) => r.method === "GET" && r.path === `/v1/invites/${TOKEN}/preview`), true);
      check("guest: names who invited and the team", await text(page, '[data-part="signin-lead"]'), "Maya Chen convidou você para o time Nebula Labs.");
      check("guest: shows the masked target only", (await text(page, '[data-part="signin-info"]')).includes("k***@example.com"), true);
      await delay(300);
      await measureApp(page, "invite-signin", INVITE_STATES.signin.pairs, protoReadings["invite-signin"], "invite-signin");
      await setValue(page, "#invite-email", "kai@example.com");
      await click(page, '[data-part="signin-submit"]');
      check("guest: email sign-in starts and the dialog waits for it", await waitFor(page, `!!${q('[data-part="signin-waiting"]')}`), true);
    },
  });

  // ============ GUEST signed in as the invited identity: accept → joined ============
  const SK = newState("guest");
  await withApp({
    seed: (dir) => seedCloud(dir, ACCOUNTS.guest.refresh),
    S: SK,
    args: [`stellar://invite?token=${TOKEN}`],
    body: async (page) => {
      check("accept: the accept step opens for the invited identity", await waitFor(page, `${q("[data-invite-dialog]")}?.dataset.step === "accept"`, 30000), true);
      check("accept: shows the identity", (await text(page, '[data-part="accept-identity"]')).includes("kai@example.com"), true);
      await delay(300);
      await measureApp(page, "invite-accept", INVITE_STATES.accept.pairs, protoReadings["invite-accept"], "invite-accept");
      await click(page, '[data-part="accept-submit"]');
      check("joined: the joined screen shows", await waitFor(page, `${q("[data-invite-dialog]")}?.dataset.step === "joined"`), true);
      check("joined: accept used the token", SK.log.some((r) => r.method === "POST" && r.path === `/v1/invites/${TOKEN}/accept`), true);
      check("joined: role and seats line", await text(page, '[data-part="joined-lead"]'), "Papel: membro. Assentos agora: 4 de 5.");
      await delay(300);
      await measureApp(page, "invite-joined", INVITE_STATES.joined.pairs, protoReadings["invite-joined"], "invite-joined");
      await click(page, '[data-part="joined-open"]');
      check("joined: opening the team lands on the team board", await waitFor(page, `!!${q('[data-part="team-board"]')}`, 20000), true);
    },
  });

  // ============ STRANGER signed in as another identity: wrong-id ============
  const SS = newState("guest");
  await withApp({
    seed: (dir) => seedCloud(dir, ACCOUNTS.stranger.refresh),
    S: SS,
    args: [`stellar://invite?token=${TOKEN}`],
    body: async (page) => {
      check("wrong-id: the wrong-identity step opens before any accept", await waitFor(page, `${q("[data-invite-dialog]")}?.dataset.step === "wrong-id"`, 30000), true);
      check("wrong-id: names both identities", (await text(page, '[data-part="wrong-identity"]')).includes("Você está como jordan@example.com. O convite é para k***@example.com"), true);
      check("wrong-id: no accept was attempted", SS.log.some((r) => r.path.endsWith("/accept")), false);
      await delay(300);
      await measureApp(page, "invite-wrong-id", INVITE_STATES["wrong-id"].pairs, protoReadings["invite-wrong-id"], "invite-wrong-id");
      await click(page, '[data-part="wrong-switch"]');
      check("wrong-id: Trocar de conta signs out and goes back to sign-in", await waitFor(page, `${q("[data-invite-dialog]")}?.dataset.step === "signin"`, 15000), true);
    },
  });
} finally {
  await new Promise((r) => proto.server.close(r));
}

// ---- parity report -----------------------------------------------------------------

const diffs = parityRows.filter((r) => !r.same);
const unknown = diffs.filter((r) => r.known === null);
const known = diffs.filter((r) => r.known !== null);
writeFileSync(join(OUT_DIR, "parity.json"), JSON.stringify({ measured: parityRows.length, equal: parityRows.length - diffs.length, known, unknown }, null, 2));
console.log(`\nparity: ${parityRows.length} property pairs measured, ${parityRows.length - diffs.length} equal, ${known.length} owner-approved deltas, ${unknown.length} unapproved`);
for (const r of known) console.log(`DELTA (${r.known.kind}) ${r.state}/${r.pair}.${r.prop}: proto=${r.proto} app=${r.app}`);
for (const r of unknown) console.log(`DIFF ${r.state}/${r.pair}.${r.prop}: proto=${r.proto} app=${r.app}`);
check("parity: no difference except the owner-approved 36px secondary button", unknown.length, 0);

finish();
