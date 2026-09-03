// DESIGN-BACKLOG.md item 16 — the constellation background's reactive
// layer (push physics + slow autonomous drift) runs entirely via direct
// DOM attribute writes in a rAF loop (ConstellationBg.tsx), not React
// state — no re-render to hook into, so this drives the SAME real thing a
// human eye would see: reads a field star's live `cx`/`cy` attributes
// before/after synthetic mouse movement and after a real time delay.
import { startApp, stopApp, connectPage, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9432;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-constellation", import.meta.url).pathname;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  check("Home screen shows the constellation SVG layer", await page.evalJs(`!!document.querySelector('.home-stars')`), true);
  check("field stars rendered (original 20 + bonus, 130+)", await page.evalJs(`document.querySelectorAll('.home-stars circle').length > 100`), true);
  check("cluster constellation lines rendered (12 instances: 4 shapes x 3 placements)", await page.evalJs(`document.querySelectorAll('.home-stars polyline').length`), 12);

  // Pick a field star (not a cluster hero, simpler physics-only case) and
  // find its on-screen position, so the synthetic mouse can be aimed
  // directly at it through a real coordinate transform (viewBox -> CSS px,
  // same `slice` math the component itself does).
  //
  // Position reads below use `getBoundingClientRect()` (real rendered
  // position, in client px) instead of the `cx`/`cy` attributes — perf fix
  // (2026-09-03, CPU spike on the home screen) moved per-frame movement to
  // `style.transform` (cheaper than mutating SVG geometry attrs every
  // frame), so `cx`/`cy` now stay frozen at their JSX-authored base value
  // and only the bounding rect reflects the star's true on-screen position.
  const svgBox = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('.home-stars').getBoundingClientRect())`));
  const readCenter = (sel) =>
    page.evalJs(`
      (() => {
        const r = document.querySelectorAll('${sel}')[5].getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()
    `);
  const before = JSON.parse(await readCenter(".home-stars circle"));
  const scale = Math.max(svgBox.width / 100, svgBox.height / 100);
  const clientX = before.x;
  const clientY = before.y;

  // A fast synthetic flick straight across the star's own position —
  // several dispatched mouseMoved events close together in time, same as
  // a real aggressive mouse gesture the component's velocity math expects.
  for (let i = -4; i <= 4; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clientX + i * 6,
      y: clientY,
      pointerType: "mouse",
    });
    await new Promise((r) => setTimeout(r, 12));
  }
  await new Promise((r) => setTimeout(r, 80));

  const pushed = JSON.parse(await readCenter(".home-stars circle"));
  // Thresholds below are in client px (`scale` converts the original
  // viewBox-unit thresholds — see the perf-fix comment above `readCenter`).
  check("a fast mouse pass near a field star measurably displaces it", dist(before, pushed) > 0.3 * scale, true);

  // Stop moving the mouse entirely and confirm the spring decays the
  // offset back toward the star's drifted-but-unpushed rest position.
  await new Promise((r) => setTimeout(r, 1500));
  const settled = JSON.parse(await readCenter(".home-stars circle"));
  check("...and settles back down after the mouse stops moving", dist(pushed, settled) > dist(before, pushed) * 0.4, true);

  // Camera drift — real elapsed time, no synthetic input at all.
  const drift0 = JSON.parse(await readCenter(".home-stars circle"));
  await new Promise((r) => setTimeout(r, 4000));
  const drift1 = JSON.parse(await readCenter(".home-stars circle"));
  check("the whole field drifts on its own over real time, with no input", dist(drift0, drift1) > 0.005 * scale, true);

  // A cluster's polyline must stay a rigid shape while drifting/pushed —
  // this is exactly the bug the rigid-body wrap shift was written to
  // prevent: sample the polyline's own point spread twice, confirm it's
  // stable (not suddenly stretched across the canvas).
  const spread = () =>
    page.evalJs(`
      (() => {
        const line = document.querySelectorAll('.home-stars polyline')[0];
        const pts = line.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
        const xs = pts.map((p) => p[0]);
        return JSON.stringify(Math.max(...xs) - Math.min(...xs));
      })()
    `);
  const spread0 = JSON.parse(await spread());
  await new Promise((r) => setTimeout(r, 2000));
  const spread1 = JSON.parse(await spread());
  check("a cluster's own point spread stays small (rigid shape, not torn apart by wrap)", spread0 < 25 && spread1 < 25, true);

  page.close();
} finally {
  await stopApp(app);
}

// Second instance: `prefers-reduced-motion: reduce` set via CDP BEFORE
// the page even loads (Page.reload after Emulation.setEmulatedMedia, so
// the effect's `mql.matches` check at mount reads it from the start) —
// the case that actually matters (an OS accessibility setting already
// on), distinct from toggling it live mid-session. Item 16's whole point
// here: this must render EXACTLY the pre-item-16 static field (the
// original 20 field points + 4 clusters at their original 0-100
// coordinates), not a differently-distributed subset of the enlarged one.
const CDP_PORT_2 = CDP_PORT + 1;
const USER_DATA_DIR_2 = `${USER_DATA_DIR}-reduced-motion`;
const app2 = await startApp({ cdpPort: CDP_PORT_2, userDataDir: USER_DATA_DIR_2 });
try {
  const page = await connectPage(CDP_PORT_2);
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await page.send("Page.enable");
  await page.send("Page.reload");
  await new Promise((r) => setTimeout(r, 1200));

  const info = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        fieldInTile: [...document.querySelectorAll('.home-stars > circle')].filter((c) => {
          const x = parseFloat(c.getAttribute('cx')), y = parseFloat(c.getAttribute('cy'));
          return x < 100 && y < 100;
        }).length,
        clusterPtsInTile: [...document.querySelectorAll('.home-stars g circle')].filter((c) => {
          const x = parseFloat(c.getAttribute('cx')), y = parseFloat(c.getAttribute('cy'));
          return x < 100 && y < 100;
        }).length,
      })
    `),
  );
  check("reduced motion: exactly the original 20 field points visible (no bonus content leaks in)", info.fieldInTile, 20);
  check("reduced motion: exactly the original 17 cluster points visible (4 shapes, 5+4+5+3 pts)", info.clusterPtsInTile, 17);

  const pos0 = JSON.parse(
    await page.evalJs(`(() => { const c = document.querySelectorAll('.home-stars > circle')[5]; return JSON.stringify({x: c.getAttribute('cx'), y: c.getAttribute('cy')}); })()`),
  );
  await new Promise((r) => setTimeout(r, 2000));
  const pos1 = JSON.parse(
    await page.evalJs(`(() => { const c = document.querySelectorAll('.home-stars > circle')[5]; return JSON.stringify({x: c.getAttribute('cx'), y: c.getAttribute('cy')}); })()`),
  );
  check("reduced motion: attributes frozen byte-identical over real time (no rAF loop running at all)", JSON.stringify(pos0) === JSON.stringify(pos1), true);

  page.close();
} finally {
  await stopApp(app2);
}

finish();
