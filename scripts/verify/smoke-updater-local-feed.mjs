// THE UPDATE FLOW, FOR REAL (packaged build, isolated instance, local feed).
//
// What is real here: the packaged app (`dist/linux-unpacked`, `app.isPackaged`),
// the real `electron-updater` events, a real download of a real file from a
// local HTTP server (throttled so progress is observable, and able to drop the
// connection or serve a wrong file), and the real renderer read over CDP. What is
// NOT exercised: a genuine package installation — with no `pkexec`/`sudo`/package
// manager on the app's PATH (set empty below) a restart can only fail, which is
// exactly how the install-failure path is proven without touching this machine.
//
// Pieces:
//   1. `resources/package-type = rpm` (what the fpm target writes) so the library
//      picks RpmUpdater instead of switching itself off without APPIMAGE;
//   2. a local feed: `latest-linux.yml` 99.0.0 + a fake rpm, served in a mode the
//      script flips at runtime: good / drop-mid-download / wrong-bytes;
//   3. an isolated userData, an isolated XDG cache (the library caches downloads
//      there — never the real one) and an empty PATH;
//   4. the dialog is walked through: offered (nothing downloads before the
//      click) → downloading with real progress → closed, download goes on →
//      network failure → retry → signature failure → retry → ready → "Reiniciar
//      depois" (still running) → "Reiniciar agora" → installing → install failure
//      (retry offered, app still up);
//   5. teardown with verification.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const APP_DIR = new URL("../../dist/linux-unpacked", import.meta.url).pathname;
const BINARY = join(APP_DIR, "stellar");
const PACKAGE_TYPE = join(APP_DIR, "resources/package-type");
const OFFERED_VERSION = "99.0.0";
const PACKAGE_BYTES = 6 * 1024 * 1024;
const CHUNK = 512 * 1024;
// The library reports progress at most once a second, so the download must last several seconds.
const CHUNK_DELAY_MS = 450;
const TIMEOUT_MS = 60_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = makeChecker();

check("build empacotado existe (npm run package)", existsSync(BINARY), true);
if (!existsSync(BINARY)) finish();

const hadPackageType = existsSync(PACKAGE_TYPE);
writeFileSync(PACKAGE_TYPE, "rpm", "utf8");

// ---- the feed -------------------------------------------------------------
const feedDir = join(tmpdir(), `stellar-update-feed-${process.pid}`);
mkdirSync(feedDir, { recursive: true });
const rpmName = `stellar-${OFFERED_VERSION}-1.x86_64.rpm`;
const goodBytes = randomBytes(PACKAGE_BYTES);
const badBytes = randomBytes(PACKAGE_BYTES);
const sha512 = createHash("sha512").update(goodBytes).digest("base64");
const releaseNotes = ["## Novidades", "", "- A atualização ganhou janela própria.", "- O download mostra o andamento.", "", "<!-- stellar:commits -->", "### Commits", "- 1a2b3c4 feat(updater): janela", "<!-- /stellar:commits -->"].join("\n");
writeFileSync(
  join(feedDir, "latest-linux.yml"),
  [
    `version: ${OFFERED_VERSION}`,
    "files:",
    `  - url: ${rpmName}`,
    `    sha512: ${sha512}`,
    `    size: ${PACKAGE_BYTES}`,
    `path: ${rpmName}`,
    `sha512: ${sha512}`,
    `releaseDate: '2026-01-01T00:00:00.000Z'`,
    "releaseNotes: |",
    ...releaseNotes.split("\n").map((l) => `  ${l}`),
    "",
  ].join("\n"),
  "utf8",
);
let mode = "good"; // good | drop | wrong
const requests = [];
const server = createServer(async (req, res) => {
  const name = (req.url ?? "/").replace(/^\//, "").split("?")[0];
  requests.push({ name, at: Date.now(), mode });
  if (name === "latest-linux.yml") {
    res.writeHead(200, { "content-type": "text/yaml" });
    res.end(readFileSync(join(feedDir, name)));
    return;
  }
  if (name !== rpmName) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const body = mode === "wrong" ? badBytes : goodBytes;
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  for (let at = 0; at < body.length; at += CHUNK) {
    if (mode === "drop" && at >= PACKAGE_BYTES * 0.6) {
      res.destroy();
      return;
    }
    if (res.destroyed) return;
    res.write(body.subarray(at, at + CHUNK));
    await delay(CHUNK_DELAY_MS);
  }
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`[smoke] feed local em ${feedUrl}`);

// ---- the app --------------------------------------------------------------
const userDataDir = join(tmpdir(), `stellar-update-proof-${process.pid}`);
const cacheDir = join(tmpdir(), `stellar-update-cache-${process.pid}`);
const emptyBin = join(tmpdir(), `stellar-update-nopath-${process.pid}`);
for (const d of [userDataDir, cacheDir]) rmSync(d, { recursive: true, force: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(emptyBin, { recursive: true });
const cdpPort = await pickFreePort();
const child = spawn(BINARY, [`--user-data-dir=${userDataDir}`, "--no-sandbox", `--remote-debugging-port=${cdpPort}`], {
  env: { ...process.env, STELLAR_UPDATE_FEED_URL: feedUrl, XDG_CACHE_HOME: cacheDir, PATH: emptyBin },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d.toString()));
child.stderr.on("data", (d) => (log += d.toString()));
let exited = false;
child.on("exit", () => (exited = true));

const needle = `[updater] update-available ${OFFERED_VERSION}`;
let deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && !log.includes(needle)) await delay(500);
check(`o MAIN recebeu o evento REAL de update-available (${OFFERED_VERSION})`, log.includes(needle), true);
if (!log.includes(needle)) console.error("log do app:\n", log.slice(-1500));

let page = null;
deadline = Date.now() + 20_000;
while (page === null && Date.now() < deadline) {
  try {
    page = await connectPage(cdpPort);
  } catch {
    await delay(500);
  }
}
check("o renderer respondeu por CDP", page !== null, true);
if (page === null) finish();

const state = () =>
  page.evalJs(`(() => {
    const d = document.querySelector('[data-part="update-dialog"]');
    const icon = document.querySelector('[data-role="update-icon"]');
    return JSON.stringify({
      state: d?.dataset.state ?? null,
      text: d?.innerText ?? null,
      primary: d?.querySelector('[data-part="update-primary"]')?.textContent ?? null,
      iconPhase: icon?.dataset.phase ?? null,
      iconTitle: icon?.title ?? null,
      percent: d?.querySelector('[data-part="update-progress"] [role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
    });
  })()`).then(JSON.parse);
async function until(label, predicate, ms = 30_000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await state();
    if (predicate(last)) return last;
    await delay(200);
  }
  console.error(`[smoke] timeout em "${label}":`, JSON.stringify(last));
  return last;
}
const clickIn = (selector, textMatch) =>
  page.evalJs(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${textMatch === undefined ? "els[0]" : `els.find((e) => e.textContent.trim() === ${JSON.stringify(textMatch)})`};
    el?.click();
    return !!el;
  })()`);
const rpmRequests = () => requests.filter((r) => r.name === rpmName);

// ---- 1. offered: nothing downloads before the click ------------------------
let s = await until("available", (x) => x.state === "available");
check("o diálogo abriu sozinho na versão oferecida", s.state, "available");
check("mostra a versão oferecida e o tamanho do pacote", [s.text?.includes(OFFERED_VERSION), s.primary], (v) => v[0] === true && v[1] === "Baixar · 6 MB");
check("as notas viram marcadores (sem commits, sem <pre>)", [s.text?.includes("A atualização ganhou janela própria."), s.text?.includes("1a2b3c4")], (v) => v[0] === true && v[1] === false);
check("o selo do salto (0.8.x -> 99.0.0 = major)", s.text?.includes("versão nova de peso"), true);
await delay(2500);
check("NADA foi baixado antes do clique (servidor não viu o pacote)", rpmRequests().length, 0);
check("o main não iniciou download nenhum", log.includes("download"), false);

// ---- 2. download #1: the connection drops at 40% ---------------------------
mode = "drop";
await clickIn('[data-part="update-primary"]');
s = await until("downloading", (x) => x.state === "downloading" && Number(x.percent) > 0, 15_000);
check("o clique inicia o download e o progresso é REAL (percentual > 0)", [s.state, Number(s.percent) > 0], (v) => v[0] === "downloading" && v[1] === true);
check("mostra MB baixados, velocidade e o que falta", /\d+,\d de \d+,\d MB/.test(s.text ?? "") && /MB\/s/.test(s.text ?? ""), true);
check("o ícone da barra de título acompanha com a porcentagem", [s.iconPhase, /\d+%/.test(s.iconTitle ?? "")], (v) => v[0] === "downloading" && v[1] === true);

// closing the dialog keeps the download going
await clickIn('[data-part="update-dialog"] footer button', "Continuar em segundo plano");
await delay(300);
s = await state();
check("fechar a janela não cancela: o ícone segue em 'baixando'", [s.state, s.iconPhase], (v) => v[0] === null && v[1] === "downloading");

s = await until("error network", (x) => x.iconPhase === "error", 20_000);
check("a conexão caiu: o ícone marca a falha (sem abrir o diálogo sozinho)", [s.iconPhase, s.state], (v) => v[0] === "error" && v[1] === null);
await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.click()`);
s = await until("error dialog", (x) => x.state === "error");
check("a falha de rede diz a causa e até onde foi", [s.text?.includes("Falha de rede ao baixar"), /parou em \d+%/.test(s.text ?? "")], (v) => v[0] === true && v[1] === true);
check("e que o Stellar atual segue funcionando", s.text?.includes("O Stellar atual continua funcionando normalmente."), true);

// ---- 3. retry #2: a wrong file -> signature failure ------------------------
mode = "wrong";
await clickIn('[data-part="update-primary"]');
s = await until("downloading again", (x) => x.state === "downloading", 15_000);
check("tentar de novo volta a baixar", s.state, "downloading");
s = await until("signature error", (x) => x.state === "error", 40_000);
check("arquivo errado vira 'a assinatura não confere'", s.text?.includes("A assinatura do arquivo não confere"), true);

// ---- 4. retry #3: good file -> ready ---------------------------------------
mode = "good";
await clickIn('[data-part="update-primary"]');
s = await until("ready", (x) => x.state === "ready", 40_000);
check("baixado e conferido: 'Pronta para instalar'", s.state, "ready");
check("sem terminal ou agente aberto, o aviso vira confirmação", s.text?.includes("Nenhum terminal ou agente aberto agora"), true);
check("o botão é 'Reiniciar agora' e NINGUÉM reiniciou", [s.primary, exited], (v) => v[0] === "Reiniciar agora" && v[1] === false);
await delay(3000);
check("passados 3 s do fim do download o app segue de pé", exited, false);

// ---- 5. restart later --------------------------------------------------------
await clickIn('[data-part="update-dialog"] footer button', "Reiniciar depois");
await delay(300);
s = await state();
check("'Reiniciar depois' só fecha: o ícone lembra que está pronta", [s.state, s.iconPhase], (v) => v[0] === null && v[1] === "ready");
await delay(2500);
check("e o app não reinicia sozinho", exited, false);

// ---- 6. restart now: no installer reachable -> honest failure ---------------
await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.click()`);
await until("ready again", (x) => x.state === "ready", 5000);
await clickIn('[data-part="update-primary"]');
s = await until("installing", (x) => x.state === "installing" || x.state === "error", 8000);
check("só depois do clique aparece 'Instalando a atualização'", s.state === "installing" || s.state === "error", true);
s = await until("install error", (x) => x.state === "error", 15_000);
check("sem instalador no PATH a instalação falha com mensagem própria", s.text?.includes("A instalação não terminou"), true);
check("e o app segue de pé, com 'Tentar de novo' oferecido", [exited, s.primary], (v) => v[0] === false && v[1] === "Tentar de novo");

// ---- 7. closing a failure does not forget the update --------------------------
await page.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await delay(300);
check("fechar um erro não esquece a atualização", (await state()).iconPhase, "error");

// ---- teardown ---------------------------------------------------------------
child.kill("SIGKILL");
await delay(800);
server.close();
for (const d of [userDataDir, cacheDir, emptyBin, feedDir]) rmSync(d, { recursive: true, force: true });
check("userData, cache e PATH isolados destruídos", [userDataDir, cacheDir, emptyBin].some((d) => existsSync(d)), false);
if (!hadPackageType) rmSync(PACKAGE_TYPE, { force: true });
check("package-type do fixture removido", existsSync(PACKAGE_TYPE), hadPackageType);
finish();
