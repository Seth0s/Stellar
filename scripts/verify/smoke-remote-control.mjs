// The mobile remote-control server (DESIGN-BACKLOG.md item 2, phase A) —
// pairing, wrong-token rejection, a real terminal round-trip over the
// WebSocket protocol, and revoke. This is the scripted version of the
// manual verification done when the feature was built; keeping it means
// the next change to remote-server.ts/pty-registry.ts gets checked the
// same way without hand-writing throwaway CDP scripts again.
import { startApp, stopApp, connectPage, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9403;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-remote-control", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  const pairing = JSON.parse(await page.evalJs(`window.remote.pairing().then(JSON.stringify)`));
  check("pairing returns a port", pairing.port, (p) => typeof p === "number");
  check("pairing returns a token", pairing.token, (t) => typeof t === "string" && t.length > 0);

  const base = `http://127.0.0.1:${pairing.port}`;
  const indexRes = await fetch(base + "/");
  check("GET / (mobile client) status", indexRes.status, 200);
  const xtermRes = await fetch(base + "/vendor/xterm.js");
  check("GET /vendor/xterm.js status", xtermRes.status, 200);

  const badWs = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=wrong`);
  const badResult = await new Promise((resolve) => {
    let gotMessage = false;
    badWs.addEventListener("message", () => (gotMessage = true));
    badWs.addEventListener("close", (ev) => resolve({ code: ev.code, gotMessage }));
  });
  check("wrong token closes with 4001", badResult.code, 4001);
  check("wrong token never receives data first", badResult.gotMessage, false);

  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=${pairing.token}`);
  const cardsMsg = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for cards")), 4000);
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      resolve(JSON.parse(ev.data));
    });
  });
  check("initial message lists at least the auto-seeded terminal", cardsMsg.cards.length, (n) => n >= 1);

  const card = cardsMsg.cards[0];
  let buffer = "";
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "pty:data" && msg.id === card.id) buffer += msg.data;
  });
  const marker = "SMOKE_" + Math.random().toString(36).slice(2, 8);
  ws.send(JSON.stringify({ type: "pty:write", id: card.id, data: `echo ${marker}\n` }));
  await new Promise((r) => setTimeout(r, 1500));
  check("command written over WS actually ran (marker echoed back)", buffer.includes(marker), true);
  ws.close();

  await page.evalJs(`window.remote.revoke()`);
  await new Promise((r) => setTimeout(r, 200));
  const oldTokenWs = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=${pairing.token}`);
  const revokedResult = await new Promise((resolve) => {
    oldTokenWs.addEventListener("close", (ev) => resolve(ev.code));
  });
  check("old token rejected after revoke", revokedResult, 4001);

  page.close();
} finally {
  await stopApp(app);
}
finish();
