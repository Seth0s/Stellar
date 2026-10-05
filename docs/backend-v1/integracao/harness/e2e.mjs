// BACKEND_V1 · E (v2) — end-to-end measurement driver (does NOT edit product code).
//
// Two isolated Electron instances ("machine A" / "machine B"), each with its own
// userData + fake $HOME + fake CLI folders, against the REAL local backend
// (StellarCloud) with a fake GitHub and the log mailer. Evidence: PASS/FAIL per
// step + a screenshot per step under Stellar/docs/backend-v1/integracao/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = "/home/lucas/Workplace/Projects/Stellar";
const SCRATCH = "/tmp/commandcode-1000/-home-lucas-Workplace-Projects-Stellar/120e41f8-0ce6-4bf3-b1a8-4803a9363a9c/scratchpad";
const OUT = join(REPO, "docs/backend-v1/integracao");
const API = `http://127.0.0.1:${readFileSync(`${SCRATCH}/apiport`, "utf8").trim()}`;
const GH = `http://127.0.0.1:${readFileSync(`${SCRATCH}/ghport`, "utf8").trim()}`;
const API_LOG = `${SCRATCH}/logs/api.log`;

const cdp = await import(`file://${join(REPO, "scripts/verify/cdp-client.mjs")}`);

mkdirSync(OUT, { recursive: true });

setTimeout(() => {
  console.error("[e2e] WATCHDOG: tempo esgotado — abortando");
  try { spawnSync("python3", [join(SCRATCH, "cleanup-e2e.py")]); } catch { /* ignore */ }
  process.exit(3);
}, 900000).unref?.();

const results = [];
const defects = [];
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
function defect(step, expected, got, evidence) {
  defects.push({ step, expected, got, evidence });
  console.log(`  DEFEITO — [${step}] esperado: ${expected} | obtido: ${got} | evidência: ${evidence}`);
}
const blockedList = [];
function blocked(label, reason) {
  blockedList.push({ label, reason });
  console.log(`BLOQUEADO (NÃO MEDIDO) — ${label} — motivo: ${reason}`);
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
    } catch { /* mounting */ }
    await delay(250);
  }
  throw new Error(`cloud não chegou a ${state}`);
}

function writeAt(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function seedClaudeHouse(claudeRoot, cloneRoot, tag = "A") {
  writeAt(claudeRoot, "CLAUDE.md", `# Regras do projeto (${tag})\n\nSempre teste. @regras/extra.md\n`);
  writeAt(claudeRoot, "regras/extra.md", `regra incluida via @ (${tag})\n`);
  writeAt(claudeRoot, "skills/deploy/SKILL.md", `---\nname: deploy\ndescription: skill pessoal ${tag}\n---\nfaca deploy ${tag}\n`);
  writeAt(claudeRoot, "agents/revisor.md", `---\nname: revisor\ndescription: agente ${tag}\n---\nrevisa ${tag}\n`);
  writeAt(claudeRoot, "settings.json", JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] }, env: { SECRET_TOKEN: "NAO-DEVE-VIAJAR" } }, null, 2));
  writeAt(claudeRoot, ".credentials.json", JSON.stringify({ token: `FAKE-CREDENTIAL-${tag}-DO-NOT-SYNC` }));
  mkdirSync(join(cloneRoot, ".git"), { recursive: true });
  writeFileSync(join(cloneRoot, ".git/config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/seth0s/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  writeFileSync(join(cloneRoot, "README.md"), "# demo\n");
  const encoded = cloneRoot.replace(/\//g, "-");
  writeAt(claudeRoot, join("projects", encoded, "memory", "nota.md"), "memoria do projeto demo\n");
  return { cloneRoot, encoded };
}

async function startMachine({ userData, home, profileId }) {
  // preserveUserData: true -> never wipe; isolatedHome: false + explicit HOME so
  // the child sees ONLY the fake home (no real CLIs) and we keep what we seeded.
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
  try { m.page.close(); } catch { /* */ }
  try { await cdp.stopApp(m.app); } catch { /* */ }
  await delay(300);
}
async function switchAndReconnect(app, page, profileId) {
  void page.evalJs(`window.profiles.switch(${JSON.stringify(profileId)})`).catch(() => {});
  await delay(1200);
  try { page.close(); } catch { /* */ }
  for (let i = 0; i < 90; i++) {
    try { return await cdp.connectPage(app.cdpPort); } catch { await delay(400); }
  }
  throw new Error("app não voltou após a troca de perfil");
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
function mailerLinks(kind) {
  const log = existsSync(API_LOG) ? readFileSync(API_LOG, "utf8") : "";
  if (kind === "invite") return [...log.matchAll(/stellar:\/\/invite\?token=([A-Za-z0-9_\-]+)/g)].map((m) => m[1]);
  return [...log.matchAll(/http:\/\/127\.0\.0\.1:\d+\/v1\/auth\/email\/verify\?token=([A-Za-z0-9_\-]+)/g)].map((m) => m[1]);
}

// ===========================================================================
const A = mkdtempSync(join(tmpdir(), "stellar-e2e-A-"));
const B = mkdtempSync(join(tmpdir(), "stellar-e2e-B-"));
const homeA = `${A}-home`;
const homeB = `${B}-home`;
mkdirSync(homeA, { recursive: true });
mkdirSync(homeB, { recursive: true });
console.log(`[e2e] A=${A}  B=${B}`);
console.log(`[e2e] API=${API}  GH=${GH}`);

let mA, mB, pageA, pageB, appA;
try {
  // ---- PASSO 1: A migra para perfis, cria Empresa (isolated) e loga ---------
  console.log("\n== PASSO 1: A migra para perfis, cria perfil Empresa (isolated) e loga ==");
  writeFileSync(join(A, "providers.json"), JSON.stringify({ schema: "legacy-providers", providers: ["commandcode"] }, null, 2));
  writeFileSync(join(A, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));

  mA = await startMachine({ userData: A, home: homeA });
  pageA = mA.page;
  await delay(500);
  const reg = JSON.parse(readFileSync(join(A, "profiles.json"), "utf8"));
  const personalId = reg.profiles[0]?.id;
  console.log("  profiles.json:", JSON.stringify(reg));
  check("migração criou o perfil pessoal", reg.profiles[0]?.kind, "personal");
  check("providers.json da raiz migrou para profiles/<id>/", existsSync(join(A, "profiles", personalId, "providers.json")), true);
  check("providers.json NÃO ficou na raiz", existsSync(join(A, "providers.json")), false);
  await shot(pageA, "migracao-perfis");

  const created = await evalJson(pageA, `await window.profiles.create({ name: "Empresa", kind: "personal" })`);
  const empresaId = created.state.profiles.find((p) => p.name === "Empresa")?.id;
  check("perfil Empresa criado", !!empresaId, true);
  await evalJson(pageA, `await window.profiles.setHomeMode(${JSON.stringify(empresaId)}, "isolated")`);
  const afterMode = await evalJson(pageA, `await window.profiles.list()`);
  check("perfil Empresa em modo isolated", afterMode.profiles.find((p) => p.id === empresaId)?.homeMode, "isolated");
  await shot(pageA, "perfil-empresa-isolated");

  // seed the Empresa (isolated) CLI house + project clone + memory
  const empresaDir = join(A, "profiles", empresaId);
  const empresaClaude = join(empresaDir, "homes", "claude");
  const seedA = seedClaudeHouse(empresaClaude, join(homeA, "work", "demo"));
  console.log("  casa Empresa A:", empresaClaude, "| clone:", seedA.cloneRoot);

  // relaunch into Empresa (new instance, stderr captured) and log in
  await stopMachine(mA);
  mA = await startMachine({ userData: A, home: homeA, profileId: empresaId });
  pageA = mA.page;
  appA = mA.app;
  const sw = await evalJson(pageA, `await window.profiles.list()`);
  check("app reabriu no perfil Empresa", sw.activeProfileId, empresaId);
  await shot(pageA, "app-reaberto-empresa");

  await setGithubUser({ id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" });
  await evalJson(pageA, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(appA);
  const aStatus = await waitCloud(pageA, "logged-in");
  check("A logado na conta (GitHub)", aStatus.account.displayName, "Alice GitHub");
  await shot(pageA, "A-logado");

  // ---- PASSO 2: A sincroniza a casa ----------------------------------------
  console.log("\n== PASSO 2: A sincroniza a casa ==");
  await evalJson(pageA, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageA, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeA, "work"))}])`);
  const previewA = await evalJson(pageA, `await window.workhome.preview()`);
  console.log("  preview A:", JSON.stringify(previewA).slice(0, 500));
  check("A: prévia da casa lista arquivos", previewA.ok && previewA.plan, true);
  const syncA = await evalJson(pageA, `await window.workhome.syncNow()`);
  console.log("  syncNow A:", JSON.stringify(syncA).slice(0, 600));
  const synthOk = !!(syncA.ok && (syncA.kind === "pushed" || syncA.kind === "conflicts"));
  const houseSyncOk = synthOk;
  check("A sincronizou a casa (push aceito)", synthOk, true);
  if (!synthOk) {
    defect("passo 2 (A sincroniza a casa)", "push da casa aceito pelo backend", JSON.stringify(syncA).slice(0, 300), "app manda GET/PUT /v1/profiles/<id LOCAL>/house; GET /v1/me.profiles=[] (o app nunca registra o perfil no servidor)");
  }
  await shot(pageA, "A-casa-sincronizada");

  // ---- PASSO 3: B loga com a mesma conta -----------------------------------
  console.log("\n== PASSO 3: B loga com a MESMA conta ==");
  writeFileSync(join(B, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  mB = await startMachine({ userData: B, home: homeB });
  pageB = mB.page;
  await delay(500);
  const regB = JSON.parse(readFileSync(join(B, "profiles.json"), "utf8"));
  const personalB = regB.profiles[0].id;
  // B's house: personal (system mode) under the fake HOME
  const seedB = seedClaudeHouse(join(homeB, ".claude"), join(homeB, "dev", "demo"));
  console.log("  casa pessoal B:", join(homeB, ".claude"), "| clone:", seedB.cloneRoot);

  await setGithubUser({ id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" });
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bStatus = await waitCloud(pageB, "logged-in");
  check("B logado na MESMA conta", bStatus.account.displayName, "Alice GitHub");
  await shot(pageB, "B-logado");

  await evalJson(pageB, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageB, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeB, "dev"))}])`);
  const previewB = await evalJson(pageB, `await window.workhome.preview()`);
  console.log("  preview B:", JSON.stringify(previewB).slice(0, 500));
  const applyB = await evalJson(pageB, `await window.workhome.apply({})`);
  console.log("  apply B:", JSON.stringify(applyB).slice(0, 500));
  const delivered = !!(previewB.ok && applyB.ok);
  check("B recebeu a casa de A (prévia + apply)", delivered, true);
  const bClaude = join(homeB, ".claude");
  if (delivered) {
    // Honest content checks: B must now carry A's tag, not its own seed.
    const claudeMd = existsSync(join(bClaude, "CLAUDE.md")) ? readFileSync(join(bClaude, "CLAUDE.md"), "utf8") : "";
    check("CLAUDE.md de B veio de A (tag A)", claudeMd.includes("(A)"), true);
    check("memória caiu no CLONE certo de B", existsSync(join(seedB.cloneRoot, "memory", "nota.md")), true);
    const cred = existsSync(join(bClaude, ".credentials.json")) ? readFileSync(join(bClaude, ".credentials.json"), "utf8") : "";
    check("credencial de A NÃO viajou", !cred.includes("FAKE-CREDENTIAL-A-"), true);
    check("credencial de B continua a de B", cred.includes("FAKE-CREDENTIAL-B-"), true);
  } else {
    blocked("passo 3 (B recebe a casa)", `a casa não chega: o passo 2 falhou (${JSON.stringify(previewB).slice(0, 120)})`);
    defect("passo 3 (B recebe a casa)", "CLAUDE.md/skill/memória de A materializados em B; credencial fora", JSON.stringify(previewB).slice(0, 200), "GET/PUT /v1/profiles/<id LOCAL de B>/house → profile not found (id local ≠ id do servidor, que nunca recebeu o perfil)");
  }
  await shot(pageB, "B-casa-recebida");

  // ---- PASSO 4/5: edições dos dois lados -----------------------------------
  if (houseSyncOk && delivered) {
    console.log("\n== PASSO 4: arquivos DIFERENTES editados nos dois lados (mescla sozinha) ==");
    writeFileSync(join(bClaude, "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\neditado em B\n");
    writeFileSync(join(empresaClaude, "agents", "revisor.md"), "---\nname: revisor\n---\neditado em A\n");
    const syncA2 = await evalJson(pageA, `await window.workhome.syncNow()`);
    const applyB2 = await evalJson(pageB, `await window.workhome.apply({})`);
    check("arquivos diferentes: A publica", syncA2.ok, true);
    check("arquivos diferentes: B mescla sozinho (0 conflitos)", applyB2.ok && applyB2.result.conflicts.length === 0, true);
    await shot(pageB, "B-merge-arquivos-diferentes");

    console.log("\n== PASSO 5: MESMO arquivo editado dos dois lados ==");
    writeFileSync(join(empresaClaude, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao A\n");
    writeFileSync(join(bClaude, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao B\n");
    await evalJson(pageA, `await window.workhome.syncNow()`);
    const conflictB = await evalJson(pageB, `await window.workhome.preview()`);
    const conflictItems = conflictB.ok ? conflictB.plan.items.filter((i) => i.action === "conflict") : [];
    console.log("  conflito B:", JSON.stringify(conflictItems));
    check("mesmo arquivo: conflito aparece", conflictItems.length >= 1, true);
    if (conflictItems.length === 0) defect("passo 5 (conflito)", "ação conflict no mesmo arquivo", JSON.stringify(conflictB).slice(0, 300), "ver passo-...-B-conflito.png");
    await shot(pageB, "B-conflito");
  } else {
    blocked("passo 4 (mescla de arquivos diferentes)", "depende do sync da casa (passo 2), que falhou");
    blocked("passo 5 (conflito no mesmo arquivo)", "depende do sync da casa (passo 2), que falhou");
  }

  // ---- PASSO 6: time -------------------------------------------------------
  console.log("\n== PASSO 6: A cria time, convida (e-mail + login GitHub); B aceita ==");
  const team = await evalJson(pageA, `await window.team.create({ name: "Acme" })`);
  console.log("  create team:", JSON.stringify(team).slice(0, 300));
  check("A cria o time", team.ok && team.value?.team?.slug, "acme");
  const teamId = team.value?.team?.id;
  await shot(pageA, "A-time-criado");
  const invEmail = await evalJson(pageA, `await window.team.invite(${JSON.stringify(teamId)}, { target: "member@example.com", role: "member" })`);
  const invGh = await evalJson(pageA, `await window.team.invite(${JSON.stringify(teamId)}, { target: "bob-gh", role: "member" })`);
  console.log("  invite email:", JSON.stringify(invEmail).slice(0, 200), "| invite gh:", JSON.stringify(invGh).slice(0, 200));
  check("A convida por e-mail", invEmail.ok, true);
  check("A convida por login GitHub", invGh.ok, true);
  await shot(pageA, "A-convites");

  // B logs out, logs in as bob-gh (the invited member), accepts
  await evalJson(pageB, `await window.cloud.logout()`);
  await setGithubUser({ id: 7654321, login: "bob-gh", name: "Bob GitHub", email: "member@example.com" });
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bMember = await waitCloud(pageB, "logged-in");
  check("B logado como o membro (bob-gh)", bMember.account.displayName, "Bob GitHub");

  const tokens = mailerLinks("invite");
  console.log("  invite tokens no log:", tokens.length);
  let accepted = null;
  for (const t of tokens) {
    const r = await evalJson(pageB, `await window.team.acceptInvite(${JSON.stringify(t)})`);
    console.log("  accept try:", r.ok, JSON.stringify(r).slice(0, 200));
    if (r.ok) { accepted = r; break; }
  }
  check("B aceita o convite", !!accepted, true);
  const profilesB2 = await evalJson(pageB, `await window.profiles.list()`);
  const teamProfileB = profilesB2.profiles.find((p) => p.teamId === teamId);
  check("perfil de time aparece em B", !!teamProfileB, true);
  check("perfil de time em isolated", teamProfileB?.homeMode, "isolated");
  await shot(pageB, "B-time-aceito");

  // ---- PASSO 7: A publica a base; B recebe com prefixo ----------------------
  console.log("\n== PASSO 7: A publica a base; B recebe com prefixo; memória recusada ==");
  const pubPrev = await evalJson(pageA, `await window.team.publishPreview(${JSON.stringify(teamId)})`);
  console.log("  publishPreview:", JSON.stringify(pubPrev).slice(0, 400));
  const pub = await evalJson(pageA, `await window.team.publish(${JSON.stringify(teamId)})`);
  console.log("  publish:", JSON.stringify(pub).slice(0, 400));
  check("A publica a base", pub.ok, true);
  await shot(pageA, "A-base-publicada");

  const pullPrev = await evalJson(pageB, `await window.team.pullPreview(${JSON.stringify(teamId)})`);
  console.log("  pullPreview B:", JSON.stringify(pullPrev).slice(0, 500));
  const prefixed = pullPrev.ok && pullPrev.value.plan.items.some((i) => i.path.includes("team-acme-"));
  check("B vê a skill do time com prefixo team-acme-", prefixed, true);
  const pullApply = await evalJson(pageB, `await window.team.pullApply(${JSON.stringify(teamId)}, {})`);
  console.log("  pullApply B:", JSON.stringify(pullApply).slice(0, 400));
  await shot(pageB, "B-base-recebida");

  // ---- PASSO 8: trocar de perfil reabre sem vazar --------------------------
  console.log("\n== PASSO 8: trocar de perfil reabre o app sem vazar boards nem a casa ==");
  const beforeSwitch = await evalJson(pageA, `await window.profiles.list()`);
  pageA = await switchAndReconnect(mA.app, pageA, personalId);
  appA = mA.app;
  const afterSwitch = await evalJson(pageA, `await window.profiles.list()`);
  check("troca reabriu no perfil pessoal", afterSwitch.activeProfileId, personalId);
  // the personal profile is a DIFFERENT db dir: the Empresa house must NOT be visible
  const personalClaude = join(A, "profiles", personalId, "homes", "claude");
  check("casa do perfil Empresa não vazou para o pessoal", existsSync(personalClaude), false);
  const cloudAfter = await evalJson(pageA, `await window.cloud.status()`);
  check("login é por perfil: pessoal não herdou a sessão da Empresa", cloudAfter.state, "logged-out");
  await shot(pageA, "A-troca-perfil-sem-vazamento");
  // switch back to Empresa for step 9
  pageA = await switchAndReconnect(mA.app, pageA, empresaId);
  await delay(500);

  // ---- PASSO 9: revogar convite, remover membro, logout, dispositivo --------
  console.log("\n== PASSO 9: revogar convite, remover membro, logout e revogação de dispositivo ==");
  // revoke the pending e-mail invite (the one not accepted)
  const pendingEmailInvite = invEmail.invite?.id;
  const revoked = pendingEmailInvite ? await evalJson(pageA, `await window.team.revokeInvite(${JSON.stringify(teamId)}, ${JSON.stringify(pendingEmailInvite)})`) : { ok: false, error: "sem id" };
  console.log("  revokeInvite:", JSON.stringify(revoked).slice(0, 200));
  check("A revoga um convite", revoked.ok, true);
  await shot(pageA, "A-convite-revogado");

  // A removes bob (member). The app turns off the LOCAL team profile of the
  // caller (A); B must learn it separately.
  const detailA = await evalJson(pageA, `await window.team.detail(${JSON.stringify(teamId)})`);
  const membersA = detailA.ok ? (detailA.detail?.members ?? detailA.value?.members ?? []) : [];
  console.log("  membros:", JSON.stringify(membersA).slice(0, 300));
  const bobMember = membersA.find((m) => m.role === "member");
  const removed = bobMember ? await evalJson(pageA, `await window.team.removeMember(${JSON.stringify(teamId)}, ${JSON.stringify(bobMember.accountId)})`) : { ok: false, error: "sem membro" };
  console.log("  removeMember:", JSON.stringify(removed).slice(0, 200));
  check("A remove o membro", removed.ok, true);
  if (!removed.ok) {
    blocked("passo 9 (remover membro)", `não há membro para remover (${JSON.stringify(removed).slice(0, 120)})`);
  } else {
    const profilesB3 = await evalJson(pageB, `await window.profiles.list()`);
    const tpB = profilesB3.profiles.find((p) => p.teamId === teamId);
    const bDetachedViaServer = !tpB || tpB.detached === true;
    check("remover no servidor desliga o perfil de time de B", bDetachedViaServer, true);
    if (!bDetachedViaServer) {
      defect("passo 9 (remover membro)", "o perfil de time de B desliga ao ser removido no servidor", "perfil de B continua ativo (nada é empurrado para B)", "profiles.list de B mantém o perfil de time ativo após A remover a conta de B");
      // B leaves -> detaches its own local profile
      const left = await evalJson(pageB, `await window.team.leave(${JSON.stringify(teamId)})`);
      console.log("  B leave:", JSON.stringify(left).slice(0, 200));
      const profilesB4 = await evalJson(pageB, `await window.profiles.list()`);
      const tpB2 = profilesB4.profiles.find((p) => p.teamId === teamId);
      check("B sai e o perfil de time desliga localmente", !tpB2 || tpB2.detached === true, true);
    }
  }
  await shot(pageB, "B-time-desligado");

  // logout on A + check device revocation surface
  // NOTE: no IPC exposes GET/DELETE /v1/devices today (preload has cloud/profiles/team/workhome only).
  const hasDevicesApi = await pageA.evalJs(`JSON.stringify({ devices: typeof window.devices, cloudKeys: Object.keys(window.cloud ?? {}) })`);
  console.log("  superfície de dispositivos:", hasDevicesApi);
  const logout = await evalJson(pageA, `await window.cloud.logout()`);
  check("A faz logout", logout.state, "logged-out");
  await shot(pageA, "A-logout");
  if (!JSON.parse(hasDevicesApi).devices || JSON.parse(hasDevicesApi).devices === "undefined") {
    defect("passo 9 (revogação de dispositivo)", "o app expõe listar/desconectar máquinas (GET/DELETE /v1/devices)", "não há IPC nem preload para devices; só logout", "preload/index.ts: cloud/profiles/team/workhome, sem devices");
  }

  console.log("\n[e2e] fim. checks:", checks, "failed:", failed, "defeitos:", defects.length);
} catch (err) {
  console.log("\n[e2e] ERRO NÃO TRATADO:", String(err && err.stack ? err.stack : err));
  defects.push({ step: "driver", expected: "roteiro até o fim", got: String(err).slice(0, 400), evidence: "ver log do driver" });
} finally {
  writeFileSync(join(OUT, "e2e-results.json"), JSON.stringify({ checks, failed, defects, blocked: blockedList, results }, null, 2));
  try { pageA?.close(); } catch { /* */ }
  try { pageB?.close(); } catch { /* */ }
  try { await stopMachine(mA); } catch { /* */ }
  try { await stopMachine(mB); } catch { /* */ }
  try { spawnSync("python3", [join(SCRATCH, "cleanup-e2e.py")]); } catch { /* */ }
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
  rmSync(A, { recursive: true, force: true });
  rmSync(B, { recursive: true, force: true });
  console.log("[e2e] cleanup ok");
}
