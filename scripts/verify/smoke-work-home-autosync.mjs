// Cold-start guard: a restored account session must not contact the work-home
// endpoints unless the profile opted into automatic sync.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const { check, finish } = makeChecker();
const userDataDir = mkdtempSync(join(tmpdir(), "stellar-work-home-autosync-"));
const apiPort = await pickFreePort();
const cdpPort = await pickFreePort();
let houseRequests = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/v1/auth/token") return send(200, { access_token: "a:1", refresh_token: "r:1", expires_in: 900, refresh_expires_in: 2592000 });
    if (path === "/v1/me") return send(200, {
      account: { id: "22222222-2222-4222-8222-222222222222", display_name: "Smoke" }, identities: [], profiles: [], teams: [],
      plan: { account_plan: "pro", account_expires_at: null, rights: { sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null } } },
    });
    if (path === "/v1/profiles") return send(200, { profiles: [] });
    if (path.endsWith("/house")) houseRequests++;
    send(200, { revision: 0, manifest: [] });
  });
});
await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));

for (const id of [PROFILE_ID, SECOND_PROFILE_ID]) mkdirSync(join(userDataDir, "profiles", id), { recursive: true });
writeFileSync(join(userDataDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: PROFILE_ID, profiles: [
  { id: PROFILE_ID, name: "Personal", kind: "personal", createdAt: 1, homeMode: "isolated" },
  { id: SECOND_PROFILE_ID, name: "Second", kind: "personal", createdAt: 2, homeMode: "isolated" },
] }));
writeFileSync(join(userDataDir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
writeFileSync(join(userDataDir, "profiles", PROFILE_ID, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "r:1", encrypted: false }, linked: true }));

let app;
try {
  app = await startApp({ cdpPort, userDataDir, preserveUserData: true, isolatedHome: true, extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}` } });
  const page = await connectPage(cdpPort);
  await page.send("Page.enable");
  let authState = "";
  for (let i = 0; i < 80; i++) {
    authState = await page.evalJs(`(async () => (await window.cloud.status()).state)()`);
    if (authState === "logged-in") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check("cold-start fixture restores an authenticated session", authState, "logged-in");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.evalJs(`document.querySelector('[data-section="workhome"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const tools = await page.evalJs(`JSON.stringify([...document.querySelectorAll('input[type="checkbox"]')].map((input) => input.checked))`);
  check("new profile starts with no work-home tool selected", tools, JSON.stringify([false, false, false, false, false]));
  const statusText = await page.evalJs(`document.querySelector('[class*="statusDot"]')?.parentElement?.textContent ?? ""`);
  check("never-synced profile does not show a plan source as a completed sync", statusText.includes("via account"), false);
  check("opening Work home leaves house API untouched", houseRequests, 0);
  await page.evalJs(`document.querySelector('[data-role="profile-trigger"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.evalJs(`document.querySelector('[data-role="profile-row"][data-profile-id="${SECOND_PROFILE_ID}"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check("switching profile leaves house API untouched", houseRequests, 0);
  check("cold start with default autoSync=false makes no work-home API request", houseRequests, 0);
  page.close();
} finally {
  if (app) await stopApp(app);
  await new Promise((resolve) => server.close(resolve));
  rmSync(userDataDir, { recursive: true, force: true });
}
finish();
