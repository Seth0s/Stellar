// Sign-in persistence across an app restart, against a fake API that rotates
// the refresh token the way the real one does (each token is single-use; a
// reused one answers invalid_grant). Isolated userData, no real network.
// Prints under /tmp/conta-perfil/.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/conta-perfil";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

/** A fake API with single-use refresh tokens. `log` records every token request. */
function startRotatingApi(port, { slowMs = 0 } = {}) {
  let counter = 0;
  const valid = new Set(["r:0"]); // refresh tokens that have not been used yet
  const log = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token") {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (slowMs) await delay(slowMs);
        const used = body.refresh_token;
        if (!valid.has(used)) {
          log.push({ used, outcome: "invalid_grant" });
          return send(400, { error: { code: "invalid_grant", message: "refresh token reused or revoked" } });
        }
        valid.delete(used);
        const next = `r:${++counter}`;
        valid.add(next);
        log.push({ used, outcome: "ok", next });
        return send(200, { access_token: `a:${counter}`, refresh_token: next, expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/me") {
        return send(200, {
          account: { id: ACCOUNT_ID, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: "ana@example.com", login: null }],
          profiles: [],
          teams: [],
          plan: { account_plan: "pro", account_expires_at: null, rights: {
            sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
            team: { granted: false, state: "none", plan: null, source: null, team_id: null, expires_at: null } } },
        });
      }
      if (path === "/v1/profiles") return send(200, { profiles: [] });
      if (path === "/v1/devices") return send(200, { devices: [] });
      if (path.endsWith("/house")) return send(200, { revision: 0, manifest: [] });
      if (path === "/v1/auth/logout") return res.writeHead(204).end();
      send(404, { error: { code: "not_found", message: path } });
    });
  });
  return { log, listen: () => new Promise((r) => server.listen(port, "127.0.0.1", r)), close: () => new Promise((r) => server.close(r)) };
}

function seed(dir) {
  mkdirSync(join(dir, "profiles", PROFILE_ID), { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }));
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "r:0", encrypted: false }, linked: true }));
}

async function bootOnce(userData, apiBase, body) {
  const cdpPort = await pickFreePort();
  const app = await startApp({ cdpPort, userDataDir: userData, preserveUserData: true, isolatedHome: true, extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" } });
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

const waitFor = async (page, expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evalJs(expr).catch(() => false)) return true;
    await delay(200);
  }
  return false;
};

const storedRefresh = (dir) => JSON.parse(readFileSync(join(dir, "profiles", PROFILE_ID, "cloud-auth.json"), "utf8")).refreshToken?.value ?? null;

const userData = mkdtempSync(join(tmpdir(), "stellar-account-persist-"));
seed(userData);
const apiPort = await pickFreePort();
const api = startRotatingApi(apiPort, { slowMs: 150 });
await api.listen();
const apiBase = `http://127.0.0.1:${apiPort}`;
try {
  for (const round of [1, 2, 3]) {
    api.log.length = 0;
    await bootOnce(userData, apiBase, async (page) => {
      const up = await waitFor(page, `document.querySelector('[data-role="profile-sub"]')?.getAttribute('data-scope') === 'account'`);
      await delay(1500); // let every boot-time consumer ask for a token
      check(`restart ${round}: still signed in`, up, true);
      const status = await page.evalJs(`window.cloud.status().then((s) => s.state)`);
      check(`restart ${round}: cloud status is logged-in`, status, "logged-in");
      const reused = api.log.filter((e) => e.outcome === "invalid_grant");
      check(`restart ${round}: no refresh token was ever presented twice`, reused.length, 0);
      console.log(`  refresh requests at boot ${round}:`, JSON.stringify(api.log));
    });
    check(`restart ${round}: a usable refresh token is on disk afterwards`, storedRefresh(userData) !== null, true);
  }
} finally {
  await api.close();
  rmSync(userData, { recursive: true, force: true });
}
finish();
