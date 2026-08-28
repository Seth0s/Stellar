import { startApp, stopApp, connectPage, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9432;
const USER_DATA_DIR = new URL("../../.verify-tmp/investigate-sticky-text-color", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Text Color Test", { spawnTerminal: false });
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.rail-btn[title="Nova nota adesiva"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(coords.x, coords.y);
  await new Promise((r) => setTimeout(r, 400));
  const result = await page.evalJs(`
    (() => {
      const ta = document.querySelector('.sticky-textarea');
      const cs = getComputedStyle(ta);
      return JSON.stringify({ color: cs.color, background: cs.backgroundColor });
    })()
  `);
  console.log("textarea colors:", result);

  // Actually type something and screenshot-equivalent: read back the
  // rendered text node's contrast isn't directly queryable, but we can at
  // least confirm the value round-trips and log the two colors for a
  // manual contrast judgement.
  page.close();
} finally {
  await stopApp(app);
}
