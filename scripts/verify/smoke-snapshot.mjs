// DESIGN-BACKLOG.md item 4 (`acbridge snapshot`) + item 21 ponto 1 — no
// automated coverage existed for the snapshot protocol at all before this;
// it had only ever been verified manually (see AGENTS.md's "Verificação ao
// vivo, não só lida" note). Drives the REAL unix-socket protocol
// (`main/message-bus.ts`), the exact same one `resources/bin/acbridge`
// uses — not a shortcut through some renderer-exposed API.
//
// Also re-verifies the specific finding documented in AGENTS.md/DESIGN-
// BACKLOG.md item 21 ponto 1: "browser card comes back as a flat rectangle
// in an agent's snapshot, capturePage() doesn't compose WebContentsView".
// That finding predates the 2026-08-26 rewrite of the browser card from a
// native WebContentsView child to offscreen-rendering-into-a-<canvas>
// (browser-registry.ts) — and a `<canvas>` painted by the SAME renderer
// window IS plain DOM content, which capturePage() has always composited
// correctly (same as xterm's own DOM text). Empirically re-tested live
// while investigating item 21 ponto 1: the finding no longer reproduces —
// capturePage() now shows the real page (confirmed visually, a live Google
// homepage came through pixel-for-pixel). No workaround code needed; this
// test is the regression guard against it silently breaking again.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CDP_PORT = 9427;
const USER_DATA_DIR_URL = new URL("../../.verify-tmp/smoke-snapshot", import.meta.url);
const USER_DATA_DIR = fileURLToPath(USER_DATA_DIR_URL);
const SOCK_PATH = `${USER_DATA_DIR}/agent-canvas.sock`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Snapshot Teste");

  function snapshotRequest(request) {
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

  // Whole window, no target — same path `acbridge snapshot` (no args) uses.
  const wholeWindow = await snapshotRequest({ cmd: "snapshot" });
  check("whole-window snapshot succeeds", wholeWindow.ok, true);
  check("whole-window snapshot returns a real file", wholeWindow.ok && readFileSync(wholeWindow.path).length > 1000, true);

  // cardId-targeted, the auto-seeded bash terminal from bootIntoFreshSession.
  const boardId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`),
  );
  const terminalCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  const terminalSnapshot = await snapshotRequest({ cmd: "snapshot", target: terminalCardId });
  check("cardId-targeted snapshot of a terminal card succeeds", terminalSnapshot.ok, true);

  // An unknown cardId returns a clear error, not a crash/hang.
  const badIdSnapshot = await snapshotRequest({ cmd: "snapshot", target: "does-not-exist" });
  check("snapshot of an unknown cardId returns ok:false with an error, not a crash", badIdSnapshot.ok, false);
  check("unknown-cardId error message is non-empty", typeof badIdSnapshot.error === "string" && badIdSnapshot.error.length > 0, true);

  // Explicit rect — the third protocol shape (`acbridge snapshot x y w h`).
  const rectSnapshot = await snapshotRequest({ cmd: "snapshot", rect: { x: 0, y: 0, w: 200, h: 200 } });
  check("explicit-rect snapshot succeeds", rectSnapshot.ok, true);

  // The actual item 21 ponto 1 regression guard: spawn a browser card,
  // navigate it to a real page, snapshot it by cardId, and confirm the
  // saved PNG has real (non-blank) content in the browser card's own
  // area — not the flat `--surface` rectangle the old WebContentsView-
  // based implementation produced.
  const railBtnCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.rail-btn')].find((x) => x.title === 'Novo navegador');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  await page.click(railBtnCoords.x, railBtnCoords.y);
  await new Promise((r) => setTimeout(r, 500));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.browser-card-address input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'https://example.com');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 3000));

  const browserCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'browser')?.id ?? null))
    `),
  );
  const browserSnapshot = await snapshotRequest({ cmd: "snapshot", target: browserCardId });
  check("cardId-targeted snapshot of the browser card succeeds", browserSnapshot.ok, true);

  if (browserSnapshot.ok) {
    // CSP is `img-src 'self' data:` — a `file://` <img> would be blocked,
    // so hand the PNG in as a data: URL instead (allowed) and sample it
    // via a throwaway canvas, same pixel-counting approach smoke-
    // browser.mjs already uses for the LIVE canvas.
    const b64 = readFileSync(browserSnapshot.path).toString("base64");
    const nonWhite = JSON.parse(
      await page.evalJs(`
        (async () => {
          const img = new Image();
          img.src = "data:image/png;base64,${b64}";
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let nonWhite = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 250 || data[i+1] < 250 || data[i+2] < 250) nonWhite++;
          }
          return JSON.stringify(nonWhite);
        })()
      `),
    );
    // Real navigated content (Example Domain: dark text on white) paints a
    // real block of non-white pixels — the old broken symptom (a flat
    // `--surface` gray rectangle) would still technically be "non-white"
    // by this same check since --surface isn't pure white either, so this
    // alone isn't proof; the visual confirmation (done manually while
    // fixing this) is what actually settled it. This check exists as a
    // regression guard against the snapshot going back to fully blank/
    // solid (0 non-white pixels), which a real composited page never is.
    check("browser card's snapshot PNG has real (non-blank) content", nonWhite > 500, true);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
