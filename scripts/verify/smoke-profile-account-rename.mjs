// Settings › Perfis — renaming the profiles of the ACCOUNT, in an isolated instance with
// SYNTHETIC profiles and a fake backend that speaks PATCH /v1/profiles/{id}:
//   1. the personal profile is renamed (the request leaves the main process with the bearer;
//      the page never holds the token), the new name shows and the list is re-read;
//   2. a name the account already uses (409) stays in edit with the account's own text;
//   3. a team profile is renamable by owner/admin only: as a plain member its button is
//      disabled and says why; the server's 403 for a stale permission is shown as such;
//   4. with no connection every account button is disabled and says so.
// It NEVER touches the owner's instance. Screenshots: /tmp/perfil-conta-renomear/.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const OUT = "/tmp/perfil-conta-renomear";
mkdirSync(OUT, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const P_PERSONAL = "11111111-1111-4111-8111-111111111111";
const P_TEAM = "22222222-2222-4222-8222-222222222222";
const ACC = "33333333-3333-4333-8333-333333333333";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SRV_PERSONAL = "44444444-4444-4444-8444-444444444444";
const SRV_TEAM = "55555555-5555-4555-8555-555555555555";

function startFakeBackend(port) {
  const team = { id: TEAM, name: "Idy Platform", slug: "idy", created_by: ACC, created_at: "2026-10-05T00:00:00Z" };
  const profiles = [
    { id: SRV_PERSONAL, account_id: ACC, kind: "personal", team_id: null, name: "Pessoal" },
    { id: SRV_TEAM, account_id: ACC, kind: "team", team_id: TEAM, name: "Idy Platform" },
  ];
  const state = { role: "owner", forbidNext: false };
  const patches = [];
  const sockets = new Set();
  const plan = {
    account_plan: "pro",
    account_expires_at: null,
    rights: {
      sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
      team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM, expires_at: null },
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
      const err = (status, code, message) => send(status, { error: { code, message } });
      if (path === "/v1/auth/token" && req.method === "POST") {
        return send(200, { access_token: "a:owner", refresh_token: "owner-refresh", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();
      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: ACC, display_name: "Ana Exemplo", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: "ana@example.com", login: "ana@example.com" }],
          profiles,
          teams: [team],
          plan,
        });
      }
      if (path === `/v1/teams/${TEAM}` && req.method === "GET") {
        return send(200, { team, members: [{ team_id: TEAM, account_id: ACC, role: state.role, joined_at: null, display_name: "Ana Exemplo", avatar_initials: "AE", email: "ana@example.com" }] });
      }
      if (path.startsWith("/v1/profiles") && req.method === "GET") return send(200, { profiles });
      if (path === "/v1/devices" && req.method === "GET") return send(200, { devices: [] });
      const patch = path.match(/^\/v1\/profiles\/([^/]+)$/);
      if (patch && req.method === "PATCH") {
        const body = (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return {};
          }
        })();
        patches.push({ id: patch[1], body, auth: String(req.headers.authorization ?? "") });
        const target = profiles.find((p) => p.id === patch[1]);
        if (!target) return err(404, "not_found", "profile not found");
        if (state.forbidNext || (target.kind === "team" && state.role === "member")) return err(403, "forbidden", "only a team owner or admin can rename a team profile");
        const name = String(body.name ?? "").trim();
        if (name === "") return err(400, "bad_request", "name is required");
        if (profiles.some((p) => p.id !== target.id && p.name.toLowerCase() === name.toLowerCase())) return err(409, "profile_name_taken", "taken");
        target.name = name;
        return send(200, target);
      }
      return err(404, "not_found", path);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    state,
    patches,
    names: () => profiles.map((p) => p.name),
  };
}

function seed(dir) {
  mkdirSync(join(dir, "profiles", P_PERSONAL), { recursive: true });
  mkdirSync(join(dir, "profiles", P_TEAM), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: P_PERSONAL,
      profiles: [
        { id: P_PERSONAL, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" },
        { id: P_TEAM, name: "Idy Platform", kind: "team", createdAt: 2, homeMode: "isolated", team: { id: TEAM, slug: "idy", name: "Idy Platform" } },
      ],
    }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", P_PERSONAL, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }));
}

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
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, "base64"));
}
const typeInto = (value) => `(() => { const i = document.querySelector('[data-part="rename-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; if (!i) return; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const ROW = (n) => `document.querySelectorAll('[data-part="account-profile-row"]')[${n}]`;
const BTN = (n) => `${ROW(n)}?.querySelector('[data-part="rename-btn"]')`;
const NAMES = `JSON.stringify([...document.querySelectorAll('[data-part="account-profile-row"]')].map((r) => r.querySelector('[data-part="account-profile-name"]')?.textContent))`;

const apiPort = await pickFreePort();
const api = startFakeBackend(apiPort);
await api.listen();
const userData = mkdtempSync(join(tmpdir(), "stellar-profile-account-rename-"));
seed(userData);
const cdpPort = await pickFreePort();
const app = await startApp({
  cdpPort,
  userDataDir: userData,
  preserveUserData: true,
  isolatedHome: true,
  extraArgs: ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
  extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}` },
});
try {
  const page = await connectPage(cdpPort);
  await page.send("Page.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);
  await delay(1500);

  const openPerfis = async () => {
    await page.evalJs(`document.querySelector('[data-role="profile-trigger"]')?.click()`);
    await delay(300);
    await page.evalJs(`document.querySelector('[data-role="manage-accounts"]')?.click()`);
    const open = await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 6000);
    await waitFor(page, `document.querySelectorAll('[data-part="account-profile-row"]').length >= 2`, 8000);
    return open;
  };
  const closeModal = async () => {
    await page.evalJs(`document.querySelector('[data-settings-close]')?.click()`);
    await delay(300);
  };

  // ---- 1. owner: the personal profile ------------------------------------------
  check("Settings opens on Perfis", await openPerfis(), true);
  check("owner: both account buttons end up enabled", await waitFor(page, `!${BTN(0)}?.disabled && !${BTN(1)}?.disabled`, 8000), true);
  await shot(page, "1-conta-habilitados");
  await page.evalJs(`${BTN(0)}?.click()`);
  await delay(250);
  check("Renomear opens the field with the current name, focused", await page.evalJs(`(() => { const i = document.querySelector('[data-part="rename-input"]'); return !!i && i.value === "Pessoal" && document.activeElement === i; })()`), true);
  check("the field sits in the account row", await page.evalJs(`!!${ROW(0)}?.querySelector('[data-part="rename-input"]')`), true);
  await shot(page, "2-conta-editando");
  await page.evalJs(typeInto("  Casa  "));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  check("the new name shows in the account list", await waitFor(page, `JSON.parse(${NAMES})[0] === "Casa"`, 6000), true);
  check("the server has the trimmed name", api.names()[0], "Casa");
  const sent = api.patches.at(-1);
  check("PATCH carried only {name}", sent && JSON.stringify(sent.body), JSON.stringify({ name: "Casa" }));
  check("…to the server profile id, with the bearer from the main process", sent && sent.id === SRV_PERSONAL && sent.auth === "Bearer a:owner", true);
  const leak = await page.evalJs(`JSON.stringify([localStorage, sessionStorage, document.cookie, location.href]).includes("a:owner")`);
  check("the page never holds the token", leak, false);

  // ---- 2. a repeated name ------------------------------------------------------
  await page.evalJs(`${BTN(0)}?.click()`);
  await delay(250);
  await page.evalJs(typeInto("idy platform"));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  await waitFor(page, `!!document.querySelector('[data-part="rename-error"]')`, 4000);
  check("a repeated name is refused with the account's own text", await page.evalJs(`document.querySelector('[data-part="rename-error"]')?.textContent`), "Já existe um perfil com esse nome nesta conta.");
  check("…and the field stays, marked invalid", await page.evalJs(`document.querySelector('[data-part="rename-input"]')?.getAttribute('aria-invalid')`), "true");
  check("…and the server kept the name", api.names()[0], "Casa");
  await shot(page, "3-conta-nome-repetido");
  await page.evalJs(typeInto("x".repeat(61)));
  const before = api.patches.length;
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  await waitFor(page, `!!document.querySelector('[data-part="rename-error"]')`, 3000);
  check("a name over 60 characters is refused before any request", api.patches.length === before && /1 a 60/.test(await page.evalJs(`document.querySelector('[data-part="rename-error"]')?.textContent ?? ""`)), true);
  await page.evalJs(`document.querySelector('[data-part="rename-cancel"]')?.click()`);

  // ---- 3. the team profile ------------------------------------------------------
  await page.evalJs(`${BTN(1)}?.click()`);
  await delay(250);
  await page.evalJs(typeInto("Plataforma"));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  check("owner renames the team profile", await waitFor(page, `JSON.parse(${NAMES}).includes("Plataforma")`, 6000), true);

  api.state.role = "member";
  await closeModal();
  await openPerfis();
  check("member: the team button is disabled", await waitFor(page, `${BTN(1)}?.disabled === true`, 8000), true);
  check("…with the reason as its tip and as text", await page.evalJs(`/owner ou admin/.test(${BTN(1)}?.title ?? "") && /owner ou admin/.test(${ROW(1)}?.querySelector('[data-part="rename-blocked"]')?.textContent ?? "")`), true);
  check("…while the personal profile is still renamable", await page.evalJs(`${BTN(0)}?.disabled === false`), true);
  await shot(page, "4-conta-membro-desabilitado");

  // The permission changed on the server after the page read it: the 403 is shown, not hidden.
  api.state.role = "owner";
  await closeModal();
  await openPerfis();
  await waitFor(page, `${BTN(1)}?.disabled === false`, 8000);
  api.state.forbidNext = true;
  await page.evalJs(`${BTN(1)}?.click()`);
  await delay(250);
  await page.evalJs(typeInto("Outro nome"));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  await waitFor(page, `!!document.querySelector('[data-part="rename-error"]')`, 4000);
  check("a server 403 says the person is not allowed", await page.evalJs(`document.querySelector('[data-part="rename-error"]')?.textContent`), "Você não tem permissão para renomear este perfil.");
  api.state.forbidNext = false;

  // ---- 4. no connection ---------------------------------------------------------
  await page.evalJs(`document.querySelector('[data-part="rename-cancel"]')?.click()`);
  await closeModal();
  await api.stop();
  await openPerfis();
  check("offline: every account button is disabled", await waitFor(page, `${BTN(0)}?.disabled === true && ${BTN(1)}?.disabled === true`, 12000), true);
  check("…and says there is no connection", await page.evalJs(`/sem conexão/.test(${ROW(0)}?.querySelector('[data-part="rename-blocked"]')?.textContent ?? "")`), true);
  await shot(page, "5-conta-offline");
  page.close();
} finally {
  await stopApp(app);
  await api.stop().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
finish();
