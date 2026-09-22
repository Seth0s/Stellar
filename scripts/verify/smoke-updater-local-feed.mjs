// A PROVA DO AVISO DE VERDADE (task 5fb0c21b) — fases 1 e 2.
//
// Regra da task: o evento `update-available` tem de ser o REAL, num build
// EMPACOTADO, numa instância ISOLADA, contra um feed LOCAL — e, na fase 2, o
// RENDERER tem de mostrar o aviso (selo, notas em Markdown, commits) e o
// "lembrar mais tarde" tem de PERSISTIR. O IPC de teste não conta: ele pula o
// electron-updater.
//
// Cada peça e o porquê:
//   1. `dist/linux-unpacked` (build empacotada: `app.isPackaged` é o que libera
//      o check) — `npm run package` antes;
//   2. `resources/package-type = rpm`, o arquivo que o target fpm escreve (e que
//      o build só escreve COM `build.publish` — por isso a 0.8.2 instalada do
//      dono não tem nenhum dos dois): sem ele, a lib escolhe AppImageUpdater e
//      se DESLIGA sem `APPIMAGE`;
//   3. feed local com `latest-linux.yml` 99.0.0, incluindo `releaseNotes` com
//      changelog e a seção `<!-- stellar:commits -->` — é do CORPO da release
//      que a lista de commits vem (sem API do GitHub em runtime);
//   4. o app sobe com userData ISOLADO e porta de CDP; o MAIN registra o evento
//      real e o RENDERER é lido por CDP (banner, selo, notas, commits);
//   5. clicar "lembrar depois" e conferir `update-prefs.json` NO DISCO — a
//      persistência por versão;
//   6. desmontar com verificação: userData destruído, `package-type` do fixture
//      removido.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const APP_DIR = new URL("../../dist/linux-unpacked", import.meta.url).pathname;
const BINARY = join(APP_DIR, "stellar");
const PACKAGE_TYPE = join(APP_DIR, "resources/package-type");
const APP_UPDATE_YML = join(APP_DIR, "resources/app-update.yml");
const OFFERED_VERSION = "99.0.0";
const COMMITS = [
  "- 1a2b3c4 fix(providers): cline não impõe sessão",
  "- 9f8e7d6 feat(updater): o feed volta a existir",
  "- 0d1c2b3 docs: o selo do salto",
];
const TIMEOUT_MS = 60_000;
const { check, finish } = makeChecker();

check("build empacotado existe (npm run package)", existsSync(BINARY), true);
if (!existsSync(BINARY)) finish();
check("o pacote carrega o app-update.yml que o build.publish gera", existsSync(APP_UPDATE_YML), true);

const hadPackageType = existsSync(PACKAGE_TYPE);
writeFileSync(PACKAGE_TYPE, "rpm", "utf8");

// 3. o feed local
const feedDir = join(tmpdir(), `stellar-update-feed-${process.pid}`);
mkdirSync(feedDir, { recursive: true });
const rpmName = `stellar-${OFFERED_VERSION}-1.x86_64.rpm`;
const rpmBytes = Buffer.from("rpm de mentira para a prova do check\n", "utf8");
writeFileSync(join(feedDir, rpmName), rpmBytes);
const sha512 = createHash("sha512").update(rpmBytes).digest("base64");
const releaseNotes = [
  "## Novidades desta versão",
  "",
  "- O feed voltou a existir.",
  "- O aviso diz o que sabe.",
  "",
  "<!-- stellar:commits -->",
  "### Commits",
  ...COMMITS,
  "<!-- /stellar:commits -->",
].join("\n");
writeFileSync(
  join(feedDir, "latest-linux.yml"),
  [
    `version: ${OFFERED_VERSION}`,
    "files:",
    `  - url: ${rpmName}`,
    `    sha512: ${sha512}`,
    `    size: ${rpmBytes.length}`,
    `path: ${rpmName}`,
    `sha512: ${sha512}`,
    `releaseDate: '2026-09-22T00:00:00.000Z'`,
    "releaseNotes: |",
    ...releaseNotes.split("\n").map((line) => `  ${line}`),
    "",
  ].join("\n"),
  "utf8",
);
const server = createServer((req, res) => {
  const name = (req.url ?? "/").replace(/^\//, "").split("?")[0];
  const file = join(feedDir, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`[smoke] feed local em ${feedUrl}`);

// 4. instância isolada + CDP
const userDataDir = join(tmpdir(), `stellar-update-proof-${process.pid}`);
rmSync(userDataDir, { recursive: true, force: true });
const cdpPort = await pickFreePort();
const child = spawn(BINARY, [`--user-data-dir=${userDataDir}`, "--no-sandbox", `--remote-debugging-port=${cdpPort}`], {
  env: { ...process.env, STELLAR_UPDATE_FEED_URL: feedUrl },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d.toString()));
child.stderr.on("data", (d) => (log += d.toString()));

const needle = `[updater] update-available ${OFFERED_VERSION}`;
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && !log.includes(needle)) await new Promise((r) => setTimeout(r, 500));
check(`o MAIN recebeu o evento REAL de update-available (${OFFERED_VERSION})`, log.includes(needle), true);
if (!log.includes(needle)) console.error("log do app:\n", log.slice(-1500));

// O RENDERER, por CDP
let page = null;
const pageDeadline = Date.now() + 20_000;
while (page === null && Date.now() < pageDeadline) {
  try {
    page = await connectPage(cdpPort);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
check("o renderer respondeu por CDP", page !== null, true);

let banner = null;
const bannerDeadline = Date.now() + 20_000;
while (Date.now() < bannerDeadline) {
  banner = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector('.update-banner');
      if (!el) return JSON.stringify(null);
      return JSON.stringify({
        text: el.textContent,
        jump: el.querySelector('.update-banner-jump')?.textContent ?? null,
        jumpClass: el.querySelector('.update-banner-jump')?.className ?? null,
        markdown: !!el.querySelector('.md-content'),
        commits: el.querySelectorAll('.update-banner-commits li').length,
        later: !!el.querySelector('.update-banner-later'),
        manualLink: el.querySelector('.update-banner-manual-link')?.getAttribute('href') ?? null,
      });
    })()`),
  );
  if (banner) break;
  await new Promise((r) => setTimeout(r, 500));
}
check("o MODAL/BANNER apareceu no renderer", banner !== null, true);
if (!banner) {
  console.error("log do app:\n", log.slice(-800));
  finish();
}
check("o banner mostra a versão oferecida", banner.text.includes(OFFERED_VERSION), true);
check("o SELO do salto está lá (0.8.2 -> 99.0.0 = major)", banner.jumpClass?.includes("update-banner-jump--major") === true, true);
check(
  "com `package-type` presente a UI OFERECE instalar — o caminho manual é para quem NÃO pode (o caso do dono hoje)",
  banner.manualLink,
  null,
);
// As NOTAS nascem COLAPSADAS (o toggle existe para isso) — clicar antes de
// medir é parte de exercitar a tela como o dono a usa, e foi assim que a
// primeira rodada desta checagem falhou por erro do TESTE, não do app.
await page.evalJs(`(() => { document.querySelector('.update-banner-notes-toggle')?.click(); return '1'; })()`);
let markdown = false;
const mdDeadline = Date.now() + 15_000;
while (Date.now() < mdDeadline && !markdown) {
  markdown = (await page.evalJs(`!!document.querySelector('.update-banner .md-content')`)) === true;
  if (!markdown) await new Promise((r) => setTimeout(r, 400));
}
check("o changelog é renderizado como MARKDOWN (marked+dompurify), não em <pre>", markdown, true);
const preCount = await page.evalJs(`document.querySelectorAll('.update-banner pre').length`);
check("e NÃO caiu no <pre> cru de antes", preCount, 0);
check(`os commits aparecem no dropdown (${COMMITS.length})`, banner.commits, COMMITS.length);

// 5. "lembrar mais tarde" persiste
await page.evalJs(`(() => { document.querySelector('.update-banner-later')?.click(); return '1'; })()`);
await new Promise((r) => setTimeout(r, 1500));
const prefsPath = join(userDataDir, "update-prefs.json");
let persisted = null;
try {
  persisted = JSON.parse(readFileSync(prefsPath, "utf8"));
} catch {
  persisted = null;
}
check("\"lembrar mais tarde\" PERSISTIU a versão no disco (update-prefs.json)", persisted?.remindLaterVersion, OFFERED_VERSION);

// 6. desmonte com verificação
child.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 800));
server.close();
rmSync(userDataDir, { recursive: true, force: true });
check("userData isolado destruído com verificação", existsSync(userDataDir), false);
if (!hadPackageType) rmSync(PACKAGE_TYPE, { force: true });
check("package-type do fixture removido", existsSync(PACKAGE_TYPE), hadPackageType);
rmSync(feedDir, { recursive: true, force: true });
finish();
