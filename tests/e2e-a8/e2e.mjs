// A8 — E2E proof against the REAL backend (StellarCloud + Postgres container).
//
// Two isolated app instances ("machine A" / "machine B"), each with its own
// userData and fake $HOME, against the local backend with a fake GitHub. Proves
// steps 2-5 of E v2 (the house leaves one machine and arrives on another of the
// SAME account) and step 9 (a removed member turns the team profile off). Prints
// go to /tmp/stellar-a8.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.env.STELLAR_A8_REPO ?? "/home/lucas/Workplace/Projects/Stellar";
const STATE = process.env.STELLAR_A8_STATE ?? "/tmp/stellar-a8";
const OUT = join(STATE, "prints");
const API = `http://127.0.0.1:${readFileSync(`${STATE}/apiport`, "utf8").trim()}`;
const GH = `http://127.0.0.1:${readFileSync(`${STATE}/ghport`, "utf8").trim()}`;

const cdp = await import(`file://${join(REPO, "scripts/verify/cdp-client.mjs")}`);
mkdirSync(OUT, { recursive: true });

setTimeout(() => {
  console.error("[a8] WATCHDOG: tempo esgotado — abortando");
  try {
    spawnSync("python3", [join(STATE, "cleanup-e2e.py")]);
  } catch {
    /* ignore */
  }
  process.exit(3);
}, 900000).unref?.();

const results = [];
let checks = 0;
let failed = 0;
function check(label, actual, expected) {
  checks++;
  const ok = typeof expected === "function" ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${ok ? "" : ` (got ${JSON.stringify(actual)})`}`);
  results.push({ label, ok, actual });
  return ok;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let shotSeq = 0;
async function shot(page, name) {
  try {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `passo-${String(++shotSeq).padStart(2, "0")}-${name}.png`);
    writeFileSync(file, Buffer.from(res.data, "base64"));
    console.log(`  [print] ${file}`);
  } catch (e) {
    console.log(`  [print] falhou ${name}: ${String(e).slice(0, 120)}`);
  }
}
async function evalJson(page, expr) {
  return JSON.parse(await page.evalJs(`(async () => JSON.stringify(${expr}))()`));
}
async function waitCloud(page, state, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const s = await evalJson(page, "await window.cloud.status()");
      if (s.state === state) return s;
    } catch {
      /* mounting */
    }
    await delay(250);
  }
  throw new Error(`cloud não chegou a ${state}`);
}

function writeAt(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function seedClaudeHouse(claudeRoot, cloneRoot, tag) {
  writeAt(claudeRoot, "CLAUDE.md", `# Regras do projeto (${tag})\n\nSempre teste. @regras/extra.md\n`);
  writeAt(claudeRoot, "regras/extra.md", `regra incluida via @ (${tag})\n`);
  writeAt(claudeRoot, "skills/deploy/SKILL.md", `---\nname: deploy\ndescription: skill pessoal ${tag}\n---\nfaca deploy ${tag}\n`);
  writeAt(claudeRoot, "agents/revisor.md", `---\nname: revisor\ndescription: agente ${tag}\n---\nrevisa ${tag}\n`);
  mkdirSync(join(cloneRoot, ".git"), { recursive: true });
  writeFileSync(
    join(cloneRoot, ".git/config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/seth0s/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  writeFileSync(join(cloneRoot, "README.md"), "# demo\n");
  writeAt(claudeRoot, join("projects", cloneRoot.replace(/\//g, "-"), "memory", "nota.md"), "memoria do projeto demo\n");
  writeFileSync(join(claudeRoot, ".credentials.json"), JSON.stringify({ token: `FAKE-CREDENTIAL-${tag}-DO-NOT-SYNC` }));
}

/** The RECEIVING machine: the project clone exists (so memory lands right) and
 *  it has its OWN credential, but its house is otherwise EMPTY — a fresh
 *  install receiving the account's house. That is the honest shape of step 3:
 *  a machine that already has divergent files is a conflict, not a receive. */
function seedReceiveMachine(claudeRoot, cloneRoot) {
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(join(cloneRoot, ".git"), { recursive: true });
  writeFileSync(
    join(cloneRoot, ".git/config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/seth0s/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  writeFileSync(join(cloneRoot, "README.md"), "# demo\n");
  writeFileSync(join(claudeRoot, ".credentials.json"), JSON.stringify({ token: "FAKE-CREDENTIAL-B-DO-NOT-SYNC" }));
}

async function startMachine({ userData, home, profileId }) {
  const port = await cdp.pickFreePort();
  const app = await cdp.startApp({
    cdpPort: port,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: false,
    extraArgs: profileId ? [`--profile=${profileId}`] : [],
    extraEnv: { HOME: home, STELLARCLOUD_API_URL: API, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const page = await cdp.connectPage(port);
  await delay(700);
  return { app, page };
}
async function stopMachine(m) {
  if (!m) return;
  try {
    m.page.close();
  } catch {
    /* */
  }
  try {
    await cdp.stopApp(m.app);
  } catch {
    /* */
  }
  await delay(300);
}
async function completeGithubLogin(app) {
  for (let i = 0; i < 80; i++) {
    const m = app.stderr().match(/STELLARCLOUD_AUTH_URL=(\S+)/g);
    if (m && m.length) {
      const url = m[m.length - 1].slice("STELLARCLOUD_AUTH_URL=".length);
      await fetch(url, { redirect: "follow" }).catch(() => {});
      return url;
    }
    await delay(200);
  }
  throw new Error("a URL de login do GitHub não apareceu no stderr");
}
async function setGithubUser(user) {
  await fetch(`${GH}/__control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user }) });
}

const ALICE = { id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" };
const BOB = { id: 7654321, login: "bob-gh", name: "Bob GitHub", email: "member@example.com" };

const A = mkdtempSync(join(tmpdir(), "stellar-a8-A-"));
const B = mkdtempSync(join(tmpdir(), "stellar-a8-B-"));
const homeA = `${A}-home`;
const homeB = `${B}-home`;
mkdirSync(homeA, { recursive: true });
mkdirSync(homeB, { recursive: true });
console.log(`[a8] A=${A}  B=${B}`);
console.log(`[a8] API=${API}  GH=${GH}`);

let mA, mB, pageA, pageB;
try {
  // ---- STEP 1: A migrates, brings the house up and logs in -------------
  console.log("\n== A: migra, loga (alice), sincroniza a casa ==");
  writeFileSync(join(A, "providers.json"), JSON.stringify({ schema: "legacy-providers", providers: ["commandcode"] }, null, 2));
  writeFileSync(join(A, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  mA = await startMachine({ userData: A, home: homeA });
  pageA = mA.page;
  await delay(500);
  const regA = JSON.parse(readFileSync(join(A, "profiles.json"), "utf8"));
  const personalA = regA.profiles[0]?.id;
  check("A: perfil pessoal criado na migração", regA.profiles[0]?.kind, "personal");
  const claudeA = join(homeA, ".claude");
  seedClaudeHouse(claudeA, join(homeA, "work", "demo"), "A");

  await setGithubUser(ALICE);
  await evalJson(pageA, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mA.app);
  const aStatus = await waitCloud(pageA, "logged-in");
  check("A logado na conta", aStatus.account.displayName, "Alice GitHub");

  await evalJson(pageA, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageA, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeA, "work"))}])`);
  const previewA = await evalJson(pageA, `await window.workhome.preview()`);
  check("A: prévia da casa responde (nada remoto ainda)", previewA.ok, true);
  const syncA = await evalJson(pageA, `await window.workhome.syncNow()`);
  console.log("  syncNow A:", JSON.stringify(syncA).slice(0, 400));
  check("PASSO 2 — A sincroniza a casa (não é mais 'profile not found')", !!(syncA.ok && (syncA.kind === "pushed" || syncA.kind === "conflicts")), true);

  // The profile is now REGISTERED on the server and the link is stored.
  const linkA = await evalJson(pageA, `await window.profiles.cloudLink()`);
  console.log("  cloudLink A:", JSON.stringify(linkA).slice(0, 300));
  check("PASSO 2 — o perfil de A está registrado no servidor (cloudProfileId)", linkA.ok && typeof linkA.view.cloudProfileId === "string", true);
  const aCloudId = linkA.ok ? linkA.view.cloudProfileId : null;
  await shot(pageA, "A-casa-sincronizada");

  // ---- STEP 3: B logs in with the SAME account and receives the house ---
  console.log("\n== PASSO 3: B loga com a MESMA conta e recebe a casa ==");
  writeFileSync(join(B, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  mB = await startMachine({ userData: B, home: homeB });
  pageB = mB.page;
  await delay(500);
  const claudeB = join(homeB, ".claude");
  seedReceiveMachine(claudeB, join(homeB, "dev", "demo"));

  await setGithubUser(ALICE);
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bStatus = await waitCloud(pageB, "logged-in");
  check("B logado na MESMA conta", bStatus.account.displayName, "Alice GitHub");

  // B links (by name/kind) to the SAME server profile A did.
  const linkB1 = await evalJson(pageB, `await window.profiles.cloudLink()`);
  await evalJson(pageB, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageB, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeB, "dev"))}])`);
  const previewB = await evalJson(pageB, `await window.workhome.preview()`);
  console.log("  preview B:", JSON.stringify(previewB).slice(0, 400));
  check("PASSO 3 — B vincula ao MESMO perfil de servidor de A", previewB.ok, true);
  const linkB2 = await evalJson(pageB, `await window.profiles.cloudLink()`);
  check("PASSO 3 — B usa o cloudProfileId de A", linkB2.ok && linkB2.view.cloudProfileId === aCloudId, true);
  void linkB1;

  const applyB = await evalJson(pageB, `await window.workhome.apply({})`);
  console.log("  apply B written:", applyB.ok ? JSON.stringify(applyB.result.written.map((w) => w.path)) : JSON.stringify(applyB));
  console.log("  apply B pending:", applyB.ok ? JSON.stringify(applyB.result.pending) : "n/a");
  console.log("  apply B warnings:", applyB.ok ? JSON.stringify(applyB.result.warnings) : "n/a");
  check("PASSO 3 — B aplica a casa de A", applyB.ok, true);
  const claudeMd = existsSync(join(claudeB, "CLAUDE.md")) ? readFileSync(join(claudeB, "CLAUDE.md"), "utf8") : "";
  check("PASSO 3 — CLAUDE.md de B veio de A (tag A)", claudeMd.includes("(A)"), true);
  // Project memory goes back under `<claude>/projects/<encoded clone>/memory`
  // (see work-home-apply-decision.ts) — the encoding is the clone path.
  const encodedCloneB = join(homeB, "dev", "demo").replace(/\//g, "-");
  check(
    "PASSO 3 — memória identificada no clone certo de B",
    existsSync(join(claudeB, "projects", encodedCloneB, "memory", "nota.md")),
    true,
  );
  const credB = existsSync(join(claudeB, ".credentials.json")) ? readFileSync(join(claudeB, ".credentials.json"), "utf8") : "";
  check("PASSO 3 — credencial de A NÃO viajou", !credB.includes("FAKE-CREDENTIAL-A-"), true);
  check("PASSO 3 — credencial de B continua a de B", credB.includes("FAKE-CREDENTIAL-B-"), true);
  await shot(pageB, "B-casa-recebida");

  // ---- STEP 4: DIFFERENT files on both sides merge on their own ---------
  console.log("\n== PASSO 4: arquivos diferentes mesclam sozinhos ==");
  writeFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\neditado em B\n");
  writeFileSync(join(claudeA, "agents", "revisor.md"), "---\nname: revisor\n---\neditado em A\n");
  const syncA2 = await evalJson(pageA, `await window.workhome.syncNow()`);
  check("PASSO 4 — A publica", syncA2.ok, true);
  const applyB2 = await evalJson(pageB, `await window.workhome.apply({})`);
  console.log("  apply B (passo 4):", JSON.stringify(applyB2).slice(0, 300));
  check("PASSO 4 — B mescla sozinho (0 conflitos)", applyB2.ok && applyB2.result.conflicts.length === 0, true);
  const revisorB = readFileSync(join(claudeB, "agents", "revisor.md"), "utf8");
  check("PASSO 4 — a edição de A chegou em B", revisorB.includes("editado em A"), true);
  const skillB = readFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "utf8");
  check("PASSO 4 — B manteve a própria edição", skillB.includes("editado em B"), true);
  await shot(pageB, "B-merge-arquivos-diferentes");

  // ---- STEP 5: the SAME file on both sides becomes a conflict -----------
  console.log("\n== PASSO 5: mesmo arquivo dos dois lados ==");
  writeFileSync(join(claudeA, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao A\n");
  writeFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao B\n");
  await evalJson(pageA, `await window.workhome.syncNow()`);
  const conflictB = await evalJson(pageB, `await window.workhome.preview()`);
  const conflictItems = conflictB.ok ? conflictB.plan.items.filter((i) => i.action === "conflict") : [];
  check("PASSO 5 — o conflito aparece para a escolha", conflictItems.length >= 1, true);
  await shot(pageB, "B-conflito");

  // ---- STEP 9 (devices): after the house, two devices of the same account.
  //      Disconnecting the other revokes its session, so this runs LAST before
  //      B switches accounts.
  console.log("\n== PASSO 9: dispositivos ==");
  const devicesA = await evalJson(pageA, `await window.cloud.devices.list()`);
  console.log("  devices A:", JSON.stringify(devicesA).slice(0, 400));
  check("PASSO 9 — o app lista as máquinas da conta", Array.isArray(devicesA) && devicesA.length >= 2, true);
  check("PASSO 9 — exatamente uma é 'esta máquina'", devicesA.filter((d) => d.current).length, 1);
  const other = devicesA.find((d) => !d.current);
  const revoked = other ? await evalJson(pageA, `await window.cloud.devices.disconnect(${JSON.stringify(other.id)})`) : { ok: false };
  check("PASSO 9 — desconectar outra máquina devolve ok", revoked.ok, true);

  // ---- STEP 9 (team): A removes B and B's team profile turns off -------
  console.log("\n== PASSO 9: A cria time, convida bob; B aceita; A remove; perfil de B desliga ==");
  const team = await evalJson(pageA, `await window.team.create({ name: "Acme" })`);
  check("A cria o time", team.ok && team.value?.team?.slug, "acme");
  const teamId = team.value?.team?.id;
  const invGh = await evalJson(pageA, `await window.team.invite(${JSON.stringify(teamId)}, { target: "bob-gh", role: "member" })`);
  check("A convida por login GitHub", invGh.ok, true);

  await evalJson(pageB, `await window.cloud.logout()`).catch(() => {});
  await setGithubUser(BOB);
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bMember = await waitCloud(pageB, "logged-in");
  check("B logado como o membro (bob-gh)", bMember.account.displayName, "Bob GitHub");

  // The invite token is in the backend log (log mailer).
  const apiLog = existsSync(`${STATE}/logs/api.log`) ? readFileSync(`${STATE}/logs/api.log`, "utf8") : "";
  const tokens = [...apiLog.matchAll(/stellar:\/\/invite\?token=([A-Za-z0-9_\-]+)/g)].map((m) => m[1]);
  let accepted = null;
  for (const t of tokens) {
    const r = await evalJson(pageB, `await window.team.acceptInvite(${JSON.stringify(t)})`);
    if (r.ok) {
      accepted = r;
      break;
    }
  }
  check("B aceita o convite", !!accepted, true);
  const profilesB = await evalJson(pageB, `await window.profiles.list()`);
  const teamProfileB = profilesB.profiles.find((p) => p.teamId === teamId);
  check("perfil de time aparece em B (ativo)", !!teamProfileB && teamProfileB.detached === false, true);

  const detailA = await evalJson(pageA, `await window.team.detail(${JSON.stringify(teamId)})`);
  const membersA = detailA.ok ? detailA.detail?.members ?? detailA.value?.members ?? [] : [];
  const bobMember = membersA.find((m) => m.role === "member");
  const removed = bobMember ? await evalJson(pageA, `await window.team.removeMember(${JSON.stringify(teamId)}, ${JSON.stringify(bobMember.accountId)})`) : { ok: false, error: "sem membro" };
  check("A remove o membro", removed.ok, true);

  // B finds out on a team endpoint (404) and the profile turns off.
  const detailB = await evalJson(pageB, `await window.team.detail(${JSON.stringify(teamId)})`);
  console.log("  detail B após remoção:", JSON.stringify(detailB).slice(0, 200));
  check("B recebe 404 do endpoint de time", detailB.ok, false);
  const profilesB2 = await evalJson(pageB, `await window.profiles.list()`);
  const teamProfileB2 = profilesB2.profiles.find((p) => p.teamId === teamId);
  check("PASSO 9 — o perfil de time de B ficou detached", !!teamProfileB2 && teamProfileB2.detached === true, true);
  const profilesA2 = await evalJson(pageA, `await window.profiles.list()`);
  const teamProfileA = profilesA2.profiles.find((p) => p.teamId === teamId);
  check("PASSO 9 — o perfil de time de A (removedor) CONTINUA ativo", !!teamProfileA && teamProfileA.detached === false, true);
  await shot(pageB, "B-time-desligado");

  console.log(`\n[a8] fim. checks: ${checks} failed: ${failed}`);
} catch (err) {
  console.log("\n[a8] ERRO NÃO TRATADO:", String(err && err.stack ? err.stack : err));
  failed++;
} finally {
  writeFileSync(join(STATE, "a8-results.json"), JSON.stringify({ checks, failed, results }, null, 2));
  try {
    pageA?.close();
  } catch {
    /* */
  }
  try {
    pageB?.close();
  } catch {
    /* */
  }
  try {
    await stopMachine(mA);
  } catch {
    /* */
  }
  try {
    await stopMachine(mB);
  } catch {
    /* */
  }
  try {
    spawnSync("python3", [join(STATE, "cleanup-e2e.py")]);
  } catch {
    /* */
  }
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
  rmSync(A, { recursive: true, force: true });
  rmSync(B, { recursive: true, force: true });
  console.log("[a8] cleanup ok");
  process.exit(failed === 0 ? 0 : 1);
}
