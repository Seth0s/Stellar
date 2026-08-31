// Pre-release audit P2 — every visible BrowserCard painted at a flat
// rate (`browser-registry.ts`'s `wc.setFrameRate(...)`) regardless of
// whether it was the one the user is actually looking at — two visible
// browser cards competed for main-process CPU/IPC at the same full rate,
// even though only one is ever the topmost/interacted-with one. Fixed
// with `setFocused(id, focused)`: the topmost card (by z-order, the same
// `order` array App.tsx already tracks for raising) stays at
// `FOCUSED_FRAME_RATE` (60 as of DESIGN-BACKLOG.md §2.1's "60fps em
// foco" — was 30), every other visible-but-not-topmost one drops to
// 8fps. This test's own checks below only assert a bounded ceiling for
// the unfocused rate and a RELATIVE gap between the two, never the
// focused rate's exact value — the 60fps bump needed no assertion
// change, only these comments.
//
// Verifies live against two REAL browser cards, both navigated to a
// local page that repaints constantly via `requestAnimationFrame`
// (guarantees genuine, continuous paint activity to measure, not an
// idle page that would paint ~0 times regardless of the cap). Counts
// REAL `browser:frame` IPC deliveries (`window.browser.onFrame`, the
// same event BrowserCard.tsx itself draws from) per card over a fixed
// window — not a synthetic frame-rate read, since Electron's
// `webContents` exposes no getter for its own configured rate.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9451;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-unfocused-throttle", import.meta.url).pathname;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0">
    <canvas id="c" width="300" height="200"></canvas>
    <script>
      const ctx = document.getElementById('c').getContext('2d');
      function loop(t) {
        ctx.fillStyle = 'hsl(' + Math.floor(t % 360) + ',90%,50%)';
        ctx.fillRect(0, 0, 300, 200);
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    </script>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

async function createBrowserCard(page) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  // Address bars render one per card in DOM order; the LAST one in the
  // NodeList is the one just created.
  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inputs = document.querySelectorAll('.browser-card-address input');
        const el = inputs[inputs.length - 1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inputs = document.querySelectorAll('.browser-card-address input');
      const inp = inputs[inputs.length - 1];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(`http://127.0.0.1:${port}/`)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))
    `),
  );
  return browserCards[browserCards.length - 1];
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Unfocused Throttle Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // Created first, so it ends up BELOW the second one in z-order —
  // "unfocused" per App.tsx's own `order.indexOf` zIndex/raise logic,
  // no explicit raise() needed.
  const cardA = await createBrowserCard(page);
  const cardB = await createBrowserCard(page); // created after A — topmost/focused
  check("two distinct real browser cards created", typeof cardA === "string" && typeof cardB === "string" && cardA !== cardB, true);

  await new Promise((r) => setTimeout(r, 500)); // let setFocused effects settle

  await page.evalJs(`
    (() => {
      window.__frameCounts = {};
      window.browser.onFrame((id) => {
        window.__frameCounts[id] = (window.__frameCounts[id] ?? 0) + 1;
      });
      return true;
    })()
  `);
  const MEASURE_MS = 2500;
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  const counts = JSON.parse(await page.evalJs(`JSON.stringify(window.__frameCounts)`));

  const countA = counts[cardA] ?? 0; // unfocused (8fps expected)
  const countB = counts[cardB] ?? 0; // focused (60fps expected)

  check(`unfocused card A still paints (${countA} frames in ${MEASURE_MS}ms, not stalled outright)`, countA > 0, true);
  check(`focused card B paints noticeably faster than unfocused card A (${countB} vs ${countA} frames)`, countB > countA * 1.5, true);
  // ~8fps over 2.5s ≈ 20 frames; generous upper bound (still well under
  // the ~150 a 60fps card would show) so real timer jitter never flakes it.
  check(`unfocused card A's rate looks like the throttled ~8fps, not the full focused rate (${countA} frames)`, countA < 45, true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
