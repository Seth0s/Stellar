// Account mode — local hides cloud surfaces; signed-in shows them; logout
// hides again. Also exercises signup_closed on the login screen.
// Isolated userData + CDP only. Prints under /tmp/account-mode/.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootIntoFreshSession,
  connectPage,
  makeChecker,
  pickFreePort,
  startApp,
  stopApp,
} from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = "/tmp/account-mode";
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function startFakeBackend(port) {
  const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z" };
  const members = [
    {
      team_id: TEAM_ID,
      account_id: OWNER_ACC,
      role: "owner",
      joined_at: "2026-10-05T00:00:00Z",
      display_name: "Ana Ribeiro",
      avatar_initials: "AR",
      email: "ana@example.com",
    },
  ];
  const plan = {
    account_plan: "team",
    account_expires_at: null,
    rights: {
      sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
      team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM_ID, expires_at: null },
    },
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token" && req.method === "POST") {
        return send(200, {
          access_token: "a:owner",
          refresh_token: "owner-refresh",
          expires_in: 900,
          refresh_expires_in: 2592000,
        });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();
      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: OWNER_ACC, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "github", subject: "1", login: "ana" }],
          profiles: [{ id: OWNER_P, account_id: OWNER_ACC, kind: "personal", team_id: null, name: "Pessoal" }],
          teams: [team],
          plan,
        });
      }
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") return send(200, { team, members });
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") {
        return send(200, { tasks: [], total: 0, limit: 50, offset: 0 });
      }
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") return send(200, { sprints: [] });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "GET") return send(200, { invites: [] });
      if (path.startsWith("/v1/profiles/") && path.endsWith("/house") && req.method === "GET") {
        return send(200, { revision: 0, manifest: [] });
      }
      if (path === "/v1/devices" && req.method === "GET") return send(200, { devices: [] });
      return send(404, { error: { code: "not_found", message: path } });
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
  writeFileSync(
    join(dir, "local-identity.json"),
    JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }),
  );
  writeFileSync(
    join(dir, "profiles", OWNER_P, "cloud-auth.json"),
    JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }),
  );
}

function seedLocal(dir) {
  mkdirSync(join(dir, "profiles", OWNER_P), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: OWNER_P,
      profiles: [{ id: OWNER_P, name: "Local", kind: "personal", createdAt: 1, homeMode: "isolated" }],
    }),
  );
  writeFileSync(
    join(dir, "local-identity.json"),
    JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }),
  );
}

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* mounting */
    }
    await delay(150);
  }
  return false;
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const abs = join(OUT_DIR, `${name}.png`);
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

function sideBySide(leftPath, rightPath, outPath) {
  const tryConvert = spawnSync("convert", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  if (tryConvert.status === 0 && existsSync(outPath)) return true;
  const tryMagick = spawnSync("magick", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  return tryMagick.status === 0 && existsSync(outPath);
}

async function cloudNavState(page) {
  return JSON.parse(
    await page.evalJs(`(() => {
      const ids = ["inbox", "workhome", "team"];
      const out = {};
      for (const id of ids) out[id] = !!document.querySelector('[data-section="' + id + '"]');
      return JSON.stringify(out);
    })()`),
  );
}

async function dismissFirstRunIfNeeded(page) {
  const local = await page.evalJs(`!!document.querySelector('[data-role="firstrun-local"]')`);
  if (local) {
    await page.evalJs(`document.querySelector('[data-role="firstrun-local"]').click()`);
    await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);
  }
}

async function openSettings(page) {
  await page.evalJs(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent || '').includes('Configura') || (b.textContent || '').includes('Settings')
      );
      if (btn) btn.click();
      else document.querySelector('[data-role="profile-trigger"]')?.click();
    })()
  `);
  // Prefer shell settings, else App board settings door via eval hook if shell.
  const opened = await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 4000);
  if (opened) return true;
  // From home shell: click the settings nav item.
  await page.evalJs(`
    (() => {
      const items = [...document.querySelectorAll('button')];
      const s = items.find((b) => /Configura|Settings/i.test(b.textContent || ''));
      s?.click();
    })()
  `);
  return waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 6000);
}

async function closeSettings(page) {
  await page.evalJs(`document.querySelector('[data-settings-close]')?.click()`);
  await delay(200);
}

async function openBoardAndOverlays(page, label) {
  await bootIntoFreshSession(page, label, { spawnTerminal: false });
  await delay(500);
  await shot(page, `${label}-board`);

  // Rail is always on the board.
  await shot(page, `${label}-rail`);

  // Radial via the smoke hook App installs.
  await page.evalJs(`window.__stellarOpenRadial?.(720, 400)`);
  await delay(300);
  await shot(page, `${label}-radial`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(150);

  // Ctrl+K palette
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await waitFor(page, `!!document.querySelector('[data-part="board-cmd-palette"]')`, 5000);
  await shot(page, `${label}-ctrlk`);
  const cmdIds = JSON.parse(
    await page.evalJs(`(() => {
      const rows = [...document.querySelectorAll('[data-part^="board-cmd-"]')].filter((r) => r.getAttribute('data-part') !== 'board-cmd-palette' && r.getAttribute('data-part') !== 'board-cmd-input' && r.getAttribute('data-part') !== 'board-cmd-kbd' && r.getAttribute('data-part') !== 'board-cmd-overlay');
      if (rows.length) return JSON.stringify(rows.map((r) => (r.getAttribute('data-part') || '').replace(/^board-cmd-/, '')));
      const text = document.querySelector('[data-part="board-cmd-palette"]')?.innerText || '';
      return JSON.stringify({ text: text.slice(0, 500) });
    })()`),
  );
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(150);

  // Settings from topbar / rail
  await page.evalJs(`document.querySelector('.topbar-settings, [data-role="open-settings"]')?.click()`);
  let settingsUp = await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 3000);
  if (!settingsUp) {
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((el) => /Configura|Settings/i.test(el.getAttribute('title') || el.textContent || ''));
        b?.click();
      })()
    `);
    settingsUp = await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 5000);
  }
  if (settingsUp) {
    // Cloud status may land a tick after the modal mounts — wait briefly for Team.
    for (let i = 0; i < 20; i++) {
      if (await page.evalJs(`!!document.querySelector('[data-settings-page="team"]')`)) break;
      await delay(100);
    }
    await shot(page, `${label}-settings`);
    const teamNav = await page.evalJs(`!!document.querySelector('[data-settings-page="team"]')`);
    const mobileCloud = await page.evalJs(`!!document.querySelector('[data-settings-devices-mobile-cloud]')`);
    await closeSettings(page);
    return { cmdIds, teamNav, mobileCloud, settingsUp: true };
  }
  return { cmdIds, teamNav: null, mobileCloud: null, settingsUp: false };
}

function ctrlKHasTeam(cmdIds) {
  if (Array.isArray(cmdIds)) return cmdIds.includes("new-team") || cmdIds.includes("import");
  const text = String(cmdIds?.text || "");
  return /nova task.*time|new team|importar|import/i.test(text) && /time|team/i.test(text);
}

async function withApp({ seed, apiBase, body }) {
  const userData = mkdtempSync(join(tmpdir(), "stellar-account-mode-"));
  seed(userData);
  const cdpPort = await pickFreePort();
  const extraEnv = { STELLARCLOUD_AUTH_BROWSER: "log" };
  if (apiBase) extraEnv.STELLARCLOUD_API_URL = apiBase;
  const app = await startApp({
    cdpPort,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv,
  });
  try {
    const page = await connectPage(cdpPort);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await body(page, app);
    page.close();
  } finally {
    await stopApp(app);
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const apiPort = await pickFreePort();
const api = startFakeBackend(apiPort);
await api.listen();
const apiBase = `http://127.0.0.1:${apiPort}`;

try {
  // ---- LOCAL ----
  await withApp({
    seed: seedLocal,
    apiBase,
    body: async (page) => {
      await waitFor(page, `!!(document.querySelector('[data-section="sessions"]') || document.querySelector('[data-role="firstrun-local"]'))`);
      await dismissFirstRunIfNeeded(page);
      await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);

      const nav = await cloudNavState(page);
      check("local: no inbox nav", nav.inbox, false);
      check("local: no workhome nav", nav.workhome, false);
      check("local: no team nav", nav.team, false);
      await shot(page, "local-shell");

      // Settings from shell
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('button')].find((el) => /Configura|Settings/i.test(el.textContent || ''));
          b?.click();
        })()
      `);
      // Shell settings opens App settings via onOpenSettings — may need board.
      // Capture shell-level sign-in card instead if modal not present.
      const shellSettings = await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 2500);
      if (shellSettings) {
        await shot(page, "local-settings-shell");
        const teamNav = await page.evalJs(
          `!![...document.querySelectorAll('[data-settings-modal] button')].find((b) => /\\bTime\\b|\\bTeam\\b/i.test(b.textContent || ''))`,
        );
        check("local: settings has no Team page", teamNav, false);
        await closeSettings(page);
      }

      const overlay = await openBoardAndOverlays(page, "local");
      check("local: Ctrl+K has no team/import commands", ctrlKHasTeam(overlay.cmdIds), false);
      if (overlay.settingsUp) {
        check("local: settings board nav has no Team", overlay.teamNav, false);
      }

      // Go home for shell screenshot already taken
      await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
      await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);
    },
  });

  // ---- LOGGED IN ----
  await withApp({
    seed: seedCloud,
    apiBase,
    body: async (page) => {
      await waitFor(page, `!!(document.querySelector('[data-section="sessions"]') || document.querySelector('[data-role="firstrun-local"]'))`);
      await dismissFirstRunIfNeeded(page);
      for (let i = 0; i < 80; i++) {
        const state = await page.evalJs(`(async () => (await window.cloud.status()).state)()`);
        if (state === "logged-in") break;
        await delay(250);
      }
      check(
        "logged-in: cloud status is logged-in",
        await page.evalJs(`(async () => (await window.cloud.status()).state)()`),
        "logged-in",
      );
      await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);

      const nav = await cloudNavState(page);
      check("logged-in: inbox nav visible", nav.inbox, true);
      check("logged-in: workhome nav visible", nav.workhome, true);
      check("logged-in: team nav visible", nav.team, true);
      await shot(page, "logged-shell");

      const overlay = await openBoardAndOverlays(page, "logged");
      check("logged-in: Ctrl+K lists team commands", ctrlKHasTeam(overlay.cmdIds), true);
      if (overlay.settingsUp) {
        check("logged-in: settings can show Team", overlay.teamNav, true);
      }

      await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
      await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);

      // Logout → cloud nav disappears without restart
      await page.evalJs(`(async () => { await window.cloud.logout(); return true; })()`);
      for (let i = 0; i < 40; i++) {
        const state = await page.evalJs(`(async () => (await window.cloud.status()).state)()`);
        if (state !== "logged-in") break;
        await delay(200);
      }
      await delay(400);
      const after = await cloudNavState(page);
      check("after logout: no inbox nav", after.inbox, false);
      check("after logout: no workhome nav", after.workhome, false);
      check("after logout: no team nav", after.team, false);
      await shot(page, "logged-out-shell");
    },
  });

  // ---- signup_closed on login ----
  await withApp({
    seed: seedLocal,
    apiBase,
    body: async (page, app) => {
      await waitFor(page, `!!(document.querySelector('[data-section="sessions"]') || document.querySelector('[data-role="firstrun-local"]') || document.querySelector('[data-role="sign-in"]'))`);
      await dismissFirstRunIfNeeded(page);
      await waitFor(page, `!!document.querySelector('[data-role="sign-in"]')`);
      await page.evalJs(`document.querySelector('[data-role="sign-in"]').click()`);
      await waitFor(page, `!!document.querySelector('[data-login-choose]')`);

      const signupSoon = await page.evalJs(`!!document.querySelector('[data-role="signup-soon"][disabled]')`);
      check("login: criar conta is disabled coming-soon", signupSoon, true);

      await page.evalJs(`
        (() => {
          const btn = [...document.querySelectorAll('button')].find((b) => /GitHub/i.test(b.textContent || ''));
          btn?.click();
        })()
      `);
      await delay(800);

      let authUrl = null;
      for (let i = 0; i < 40 && !authUrl; i++) {
        const m = app.stderr().match(/STELLARCLOUD_AUTH_URL=(\S+)/);
        if (m) authUrl = m[1];
        else await delay(100);
      }
      check("login: auth URL logged for browser seam", !!authUrl, true);
      if (authUrl) {
        const u = new URL(authUrl);
        const redirect = u.searchParams.get("redirect_uri");
        const state = u.searchParams.get("state");
        check("login: redirect_uri present", !!redirect, true);
        if (redirect && state) {
          const cb = new URL(redirect);
          cb.searchParams.set("error", "signup_closed");
          cb.searchParams.set("state", state);
          const fetchRes = await fetch(cb.toString()).then((r) => r.status).catch((e) => String(e));
          check("login: callback HTTP for signup_closed", typeof fetchRes === "number" && fetchRes >= 200, true);
          // Wait until cloud status carries the machine code, then for the UI copy.
          for (let i = 0; i < 40; i++) {
            const err = await page.evalJs(
              `(async () => { const s = await window.cloud.status(); return s.state === 'logged-out' ? (s.lastError || '') : ''; })()`,
            );
            if (err === "signup_closed") break;
            await delay(150);
          }
          const lastError = await page.evalJs(
            `(async () => { const s = await window.cloud.status(); return s.lastError || ''; })()`,
          );
          check("login: lastError is signup_closed", lastError, "signup_closed");
          const shown = await waitFor(
            page,
            `!!document.querySelector('[data-role="login-error"]')`,
            8000,
          );
          check("login: signup_closed message shown", shown, true);
          await shot(page, "signup-closed");
        }
      }
    },
  });

  // Side-by-side composites
  for (const pair of [
    ["local-shell", "logged-shell", "compare-shell"],
    ["local-board", "logged-board", "compare-board"],
    ["local-rail", "logged-rail", "compare-rail"],
    ["local-radial", "logged-radial", "compare-radial"],
    ["local-ctrlk", "logged-ctrlk", "compare-ctrlk"],
    ["local-settings", "logged-settings", "compare-settings"],
  ]) {
    const left = join(OUT_DIR, `${pair[0]}.png`);
    const right = join(OUT_DIR, `${pair[1]}.png`);
    const out = join(OUT_DIR, `${pair[2]}.png`);
    if (existsSync(left) && existsSync(right)) {
      const ok = sideBySide(left, right, out);
      check(`side-by-side ${pair[2]}`, ok, true);
    }
  }
} finally {
  await api.close();
}

finish();
