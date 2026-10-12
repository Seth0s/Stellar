// A6 — Import (tela 18) and Integrations (tela 19). Isolated Electron + fake
// StellarCloud backend (no real Slack/GitHub/Linear/Jira). Screenshots and
// side-by-side comparisons go ONLY to /tmp/a6/.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v2/prototipo");
const OUT_DIR = "/tmp/a6";
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const MEMBER_P = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const MEMBER_ACC = "44444444-4444-4444-8444-444444444444";
const SLACK_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const WH_ID = "77777777-7777-4777-8777-777777777777";

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

function startFakeBackend(port) {
  const members = [
    { team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null, display_name: "Ana Ribeiro", avatar_initials: "AR", email: "ana@example.com" },
    { team_id: TEAM_ID, account_id: MEMBER_ACC, role: "member", joined_at: null, display_name: "Bruno Melo", avatar_initials: "BM", email: null },
  ];
  const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z" };
  const integrations = new Map([
    [
      "slack",
      {
        id: SLACK_ID,
        kind: "slack",
        status: "connected",
        // Legacy shape on purpose: absent B9c keys must resolve to defaults in the UI.
        config: {
          workspace_name: "idy",
          workspace_id: "T_IDY",
          channel_id: "backlog",
          channel_name: "backlog",
        },
        connected_by: OWNER_ACC,
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-10-05T00:00:00Z",
      },
    ],
    [
      "github",
      {
        id: "88888888-8888-4888-8888-888888888888",
        kind: "github",
        status: "connected",
        // Absent link_pr / close_on_done → B9c defaults (true / false).
        config: { repo: "Seth0s/demo", label: "stellar" },
        connected_by: OWNER_ACC,
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-10-05T00:00:00Z",
      },
    ],
  ]);
  const webhooks = [
    {
      id: WH_ID,
      url: "https://example.test/hook",
      events: ["task.updated"],
      status: "active",
      consecutive_failures: 0,
      created_at: "2026-10-05T00:00:00Z",
      updated_at: "2026-10-05T00:00:00Z",
    },
  ];
  const imports = [];
  const oauthUrls = [];
  const patches = [];

  function accountOf(req) {
    const m = String(req.headers.authorization ?? "").match(/^Bearer a:(.+)$/);
    return m ? m[1] : null;
  }
  const accIdOf = (who) => (who === "owner" ? OWNER_ACC : MEMBER_ACC);
  const roleOf = (who) => (who === "owner" ? "owner" : "member");

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = (() => {
        try {
          return JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          return {};
        }
      })();
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const forbidden = () => send(403, { error: { code: "forbidden", message: "not allowed" } });
      const notFound = () => send(404, { error: { code: "not_found", message: path } });

      if (path === "/v1/auth/token" && req.method === "POST") {
        const who = body.refresh_token === "member-refresh" ? "member" : "owner";
        return send(200, { access_token: `a:${who}`, refresh_token: body.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();

      const who = accountOf(req);
      if (!who) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });
      const role = roleOf(who);

      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: accIdOf(who), display_name: who === "owner" ? "Ana Ribeiro" : "Bruno Melo", created_at: "2026-10-05T00:00:00Z" },
          identities: [],
          profiles: [{ id: who === "owner" ? OWNER_P : MEMBER_P, account_id: accIdOf(who), kind: "personal", team_id: null, name: "Pessoal", created_at: null }],
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

      if (path === `/v1/teams/${TEAM_ID}/integrations` && req.method === "GET") {
        return send(200, { integrations: [...integrations.values()] });
      }
      const integPath = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/integrations/([a-z]+)$`));
      if (integPath) {
        const kind = integPath[1];
        if (req.method === "PATCH") {
          if (role !== "owner" && role !== "admin") return forbidden();
          const cur = integrations.get(kind);
          if (!cur) return notFound();
          patches.push({ kind, config: { ...(body.config ?? {}) } });
          cur.config = { ...cur.config, ...(body.config ?? {}) };
          if (body.status) cur.status = body.status;
          cur.updated_at = new Date().toISOString();
          return send(200, cur);
        }
        if (req.method === "DELETE") {
          if (role !== "owner" && role !== "admin") return forbidden();
          integrations.delete(kind);
          return res.writeHead(204).end();
        }
      }
      const oauthPath = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/integrations/([a-z]+)/oauth$`));
      if (oauthPath && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const url = `http://127.0.0.1:${port}/fake-oauth/${oauthPath[1]}?return=${encodeURIComponent(body.return_url ?? "")}`;
        oauthUrls.push(url);
        return send(200, { authorize_url: url });
      }
      const connectPath = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/integrations/([a-z]+)/connect$`));
      if (connectPath && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const kind = connectPath[1];
        const row = {
          id: randomUUID(),
          kind,
          status: "connected",
          config: body.config ?? {},
          connected_by: accIdOf(who),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        integrations.set(kind, row);
        return send(200, row);
      }

      if (path === `/v1/teams/${TEAM_ID}/imports` && req.method === "GET") return send(200, { imports });
      if (path === `/v1/teams/${TEAM_ID}/imports/preview` && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        return send(200, {
          kind: body.kind ?? "slack",
          total: 23,
          duplicates: 3,
          items: [
            {
              title: "Relatório de presença sai com horário UTC",
              external_id: "slack:1",
              duplicate: false,
              meta: "Carla · ontem · 4 respostas · Corrigir · território src/reports/**",
            },
            {
              title: "Exportar lista de membros para CSV",
              external_id: "slack:2",
              duplicate: false,
              meta: "Ana · há 3 dias · Implementar · sem dono",
            },
            {
              title: "Fila de retries com backoff em 429",
              external_id: "slack:3",
              duplicate: true,
              existing_ref: "#58",
              meta: null,
            },
          ],
        });
      }
      if (path === `/v1/teams/${TEAM_ID}/imports` && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const job = {
          id: JOB_ID,
          kind: body.kind ?? "slack",
          status: "done",
          rule: body.rule ?? {},
          mapping: body.mapping ?? {},
          continue_import: body.continue === true,
          cursor: "",
          created_count: 2,
          skipped_count: 1,
          error: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        imports.push(job);
        return send(201, job);
      }
      if (path === `/v1/teams/${TEAM_ID}/imports/${JOB_ID}/run` && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const job = imports.find((j) => j.id === JOB_ID) ?? {
          id: JOB_ID,
          kind: "slack",
          status: "done",
          rule: {},
          mapping: {},
          continue_import: true,
          cursor: "",
          created_count: 0,
          skipped_count: 0,
          error: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        job.status = "done";
        return send(200, job);
      }

      if (path === `/v1/teams/${TEAM_ID}/webhooks` && req.method === "GET") return send(200, { webhooks });
      if (path === `/v1/teams/${TEAM_ID}/webhooks` && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const wh = {
          id: randomUUID(),
          url: body.url,
          events: body.events ?? [],
          status: "active",
          consecutive_failures: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        webhooks.push(wh);
        return send(201, wh);
      }
      if (path.startsWith(`/v1/teams/${TEAM_ID}/webhooks/`) && req.method === "DELETE") {
        if (role !== "owner" && role !== "admin") return forbidden();
        return res.writeHead(204).end();
      }
      if (path === `/v1/teams/${TEAM_ID}/export` || path.startsWith(`/v1/teams/${TEAM_ID}/export?`)) {
        const fmt = (req.url ?? "").includes("format=json") ? "json" : "csv";
        if (fmt === "json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ tasks: [] }));
        }
        res.writeHead(200, { "Content-Type": "text/csv" });
        return res.end("ref,title\n");
      }

      return notFound();
    });
  });

  return {
    server,
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
    oauthUrls: () => oauthUrls,
    patches: () => patches,
    integrations,
  };
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
  for (let i = 0; i < 60; i++) {
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

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* */
    }
    await delay(150);
  }
  return false;
}

function sideBySide(left, right, out) {
  execFileSync("magick", [left, right, "+append", "-background", "#05060a", "-gravity", "North", out], { stdio: "pipe" });
}

const ownerUserData = mkdtempSync(join(tmpdir(), "stellar-a6-owner-"));
const memberUserData = mkdtempSync(join(tmpdir(), "stellar-a6-member-"));
const protoUserData = mkdtempSync(join(tmpdir(), "stellar-a6-proto-"));

let backend;
let staticSrv;
let ownerApp;
let memberApp;
let protoApp;

try {
  const apiPort = await pickFreePort();
  const staticPort = await pickFreePort();
  backend = startFakeBackend(apiPort);
  staticSrv = startStatic(staticPort, PROTO_DIR);
  await backend.listen();
  await staticSrv.listen();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  // Prototype screenshots (same viewport).
  const protoCdp = await pickFreePort();
  protoApp = await startApp({
    cdpPort: protoCdp,
    userDataDir: protoUserData,
    preserveUserData: true,
    isolatedHome: true,
  });
  const protoPage = await connectPage(protoCdp);
  await protoPage.send("Page.enable");
  await protoPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const shotProto = async (file, name) => {
    await protoPage.send("Page.navigate", { url: `${staticSrv.origin}/${file}` });
    await delay(600);
    const res = await protoPage.send("Page.captureScreenshot", { format: "png" });
    const abs = join(OUT_DIR, name);
    writeFileSync(abs, Buffer.from(res.data, "base64"));
    return abs;
  };
  const protoImport = await shotProto("Import.dc.html", "proto-import.png");
  const protoInteg = await shotProto("Integrations.dc.html", "proto-integrations.png");
  check("proto import shot", existsSync(protoImport), true);
  check("proto integrations shot", existsSync(protoInteg), true);

  // Owner app.
  seedUserData(ownerUserData, OWNER_P, "Pessoal", "owner-refresh");
  const ownerCdp = await pickFreePort();
  ownerApp = await startApp({
    cdpPort: ownerCdp,
    userDataDir: ownerUserData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const ownerPage = await connectPage(ownerCdp);
  await ownerPage.send("Page.enable");
  await ownerPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForCloud(ownerPage);
  await ownerPage.evalJs(`(async () => { await window.team.create({ name: "Idy Platform" }); })()`);

  await ownerPage.evalJs(`document.querySelector('[data-section="team"]').click()`);
  check("team section opens", await waitFor(ownerPage, `!!document.querySelector('[data-team-sub="overview"]')`), true);

  // Ctrl K palette.
  await ownerPage.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  check("Ctrl K opens command palette", await waitFor(ownerPage, `!!document.querySelector('[data-part="team-cmd-palette"]')`), true);
  await ownerPage.evalJs(`document.querySelector('[data-part="cmd-integrations"]')?.click()`);
  check("palette opens integrations", await waitFor(ownerPage, `!!document.querySelector('[data-part="integrations-page"]')`), true);
  await delay(400);
  const shot = async (page, name) => {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    const abs = join(OUT_DIR, name);
    writeFileSync(abs, Buffer.from(res.data, "base64"));
    return abs;
  };
  // B9c defaults for absent keys (GET config without keys → UI defaults).
  const switchState = JSON.parse(
    await ownerPage.evalJs(`(() => {
      const on = (sel) => !!document.querySelector(sel)?.checked;
      const dis = (sel) => !!document.querySelector(sel)?.disabled;
      return JSON.stringify({
        slash: on('[data-part="slack-slash_command"]'),
        reaction: on('[data-part="slack-reaction"]'),
        mention: on('[data-part="slack-mention_to_task"]'),
        notifyReview: on('[data-part="slack-notify_review"]'),
        notifyGate: on('[data-part="slack-notify_gate_failed"]'),
        notifyDone: on('[data-part="slack-notify_done"]'),
        dm: on('[data-part="slack-dm_assignee"]'),
        linkPr: on('[data-part="github-link_pr"]'),
        closeOnDone: on('[data-part="github-close_on_done"]'),
        mentionNote: !!document.querySelector('[data-part="slack-mention-note"]'),
        notifyReviewDisabled: dis('[data-part="slack-notify_review"]'),
      });
    })()`),
  );
  check("slack slash_command default on", switchState.slash, true);
  check("slack reaction default on", switchState.reaction, true);
  check("slack mention_to_task default off", switchState.mention, false);
  check("slack notify_review default on", switchState.notifyReview, true);
  check("slack notify_gate_failed default on", switchState.notifyGate, true);
  check("slack notify_done default off", switchState.notifyDone, false);
  check("slack dm_assignee default on", switchState.dm, true);
  check("github link_pr default on", switchState.linkPr, true);
  check("github close_on_done default off", switchState.closeOnDone, false);
  check("mention reconnect note visible", switchState.mentionNote, true);
  check("notify children clickable when master default true", switchState.notifyReviewDisabled, false);

  const appInteg = await shot(ownerPage, "app-integrations-owner.png");

  const listInteg = JSON.parse(await ownerPage.evalJs(`(async () => JSON.stringify(await window.team.listIntegrations("${TEAM_ID}")))()`));
  check("owner lists integrations", listInteg.ok && listInteg.integrations.some((i) => i.kind === "slack"), true);

  // PATCH exact B9c keys.
  await ownerPage.evalJs(`document.querySelector('[data-part="slack-mention_to_task"]')?.click()`);
  await delay(300);
  await ownerPage.evalJs(`document.querySelector('[data-part="slack-notify_done"]')?.click()`);
  await delay(300);
  await ownerPage.evalJs(`document.querySelector('[data-part="github-link_pr"]')?.click()`);
  await delay(300);
  const patchKinds = backend.patches().map((p) => ({ kind: p.kind, keys: Object.keys(p.config).sort() }));
  check(
    "PATCH mention_to_task exact key",
    patchKinds.some((p) => p.kind === "slack" && p.keys.join() === "mention_to_task"),
    true,
  );
  check(
    "PATCH notify_done exact key",
    patchKinds.some((p) => p.kind === "slack" && p.keys.join() === "notify_done"),
    true,
  );
  check(
    "PATCH link_pr exact key",
    patchKinds.some((p) => p.kind === "github" && p.keys.join() === "link_pr"),
    true,
  );

  // Master notify_channel false: three avisos unchecked but still clickable;
  // turning one ON PATCHes notify_channel=true in the same body.
  await ownerPage.evalJs(
    `(async () => JSON.stringify(await window.team.updateIntegration("${TEAM_ID}", "slack", { config: { notify_channel: false } })))()`,
  );
  await ownerPage.evalJs(`document.querySelector('[data-part="integrations-back"]')?.click()`);
  await waitFor(ownerPage, `!!document.querySelector('[data-part="team-open-integrations"]')`);
  await ownerPage.evalJs(`document.querySelector('[data-part="team-open-integrations"]')?.click()`);
  check("reopen integrations after master off", await waitFor(ownerPage, `!!document.querySelector('[data-part="integrations-page"]')`), true);
  await delay(300);
  const masterOff = JSON.parse(
    await ownerPage.evalJs(`(() => JSON.stringify({
      review: !!document.querySelector('[data-part="slack-notify_review"]')?.checked,
      gate: !!document.querySelector('[data-part="slack-notify_gate_failed"]')?.checked,
      done: !!document.querySelector('[data-part="slack-notify_done"]')?.checked,
      reviewDis: !!document.querySelector('[data-part="slack-notify_review"]')?.disabled,
      gateDis: !!document.querySelector('[data-part="slack-notify_gate_failed"]')?.disabled,
      doneDis: !!document.querySelector('[data-part="slack-notify_done"]')?.disabled,
    }))()`),
  );
  check("master off unchecks notify_review", masterOff.review, false);
  check("master off unchecks notify_gate_failed", masterOff.gate, false);
  check("master off unchecks notify_done", masterOff.done, false);
  check("master off keeps notify_review clickable", masterOff.reviewDis, false);
  check("master off keeps notify_gate_failed clickable", masterOff.gateDis, false);
  check("master off keeps notify_done clickable", masterOff.doneDis, false);
  await shot(ownerPage, "app-integrations-notify-off.png");

  const patchesBeforeRelight = backend.patches().length;
  await ownerPage.evalJs(`document.querySelector('[data-part="slack-notify_review"]')?.click()`);
  await delay(400);
  const relight = backend.patches().slice(patchesBeforeRelight);
  const relightBody = relight.find((p) => p.kind === "slack" && p.config.notify_review === true);
  check("relight PATCH includes notify_review", !!relightBody, true);
  check("relight PATCH sets notify_channel true", relightBody?.config?.notify_channel === true, true);
  await delay(200);
  const afterRelight = JSON.parse(
    await ownerPage.evalJs(
      `(() => JSON.stringify({ review: !!document.querySelector('[data-part="slack-notify_review"]')?.checked }))()`,
    ),
  );
  check("relight shows notify_review checked", afterRelight.review, true);

  // The connect form starts empty (generic placeholders), and GitHub needs a repo.
  const savedGithub = backend.integrations.get("github");
  backend.integrations.delete("github");
  await ownerPage.evalJs(`document.querySelector('[data-part="integrations-back"]')?.click()`);
  await waitFor(ownerPage, `!!document.querySelector('[data-part="team-open-integrations"]')`);
  await ownerPage.evalJs(`document.querySelector('[data-part="team-open-integrations"]')?.click()`);
  await waitFor(ownerPage, `!!document.querySelector('[data-part="github-connect"]')`);
  await ownerPage.evalJs(`document.querySelector('[data-part="github-connect"]')?.click()`);
  check("connect form opens", await waitFor(ownerPage, `!!document.querySelector('[data-part="connect-modal"]')`), true);
  const connectFields = JSON.parse(
    await ownerPage.evalJs(`JSON.stringify([...document.querySelectorAll('[data-part="connect-modal"] input')].map((i) => [i.placeholder, i.value]))`),
  );
  check("connect form: repo and label start empty with generic placeholders", JSON.stringify(connectFields), JSON.stringify([["org/repo", ""], ["label (ex.: stellar)", ""], ["token / api key", ""]]));
  await ownerPage.evalJs(
    `(() => { const el = document.querySelector('[data-part="connect-token"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "tok"); el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await delay(150);
  check("connect form: a token alone does not enable GitHub connect (repo missing)", await ownerPage.evalJs(`!!document.querySelector('[data-part="connect-submit"]').disabled`), true);
  if (savedGithub) backend.integrations.set("github", savedGithub);
  await ownerPage.evalJs(`document.querySelector('[data-part="connect-modal"] button')?.click()`);
  await delay(150);

  // Integrations is a full-page subview — go back to overview, then open Import.
  await ownerPage.evalJs(`document.querySelector('[data-part="integrations-back"]')?.click()`);
  check("back to team overview", await waitFor(ownerPage, `!!document.querySelector('[data-team-sub="import"]')`), true);
  await ownerPage.evalJs(`document.querySelector('[data-team-sub="import"]')?.click()`);
  check("import wizard opens", await waitFor(ownerPage, `!!document.querySelector('[data-part="import-wizard"]')`), true);

  // Walk to step 3 (map) like the prototype; preview auto-loads.
  await ownerPage.evalJs(`document.querySelector('[data-part="import-next"]')?.click()`);
  await delay(200);
  await ownerPage.evalJs(`document.querySelector('[data-part="import-next"]')?.click()`);
  check("import step 3 active", await waitFor(ownerPage, `document.querySelector('[data-step="3"]')?.getAttribute('data-step-state') === 'active'`), true);
  check("preview loads duplicate #58", await waitFor(ownerPage, `!!Array.from(document.querySelectorAll('[data-part="import-preview"] *')).find(el => (el.textContent||'').includes('#58'))`), true);
  await delay(300);
  const appImport = await shot(ownerPage, "app-import-map.png");

  await ownerPage.evalJs(`document.querySelector('[data-part="import-to-review"]')?.click()`);
  await delay(200);
  await ownerPage.evalJs(`document.querySelector('[data-part="import-run"]')?.click()`);
  check("import job finishes", await waitFor(ownerPage, `!!document.querySelector('[data-part="import-job-status"]')`), true);

  // Member: read-only integrations.
  seedUserData(memberUserData, MEMBER_P, "Pessoal", "member-refresh");
  const memberCdp = await pickFreePort();
  memberApp = await startApp({
    cdpPort: memberCdp,
    userDataDir: memberUserData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const memberPage = await connectPage(memberCdp);
  await memberPage.send("Page.enable");
  await memberPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForCloud(memberPage);
  await memberPage.evalJs(`document.querySelector('[data-section="team"]').click()`);
  await waitFor(memberPage, `!!document.querySelector('[data-part="team-open-integrations"]')`);
  await memberPage.evalJs(`document.querySelector('[data-part="team-open-integrations"]')?.click()`);
  check("member sees integrations read-only", await waitFor(memberPage, `!!document.querySelector('[data-part="integrations-page"]')`), true);
  const memberConnectVisible = await memberPage.evalJs(`!!document.querySelector('[data-part="slack-connect"], [data-part="slack-disconnect"]')`);
  check("member has no slack connect/disconnect control", memberConnectVisible, false);
  const memberPreviewForbidden = JSON.parse(
    await memberPage.evalJs(`(async () => JSON.stringify(await window.team.previewImport("${TEAM_ID}", { kind: "slack", rule: {}, mapping: {}, data: "", continue: false })))()`),
  );
  check("member preview is forbidden", memberPreviewForbidden.ok, false);
  await delay(300);
  await shot(memberPage, "app-integrations-member.png");

  sideBySide(protoImport, appImport, join(OUT_DIR, "side-by-side-import.png"));
  sideBySide(protoInteg, appInteg, join(OUT_DIR, "side-by-side-integrations.png"));
  check("side-by-side import written", existsSync(join(OUT_DIR, "side-by-side-import.png")), true);
  check("side-by-side integrations written", existsSync(join(OUT_DIR, "side-by-side-integrations.png")), true);

  writeFileSync(
    join(OUT_DIR, "smoke-results.json"),
    JSON.stringify(
      {
        ok: true,
        screenshots: [
          join(OUT_DIR, "proto-import.png"),
          join(OUT_DIR, "app-import-map.png"),
          join(OUT_DIR, "side-by-side-import.png"),
          join(OUT_DIR, "proto-integrations.png"),
          join(OUT_DIR, "app-integrations-owner.png"),
          join(OUT_DIR, "app-integrations-notify-off.png"),
          join(OUT_DIR, "app-integrations-member.png"),
          join(OUT_DIR, "side-by-side-integrations.png"),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (ownerApp) await stopApp(ownerApp).catch(() => {});
  if (memberApp) await stopApp(memberApp).catch(() => {});
  if (protoApp) await stopApp(protoApp).catch(() => {});
  if (backend) await backend.close().catch(() => {});
  if (staticSrv) await staticSrv.close().catch(() => {});
  rmSync(ownerUserData, { recursive: true, force: true });
  rmSync(memberUserData, { recursive: true, force: true });
  rmSync(protoUserData, { recursive: true, force: true });
}

finish();
