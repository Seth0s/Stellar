// A PROVA DO AVISO DE VERDADE (task 5fb0c21b, item 4).
//
// Regra da task: o evento `update-available` tem de ser o REAL, num build
// EMPACOTADO, numa instância ISOLADA, contra um feed LOCAL. O IPC de teste
// (`updater:test-emit-available`) NÃO conta — ele pula o electron-updater.
//
// O que este smoke faz, e por que cada peça existe:
//   1. exige `dist/linux-unpacked` (build empacotada de verdade, não `out/` de
//      dev): `app.isPackaged` só é true ali, e é o que libera o check;
//   2. escreve `resources/package-type` = `rpm` — o arquivo que o target fpm do
//      electron-builder escreve e que faz a lib escolher `RpmUpdater` em vez do
//      `AppImageUpdater` (que se DESLIGA sem `APPIMAGE`; medido em
//      `AppImageUpdater.isUpdaterActive`). Sem ele, o evento não acontece nem
//      com feed — e é justamente o estado da instalação do dono;
//   3. gera um feed `latest-linux.yml` de versão 99.0.0 e o serve em
//      127.0.0.1, apontado pelo override `STELLAR_UPDATE_FEED_URL`;
//   4. sobe o app com userData ISOLADO e espera a linha do MAIN
//      (`[updater] update-available 99.0.0`) — o registro do lado do main;
//   5. DESTRÓI o userData com verificação (regra da casa) e o package-type que
//      ele mesmo criou.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeChecker } from "./cdp-client.mjs";

const APP_DIR = new URL("../../dist/linux-unpacked", import.meta.url).pathname;
const BINARY = join(APP_DIR, "stellar");
const PACKAGE_TYPE = join(APP_DIR, "resources/package-type");
const APP_UPDATE_YML = join(APP_DIR, "resources/app-update.yml");
const OFFERED_VERSION = "99.0.0";
const TIMEOUT_MS = 60_000;
const { check, finish } = makeChecker();

check("build empacotado existe (dist/linux-unpacked/stellar)", existsSync(BINARY), true);
if (!existsSync(BINARY)) {
  console.error("rode `npm run package` antes deste smoke");
  finish();
}
check(
  "o pacote carrega o app-update.yml que o build.publish gera (a fonte única do feed)",
  existsSync(APP_UPDATE_YML),
  true,
);

// 2. o estado de uma instalação rpm de verdade
const hadPackageType = existsSync(PACKAGE_TYPE);
writeFileSync(PACKAGE_TYPE, "rpm", "utf8");

// 3. o feed local
const feedDir = join(tmpdir(), `stellar-update-feed-${process.pid}`);
mkdirSync(feedDir, { recursive: true });
const rpmName = `stellar-${OFFERED_VERSION}-1.x86_64.rpm`;
const rpmBytes = Buffer.from("rpm de mentira para a prova do check\n", "utf8");
writeFileSync(join(feedDir, rpmName), rpmBytes);
const sha512 = createHash("sha512").update(rpmBytes).digest("base64");
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

// 4. instância isolada
const userDataDir = join(tmpdir(), `stellar-update-proof-${process.pid}`);
rmSync(userDataDir, { recursive: true, force: true });
const child = spawn(BINARY, [`--user-data-dir=${userDataDir}`, "--no-sandbox"], {
  env: { ...process.env, STELLAR_UPDATE_FEED_URL: feedUrl, ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d.toString()));
child.stderr.on("data", (d) => (log += d.toString()));

const needle = `[updater] update-available ${OFFERED_VERSION}`;
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && !log.includes(needle)) {
  await new Promise((r) => setTimeout(r, 500));
}
const sawEvent = log.includes(needle);
check(
  `o MAIN recebeu o evento REAL de update-available (${OFFERED_VERSION}) do feed local`,
  sawEvent,
  true,
);
check(
  "o log do main nomeia o feed que respondeu (override), e nao o de producao",
  /\[updater\] update-available 99\.0\.0 \(feed: http:\/\/127\.0\.0\.1:\d+\)/.test(log),
  true,
);
if (!sawEvent) console.error("log do app (fim):\n", log.slice(-1500));

// 5. desmonte com verificação
child.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 800));
server.close();
rmSync(userDataDir, { recursive: true, force: true });
check("userData isolado destruído com verificação", existsSync(userDataDir), false);
if (!hadPackageType) rmSync(PACKAGE_TYPE, { force: true });
check("package-type do fixture removido (não deixei estado no build)", existsSync(PACKAGE_TYPE), hadPackageType);
mkdirSync(feedDir, { recursive: true });
rmSync(feedDir, { recursive: true, force: true });
finish();
