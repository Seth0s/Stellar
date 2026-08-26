// The mobile remote-control server (DESIGN-BACKLOG.md item 2) — pairing,
// wrong-token rejection, a real terminal round-trip over the WebSocket
// protocol, and per-device + revoke-all (item 2 revisited). This is the
// scripted version of the manual verification done when the feature was
// built; keeping it means the next change to remote-server.ts/
// pty-registry.ts gets checked the same way without hand-writing
// throwaway CDP scripts again.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9403;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-remote-control", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // DESIGN-BACKLOG.md item 8 — boots to Home now, no cards to report over
  // the remote WS until a session actually exists.
  await bootIntoFreshSession(page);

  // Item 2 revisited — each pairing call mints a NEW device (own id +
  // token), not one shared server-wide token.
  const pairing = JSON.parse(await page.evalJs(`window.remote.pairNewDevice().then(JSON.stringify)`));
  check("pairing returns a port", pairing.port, (p) => typeof p === "number");
  check("pairing returns a token", pairing.token, (t) => typeof t === "string" && t.length > 0);
  check("pairing returns a device id", pairing.id, (id) => typeof id === "string" && id.length > 0);

  // DESIGN-BACKLOG.md item 12, achado 4 — the QR itself was a real, valid
  // data: URL all along; the CSP's `default-src 'self'` (no `img-src`)
  // silently blocked the <img> from ever loading it, showing a
  // broken-image icon. Checking `naturalWidth` (not just that `src` looks
  // right) is what actually catches a CSP regression — a blocked image
  // still gets a `src` attribute, it just never decodes.
  const remoteBtnCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.zoom-pill button[title*="Controle remoto"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!remoteBtnCoords) throw new Error("Topbar's 'Controle remoto' button not found");
  await page.click(remoteBtnCoords.x, remoteBtnCoords.y);
  await new Promise((r) => setTimeout(r, 1500));
  // The modal only auto-pairs on mount when NO device exists yet — the
  // direct `pairNewDevice()` call above already created one, so click
  // "+ parear novo dispositivo" explicitly to get a QR rendered here too
  // (also exercises that button, not just the auto-pair-on-first-open path).
  await page.evalJs(`document.querySelector('.remote-pair-new')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  const qr = JSON.parse(
    await page.evalJs(`
      (() => {
        const img = document.querySelector('.remote-pairing-qr');
        return JSON.stringify(img ? { exists: true, complete: img.complete, naturalWidth: img.naturalWidth } : { exists: false });
      })()
    `),
  );
  if (qr.exists) {
    check("QR image actually decodes (not a broken-image icon)", qr.complete && qr.naturalWidth > 0, true);
  } else {
    // No LAN address in this sandbox (RemotePairingModal shows the
    // no-address message instead, `pairing.qrDataUrl` is legitimately
    // null then) — nothing to assert either way.
    console.log("(no LAN address in this environment — QR <img> never renders; skipping)");
  }
  check(
    "device list shows both paired devices (direct call + modal button)",
    await page.evalJs(`document.querySelectorAll('.remote-device-row').length`),
    2,
  );
  await page.evalJs(`document.querySelector('.modal-actions button.primary')?.click()`);
  await new Promise((r) => setTimeout(r, 200));

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

  // Item 2 revisited — a second, independent device (own token), so the
  // per-device revoke below can be checked against "everyone else stays
  // connected", not just "the one token I revoked stops working".
  const pairing2 = JSON.parse(await page.evalJs(`window.remote.pairNewDevice().then(JSON.stringify)`));

  await page.evalJs(`window.remote.revokeDevice(${JSON.stringify(pairing.id)})`);
  await new Promise((r) => setTimeout(r, 200));
  const revokedResult = await new Promise((resolve) => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=${pairing.token}`);
    ws1.addEventListener("close", (ev) => resolve(ev.code));
  });
  check("revoked device's token rejected", revokedResult, 4001);

  const otherResult = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for cards on the untouched device")), 4000);
    const ws2 = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=${pairing2.token}`);
    ws2.addEventListener("message", (ev) => {
      clearTimeout(t);
      ws2.close();
      resolve(JSON.parse(ev.data));
    });
    ws2.addEventListener("close", (ev) => {
      if (ev.code !== 1000) reject(new Error("unrevoked device's socket closed unexpectedly: " + ev.code));
    });
  });
  check(
    "revoking one device leaves an untouched device's token still working",
    otherResult.cards.length,
    (n) => n >= 1,
  );

  await page.evalJs(`window.remote.revokeAll()`);
  await new Promise((r) => setTimeout(r, 200));
  const revokedAllResult = await new Promise((resolve) => {
    const ws3 = new WebSocket(`ws://127.0.0.1:${pairing.port}/ws?token=${pairing2.token}`);
    ws3.addEventListener("close", (ev) => resolve(ev.code));
  });
  check("revokeAll rejects every remaining device's token too", revokedAllResult, 4001);

  page.close();
} finally {
  await stopApp(app);
}
finish();
