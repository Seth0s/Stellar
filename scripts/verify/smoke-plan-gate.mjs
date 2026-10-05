// A9 — plan gate in the app. Four ISOLATED instances (its own userData/HOME and
// CDP port each), against a LOCAL backend that speaks the `/v1/me` plan block
// and the 402 codes. It measures: Free locks the Work home sync and the Team
// section; Pro unlocks sync; a paid-team member sees the team; an expired plan
// stays readable with the write buttons disabled; invites past the seats get
// `seats_exceeded`. Writes 1440x900 screenshots.
//
// It NEVER touches the owner's instance or the real CLI houses.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootIntoFreshSession, connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, "docs/design/app-v2/comparacao");
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const OWNER_P = "11111111-1111-4111-8111-111111111111";
const EXPIRED_AT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy" };
const members = [
  { account_id: OWNER_ACC, role: "owner", joined_at: "2026-10-05T00:00:00Z", display_name: "Ana Ribeiro", avatar_initials: "AR", email: "ana@example.com" },
];

/** The plan block each account sees, keyed by its refresh token. */
function planFor(who) {
  if (who === "free") {
    return {
      account_plan: "free",
      account_expires_at: null,
      rights: {
        sync: { granted: false, state: "none", plan: "pro", source: null, team_id: null, expires_at: null },
        team: { granted: false, state: "none", plan: "team", source: null, team_id: null, expires_at: null },
      },
    };
  }
  if (who === "pro") {
    return {
      account_plan: "pro",
      account_expires_at: null,
      rights: {
        sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
        team: { granted: false, state: "none", plan: "team", source: null, team_id: null, expires_at: null },
      },
    };
  }
  if (who === "expired") {
    return {
      account_plan: "pro",
      account_expires_at: EXPIRED_AT,
      rights: {
        sync: { granted: false, state: "grace", plan: "pro", source: "account", team_id: null, expires_at: EXPIRED_AT },
        team: { granted: false, state: "none", plan: "team", source: null, team_id: null, expires_at: null },
      },
    };
  }
  // paid team member: every member occupies a seat, so both rights come from the team.
  return {
    account_plan: "team",
    account_expires_at: null,
    rights: {
      sync: { granted: true, state: "active", plan: "pro", source: "team", team_id: TEAM_ID, expires_at: null },
      team: { granted: true, state: "active", plan: "team", source: "team", team_id: TEAM_ID, expires_at: null },
    },
  };
}

function startFakeBackend(port) {
  const whoOf = (token) => ({ "free-refresh": "free", "pro-refresh": "pro", "expired-refresh": "expired" })[token] ?? "team";

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* no body */
      }
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const planRequired = (feature, plan) =>
        send(402, { error: { code: "plan_required", message: "plan required", feature, plan } });

      if (path === "/v1/auth/token" && req.method === "POST") {
        const who = whoOf(body.refresh_token);
        return send(200, { access_token: `a:${who}`, refresh_token: body.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();

      const m = String(req.headers.authorization ?? "").match(/^Bearer a:(.+)$/);
      if (!m) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });
      const who = m[1];
      const plan = planFor(who);
      const syncOk = plan.rights.sync.granted;
      const teamOk = plan.rights.team.granted;

      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: OWNER_ACC, display_name: `Conta ${who}`, created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: `${who}@example.com`, login: who }],
          profiles: [{ id: OWNER_P, account_id: OWNER_ACC, kind: "personal", team_id: null, name: "Pessoal" }],
          teams: teamOk ? [team] : [],
          plan,
        });
      }

      if (path.startsWith("/v1/teams/") || path.startsWith("/v1/profiles/") || path.startsWith("/v1/blobs/") || path.startsWith("/v1/devices")) {
        if (!teamOk && path.startsWith("/v1/teams/")) return planRequired("team", "team");
        if (!syncOk && !path.startsWith("/v1/teams/")) return planRequired("sync", "pro");
      }

      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") return send(200, { team, members });
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") return send(200, { sprints: [] });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "GET") return send(200, { invites: [] });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "POST") {
        return send(402, { error: { code: "seats_exceeded", message: "the team has no free seat for another member", feature: "team", plan: "team" } });
      }
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") return send(200, { tasks: [], total: 0, limit: 50, offset: 0 });
      if (path.startsWith("/v1/profiles/") && path.endsWith("/house") && req.method === "GET") return send(200, { revision: 0, manifest: [] });
      if (path === "/v1/blobs/check") return send(200, { missing: [] });

      return send(404, { error: { code: "not_found", message: path } });
    });
  });
  return { server, listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())), close: () => new Promise((r) => server.close(() => r())) };
}

function seedUserData(dir, profileId, name, refresh) {
  mkdirSync(join(dir, "profiles", profileId), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({ schemaVersion: 1, defaultProfileId: profileId, profiles: [{ id: profileId, name, kind: "personal", createdAt: 1, homeMode: "isolated" }] }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", profileId, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: refresh, encrypted: false }, linked: true }));
}

async function waitForCloud(page) {
  for (let i = 0; i < 80; i++) {
    try {
      const status = JSON.parse(await page.evalJs(`(async () => JSON.stringify(await window.cloud.status()))()`));
      if (status.state === "logged-in") return status;
    } catch {
      /* still mounting */
    }
    await delay(250);
  }
  throw new Error("login (cloud) não completou a tempo");
}

async function waitFor(page, expr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* not ready */
    }
    await delay(150);
  }
  return false;
}

const evalJson = async (page, expr) => JSON.parse(await page.evalJs(`(async () => JSON.stringify(${expr}))()`));

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const abs = join(OUT_DIR, `${name}.png`);
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

async function gotoSection(page, section) {
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await waitFor(page, `!!document.querySelector('[data-section="${section}"]')`);
  await page.evalJs(`document.querySelector('[data-section="${section}"]').click()`);
  await delay(400);
}

/** Boot one isolated instance for `who`, hand it to `body`, then stop it. */
async function withAccount(apiBase, port, who, body) {
  const userData = mkdtempSync(join(tmpdir(), `stellar-plan-${who}-`));
  seedUserData(userData, OWNER_P, "Pessoal", `${who}-refresh`);
  const cdpPort = await pickFreePort();
  const app = await startApp({ cdpPort, userDataDir: userData, preserveUserData: true, isolatedHome: true, extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" } });
  try {
    const page = await connectPage(cdpPort);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const status = await waitForCloud(page);
    await bootIntoFreshSession(page, "Plano");
    await body(page, status);
  } finally {
    await stopApp(app);
    rmSync(`${userData}-home`, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

const apiPort = await pickFreePort();
const apiBase = `http://127.0.0.1:${apiPort}`;
const backend = startFakeBackend(apiPort);
await backend.listen();

try {
  // ---- FREE ----------------------------------------------------------------
  await withAccount(apiBase, apiPort, "free", async (page, status) => {
    check("free: /me traz o plano Free", status.plan.accountPlan, "free");
    const preview = await evalJson(page, `await window.workhome.preview()`);
    check("free: o sync de casa é recusado pelo servidor (402)", preview.ok, false);

    await gotoSection(page, "workhome");
    check("free: a Casa de trabalho mostra o upgrade do Pro", await waitFor(page, `document.body.textContent.includes("Fazer upgrade")`), true);
    const syncDisabled = await page.evalJs(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Sincronizar agora")); return b ? b.disabled : null; })()`);
    check("free: Sincronizar agora fica desabilitado", syncDisabled, true);
    await shot(page, "app-a9-free-workhome");

    const detail = await evalJson(page, `await window.team.detail("${TEAM_ID}")`);
    check("free: uma rota do time é recusada pelo servidor (402)", detail.ok, false);
    await gotoSection(page, "team");
    check("free: a seção Time explica o plano Team", await waitFor(page, `document.body.textContent.includes("Faça upgrade para o Team")`), true);
    await shot(page, "app-a9-free-team");
  });

  // ---- PRO -----------------------------------------------------------------
  await withAccount(apiBase, apiPort, "pro", async (page, status) => {
    check("pro: /me traz o plano Pro", status.plan.accountPlan, "pro");
    check("pro: o direito de sync vem da conta", status.plan.rights.sync.source, "account");
    await gotoSection(page, "workhome");
    check("pro: a Casa de trabalho NÃO pede upgrade", await waitFor(page, `!document.body.textContent.includes("Fazer upgrade")`), true);
    const syncDisabled = await page.evalJs(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Sincronizar agora")); return b ? b.disabled : null; })()`);
    check("pro: Sincronizar agora fica habilitado", syncDisabled, false);
    await shot(page, "app-a9-pro-workhome");
  });

  // ---- PAID TEAM MEMBER ----------------------------------------------------
  await withAccount(apiBase, apiPort, "team", async (page, status) => {
    check("team: /me traz o plano Team", status.plan.accountPlan, "team");
    check("team: o direito de time vem do time", status.plan.rights.team.source, "team");
    const overview = await evalJson(page, `await window.team.overview()`);
    check("team: a seção Time abre normalmente", overview.ok, true);
    await gotoSection(page, "team");
    check("team: NÃO mostra o aviso de upgrade do Team", await waitFor(page, `!document.body.textContent.includes("Faça upgrade para o Team")`), true);
    await shot(page, "app-a9-team-member");

    const invite = await evalJson(page, `await window.team.invite("${TEAM_ID}", { target: "novo@example.com", role: "member" })`);
    check("team: convite além dos assentos → seats-exceeded", invite.ok === false ? invite.reason : null, "seats-exceeded");
  });

  // ---- EXPIRED (read-only) -------------------------------------------------
  await withAccount(apiBase, apiPort, "expired", async (page, status) => {
    check("expired: /me traz o sync em carência", status.plan.rights.sync.state, "grace");
    await gotoSection(page, "workhome");
    check("expired: a faixa diz que o plano venceu", await waitFor(page, `document.body.textContent.includes("Seu plano venceu")`), true);
    const syncDisabled = await page.evalJs(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Sincronizar agora")); return b ? b.disabled : null; })()`);
    check("expired: a escrita fica desabilitada", syncDisabled, true);
    await shot(page, "app-a9-expired-workhome");
  });
} finally {
  await backend.close();
}

finish();
