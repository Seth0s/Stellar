// Pre-release audit B6 — `handleSnapshotRequest`/`onReadCardRequest`
// (main/index.ts) each register a one-shot `ipcMain` listener
// ("snapshot:rect-reply"/"readcard:reply") while waiting for the renderer
// to answer, removed once it actually replies. If the renderer never
// replies (crashed/unresponsive window), message-bus.ts's own 10s timeout
// still resolves the caller — but nothing told main to give up on ITS
// listener too, so it stayed registered forever, one more per stuck
// request. Fixed with `onSnapshotTimeout`/`onReadCardTimeout` callbacks
// wired to two new `pendingXReplyCleanup` maps.
//
// Verifies live: a real renderer-side no-reply is simulated by
// navigating the window's own page to `about:blank` (real CDP
// `Page.navigate`) before firing the request — the preload script (and
// so `window.debugBridge`/`window.store`, plain IPC, unaffected by page
// content) reruns on the new document, but App.tsx's `onRectRequest`/
// `onReadCardRequest` subscribers are gone with it, so nothing EVER
// answers "snapshot:rect-request"/"readcard:request" — indistinguishable
// from main's perspective from a genuinely unresponsive window. (An
// earlier version of this test tried monkey-patching
// `window.snapshot.reply` to a no-op instead — contextBridge's exposed
// object silently ignored the reassignment, so the real reply still went
// through; navigating away removes the listener instead of trying to
// neuter it.) Drives the real raw acbridge-socket protocol
// (message-bus.ts), not a shortcut. Real `ipcMain.listenerCount(...)` —
// via a new test-only `debug:listener-count` IPC — proves the listener is
// gone after the timeout, not just that the request eventually resolves.
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9445;
const USER_DATA_DIR_URL = new URL("../../.verify-tmp/smoke-listener-leak-timeout", import.meta.url);
const USER_DATA_DIR = fileURLToPath(USER_DATA_DIR_URL);
const SOCK_PATH = `${USER_DATA_DIR}/agent-canvas.sock`;

function busRequest(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: SOCK_PATH }, () => {
      socket.end(JSON.stringify(request) + "\n");
    });
    let buf = "";
    socket.on("data", (chunk) => (buf += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse((buf.split("\n")[0] ?? "").trim()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Listener Leak Timeout Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const terminalCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("real terminal card id resolved", typeof terminalCardId === "string" && terminalCardId.length > 0, true);

  async function listenerCount(channel) {
    return JSON.parse(await page.evalJs(`window.debugBridge.listenerCount(${JSON.stringify(channel)}).then(JSON.stringify)`));
  }

  // No App.tsx mounted here at all past this point — nothing will EVER
  // answer a "snapshot:rect-request"/"readcard:request" IPC again.
  await page.send("Page.navigate", { url: "about:blank" });
  await new Promise((r) => setTimeout(r, 500));

  // ---- snapshot:rect-reply ----
  check("no snapshot:rect-reply listener before anything happens", await listenerCount("snapshot:rect-reply"), 0);

  const snapshotPromise = busRequest({ cmd: "snapshot", target: terminalCardId });
  await new Promise((r) => setTimeout(r, 500));
  check("main registers the listener while waiting for the (never-coming) reply", await listenerCount("snapshot:rect-reply"), 1);

  const snapshotResult = await snapshotPromise; // resolves after message-bus's own 10s timeout
  check("the request itself still resolves (not hung forever)", snapshotResult.ok, false);
  check("...with an honest timeout error", snapshotResult.error?.includes("timed out"), true);
  check("main's listener is cleaned up after the timeout, not leaked", await listenerCount("snapshot:rect-reply"), 0);

  // ---- readcard:reply ----
  check("no readcard:reply listener before anything happens", await listenerCount("readcard:reply"), 0);

  const readCardPromise = busRequest({ cmd: "read_card", target: terminalCardId });
  await new Promise((r) => setTimeout(r, 500));
  check("main registers the listener while waiting for the (never-coming) reply", await listenerCount("readcard:reply"), 1);

  const readCardResult = await readCardPromise; // resolves after message-bus's own 10s timeout
  check("the request itself still resolves (not hung forever)", readCardResult.ok, false);
  check("...with an honest timeout error", readCardResult.error?.includes("timed out"), true);
  check("main's listener is cleaned up after the timeout, not leaked", await listenerCount("readcard:reply"), 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
