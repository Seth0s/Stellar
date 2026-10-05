// ISOLATED smoke for teams in the app (team + team house): TWO isolated
// instances (owner and member), each with its own userData, HOME and fake
// folders, against a LOCAL backend that speaks the SAME contract as the real
// one (teams, invites, team house with manifest + blobs). It NEVER touches the
// real CLI houses.
//
// It measures the logic end to end through the REAL IPC: create a team, publish
// the base (only rules/skills/agents/config — memory out), accept the invite
// creating the team profile, and the base arriving at the member WITH the
// `team-<slug>-` prefix.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const MEMBER_P = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const MEMBER_ACC = "44444444-4444-4444-8444-444444444444";
const INVITE_ID = "66666666-6666-4666-8666-666666666666";
const INVITE_TOKEN = "invite-token-1";

const SKILL_PATH = "{claude}/skills/foo/SKILL.md";
const SKILL_CONTENT = "---\nname: foo\ndescription: skill do time\n---\nconteudo do time\n";

/**
 * FAKE in-process backend. Same contract as the real one for the paths the app
 * uses. The `refresh_token` identifies the account (`owner`/`member`).
 */
function startFakeBackend(port) {
  let revision = 0;
  let manifest = [];
  const blobs = new Map();
  const members = [{ team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null }];
  const team = { id: TEAM_ID, name: "Acme", slug: "acme", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z" };

  function accountOf(req) {
    const auth = req.headers.authorization ?? "";
    const m = String(auth).match(/^Bearer a:(.+)$/);
    return m ? m[1] : null;
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const jsonBody = (() => {
        try {
          return JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          return {};
        }
      })();
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        const text = obj === null ? "" : JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(text);
      };
      const raw404 = () => send(404, { error: { code: "not_found", message: path } });

      if (path === "/v1/auth/token" && req.method === "POST") {
        const who = jsonBody.refresh_token === "member-refresh" ? "member" : "owner";
        return send(200, { access_token: `a:${who}`, refresh_token: jsonBody.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();

      const who = accountOf(req);
      if (!who) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });

      const me = () => {
        const isOwner = who === "owner";
        const accId = isOwner ? OWNER_ACC : MEMBER_ACC;
        const profileId = isOwner ? OWNER_P : MEMBER_P;
        const email = isOwner ? "owner@example.com" : "member@example.com";
        const joined = members.some((m) => m.account_id === accId);
        return {
          account: { id: accId, display_name: isOwner ? "Owner" : "Member", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ id: accId, account_id: accId, kind: "email", subject: email, verified_at: "2026-10-05T00:00:00Z", created_at: null, login: null }],
          profiles: [{ id: profileId, account_id: accId, kind: "personal", team_id: null, name: "Pessoal", created_at: "2026-10-05T00:00:00Z" }],
          teams: joined || isOwner ? [team] : [],
        };
      };

      if (path === "/v1/me" && req.method === "GET") return send(200, me());
      if (path === "/v1/teams" && req.method === "POST") return send(201, team);
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") return send(200, { team, members });
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "POST") {
        return send(201, { id: INVITE_ID, team_id: TEAM_ID, target: jsonBody.target, role: jsonBody.role, invited_by: OWNER_ACC, expires_at: null, accepted_at: null, revoked_at: null, created_at: null });
      }
      if (path === `/v1/invites/${INVITE_TOKEN}/accept` && req.method === "POST") {
        const accId = who === "owner" ? OWNER_ACC : MEMBER_ACC;
        if (!members.some((m) => m.account_id === accId)) {
          members.push({ team_id: TEAM_ID, account_id: accId, role: "member", joined_at: null });
        }
        return send(200, { team, membership: { team_id: TEAM_ID, account_id: accId, role: "member", joined_at: null } });
      }
      if (path === `/v1/teams/${TEAM_ID}/house`) {
        if (req.method === "GET") return send(200, { revision, manifest });
        if (req.method === "PUT") {
          if (req.headers["if-match"] !== String(revision)) {
            return send(409, { error: { code: "revision_conflict", message: "conflict" }, current_revision: revision, current_manifest: manifest });
          }
          manifest = jsonBody.manifest ?? [];
          revision += 1;
          return send(200, { revision, manifest });
        }
      }
      if (path === "/v1/blobs/check" && req.method === "POST") {
        const asked = jsonBody.sha256 ?? [];
        return send(200, { missing: asked.filter((s) => !blobs.has(s)) });
      }
      const blob = path.match(/^\/v1\/blobs\/([0-9a-f]{64})$/);
      if (blob && req.method === "PUT") {
        blobs.set(blob[1], Buffer.from(raw));
        return send(201, { sha256: blob[1], created: true });
      }
      if (blob && req.method === "GET") {
        const got = blobs.get(blob[1]);
        if (!got) return send(404, { error: { code: "not_found", message: "no blob" } });
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(got);
      }
      return raw404();
    });
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve())),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    paths: () => manifest.map((e) => e.path),
    revision: () => revision,
    // Test hooks: a hostile base can be published without going through the app.
    setManifest: (next, rev) => {
      manifest = next;
      revision = rev;
    },
    putBlob: (sha, bytes) => blobs.set(sha, Buffer.from(bytes)),
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

function writeFileAt(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function waitForCloud(page) {
  for (let i = 0; i < 60; i++) {
    try {
      const status = JSON.parse(await page.evalJs(`(async () => JSON.stringify(await window.cloud.status()))()`));
      if (status.state === "logged-in") return status;
    } catch {
      /* the page is still mounting */
    }
    await delay(250);
  }
  throw new Error("login (cloud) não completou a tempo");
}

const ownerUserData = mkdtempSync(join(tmpdir(), "stellar-team-owner-"));
const memberUserData = mkdtempSync(join(tmpdir(), "stellar-team-member-"));
console.log("[smoke] owner:", ownerUserData, "| member:", memberUserData);

let backend;
let ownerApp;
let memberApp;
try {
  const apiPort = await pickFreePort();
  backend = startFakeBackend(apiPort);
  await backend.listen();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  // ---- OWNER: create the team and publish the base -------------------------
  seedUserData(ownerUserData, OWNER_P, "Pessoal", "owner-refresh");
  writeFileAt(ownerUserData, join("profiles", OWNER_P, "homes", "claude", "skills", "foo", "SKILL.md"), SKILL_CONTENT);
  // project memory under the house: it must NOT go into the team base.
  writeFileAt(ownerUserData, join("profiles", OWNER_P, "homes", "claude", "projects", "-home-u-proj", "memory", "nota.md"), "memoria pessoal");

  const ownerCdp = await pickFreePort();
  ownerApp = await startApp({
    cdpPort: ownerCdp,
    userDataDir: ownerUserData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const ownerPage = await connectPage(ownerCdp);
  const ownerStatus = await waitForCloud(ownerPage);
  check("owner entra na conta", ownerStatus.account.displayName, "Owner");

  const created = JSON.parse(await ownerPage.evalJs(`(async () => JSON.stringify(await window.team.create({ name: "Acme" })))()`));
  check("owner cria o time", created.ok && created.value.team.slug, "acme");

  const preview = JSON.parse(await ownerPage.evalJs(`(async () => JSON.stringify(await window.team.publishPreview("${TEAM_ID}")))()`));
  check("prévia inclui a skill", preview.ok && preview.preview.entries.some((e) => e.path === SKILL_PATH), true);
  check(
    "prévia NÃO inclui memória",
    preview.ok && preview.preview.entries.every((e) => !e.path.includes("memory")),
    true,
  );

  const published = JSON.parse(await ownerPage.evalJs(`(async () => JSON.stringify(await window.team.publish("${TEAM_ID}")))()`));
  check("owner publica a base", published.ok, true);
  check("servidor guardou a skill", backend.paths().includes(SKILL_PATH), true);
  check("servidor NÃO guardou memória", backend.paths().every((p) => !p.includes("memory")), true);

  const invite = JSON.parse(
    await ownerPage.evalJs(`(async () => JSON.stringify(await window.team.invite("${TEAM_ID}", { target: "member@example.com", role: "member" })))()`),
  );
  check("owner convida por e-mail", invite.ok, true);

  // ---- MEMBER: accept the invite and materialize the base ------------------
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
  const memberStatus = await waitForCloud(memberPage);
  check("membro entra na conta", memberStatus.account.displayName, "Member");

  const accepted = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.team.acceptInvite("${INVITE_TOKEN}")))()`));
  check("membro aceita o convite", accepted.ok, true);
  check("aceite cria o perfil de time ligado ao time", accepted.ok && accepted.value.team.id, TEAM_ID);

  const profiles = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.profiles.list()))()`));
  const teamProfile = profiles.profiles.find((p) => p.teamId === TEAM_ID);
  check("perfil de time existe e está isolado", teamProfile && teamProfile.homeMode, "isolated");

  const pull = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.team.pullPreview("${TEAM_ID}")))()`));
  check(
    "prévia da chegada já mostra o prefixo do time",
    pull.ok && pull.value.plan.items.some((i) => i.path === "{claude}/skills/team-acme-foo/SKILL.md"),
    true,
  );

  const applied = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.team.pullApply("${TEAM_ID}", {})))()`));
  check("membro aplica a base", applied.ok, true);

  const written = join(memberUserData, "profiles", teamProfile?.id ?? "missing", "homes", "claude", "skills", "team-acme-foo", "SKILL.md");
  check("skill do time no membro COM prefixo team-acme-", existsSync(written), true);
  if (existsSync(written)) {
    check("conteúdo da skill chegou inteiro", readFileSync(written, "utf-8"), SKILL_CONTENT);
  }

  // ---- HOSTILE base: a traversal path must be refused, not written ---------
  // A base applied inside every member's home cannot trust the sender: a path
  // like `{claude}/../../.bashrc` would write outside the profile without the
  // app's own guard. After the prefix it becomes `{claude}/../../team-acme-.bashrc`.
  const evilPath = "{claude}/../../.bashrc";
  const evilContent = "implantado\n";
  const evilSha = createHash("sha256").update(Buffer.from(evilContent)).digest("hex");
  backend.putBlob(evilSha, Buffer.from(evilContent));
  backend.setManifest([{ tool: "claude", path: evilPath, sha256: evilSha, size: evilContent.length, mode: "100644" }], backend.revision() + 1);

  const evilPreview = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.team.pullPreview("${TEAM_ID}")))()`));
  const evilItem = evilPreview.ok ? evilPreview.value.plan.items.find((i) => i.path.includes(".bashrc")) : null;
  check("caminho hostil vira pending unsafe-path", evilItem && evilItem.action, "pending");

  const evilApplied = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.team.pullApply("${TEAM_ID}", {})))()`));
  check("aplicar a base hostil NÃO escreve nada", evilApplied.ok && evilApplied.result.written.length, 0);
  const escaped = join(memberUserData, "profiles", teamProfile?.id ?? "missing", "homes", "team-acme-.bashrc");
  check("arquivo não escapou para fora da raiz", existsSync(escaped), false);

  ownerPage.close();
  memberPage.close();
} finally {
  if (ownerApp) await stopApp(ownerApp);
  if (memberApp) await stopApp(memberApp);
  if (backend) await backend.close();
  rmSync(ownerUserData, { recursive: true, force: true });
  rmSync(memberUserData, { recursive: true, force: true });
  rmSync(`${ownerUserData}-home`, { recursive: true, force: true });
  rmSync(`${memberUserData}-home`, { recursive: true, force: true });
  console.log("[smoke] removidos:", ownerUserData, memberUserData);
}
finish();
process.exit(0);
