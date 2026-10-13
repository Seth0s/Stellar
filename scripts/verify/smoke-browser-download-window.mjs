import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-download-${CDP_PORT}`);
const isolatedHome = `${USER_DATA_DIR}-home`;
const downloadDir = join(isolatedHome, "Downloads");
const configDir = join(isolatedHome, ".config");
mkdirSync(downloadDir, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "user-dirs.dirs"), `XDG_DOWNLOAD_DIR="${downloadDir}"\n`);
const existingDownload = join(downloadDir, "browser-smoke.txt");
writeFileSync(existingDownload, "keep this existing file");

const server = createServer((request, response) => {
  if (request.url === "/download") {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="browser-smoke.txt"' });
    response.end("download survived");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>start</title></head><body>
    <a id="download" href="/download" download>download</a>
    <a id="new-window" href="/child" target="_blank">new window</a>
  </body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, extraEnv: { HOME: isolatedHome, XDG_CONFIG_HOME: configDir } });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await bootIntoFreshSession(page, "Browser download and window test", { spawnTerminal: false });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const railPoint = JSON.parse(await page.evalJs(`(() => {
    const button = document.querySelector('[data-role="rail-add-card"]');
    if (!button) return JSON.stringify(null);
    const rect = button.getBoundingClientRect();
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  })()`));
  if (!railPoint) throw new Error("browser-card creation control was not found");
  await page.click(railPoint.x, railPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const browserPoint = JSON.parse(await page.evalJs(`(() => {
    const button = document.querySelector('[data-role="rail-panel"] [data-kind="browser"]');
    if (!button) return JSON.stringify(null);
    const rect = button.getBoundingClientRect();
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  })()`));
  if (!browserPoint) throw new Error("browser option was not found in the add-card popover");
  await page.click(browserPoint.x, browserPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => JSON.stringify(boards[0].id))`));
  const cardIds = JSON.parse(await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((card) => card.kind === 'browser').map((card) => card.id)))`));
  const cardId = cardIds.at(-1);
  if (!cardId) throw new Error("browser card did not appear in the board store");
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(fixtureUrl)})`);
  const targetDeadline = Date.now() + 8000;
  let target;
  while (Date.now() < targetDeadline) {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((response) => response.json());
    target = targets.find((item) => item.url.startsWith(fixtureUrl));
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!target) throw new Error("could not find the browser card's fixture target in CDP");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  ws.addEventListener("close", () => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const messageId = ++id;
    pending.set(messageId, resolve);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })).result.value;
  await send("Runtime.enable");
  await send("Page.enable");
  const pageReadyDeadline = Date.now() + 5000;
  while (Date.now() < pageReadyDeadline && !(await evaluate(`!!document.querySelector('#download')`))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const downloadLink = JSON.parse(await evaluate(`(() => {
    const rect = document.querySelector('#download').getBoundingClientRect();
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  })()`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: downloadLink.x, y: downloadLink.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: downloadLink.x, y: downloadLink.y, button: "left", clickCount: 1 });
  const downloadDeadline = Date.now() + 5000;
  while (Date.now() < downloadDeadline && !readdirSync(downloadDir).includes("browser-smoke (1).txt")) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check("browser-card download receives a unique filename in isolated Downloads", readdirSync(downloadDir).includes("browser-smoke (1).txt"), true);
  check("an existing download with the same filename remains unchanged", readFileSync(existingDownload, "utf8"), "keep this existing file");
  check("Electron remains alive after the browser-card download", app.proc.exitCode, null);
  if (app.proc.exitCode !== null) {
    throw new Error(`Electron exited during the browser-card download (exit ${app.proc.exitCode})\n${app.stderr().slice(-2000)}`);
  }

  const windowLink = JSON.parse(await evaluate(`(() => {
    const rect = document.querySelector('#new-window').getBoundingClientRect();
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  })()`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: windowLink.x, y: windowLink.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: windowLink.x, y: windowLink.y, button: "left", clickCount: 1 });
  const navigationDeadline = Date.now() + 5000;
  let sameCardAtChild = false;
  while (Date.now() < navigationDeadline) {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((response) => response.json());
    const child = targets.find((item) => item.id === target.id);
    if (child?.url === new URL("/child", fixtureUrl).href) { sameCardAtChild = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check("target=_blank navigates within the existing browser card", sameCardAtChild, true);
  check("Electron remains alive after the new-window link", app.proc.exitCode, null);
  ws.close();
  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
