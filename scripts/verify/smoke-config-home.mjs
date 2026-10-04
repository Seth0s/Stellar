// Smoke ISOLADO da A3c (P5): um card de provider num perfil `isolated` escreve
// na pasta DO PERFIL, não em ~/.claude. HOME FALSO (nunca o ~/.claude real).
// Também prova o canal `pty:home-notice` para um provider que NÃO separa.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ID1 = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const INSTALL_ID = "33333333-3333-4333-8333-333333333333";

const userData = mkdtempSync(join(tmpdir(), "stellar-a3c-smoke-"));
const fakeHome = `${userData}-home`;
console.log("[smoke] userData:", userData, "| HOME falso:", fakeHome);

mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "profiles.json"),
  JSON.stringify({
    schemaVersion: 1,
    defaultProfileId: ID1,
    profiles: [{ id: ID1, name: "Empresa", kind: "team", createdAt: 1, homeMode: "isolated" }],
  }),
);
writeFileSync(
  join(userData, "local-identity.json"),
  JSON.stringify({ schema_version: 1, user_id: USER_ID, install_id: INSTALL_ID, created_at: 1 }),
);

const profileDir = join(userData, "profiles", ID1);
const profileClaudeHome = join(profileDir, "homes", "claude");
const realClaudeDir = join(fakeHome, ".claude");

let app;
try {
  const cdpPort = await pickFreePort();
  app = await startApp({ cdpPort, userDataDir: userData, preserveUserData: true, isolatedHome: true });
  const page = await connectPage(cdpPort);
  await delay(1800);

  const status = () => page.evalJs(`(async () => JSON.stringify(await window.profiles.homeStatus()))()`).then(JSON.parse);
  const home = await status();
  console.log("[smoke] homeStatus:", JSON.stringify(home));
  check("perfil ativo está em modo isolated", home.homeMode, "isolated");
  check("claude declara suporte (env)", home.providers.find((p) => p.id === "claude")?.supported, true);
  check("cursor NÃO declara suporte", home.providers.find((p) => p.id === "cursor")?.supported, false);

  // O canal pty:home-notice é registrado ANTES de spawnar.
  await page.evalJs(`window.__homeNotices = []; window.__offHome = window.pty.onHomeNotice((id, pid) => window.__homeNotices.push({ id, pid }));`);

  // Spawn claude no perfil isolated: o app injeta CLAUDE_CONFIG_DIR na pasta do perfil.
  const spawned = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify(await window.pty.spawn("smoke-claude", "claude", ${JSON.stringify(userData)}, 100, 30, {})))()`),
  );
  console.log("[smoke] spawn claude:", JSON.stringify(spawned));
  check("claude spawna", spawned.id === "smoke-claude", true);

  await delay(4000);
  check("a pasta do PERFIL foi criada para o claude", existsSync(profileClaudeHome), true);
  const files = existsSync(profileClaudeHome) ? readdirSync(profileClaudeHome) : [];
  console.log("[smoke] conteúdo de homes/claude:", JSON.stringify(files));
  check("o ~/.claude (HOME falso) NÃO existe — a CLI foi desviada", existsSync(realClaudeDir), false);

  // Provider SEM suporte (cursor): abre no sistema e emite o aviso no canal.
  const cursor = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify(await window.pty.spawn("smoke-cursor", "cursor", ${JSON.stringify(userData)}, 100, 30, {})))()`),
  );
  console.log("[smoke] spawn cursor:", JSON.stringify(cursor));
  await delay(1500);
  const notices = JSON.parse(await page.evalJs(`JSON.stringify(window.__homeNotices)`));
  console.log("[smoke] home notices:", JSON.stringify(notices));
  check("provider sem suporte emite pty:home-notice para o card", notices.some((n) => n.id === "smoke-cursor" && n.pid === "cursor"), true);
  check("a pasta do cursor NÃO é criada (usa o sistema)", existsSync(join(profileDir, "homes", "cursor")), false);

  page.close();
} finally {
  if (app) await stopApp(app);
  rmSync(userData, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  console.log("[smoke] removidos:", userData, fakeHome);
}
finish();
process.exit(0);
