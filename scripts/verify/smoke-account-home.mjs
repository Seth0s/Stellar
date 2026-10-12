// The ONE account/profile control of the Home: sign-in from it, the account's
// profiles (Pro, a team), sessions that belong to each, the import, the offline
// state with retry, and the error state of the profile list. Isolated userData,
// fake API. Prints under /tmp/conta-perfil/.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootIntoFreshSession, connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/conta-perfil";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TEAM_PROFILE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

/** A fake account API: tokens, /me with a personal and a team profile. */
function startFakeApi(port) {
  // `meBudget`: how many /v1/me reads answer before it starts failing (the profile list is its second read).
  const knobs = { meBudget: Infinity };
  const sockets = new Set();
  let server = null;
  const handler = (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token") return send(200, { access_token: "a:1", refresh_token: "r:1", expires_in: 900, refresh_expires_in: 2592000 });
      if (path === "/v1/auth/logout") return res.writeHead(204).end();
      if (path === "/v1/me") {
        if (knobs.meBudget <= 0) return send(503, { error: { code: "unavailable", message: "me unavailable" } });
        knobs.meBudget--;
        return send(200, {
          account: { id: ACCOUNT_ID, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: "ana@example.com", login: null }],
          profiles: [
            { id: PRO_ID, account_id: ACCOUNT_ID, kind: "personal", team_id: null, name: "Pro" },
            { id: TEAM_PROFILE_ID, account_id: ACCOUNT_ID, kind: "team", team_id: TEAM_ID, name: "Time Exemplo" },
          ],
          teams: [{ id: TEAM_ID, name: "Time Exemplo", slug: "exemplo", created_by: ACCOUNT_ID, created_at: "2026-10-05T00:00:00Z" }],
          plan: { account_plan: "pro", account_expires_at: null, rights: {
            sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
            team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM_ID, expires_at: null } } },
        });
      }
      if (path === `/v1/teams/${TEAM_ID}`) return send(200, { team: { id: TEAM_ID, name: "Time Exemplo", slug: "exemplo", created_by: ACCOUNT_ID, created_at: "2026-10-05T00:00:00Z" }, members: [] });
      if (path.startsWith(`/v1/teams/${TEAM_ID}/`)) return send(200, { tasks: [], total: 0, limit: 50, offset: 0, sprints: [], invites: [] });
      if (path === "/v1/profiles") return send(200, { profiles: [] });
      if (path === "/v1/devices") return send(200, { devices: [] });
      if (path.endsWith("/house")) return send(200, { revision: 0, manifest: [] });
      send(404, { error: { code: "not_found", message: path } });
    });
  };
  return {
    knobs,
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

function seed(dir, { loggedIn }) {
  mkdirSync(join(dir, "profiles", PROFILE_ID), { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }));
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  if (loggedIn) writeFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "r:1", encrypted: false }, linked: true }));
}

async function withApp({ loggedIn, apiBase, body, userData: reuse = null, keep = false }) {
  const userData = reuse ?? mkdtempSync(join(tmpdir(), "stellar-account-home-"));
  if (!reuse) seed(userData, { loggedIn });
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
    if (!keep) rmSync(userData, { recursive: true, force: true });
  }
}

const view = (page) =>
  page.evalJs(`(() => ({
    nav: [...document.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section')).join(','),
    name: document.querySelector('[data-role="profile-name"]')?.textContent ?? null,
    scope: document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') ?? null,
    sub: document.querySelector('[data-role="profile-sub"]')?.textContent ?? '',
    pill: document.querySelector('[data-role="context-pill"]')?.textContent ?? null,
    cards: document.querySelectorAll('.home-session-card').length,
    empty: !!document.querySelector('.home-empty'),
    importBtn: !!document.querySelector('[data-role="account-import-open"]'),
    footerCards: document.querySelectorAll('aside [data-role="account"], aside [class*="signInCard"]').length,
    asideText: document.querySelector('aside')?.innerText ?? '',
  }))()`);

const openMenu = async (page) => {
  await page.evalJs(`document.querySelector('[data-role="profile-trigger"]').click()`);
  await delay(300);
};

const apiPort = await pickFreePort();
const api = startFakeApi(apiPort);
await api.up();
const apiBase = `http://127.0.0.1:${apiPort}`;

try {
  // ---- Without an account: the control offers sign-in; nothing at the bottom ----
  await withApp({
    loggedIn: false,
    apiBase,
    body: async (page) => {
      check("no account: shell is up", await waitFor(page, `!!document.querySelector('[data-section="sessions"]')`), true);
      let v = await view(page);
      check("no account: the control names the local profile", v.name, "Pessoal");
      check("no account: sidebar is Sessões and Estatísticas", v.nav, "sessions,stats");
      check("no account: no account or sign-in card at the bottom of the sidebar", v.footerCards, 0);
      check("no account: Configurações stays at the bottom", /Configurações/.test(v.asideText), true);
      await openMenu(page);
      check("no account: the menu offers 'Entrar no Stellar'", await page.evalJs(`!!document.querySelector('[data-role="sign-in"]')`), true);
      check("no account: no sign-out row", await page.evalJs(`!document.querySelector('[data-role="sign-out"]')`), true);
      await shot(page, "app-sem-conta-menu");
      await page.evalJs(`document.querySelector('[data-role="sign-in"]').click()`);
      check("the control opens the existing login screen", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
      check("the login screen is the existing one (GitHub + e-mail)", await page.evalJs(`document.body.innerText.includes('GitHub') && !!document.getElementById('lg-email')`), true);
      await shot(page, "app-login-aberto-pelo-controle");
    },
  });

  // ---- Signed in: Pro and a team, sessions that belong to each ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("account: lands on the account's Sessões", await waitFor(page, `document.querySelector('[data-section="sessions"]')?.getAttribute('aria-current') === 'page' && document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      let v = await view(page);
      check("account (Pro): Sessões is there, Time is not", v.nav, "sessions,inbox,workhome,stats");
      check("account (Pro): the control names the profile and the e-mail", v.name === "Pro" && v.sub.includes("ana@example.com"), true);
      check("account (Pro): sessions start empty, apart from the local ones", v.empty && v.cards === 0, true);
      check("account (Pro): no account card at the bottom of the sidebar", v.footerCards, 0);
      check("account (Pro): no import offered while nothing is local", v.importBtn, false);
      await shot(page, "app-conta-pro-vazia");

      // A local session, created from the local Home.
      await bootIntoFreshSession(page, "Local 1", { spawnTerminal: false });
      await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
      check("local session: back on the Home", await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`), true);
      v = await view(page);
      check("local session: the Home is the local list with it", v.scope === "local" && v.cards === 1, true);

      // Account Pro: still empty; now an import is offered.
      await openMenu(page);
      const rows = await page.evalJs(`[...document.querySelectorAll('[data-role="profile-row-account"]')].map((e) => e.querySelector('span:nth-child(2) span')?.textContent)`);
      check("menu: the account's profiles are Pro and the team", rows.join("|"), "Pro|Time Exemplo");
      await shot(page, "app-menu-conta");
      await page.evalJs(`document.querySelector('[data-role="profile-row-account"]').click()`);
      check("pick Pro: account scope", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      v = await view(page);
      check("account (Pro): the local session did NOT leak in", v.empty && v.cards === 0, true);
      check("account (Pro): import is offered now", v.importBtn, true);
      await page.evalJs(`document.querySelector('[data-role="account-import-open"]').click()`);
      check("import: the dialog lists the local session", await waitFor(page, `!!document.querySelector('[data-role="account-import"] input[type="checkbox"]')`), true);
      await shot(page, "app-importar-sessoes");
      await page.evalJs(`document.querySelector('[data-role="account-import-confirm"]').click()`);
      check("import: the session now belongs to Pro", await waitFor(page, `document.querySelectorAll('.home-session-card').length === 1`), true);
      v = await view(page);
      check("import: the context pill names the profile", /Pro/.test(v.pill ?? ""), true);

      // ... and left the local list.
      await openMenu(page);
      await page.evalJs(`document.querySelector('[data-role="profile-row"]').click()`);
      check("local: back to the local list", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'local'`), true);
      v = await view(page);
      check("local: the imported session left the local list", v.empty && v.cards === 0, true);

      // The team profile: its own sessions, and the Time section appears.
      await openMenu(page);
      await page.evalJs(`document.querySelectorAll('[data-role="profile-row-account"]')[1].click()`);
      check("pick the team profile", await waitFor(page, `document.querySelector('[data-role="profile-name"]')?.textContent === 'Time Exemplo'`), true);
      v = await view(page);
      check("team profile: Time shows in the sidebar", v.nav, "sessions,inbox,workhome,team,stats");
      check("team profile: its sessions are its own (Pro's is not here)", v.empty && v.cards === 0, true);
      check("team profile: the pill is the team's name", v.pill, "Time Exemplo");
      await shot(page, "app-conta-time");

      // A session created while the team profile is in view belongs to it.
      await bootIntoFreshSession(page, "Do time", { spawnTerminal: false, keepScope: true });
      await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
      check("team session: back on the Home", await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`), true);
      check("team session: listed under the team profile", await waitFor(page, `document.querySelectorAll('.home-session-card').length === 1`), true);
      await openMenu(page);
      await page.evalJs(`document.querySelectorAll('[data-role="profile-row-account"]')[0].click()`);
      await waitFor(page, `document.querySelector('[data-role="profile-name"]')?.textContent === 'Pro'`);
      v = await view(page);
      check("back to Pro: Pro keeps only its imported session, the team's is not there", v.cards, 1);
      check("Pro: Time hidden again", v.nav, "sessions,inbox,workhome,stats");
    },
  });

  // ---- The profile list fails (API trouble on the second /me read) ----
  api.knobs.meBudget = 1;
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("profiles error: the control is up in the account scope", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      await openMenu(page);
      check("profiles error: the menu says it could not load, with 'Tentar de novo'", await waitFor(page, `!!document.querySelector('[data-role="account-profiles-error"] [data-role="account-profiles-retry"]')`), true);
      await shot(page, "app-perfis-erro");
      api.knobs.meBudget = Infinity;
      await page.evalJs(`document.querySelector('[data-role="account-profiles-retry"]').click()`);
      check("profiles error: retry loads the profiles", await waitFor(page, `document.querySelectorAll('[data-role="profile-row-account"]').length === 2`), true);
    },
  });
  api.knobs.meBudget = Infinity;

  // ---- A saved session and no connection: the ACCOUNT stays on screen, marked stale ----
  {
    const downPort = await pickFreePort();
    const lateApi = startFakeApi(downPort);
    await lateApi.up();
    const userData = mkdtempSync(join(tmpdir(), "stellar-account-offline-"));
    seed(userData, { loggedIn: true });
    // First start, online: the machine learns the account (name, e-mail, profiles) and when.
    await withApp({
      loggedIn: true,
      apiBase: `http://127.0.0.1:${downPort}`,
      userData,
      keep: true,
      body: async (page) => {
        check("offline setup: signed in online first", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account' && document.querySelectorAll('[data-role="profile-row-account"]').length >= 0`), true);
        check("offline setup: the profile list was read and saved on the machine", await waitFor(page, `!!localStorage.getItem('ac.acctProfilesCache.${PROFILE_ID}')`), true);
        await delay(9000); // let the renderer storage reach the disk before the app closes
      },
    });
    await lateApi.down(); // the API goes away for the next start
    await withApp({
      loggedIn: true,
      apiBase: `http://127.0.0.1:${downPort}`,
      userData,
      keep: true,
      body: async (page) => {
        check("offline: shell is up", await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`), true);
        check("offline: the control shows the warning", await waitFor(page, `!!document.querySelector('[data-role="profile-offline-dot"]')`, 20000), true);
        let v = await view(page);
        check("offline: the control shows the ACCOUNT (not the local profile)", v.scope === "account" && v.name !== "Pessoal", true);
        check("offline: the account's e-mail is still shown", await page.evalJs(`document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-account-identity') === 'ana@example.com'`), true);
        check("offline: the control says there is no connection and since when", /sem conexão · dados de \d{2}\/\d{2}/i.test(v.sub), true);
        check("offline: account sessions are still reachable (the sessions are local data)", v.nav.startsWith("sessions"), true);
        check("offline: Home marks the data as stale with the time", await page.evalJs(`/Sem conexão com a conta — dados de \\d{2}\\/\\d{2}/.test(document.querySelector('[data-role="stale-notice"]')?.textContent ?? '')`), true);
        await openMenu(page);
        check("offline: the menu still lists the account's profiles (saved list)", await page.evalJs(`document.querySelectorAll('[data-role="profile-row-account"]').length === 2`), true);
        check("offline: the menu explains it, shows when, and offers 'Tentar de novo'", await page.evalJs(`!!document.querySelector('[data-role="account-offline"] [data-role="account-retry"]') && !!document.querySelector('[data-role="account-stale-stamp"]')`), true);
        check("offline: no sign-in prompt (the account is still known)", await page.evalJs(`!document.querySelector('[data-role="sign-in"]')`), true);
        await shot(page, "app-offline-conta");
        // Switching profile still works offline: to the team profile, then local.
        await page.evalJs(`document.querySelectorAll('[data-role="profile-row-account"]')[1].click()`);
        check("offline: switching to the team profile works", await waitFor(page, `document.querySelector('[data-role="profile-name"]')?.textContent === 'Time Exemplo'`), true);
        await page.evalJs(`document.querySelector('[data-section="workhome"]')?.click()`);
        check("offline: an account section that needs the API says so, with the time", await waitFor(page, `!!document.querySelector('[data-role="account-offline-section"]')`), true);
        await shot(page, "app-offline-secao");
        await openMenu(page);
        await page.evalJs(`document.querySelector('[data-role="profile-row"]').click()`);
        check("offline: switching to the local profile works", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'local'`), true);
        await lateApi.up(); // the API comes back; the user does not wait for the timer
        await openMenu(page);
        await page.evalJs(`document.querySelector('[data-role="account-retry"]')?.click()`);
        check("offline: 'Tentar de novo' brings the live account back", await waitFor(page, `!document.querySelector('[data-role="profile-offline-dot"]')`, 20000), true);
        check("offline: the stale mark is gone", await page.evalJs(`!document.querySelector('[data-role="stale-notice"]')`), true);
      },
    });
    await lateApi.down();
    rmSync(userData, { recursive: true, force: true });
  }

  // ---- The owner of an account session lives in the database ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("owners: the app is in the account scope", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      const mk = (id, name) => `{ id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, project: "", cwd: "/tmp/${id}", created_at: 1, updated_at: 1, last_accessed_at: null, autonomous: false, concurrency_cap: null, orchestrator_card_id: null }`;
      await page.evalJs(`(async () => { await window.store.boards.upsert(${mk("m1", "Migrada")}); await window.store.boards.upsert(${mk("m2", "Fica local")}); })()`);
      // The old renderer-side partition (as an earlier version left it), then a restart of the page.
      await page.evalJs(`localStorage.setItem('ac.acctSessions.${PROFILE_ID}', JSON.stringify({ m1: '${PRO_ID}' }))`);
      await page.evalJs(`location.reload()`);
      check("owners: the old partition is moved into the database", await waitFor(page, `window.store.boards.list().then((rows) => rows.find((r) => r.id === 'm1')?.account_profile_id === '${PRO_ID}')`, 20000), true);
      check("owners: a session that was local stays local (NULL)", await page.evalJs(`window.store.boards.list().then((rows) => rows.find((r) => r.id === 'm2')?.account_profile_id === null)`), true);
      check("owners: the old key is cleared", await page.evalJs(`localStorage.getItem('ac.acctSessions.${PROFILE_ID}') === null`), true);
      await waitFor(page, `document.querySelectorAll('.home-session-card').length >= 1`);
      check("owners: Pro lists the migrated session only", await page.evalJs(`[...document.querySelectorAll('.home-session-card')].map((e) => e.textContent).join('|').includes('Migrada') && !document.body.innerText.includes('Fica local')`), true);
      // Clearing everything the renderer kept changes nothing: the owner is in the database.
      await page.evalJs(`localStorage.clear()`);
      await page.evalJs(`location.reload()`);
      await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`);
      check("owners: after wiping the renderer storage Pro still has its session", await waitFor(page, `document.body.innerText.includes('Migrada') && !document.body.innerText.includes('Fica local')`, 15000), true);
      await shot(page, "app-dono-no-banco");
    },
  });

  // ---- Time: under the team profile the team's board is always reachable ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("team board: the app is in the account scope", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      await openMenu(page);
      await page.evalJs(`document.querySelectorAll('[data-role="profile-row-account"]')[1].click()`);
      await waitFor(page, `!!document.querySelector('[data-section="team"]')`);
      await page.evalJs(`document.querySelector('[data-section="team"]').click()`);
      check("team board: the Board section is offered whatever the role", await waitFor(page, `!!document.querySelector('[data-team-sub="board"]')`), true);
      await shot(page, "app-time-board");
    },
  });

  // ---- "Gerenciar perfis e contas" reaches the account page ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("manage: account scope up", await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`), true);
      await openMenu(page);
      await page.evalJs(`document.querySelector('[data-role="manage-accounts"]').click()`);
      check("manage: the account page opens (the local profile's link to a server profile and the machines)", await waitFor(page, `!!document.querySelector('[data-role="account-page-identity"]')`), true);
      check("manage: it names the account and the e-mail", await page.evalJs(`/Ana Ribeiro · ana@example.com/.test(document.querySelector('[data-role="account-page-identity"]')?.textContent ?? '')`), true);
      check("manage: the link panel is there", await waitFor(page, `[...document.querySelectorAll('main *')].some((e) => /Perfil da conta|conta Stellar|account profile/i.test(e.textContent ?? ''))`), true);
      await delay(500);
      await shot(page, "app-pagina-da-conta");
    },
  });
} finally {
  await api.down();
}
finish();
