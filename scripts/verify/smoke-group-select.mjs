// Verifies item 10 achado 3 (DESIGN-BACKLOG.md): can the user actually
// multi-select cards, group them (drag on one moves the rest), and
// ungroup (drag on one stops moving the rest)?
//
// Both sticky cards spawn 720x560 in an 1280x800 window — too big to
// ever fully separate on screen, so their bounding boxes always overlap
// somewhere, and whichever card is topmost (raised by the most recent
// click/drag) covers part of the other at the overlap. querySelectorAll
// index order is NOT a reliable way to track "which card is which"
// across a z-order change (confirmed empirically, several confusing
// false negatives before landing on this). This script instead verifies
// via elementFromPoint().closest(".sticky-card") immediately before each
// click which card a point actually belongs to right now, rather than
// assuming a header's measured center stays hit-testable after any
// intervening raise — and zooms out first so the two cards can be
// dragged genuinely clear of each other at all (at zoom 1 there is no
// on-screen destination that fully separates two 720x560 cards in an
// 1280x800 window).
import { startApp, stopApp, connectPage, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9405;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-group-select", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  async function clickSelector(sel) {
    const pt = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('${sel}');
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!pt) throw new Error(`selector not found: ${sel}`);
    await page.click(pt.x, pt.y);
    return pt;
  }

  async function stickyRects() {
    return JSON.parse(
      await page.evalJs(`
        JSON.stringify([...document.querySelectorAll(".sticky-card")].map(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y };
        }))
      `),
    );
  }
  // Which card (by top-left position) is CURRENTLY hit-testable at a
  // given point — not just where it was last measured.
  async function cardAt(x, y) {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.elementFromPoint(${x}, ${y})?.closest(".sticky-card");
          const r = el?.getBoundingClientRect();
          return JSON.stringify(r ? { x: r.x, y: r.y } : null);
        })()
      `),
    );
  }
  async function headerCenters() {
    return JSON.parse(
      await page.evalJs(`
        JSON.stringify([...document.querySelectorAll(".sticky-card .card-head")].map(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }))
      `),
    );
  }
  function sameRect(a, b) {
    return a && b && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
  }
  async function shiftClickPt(pt) {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1, pointerType: "mouse", modifiers: 8 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1, pointerType: "mouse", modifiers: 8 });
  }
  async function dragHeader(pt, dest) {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dest.x, y: dest.y, pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dest.x, y: dest.y, button: "left", clickCount: 1, pointerType: "mouse" });
  }
  function closestIdx(rects, pt) {
    let best = 0, bestD = Infinity;
    rects.forEach((r, i) => {
      const d = (r.x - pt.x) ** 2 + (r.y - pt.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /** Select both sticky cards (one plain click + one shift-click),
   * regardless of current z-order: click one header, check which card
   * actually got selected, then shift-click a point confirmed (via
   * elementFromPoint) to belong to the OTHER card — falling back to a
   * point derived from that card's own measured rect if its own header
   * is currently covered. */
  async function selectBothStickies() {
    const [ha, hb] = await headerCenters();
    await page.click(ha.x, ha.y);
    await new Promise((r) => setTimeout(r, 200));
    const firstSelected = JSON.parse(
      await page.evalJs(`
        (() => { const r = document.querySelector(".card-frame.selected")?.getBoundingClientRect(); return JSON.stringify(r ? {x:r.x,y:r.y} : null); })()
      `),
    );
    const atB = await cardAt(hb.x, hb.y);
    let clickPt = hb;
    if (sameRect(atB, firstSelected)) {
      const rects = await stickyRects();
      const other = rects.find((r) => !sameRect(r, firstSelected));
      clickPt = { x: other.x + 360, y: other.y + 16 };
    }
    await shiftClickPt(clickPt);
    await new Promise((r) => setTimeout(r, 200));
  }

  await clickSelector('.rail-btn[title="Nova nota adesiva"]');
  await new Promise((r) => setTimeout(r, 400));
  await clickSelector('.rail-btn[title="Nova nota adesiva"]');
  await new Promise((r) => setTimeout(r, 400));
  check("two sticky cards spawned", await page.evalJs(`document.querySelectorAll(".sticky-card").length`), 2);

  const zoomOutBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title="Diminuir zoom"]') || [...document.querySelectorAll("button")].find(x => x.title === "Diminuir zoom");
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  for (let i = 0; i < 10; i++) await page.click(zoomOutBtn.x, zoomOutBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  let [ha, hb] = await headerCenters();
  await dragHeader(hb, { x: 1150, y: 720 });
  await new Promise((r) => setTimeout(r, 300));

  await clickSelector('.rail-btn[title="Selecionar"]');
  await new Promise((r) => setTimeout(r, 200));
  check(
    "select tool active",
    await page.evalJs(`document.querySelector('.rail-btn[title="Selecionar"]')?.classList.contains("active")`),
    true,
  );

  await selectBothStickies();
  check("both selected (round 1)", await page.evalJs(`document.querySelectorAll(".card-frame.selected").length`), 2);

  const groupBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title="Agrupar"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  check("group button appeared with 2 selected", groupBtn !== null, true);
  if (groupBtn) {
    await page.click(groupBtn.x, groupBtn.y);
    await new Promise((r) => setTimeout(r, 300));
  }

  await clickSelector('.rail-btn[title="Ponteiro"]');
  await new Promise((r) => setTimeout(r, 200));

  const before = await stickyRects();
  [ha, hb] = await headerCenters();
  const DX = 80, DY = 40;
  await dragHeader(ha, { x: ha.x + DX, y: ha.y + DY });
  await new Promise((r) => setTimeout(r, 400));
  const after = await stickyRects();

  const draggedBeforeIdx = closestIdx(before, { x: ha.x - 360, y: ha.y - 16 });
  const siblingIdx = 1 - draggedBeforeIdx;
  const dDx = after[draggedBeforeIdx].x - before[draggedBeforeIdx].x;
  const dDy = after[draggedBeforeIdx].y - before[draggedBeforeIdx].y;
  const sDx = after[siblingIdx].x - before[siblingIdx].x;
  const sDy = after[siblingIdx].y - before[siblingIdx].y;
  check("dragged card moved by the gesture delta", Math.abs(dDx - DX) < 5 && Math.abs(dDy - DY) < 5, true);
  check("sibling card followed by the same delta (group drag-sync)", Math.abs(sDx - dDx) < 3 && Math.abs(sDy - dDy) < 3, true);

  await clickSelector('.rail-btn[title="Selecionar"]');
  await new Promise((r) => setTimeout(r, 200));
  await selectBothStickies();
  check("both selected again for ungroup", await page.evalJs(`document.querySelectorAll(".card-frame.selected").length`), 2);

  const ungroupBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title="Desagrupar"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  check("ungroup button appeared", ungroupBtn !== null, true);
  if (ungroupBtn) {
    await page.click(ungroupBtn.x, ungroupBtn.y);
    await new Promise((r) => setTimeout(r, 300));
  }

  await clickSelector('.rail-btn[title="Ponteiro"]');
  await new Promise((r) => setTimeout(r, 200));

  const before2 = await stickyRects();
  [ha, hb] = await headerCenters();
  await dragHeader(ha, { x: ha.x + DX, y: ha.y + DY });
  await new Promise((r) => setTimeout(r, 400));
  const after2 = await stickyRects();
  const draggedIdx2 = closestIdx(before2, { x: ha.x - 360, y: ha.y - 16 });
  const siblingIdx2 = 1 - draggedIdx2;
  const eDx = after2[draggedIdx2].x - before2[draggedIdx2].x;
  const eSx = after2[siblingIdx2].x - before2[siblingIdx2].x;
  check("after ungroup, dragged card still moves", Math.abs(eDx - DX) < 5, true);
  check("after ungroup, sibling stays put", Math.abs(eSx) < 3, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
