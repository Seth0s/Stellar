// BACKEND_V1 · E v2 (re-run) — end-to-end measurement, REAL backend, two isolated app
// instances. Proves steps 1-9 of the E v2 roteiro, including the ones that were
// blocked/failed before A8 (house sync between machines, merge, conflict,
// device revocation, removed-member detach). Does NOT edit product code.
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
const blockedList = [];
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
function seedClaudeHouse(claudeRoot, cloneRoot, tag) {
  writeAt(claudeRoot, "CLAUDE.md", `# Regras do projeto (${tag})\n\nSempre teste. @regras/extra.md\n`);
  writeAt(claudeRoot, "regras/extra.md", `regra incluida via @ (${tag})\n`);
  writeAt(claudeRoot, "skills/deploy/SKILL.md", `---\nname: deploy\ndescription: skill pessoal ${tag}\n---\nfaca deploy ${tag}\n`);
  writeAt(claudeRoot, "agents/revisor.md", `---\nname: revisor\ndescription: agente ${tag}\n---\nrevisa ${tag}\n`);
  writeAt(claudeRoot, "settings.json", JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] }, env: { SECRET_TOKEN: "NAO-DEVE-VIAJAR" } }, null, 2));
}
function seedClone(cloneRoot) {
  mkdirSync(join(cloneRoot, ".git"), { recursive: true });
  writeFileSync(join(cloneRoot, ".git/config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/seth0s/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  writeFileSync(join(cloneRoot, "README.md"), "# demo\n");
}
function seedMemory(claudeRoot, cloneRoot, text) {
  writeAt(claudeRoot, join("projects", cloneRoot.replace(/\//g, "-"), "memory", "nota.md"), text);
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
const ALICE = { id: 1234567, login: "alice-gh", name: "Alice GitHub", email: "alice@example.com" };
const BOB = { id: 7654321, login: "bob-gh", name: "Bob GitHub", email: "member@example.com" };

// ===========================================================================
const A = mkdtempSync(join(tmpdir(), "stellar-e2e-A-"));
const B = mkdtempSync(join(tmpdir(), "stellar-e2e-B-"));
const homeA = `${A}-home`;
const homeB = `${B}-home`;
mkdirSync(homeA, { recursive: true });
mkdirSync(homeB, { recursive: true });
console.log(`[e2e] A=${A}  B=${B}\n[e2e] API=${API}  GH=${GH}`);

let mA, mB, pageA, pageB;
try {
  // ---- PASSO 1: A migra, cria Empresa (isolated) e loga --------------------
  console.log("\n== PASSO 1: A migra para perfis, cria Empresa (isolated) e loga ==");
  writeFileSync(join(A, "providers.json"), JSON.stringify({ schema: "legacy-providers", providers: ["commandcode"] }, null, 2));
  writeFileSync(join(A, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  mA = await startMachine({ userData: A, home: homeA });
  pageA = mA.page;
  await delay(500);
  const reg = JSON.parse(readFileSync(join(A, "profiles.json"), "utf8"));
  const personalId = reg.profiles[0]?.id;
  check("migração criou o perfil pessoal", reg.profiles[0]?.kind, "personal");
  check("providers.json da raiz migrou para profiles/<id>/", existsSync(join(A, "profiles", personalId, "providers.json")), true);
  check("providers.json NÃO ficou na raiz", existsSync(join(A, "providers.json")), false);
  await shot(pageA, "migracao-perfis");

  const created = await evalJson(pageA, `await window.profiles.create({ name: "Empresa", kind: "personal" })`);
  const empresaA = created.state.profiles.find((p) => p.name === "Empresa")?.id;
  check("perfil Empresa criado", !!empresaA, true);
  await evalJson(pageA, `await window.profiles.setHomeMode(${JSON.stringify(empresaA)}, "isolated")`);
  const afterMode = await evalJson(pageA, `await window.profiles.list()`);
  check("perfil Empresa em modo isolated", afterMode.profiles.find((p) => p.id === empresaA)?.homeMode, "isolated");
  await shot(pageA, "perfil-empresa-isolated");

  await stopMachine(mA);
  mA = await startMachine({ userData: A, home: homeA, profileId: empresaA });
  pageA = mA.page;
  const sw = await evalJson(pageA, `await window.profiles.list()`);
  check("app reabriu no perfil Empresa", sw.activeProfileId, empresaA);
  await setGithubUser(ALICE);
  await evalJson(pageA, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mA.app);
  const aStatus = await waitCloud(pageA, "logged-in");
  check("A logado na conta (GitHub)", aStatus.account.displayName, "Alice GitHub");
  await shot(pageA, "A-logado");

  // ---- PASSO 2: A sincroniza a casa ----------------------------------------
  console.log("\n== PASSO 2: A sincroniza a casa ==");
  const claudeA = join(A, "profiles", empresaA, "homes", "claude");
  const cloneA = join(homeA, "work", "demo");
  seedClone(cloneA);
  seedClaudeHouse(claudeA, cloneA, "A");
  seedMemory(claudeA, cloneA, "memoria do projeto demo (A)\n");
  writeFileSync(join(claudeA, ".credentials.json"), JSON.stringify({ token: "FAKE-CREDENTIAL-A-DO-NOT-SYNC" }));
  await evalJson(pageA, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageA, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeA, "work"))}])`);
  const previewA = await evalJson(pageA, `await window.workhome.preview()`);
  check("A: prévia da casa responde", previewA.ok, true);
  const syncA = await evalJson(pageA, `await window.workhome.syncNow()`);
  console.log("  syncNow A:", JSON.stringify(syncA).slice(0, 300));
  check("PASSO 2 — A sincroniza a casa (push)", !!(syncA.ok && (syncA.kind === "pushed" || syncA.kind === "conflicts")), true);
  const linkA = await evalJson(pageA, `await window.profiles.cloudLink()`);
  console.log("  cloudLink A:", JSON.stringify(linkA).slice(0, 260));
  const aCloudId = linkA.ok ? linkA.view.cloudProfileId : null;
  check("PASSO 2 — perfil de A registrado no servidor (cloudProfileId)", typeof aCloudId === "string" && aCloudId.length > 0, true);
  if (!(typeof aCloudId === "string" && aCloudId.length > 0)) {
    defect("passo 2 (A sincroniza a casa)", "perfil registrado no servidor e push aceito", JSON.stringify({ syncA, linkA }).slice(0, 300), "e2e-results.json");
  }
  await shot(pageA, "A-casa-sincronizada");

  // ---- PASSO 3: B (mesma conta) cria Empresa, vincula e recebe a casa -------
  console.log("\n== PASSO 3: B loga com a MESMA conta e recebe a casa ==");
  writeFileSync(join(B, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  mB = await startMachine({ userData: B, home: homeB });
  pageB = mB.page;
  await delay(500);
  const createdB = await evalJson(pageB, `await window.profiles.create({ name: "Empresa", kind: "personal" })`);
  const empresaB = createdB.state.profiles.find((p) => p.name === "Empresa")?.id;
  await evalJson(pageB, `await window.profiles.setHomeMode(${JSON.stringify(empresaB)}, "isolated")`);
  await stopMachine(mB);
  mB = await startMachine({ userData: B, home: homeB, profileId: empresaB });
  pageB = mB.page;
  const claudeB = join(B, "profiles", empresaB, "homes", "claude");
  const cloneB = join(homeB, "dev", "demo");
  mkdirSync(claudeB, { recursive: true });
  seedClone(cloneB);
  writeFileSync(join(claudeB, ".credentials.json"), JSON.stringify({ token: "FAKE-CREDENTIAL-B-DO-NOT-SYNC" }));

  await setGithubUser(ALICE);
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bStatus = await waitCloud(pageB, "logged-in");
  check("B logado na MESMA conta", bStatus.account.displayName, "Alice GitHub");
  await evalJson(pageB, `await window.workhome.setTools(["claude"])`);
  await evalJson(pageB, `await window.workhome.setWorkFolders([${JSON.stringify(join(homeB, "dev"))}])`);
  const previewB = await evalJson(pageB, `await window.workhome.preview()`);
  const linkB = await evalJson(pageB, `await window.profiles.cloudLink()`);
  check("PASSO 3 — B vincula ao MESMO perfil de servidor de A", linkB.ok && linkB.view.cloudProfileId === aCloudId, true);
  check("PASSO 3 — B recebe a prévia da casa", previewB.ok, true);
  const applyB = await evalJson(pageB, `await window.workhome.apply({})`);
  console.log("  apply B written:", applyB.ok ? JSON.stringify(applyB.result.written.map((w) => w.path)) : JSON.stringify(applyB).slice(0, 200));
  check("PASSO 3 — B aplica a casa de A", applyB.ok, true);
  const claudeMd = existsSync(join(claudeB, "CLAUDE.md")) ? readFileSync(join(claudeB, "CLAUDE.md"), "utf8") : "";
  check("PASSO 3 — CLAUDE.md de B veio de A (tag A)", claudeMd.includes("(A)"), true);
  const encodedCloneB = cloneB.replace(/\//g, "-");
  check("PASSO 3 — memória no clone certo de B", existsSync(join(claudeB, "projects", encodedCloneB, "memory", "nota.md")), true);
  const credB = existsSync(join(claudeB, ".credentials.json")) ? readFileSync(join(claudeB, ".credentials.json"), "utf8") : "";
  check("PASSO 3 — credencial de A NÃO viajou", !credB.includes("FAKE-CREDENTIAL-A-"), true);
  check("PASSO 3 — credencial de B continua a de B", credB.includes("FAKE-CREDENTIAL-B-"), true);
  await shot(pageB, "B-casa-recebida");

  // ---- PASSO 4: arquivos diferentes mesclam sozinhos -----------------------
  console.log("\n== PASSO 4: arquivos DIFERENTES editados nos dois lados ==");
  writeFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\neditado em B\n");
  writeFileSync(join(claudeA, "agents", "revisor.md"), "---\nname: revisor\n---\neditado em A\n");
  const syncA2 = await evalJson(pageA, `await window.workhome.syncNow()`);
  check("PASSO 4 — A publica", syncA2.ok, true);
  const applyB2 = await evalJson(pageB, `await window.workhome.apply({})`);
  check("PASSO 4 — B mescla sozinho (0 conflitos)", applyB2.ok && applyB2.result.conflicts.length === 0, true);
  check("PASSO 4 — a edição de A chegou em B", readFileSync(join(claudeB, "agents", "revisor.md"), "utf8").includes("editado em A"), true);
  check("PASSO 4 — B manteve a própria edição", readFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "utf8").includes("editado em B"), true);
  await shot(pageB, "B-merge-arquivos-diferentes");

  // ---- PASSO 5: mesmo arquivo dos dois lados -------------------------------
  console.log("\n== PASSO 5: MESMO arquivo editado dos dois lados ==");
  writeFileSync(join(claudeA, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao A\n");
  writeFileSync(join(claudeB, "skills", "deploy", "SKILL.md"), "MESMO ARQUIVO versao B\n");
  await evalJson(pageA, `await window.workhome.syncNow()`);
  const conflictB = await evalJson(pageB, `await window.workhome.preview()`);
  const conflictItems = conflictB.ok ? conflictB.plan.items.filter((i) => i.action === "conflict") : [];
  console.log("  conflito B:", JSON.stringify(conflictItems));
  check("PASSO 5 — o conflito aparece para a escolha", conflictItems.length >= 1, true);
  if (conflictItems.length === 0) defect("passo 5 (conflito)", "ação conflict no mesmo arquivo", JSON.stringify(conflictB).slice(0, 200), "e2e-results.json");
  await shot(pageB, "B-conflito");

  // ---- PASSO 9 (dispositivos): antes da troca de conta de B ----------------
  console.log("\n== PASSO 9: dispositivos ==");
  const devicesA = await evalJson(pageA, `await window.cloud.devices.list()`);
  console.log("  devices A:", JSON.stringify(devicesA).slice(0, 300));
  check("PASSO 9 — o app lista as máquinas da conta (>=2)", Array.isArray(devicesA) && devicesA.length >= 2, true);
  check("PASSO 9 — exatamente uma é 'esta máquina'", Array.isArray(devicesA) ? devicesA.filter((d) => d.current).length : -1, 1);
  const other = Array.isArray(devicesA) ? devicesA.find((d) => !d.current) : null;
  const revoked = other ? await evalJson(pageA, `await window.cloud.devices.disconnect(${JSON.stringify(other.id)})`) : { ok: false };
  check("PASSO 9 — desconectar outra máquina devolve ok", revoked.ok, true);
  if (!revoked.ok) defect("passo 9 (revogação de dispositivo)", "listar e desconectar máquinas", JSON.stringify({ devicesA, revoked }).slice(0, 250), "e2e-results.json");
  await shot(pageA, "A-dispositivos");

  // ---- PASSO 6: time --------------------------------------------------------
  console.log("\n== PASSO 6: A cria time, convida (e-mail + login GitHub); B aceita ==");
  const team = await evalJson(pageA, `await window.team.create({ name: "Acme" })`);
  check("A cria o time", team.ok && team.value?.team?.slug, "acme");
  const teamId = team.value?.team?.id;
  await shot(pageA, "A-time-criado");
  const invEmail = await evalJson(pageA, `await window.team.invite(${JSON.stringify(teamId)}, { target: "member@example.com", role: "member" })`);
  const invGh = await evalJson(pageA, `await window.team.invite(${JSON.stringify(teamId)}, { target: "bob-gh", role: "member" })`);
  check("A convida por e-mail", invEmail.ok, true);
  check("A convida por login GitHub", invGh.ok, true);
  await shot(pageA, "A-convites");

  await evalJson(pageB, `await window.cloud.logout()`);
  await setGithubUser(BOB);
  await evalJson(pageB, `await window.cloud.login("github")`).catch(() => {});
  await completeGithubLogin(mB.app);
  const bMember = await waitCloud(pageB, "logged-in");
  check("B logado como o membro (bob-gh)", bMember.account.displayName, "Bob GitHub");

  const apiLog = existsSync(API_LOG) ? readFileSync(API_LOG, "utf8") : "";
  const tokens = [...apiLog.matchAll(/stellar:\/\/invite\?token=([A-Za-z0-9_\-]+)/g)].map((m) => m[1]);
  let accepted = null;
  for (const t of tokens) {
    const r = await evalJson(pageB, `await window.team.acceptInvite(${JSON.stringify(t)})`);
    if (r.ok) { accepted = r; break; }
  }
  check("B aceita o convite", !!accepted, true);
  const profilesB = await evalJson(pageB, `await window.profiles.list()`);
  const teamProfileB = profilesB.profiles.find((p) => p.teamId === teamId);
  check("perfil de time aparece em B (ativo)", !!teamProfileB && teamProfileB.detached !== true, true);
  check("perfil de time em isolated", teamProfileB?.homeMode, "isolated");
  await shot(pageB, "B-time-aceito");

  // ---- PASSO 7: A publica a base; B recebe com prefixo ---------------------
  console.log("\n== PASSO 7: A publica a base; B recebe com prefixo; memória recusada ==");
  const pubPrev = await evalJson(pageA, `await window.team.publishPreview(${JSON.stringify(teamId)})`);
  const pub = await evalJson(pageA, `await window.team.publish(${JSON.stringify(teamId)})`);
  console.log("  publish:", JSON.stringify(pub).slice(0, 250));
  check("A publica a base", pub.ok, true);
  check("base publicada NÃO inclui memória", pubPrev.ok && pubPrev.preview.entries.every((e) => !e.path.includes("memory")), true);
  await shot(pageA, "A-base-publicada");
  const pullPrev = await evalJson(pageB, `await window.team.pullPreview(${JSON.stringify(teamId)})`);
  check("B vê a skill do time com prefixo team-acme-", pullPrev.ok && pullPrev.value.plan.items.some((i) => i.path.includes("team-acme-")), true);
  const pullApply = await evalJson(pageB, `await window.team.pullApply(${JSON.stringify(teamId)}, {})`);
  check("B aplica a base com prefixo", pullApply.ok, true);
  await shot(pageB, "B-base-recebida");

  // ---- PASSO 8: trocar de perfil reabre sem vazar --------------------------
  console.log("\n== PASSO 8: trocar de perfil reabre o app sem vazar ==");
  pageA = await switchAndReconnect(mA.app, pageA, personalId);
  const afterSwitch = await evalJson(pageA, `await window.profiles.list()`);
  check("troca reabriu no perfil pessoal", afterSwitch.activeProfileId, personalId);
  check("casa do perfil Empresa não vazou para o pessoal", existsSync(join(A, "profiles", personalId, "homes", "claude")), false);
  const cloudAfter = await evalJson(pageA, `await window.cloud.status()`);
  check("login é por perfil: pessoal não herdou a sessão", cloudAfter.state, "logged-out");
  await shot(pageA, "A-troca-perfil-sem-vazamento");
  pageA = await switchAndReconnect(mA.app, pageA, empresaA);
  await delay(500);

  // ---- PASSO 9 (time): A remove o membro e o perfil de B desliga -----------
  console.log("\n== PASSO 9: revogar convite, remover membro, logout ==");
  const revokedInv = invEmail.invite?.id ? await evalJson(pageA, `await window.team.revokeInvite(${JSON.stringify(teamId)}, ${JSON.stringify(invEmail.invite.id)})`) : { ok: false };
  check("A revoga um convite", revokedInv.ok, true);
  await shot(pageA, "A-convite-revogado");

  const detailA = await evalJson(pageA, `await window.team.detail(${JSON.stringify(teamId)})`);
  const membersA = detailA.ok ? (detailA.detail?.members ?? detailA.value?.members ?? []) : [];
  const bobMember = membersA.find((m) => m.role === "member");
  const removed = bobMember ? await evalJson(pageA, `await window.team.removeMember(${JSON.stringify(teamId)}, ${JSON.stringify(bobMember.accountId)})`) : { ok: false };
  check("A remove o membro", removed.ok, true);

  const detailB = await evalJson(pageB, `await window.team.detail(${JSON.stringify(teamId)})`);
  console.log("  detail B após remoção:", JSON.stringify(detailB).slice(0, 160));
  check("B recebe 404 do endpoint de time", detailB.ok, false);
  const profilesB2 = await evalJson(pageB, `await window.profiles.list()`);
  const teamProfileB2 = profilesB2.profiles.find((p) => p.teamId === teamId);
  check("PASSO 9 — o perfil de time de B ficou detached", !!teamProfileB2 && teamProfileB2.detached === true, true);
  if (!(teamProfileB2 && teamProfileB2.detached === true)) {
    defect("passo 9 (remover membro)", "o perfil de time de B desliga ao ser removido", JSON.stringify(teamProfileB2).slice(0, 200), "profiles.list de B após A remover");
  }
  const profilesA2 = await evalJson(pageA, `await window.profiles.list()`);
  const teamProfileA = profilesA2.profiles.find((p) => p.teamId === teamId);
  check("PASSO 9 — o perfil de time de A (removedor) continua ativo", !!teamProfileA && teamProfileA.detached !== true, true);
  await shot(pageB, "B-time-desligado");

  const logout = await evalJson(pageA, `await window.cloud.logout()`);
  check("A faz logout", logout.state, "logged-out");
  await shot(pageA, "A-logout");

  console.log(`\n[e2e] fim. checks: ${checks} failed: ${failed} defeitos: ${defects.length}`);
} catch (err) {
  console.log("\n[e2e] ERRO NÃO TRATADO:", String(err && err.stack ? err.stack : err));
  defects.push({ step: "driver", expected: "roteiro até o fim", got: String(err).slice(0, 400), evidence: "ver log do driver" });
} finally {
  writeFileSync(join(OUT, "e2e-results.json"), JSON.stringify({ checks, failed, defects, blocked: blockedList, results }, null, 2));
  writeFileSync(join(SCRATCH, "logs", "e2e-results.json"), JSON.stringify({ checks, failed, defects, blocked: blockedList, results }, null, 2));
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
