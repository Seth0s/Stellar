// DESIGN-BACKLOG.md item 1 revisited — press-and-hold as a second gatilho
// for the radial menu, alongside right-click (already covered by
// smoke-card-lifecycle.mjs). Held still past the 450ms timer opens it; a
// real drag (moved past the 6px threshold early) must NOT open it — that
// would make ordinary panning pop the menu constantly.
//
// The indicator half of this test was rewritten 2026-09-09: the repo
// owner reverted the item-21/7 decision this file used to assert (an arc
// riding the ring) in favor of a straight line from the CENTER to the
// cursor, clipped at the ring's radius — see RadialMenu.tsx's file
// comment for the full history. The old assertions here (`.radial-
// indicator path`, freeze-at-last-RAW-angle) describe behavior that no
// longer exists; this rewrite targets the new one instead: a `<line>`
// element, and "sticks to the last item" now meaning "snaps to that
// item's own angle", not "whatever raw angle the cursor last had".
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
// Review round 4, achado 3 — this used to hardcode its own `ROOT_RADIUS =
// 88`, duplicating RadialMenu.tsx's radius instead of deriving from it;
// the exact kind of repeated number that silently drifts out of sync
// (board-model.test.ts already broke this way once this session, per the
// same review). Node (v22.23+ here) can import a `.ts` file directly —
// confirmed working for this exact file before relying on it — so this
// imports the real constant instead of re-typing it.
import { BASE_RADIUS } from "../../src/renderer/src/radial-ring-geometry.ts";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-radial-longpress-${CDP_PORT}`, import.meta.url).pathname;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reads the indicator `<line>`'s endpoints, if one is currently rendered. */
async function readIndicatorLine(page) {
  const raw = await page.evalJs(`
    JSON.stringify((() => {
      const l = document.querySelector('.radial-indicator line');
      if (!l) return null;
      return {
        x1: Number(l.getAttribute('x1')),
        y1: Number(l.getAttribute('y1')),
        x2: Number(l.getAttribute('x2')),
        y2: Number(l.getAttribute('y2')),
      };
    })())
  `);
  return JSON.parse(raw);
}

/** Polls until a `<line>` is present AND satisfies `predicate` — same
 * poll-with-timeout discipline as smoke-files-live-watch.mjs's `waitFor`
 * / smoke-browser-inspector-device-frame.mjs's `waitForBrowserJs`: wait
 * past the moment a `mouseMoved` dispatch lands and React actually
 * re-renders, without hard-coding how long that takes or masking a real
 * regression behind a blind fixed sleep. */
async function waitForIndicatorLineNear(page, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = await readIndicatorLine(page);
    if (line && predicate(line)) return line;
    await delay(100);
  }
  return null;
}

// --- geometry mirrored from RadialMenu.tsx / radial-indicator.ts -------
//
// ROOT_ITEM_COUNT: `ACTIONS.length` (11), the top-level ring this test
// drives — not imported since it's just `ACTIONS.length`, not a
// standalone exported constant anywhere.
// ROOT_RADIUS: `idealRadiusFor(ROOT_ITEM_COUNT)` (radial-ring-geometry.ts)
// is `BASE_RADIUS` for any count <= ~12 (see that module's own tests),
// which 11 is — imported directly rather than recomputing
// `idealRadiusFor` here, since this test only cares about the concrete
// number, not the count-driven growth logic.
// `point` below (1080, 400) is far enough from every edge of the default
// window that `resolveRingGeometry`'s clamp (review round 4) never
// engages — the ring's rendered center stays exactly at `point`, exactly
// as this test assumes throughout.
// itemAngleRad mirrors `itemAngle` in radial-indicator.ts exactly — kept
// duplicated (not imported) since this script is plain JS run outside
// the TS build, same reasoning RadialMenu.tsx gives for its own
// PROVIDER_ICON duplication.
const ROOT_ITEM_COUNT = 11;
const ROOT_RADIUS = BASE_RADIUS;
function itemAngleRad(i, n) {
  return (i / n) * Math.PI * 2 - Math.PI / 2;
}

// Review achado 1 — a cursor at EXACTLY 90° (straight down) sits on a
// genuine mathematical tie: itemAngle(5.5, 11) === PI/2 exactly, the
// precise midpoint between item 5 (~73.6°) and item 6 (~106.36°). Which
// one `nearestItemIndex` used to pick there depended on ~1e-16 IEEE 754
// rounding noise — an accident, not a rule (fixed source-side in
// radial-indicator.ts's `nearestItemIndex` with an explicit epsilon
// tie-break, tested in tests/unit/radial-indicator.test.ts). This smoke
// test has no business sitting on that boundary when what it wants is
// "unambiguously item 6, not item 5" — so it uses the angle exactly
// halfway between the tie boundary (90°) and item 6's own center
// (~106.36°) instead: ~8.2° clear of the boundary on one side, ~8.2°
// clear of item 6's own center on the other. Deliberately NOT item 6's
// own center either — the freeze assertion below needs the raw
// (pre-freeze) angle and the snapped (post-freeze) angle to be two
// genuinely different values, or it can't tell "snaps to the item" apart
// from "keeps the last raw angle" (the reverted behavior).
const TIE_BOUNDARY_RAD = (itemAngleRad(5, ROOT_ITEM_COUNT) + itemAngleRad(6, ROOT_ITEM_COUNT)) / 2;
const ITEM6_CENTER_RAD = itemAngleRad(6, ROOT_ITEM_COUNT);
const SAFE_ANGLE_RAD = (TIE_BOUNDARY_RAD + ITEM6_CENTER_RAD) / 2;
const SAFE_DX = Math.round(Math.cos(SAFE_ANGLE_RAD) * ROOT_RADIUS);
const SAFE_DY = Math.round(Math.sin(SAFE_ANGLE_RAD) * ROOT_RADIUS);
// Expected endpoint deltas (relative to the ring's center) once frozen —
// snapped to item 6's own exact angle, length back out to the full
// radius (per `computeIndicator`'s frozen branch).
const FROZEN_DX = Math.cos(ITEM6_CENTER_RAD) * ROOT_RADIUS;
const FROZEN_DY = Math.sin(ITEM6_CENTER_RAD) * ROOT_RADIUS;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page);

  // Same empty point smoke-card-lifecycle.mjs uses, for the same reason
  // (clear of the auto-seeded terminal's 860×660 box, with margin for the
  // radial menu's own spread).
  const point = { x: 1080, y: 400 };

  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 600));
  check(
    "radial menu opens from a held-still left-button press (long-press)",
    await page.evalJs(`!!document.querySelector(".radial-menu")`),
    true,
  );

  // Center-line indicator (RadialMenu.tsx / radial-indicator.ts,
  // 2026-09-09 rewrite): a straight `<line>` from the ring's center
  // toward the cursor, clipped at the ring's radius; no indicator before
  // the cursor ever gets within RING_BAND of the ring. ROOT_RADIUS is
  // imported (BASE_RADIUS), ROOT_ITEM_COUNT=11 is `ACTIONS.length` in
  // RadialMenu.tsx (see the geometry block above); if the root ring's
  // item count changes the expected angles below need recomputing.
  const noIndicatorYet = await page.evalJs(`JSON.stringify(!document.querySelector('.radial-indicator'))`);
  check("no indicator before the pointer nears the ring", JSON.parse(noIndicatorYet), true);
  // A stray `.radial-indicator path` would mean the old arc markup is
  // still around (this rewrite's whole point) — fail loudly instead of
  // the later checks just silently finding nothing under a stale selector.
  check(
    "no leftover arc <path> markup from the reverted item-21/7 behavior",
    await page.evalJs(`!!document.querySelector('.radial-indicator path')`),
    false,
  );

  // Move onto the ring, straight right of the anchor (raw angle 0).
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + ROOT_RADIUS,
    y: point.y,
    button: "left",
    pointerType: "mouse",
  });
  const atRight = await waitForIndicatorLineNear(page, (l) => l.x2 !== l.x1 || l.y2 !== l.y1);
  check("moving onto the ring shows the indicator line", atRight !== null, true);
  check(
    // While inside the ring band the line follows the cursor's RAW angle
    // live (only the freeze below snaps to an item) — pointing right
    // means the endpoint sits to the right of the start point and level
    // with it vertically.
    "line points right (x2 well past x1, y2 level with y1) while hovering the ring at angle 0",
    atRight !== null && atRight.x2 - atRight.x1 > 60 && Math.abs(atRight.y2 - atRight.y1) < 5,
    true,
  );
  // A line drawn from the CENTER, not an arc riding the ring: the start
  // point never moves off the ring's center regardless of cursor angle —
  // checked again after the next two moves below.
  const centerX = atRight?.x1;
  const centerY = atRight?.y1;

  // Move to a different point on the ring — SAFE_ANGLE_RAD (see the
  // geometry block above), unambiguously inside item 6's sector — real
  // tracking, not a static decoration. While in-band the line follows
  // this RAW angle live (only the freeze below snaps to the item).
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + SAFE_DX,
    y: point.y + SAFE_DY,
    button: "left",
    pointerType: "mouse",
  });
  const atDown = await waitForIndicatorLineNear(
    page,
    (l) => Math.abs(l.x2 - l.x1 - SAFE_DX) < 3 && Math.abs(l.y2 - l.y1 - SAFE_DY) < 3,
  );
  check("moving to a different point on the ring updates the line (real tracking)", atDown !== null, true);
  check("the line's start point stays fixed at the ring's center across moves", atDown?.x1 === centerX && atDown?.y1 === centerY, true);

  // Leave the ring band entirely — back to dead center under the cursor.
  // Old behavior (item 21/7, reverted): froze at whatever RAW angle was
  // last computed (here, SAFE_ANGLE_RAD, ~98.18°) because updates just
  // stopped outside the band — the frozen endpoint would stay at
  // (SAFE_DX, SAFE_DY). New, explicit rule (radial-indicator.ts's
  // `computeIndicator`): freeze at the last POINTED ITEM's own angle
  // instead — item 6's exact center, ~106.36° (FROZEN_DX/FROZEN_DY),
  // genuinely different from SAFE_DX/SAFE_DY by construction. This is
  // exactly the assertion that would fail under the old (or a naive
  // line-that-freezes-on-the-raw-last-angle) implementation — both would
  // keep the endpoint at (SAFE_DX, SAFE_DY) here instead of snapping to
  // (FROZEN_DX, FROZEN_DY).
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
    pointerType: "mouse",
  });
  const frozen = await waitForIndicatorLineNear(
    page,
    (l) => Math.abs(l.x2 - l.x1 - FROZEN_DX) < 2 && Math.abs(l.y2 - l.y1 - FROZEN_DY) < 2,
  );
  check("leaving the ring keeps the indicator visible, frozen — not reset/removed", frozen !== null, true);
  check(
    "frozen line snaps to item 6's exact angle (FROZEN_DX/DY), not the raw last cursor angle (SAFE_DX/DY, which the old/naive behavior would keep)",
    frozen !== null &&
      Math.abs(frozen.x2 - frozen.x1 - FROZEN_DX) < 2 &&
      Math.abs(frozen.y2 - frozen.y1 - FROZEN_DY) < 2 &&
      // The discriminator: assert it's NOT the raw angle's endpoint —
      // this is what the old ("freeze on last raw angle") behavior, or a
      // naive re-implementation of it, would produce instead.
      (Math.abs(frozen.x2 - frozen.x1 - SAFE_DX) > 5 || Math.abs(frozen.y2 - frozen.y1 - SAFE_DY) > 5),
    true,
  );
  check("the frozen line is still anchored at the same center point", frozen?.x1 === centerX && frozen?.y1 === centerY, true);

  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evalJs(`document.querySelector(".radial-backdrop")?.click()`);
  await new Promise((r) => setTimeout(r, 200));

  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + 60,
    y: point.y + 40,
    button: "left",
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 600));
  check(
    "a real drag (moved early) does not open the radial menu",
    await page.evalJs(`!!document.querySelector(".radial-menu")`),
    false,
  );
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x + 60,
    y: point.y + 40,
    button: "left",
    pointerType: "mouse",
  });

  page.close();
} finally {
  await stopApp(app);
}
finish();
