// Home (sessions) of the shell: the Settings button, the profile selector and
// the account footer, on an isolated profile. Prints under /tmp/account-fix/.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/account-fix";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evalJs(expr)) return true;
    await delay(150);
  }
  return false;
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
}

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

/** A fake account API: tokens, /me with an e-mail and a GitHub identity, one account profile.
 *  `knobs.profilesDown` makes /v1/profiles answer 503; `down()`/`up()` take the whole API off the air. */
function startFakeApi(port) {
  const knobs = { profilesDown: false, hits: 0 };
  const sockets = new Set();
  let server = null;
  const handler = (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      knobs.hits++;
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const accountProfiles = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", account_id: ACCOUNT_ID, kind: "personal", team_id: null, name: "Conta pessoal" }];
      if (path === "/v1/auth/token") return send(200, { access_token: "a:1", refresh_token: "r:1", expires_in: 900, refresh_expires_in: 2592000 });
      if (path === "/v1/auth/logout") return res.writeHead(204).end();
      if (path === "/v1/me") {
        return send(200, {
          account: { id: ACCOUNT_ID, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [
            { kind: "github", subject: "1", login: "ana" },
            { kind: "email", subject: "ana@example.com", login: null },
          ],
          profiles: accountProfiles,
          teams: [],
          plan: { account_plan: "pro", account_expires_at: null, rights: {
            sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
            team: { granted: false, state: "none", plan: null, source: null, team_id: null, expires_at: null } } },
        });
      }
      if (path === "/v1/profiles") {
        if (knobs.profilesDown) return send(503, { error: { code: "unavailable", message: "profiles unavailable" } });
        return send(200, { profiles: accountProfiles });
      }
      if (path.endsWith("/house")) return send(200, { revision: 0, manifest: [] });
      if (path === "/v1/devices") return send(200, { devices: [] });
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
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: PROFILE_ID,
      profiles: [{ id: PROFILE_ID, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }],
    }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  if (loggedIn) {
    writeFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "r:1", encrypted: false }, linked: true }));
  }
}

async function withApp({ loggedIn, apiBase, body }) {
  const userData = mkdtempSync(join(tmpdir(), "stellar-account-home-"));
  seed(userData, { loggedIn });
  const cdpPort = await pickFreePort();
  const app = await startApp({
    cdpPort,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: apiBase },
  });
  try {
    const page = await connectPage(cdpPort);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await body(page);
    page.close();
  } finally {
    await stopApp(app);
    rmSync(userData, { recursive: true, force: true });
  }
}

const apiPort = await pickFreePort();
const api = startFakeApi(apiPort);
await api.up();
const apiBase = `http://127.0.0.1:${apiPort}`;

try {
  // ---- Local profile ----
  await withApp({
    loggedIn: false,
    apiBase,
    body: async (page) => {
      check("local: home shell is up", await waitFor(page, `!!document.querySelector('[data-section="sessions"]')`), true);
      await page.evalJs(`[...document.querySelectorAll('aside button')].find((b) => /configura|settings/i.test(b.textContent || ''))?.click()`);
      check("local: settings button opens the settings modal", await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 4000), true);
      await shot(page, "home-local-settings");
    },
  });

  // ---- Logged-in: one scope drives the selector, the footer and the content ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      const view = () =>
        page.evalJs(`(() => ({
          nav: [...document.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section')),
          footer: document.querySelector('[data-role="account"]')?.textContent ?? null,
          footerScope: document.querySelector('[data-role="account"]')?.getAttribute('data-scope') ?? null,
          triggerName: document.querySelector('[data-role="profile-name"]')?.textContent ?? null,
          triggerScope: document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') ?? null,
          triggerSub: document.querySelector('[data-role="profile-sub"]')?.textContent ?? null,
          page: document.querySelector('main')?.innerText.slice(0, 200) ?? '',
          newSession: [...document.querySelectorAll('main button')].some((b) => /nova sessão|new session/i.test(b.textContent || '')),
          inboxPage: !!document.querySelector('[data-page="inbox"]'),
        }))()`);
      const openMenu = async () => {
        await page.evalJs(`document.querySelector('[data-role="profile-trigger"]').click()`);
        await delay(250);
      };

      check("account: footer shows the account", await waitFor(page, `!!document.querySelector('[data-role="account"]')`), true);
      check("account: lands on the account work home", await waitFor(page, `document.querySelector('[data-section="workhome"]')?.getAttribute('aria-current') === 'page'`), true);
      let v = await view();
      check("account scope: nav is inbox/workhome/team/stats (no local sessions)", v.nav.join(","), "inbox,workhome,team,stats");
      check("account scope: footer and selector agree", v.footerScope === "account" && v.triggerScope === "account", true);
      check("account scope: footer reads 'conta conectada'", /conta conectada/i.test(v.footer ?? ""), true);
      check("account scope: selector shows the account name", v.triggerName, "Ana Ribeiro");
      await openMenu();
      const who = await page.evalJs(`(() => {
        const f = document.querySelector('[data-role="account"]');
        const r = document.querySelector('[data-role="profile-row-account"]');
        return {
          footer: [f?.getAttribute('data-account-name'), f?.getAttribute('data-account-identity')],
          row: [r?.getAttribute('data-account-name'), r?.getAttribute('data-account-identity')],
          footerText: f?.textContent ?? '',
          rowText: r?.textContent ?? '',
          triggerSub: document.querySelector('[data-role="profile-sub"]')?.textContent ?? '',
        };
      })()`);
      check("identity: footer shows the signed-in name and e-mail", who.footer.join("|"), "Ana Ribeiro|ana@example.com");
      check("identity: selector shows the very same name and e-mail", who.row.join("|"), who.footer.join("|"));
      check("identity: e-mail visible in the footer, the row and the trigger", who.footerText.includes("ana@example.com") && who.rowText.includes("ana@example.com") && who.triggerSub.includes("ana@example.com"), true);
      const rows = await page.evalJs(`(() => ({
        local: document.querySelectorAll('[data-role="profile-row"]').length,
        account: document.querySelectorAll('[data-role="profile-row-account"]').length,
        accountChecked: document.querySelector('[data-role="profile-row-account"]')?.getAttribute('aria-checked'),
        localChecked: document.querySelector('[data-role="profile-row"]')?.getAttribute('aria-checked'),
      }))()`);
      check("menu: one local row and one account row", rows.local === 1 && rows.account === 1, true);
      check("menu: the account row is the checked one in account scope", rows.accountChecked === "true" && rows.localChecked === "false", true);
      await shot(page, "scope-account-menu");

      // account → local
      await page.evalJs(`document.querySelector('[data-role="profile-row"]').click()`);
      check("switch to local: Home sessions appear", await waitFor(page, `!!document.querySelector('[data-section="sessions"]')`), true);
      v = await view();
      check("local scope: nav is sessions/stats only", v.nav.join(","), "sessions,stats");
      check("local scope: footer and selector agree", v.footerScope === "local" && v.triggerScope === "local", true);
      check("local scope: footer reads 'só nesta máquina'", /só nesta máquina/i.test(v.footer ?? ""), true);
      check("local scope: selector shows the local profile", v.triggerName, "Pessoal");
      check("local scope: Home has no account content", v.inboxPage === false && !/time|team/i.test(v.nav.join(",")), true);
      await shot(page, "scope-local-home");
      await openMenu();
      const rows2 = await page.evalJs(`({
        accountChecked: document.querySelector('[data-role="profile-row-account"]')?.getAttribute('aria-checked'),
        localChecked: document.querySelector('[data-role="profile-row"]')?.getAttribute('aria-checked'),
      })`);
      check("menu: the local row is the checked one in local scope", rows2.localChecked === "true" && rows2.accountChecked === "false", true);

      // local → account
      await page.evalJs(`document.querySelector('[data-role="profile-row-account"]').click()`);
      check("switch back to account: work home is the landing", await waitFor(page, `document.querySelector('[data-section="workhome"]')?.getAttribute('aria-current') === 'page'`), true);
      v = await view();
      check("account scope again: nav and footer follow", v.nav.join(",") === "inbox,workhome,team,stats" && v.footerScope === "account", true);

      // The footer click while local brings the account page, scope included.
      await page.evalJs(`document.querySelector('[data-role="profile-trigger"]').click()`);
      await delay(200);
      await page.evalJs(`document.querySelector('[data-role="profile-row"]').click()`);
      await waitFor(page, `!!document.querySelector('[data-section="sessions"]')`);
      await page.evalJs(`document.querySelector('[data-role="account"]').click()`);
      await delay(400);
      v = await view();
      check("footer click from local: scope becomes account", v.footerScope === "account" && v.triggerScope === "account", true);
    },
  });

  // ---- API down at start: a saved session shows "no connection", then recovers by itself ----
  {
    const downPort = await pickFreePort();
    const lateApi = startFakeApi(downPort);
    await withApp({
      loggedIn: true,
      apiBase: `http://127.0.0.1:${downPort}`,
      body: async (page) => {
        check("offline start: shell is up", await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`), true);
        check("offline start: 'no connection' card instead of the sign-in card", await waitFor(page, `!!document.querySelector('[data-role="account-offline"]')`, 20000), true);
        const st = await page.evalJs(`(() => ({
          signIn: !!document.querySelector('[data-role="sign-in"]'),
          text: document.querySelector('[data-role="account-offline"]')?.textContent ?? '',
        }))()`);
        check("offline start: not shown as a plain sign-in prompt", st.signIn, false);
        check("offline start: says it retries on its own", /sem conexão/i.test(st.text) && /de novo sozinho/i.test(st.text), true);
        await shot(page, "offline-session");
        await lateApi.up(); // the API comes back
        check("offline start: signs back in by itself when the API returns", await waitFor(page, `!!document.querySelector('[data-role="account"]')`, 45000), true);
        await shot(page, "offline-session-recovered");
      },
    });
    await lateApi.down();
  }

  // ---- Profile load fails: message + retry in the menu, scope switch still works ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      api.knobs.profilesDown = true;
      check("profiles down: account footer is up", await waitFor(page, `!!document.querySelector('[data-role="account"]')`), true);
      // The profile is read when the menu mounts; remount it through a scope round trip is not needed:
      // the failure state is read on load, so reload the window with the API still failing.
      await page.evalJs(`location.reload()`);
      check("profiles down: shell back after reload", await waitFor(page, `!!document.querySelector('[data-role="account"]')`, 20000), true);
      await page.evalJs(`document.querySelector('[data-role="profile-trigger"]').click()`);
      check("profiles down: menu says it could not load the account profile", await waitFor(page, `!!document.querySelector('[data-role="account-link-error"]')`), true);
      await shot(page, "profile-load-failed");
      // Switching scope does not depend on that call.
      await page.evalJs(`document.querySelector('[data-role="profile-row"]').click()`);
      check("profiles down: local<->account switch still works", await waitFor(page, `!!document.querySelector('[data-section="sessions"]')`), true);
      await page.evalJs(`document.querySelector('[data-role="profile-trigger"]').click()`);
      await delay(250);
      api.knobs.profilesDown = false;
      await page.evalJs(`document.querySelector('[data-role="account-link-retry"]').click()`);
      check("profiles retry: error clears once the API answers", await waitFor(page, `!document.querySelector('[data-role="account-link-error"]')`), true);
    },
  });

  // ---- Work home: the API drops while using it ----
  await withApp({
    loggedIn: true,
    apiBase,
    body: async (page) => {
      check("work home: opens as the account landing", await waitFor(page, `document.querySelector('[data-section="workhome"]')?.getAttribute('aria-current') === 'page'`), true);
      await waitFor(page, `[...document.querySelectorAll('main button')].some((b) => /sincronizar agora/i.test(b.textContent || '') && !b.disabled)`);
      await api.down(); // connection lost
      await page.evalJs(`[...document.querySelectorAll('main button')].find((b) => /sincronizar agora/i.test(b.textContent || ''))?.click()`);
      check("work home: a lost connection shows a message and 'try again' (not an empty screen)", await waitFor(page, `!!document.querySelector('[data-role="workhome-error"] [data-role="workhome-retry"]')`, 20000), true);
      const msg = await page.evalJs(`document.querySelector('[data-role="workhome-error"]')?.textContent ?? ''`);
      check("work home: the message says there is no connection", /sem conexão/i.test(msg), true);
      check("work home: the page is not blank (tools list still there)", await page.evalJs(`document.querySelectorAll('main input[type="checkbox"]').length > 0`), true);
      await shot(page, "workhome-offline");
      await api.up();
      await page.evalJs(`document.querySelector('[data-role="workhome-retry"]').click()`);
      check("work home: retry runs again and the connection message goes away", await waitFor(page, `!/sem conexão/i.test(document.querySelector('[data-role="workhome-error"]')?.textContent ?? '')`, 20000), true);
    },
  });

} finally {
  await api.down();
}
finish();
