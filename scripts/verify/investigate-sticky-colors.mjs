// Live check for the new pastel sticky-note palette (StickyCard.tsx) —
// confirms the swatches/tag text/textarea background actually render the
// new softened hex values, not the old saturated ones.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9431;
const USER_DATA_DIR = new URL("../../.verify-tmp/investigate-sticky-colors", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Sticky Colors Test", { spawnTerminal: false });

  async function clickRailButton(title) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector('.rail-btn[title=${JSON.stringify(title)}]');
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    await page.click(coords.x, coords.y);
    await new Promise((r) => setTimeout(r, 400));
  }

  await clickRailButton("Nova nota adesiva");
  check("sticky card spawned", Number(await page.evalJs(`document.querySelectorAll('.sticky-card').length`)), 1);

  const tagColor = await page.evalJs(`getComputedStyle(document.querySelector('.sticky-card .card-tag')).color`);
  check("card-tag text color is the new soft yellow (#d4b876 → rgb(212, 184, 118))", tagColor, "rgb(212, 184, 118)");

  const swatchColors = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('.sticky-card .swatch')].map(s => getComputedStyle(s).backgroundColor))
    `),
  );
  check(
    "4 swatches, all new soft palette values",
    swatchColors,
    ["rgb(212, 184, 118)", "rgb(130, 199, 154)", "rgb(122, 184, 221)", "rgb(209, 146, 179)"],
  );

  // Switch to pink and confirm both the tag text and textarea bg update live.
  const pinkSwatch = JSON.parse(
    await page.evalJs(`
      (() => {
        const els = [...document.querySelectorAll('.sticky-card .swatch')];
        const r = els[3].getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(pinkSwatch.x, pinkSwatch.y);
  await new Promise((r) => setTimeout(r, 300));
  const pinkTagColor = await page.evalJs(`getComputedStyle(document.querySelector('.sticky-card .card-tag')).color`);
  check("after picking pink, tag text is the new soft rose", pinkTagColor, "rgb(209, 146, 179)");
  const pinkTextareaBg = await page.evalJs(`getComputedStyle(document.querySelector('.sticky-textarea')).backgroundColor`);
  check("textarea background is the (unchanged) dark pink tint", pinkTextareaBg, "rgb(74, 32, 56)");

  page.close();
} finally {
  await stopApp(app);
}
finish();
