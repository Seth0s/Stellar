// Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — terceiro/quarto card
// kind migrados pra renderização screen-projected, depois de sticky e
// browser: FilesCard e ChangesCard agora portam pra `.cards-layer` (fora
// de `.world`) e calculam seu próprio retângulo de tela via
// `worldRectToScreen`, em vez de confiar no `scale(zoom)` ambiente do
// `.world`. Mesma prova real que `smoke-sticky-screen-projection.mjs` já
// fez pro sticky: DOM real no lugar certo, posição real batendo com a
// fórmula `rect*zoom+pan` em DOIS zooms diferentes (não só 100%, onde um
// bug de projeção poderia cancelar por coincidência), e drag/resize/close
// reais continuando funcionais no modo novo.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-files-changes-screen-projection-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_DIR = new URL(`../../.verify-tmp/smoke-files-changes-screen-projection-scratch-${CDP_PORT}`, import.meta.url).pathname;

rmSync(SCRATCH_DIR, { recursive: true, force: true });
mkdirSync(SCRATCH_DIR, { recursive: true });
writeFileSync(`${SCRATCH_DIR}/notes.md`, "# hello\n");

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  return res;
}

async function setZoom(page, pct) {
  const alreadyOpen = await page.evalJs(`!!document.querySelector('.zoom-input')`);
  if (!alreadyOpen) {
    const zoomReadout = await centerOf(page, ".zoom-readout");
    await page.click(zoomReadout.x, zoomReadout.y);
    await new Promise((r) => setTimeout(r, 200));
  }
  const zoomInputCoords = await centerOf(page, ".zoom-input");
  await page.click(zoomInputCoords.x, zoomInputCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.zoom-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(String(pct))});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 1500));
}

async function worldState(page) {
  const style = await page.evalJs(`document.querySelector('.world')?.getAttribute('style') ?? ""`);
  const m = style.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
  if (!m) throw new Error(`could not parse .world style: ${style}`);
  return { panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3]) };
}

async function realRect(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
      })()
    `),
  );
}

function approxEqual(a, b, tol = 1.5) {
  return Math.abs(a - b) <= tol;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Files/Changes Screen Projection", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 400));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));

  // Seed a files + a changes card directly, same technique
  // smoke-files-card.mjs already uses -- avoids fighting the rail's
  // popover UI just to get a card rooted at a disposable scratch dir.
  await page.evalJs(`
    (async () => {
      const now = Date.now();
      await window.store.upsert({
        id: 'proj-files', board_id: ${JSON.stringify(boardId)}, kind: 'files', provider: '',
        cwd: ${JSON.stringify(SCRATCH_DIR)}, x: 40, y: 220, w: 420, h: 320,
        resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
        updated_at: now, messages_json: null, archived_at: null,
      });
      await window.store.upsert({
        id: 'proj-changes', board_id: ${JSON.stringify(boardId)}, kind: 'changes', provider: '',
        cwd: ${JSON.stringify(SCRATCH_DIR)}, x: 520, y: 220, w: 420, h: 320,
        resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
        updated_at: now, messages_json: null, archived_at: null,
      });
    })()
  `);

  // Home -> back in, same mechanism loadBoard()/switchBoard() already
  // use for a real reopen -- exercises the actual mount path, not a
  // shortcut around it.
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  const target = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-name')?.textContent === 'Files/Changes Screen Projection');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!target) throw new Error("board card not found on Home");
  await page.click(target.x, target.y);
  await new Promise((r) => setTimeout(r, 800));

  check("files card real criado", Number(await page.evalJs(`document.querySelectorAll('.files-card').length`)), 1);
  check("changes card real criado", Number(await page.evalJs(`document.querySelectorAll('[data-kind="changes"]').length`)), 1);

  // --- DOM real: dentro de .cards-layer, NÃO dentro de .world ---
  for (const cls of [".files-card", '[data-kind="changes"]']) {
    check(`${cls} vive em .cards-layer (migrado)`, await page.evalJs(`!!document.querySelector('.cards-layer ${cls}')`), true);
    check(`${cls} NÃO vive mais em .world`, await page.evalJs(`!!document.querySelector('.world ${cls}')`), false);
  }

  async function storedRect(id) {
    const cards = JSON.parse(
      await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards))`),
    );
    return cards.find((c) => c.id === id);
  }

  // --- posição real bate com a fórmula, em DOIS zooms, pros dois kinds ---
  for (const pct of [150, 50]) {
    await setZoom(page, pct);
    const world = await worldState(page);
    check(`board real em ${pct}% (leitura via .world style: ${world.zoom})`, Math.round(world.zoom * 100), pct);

    for (const [id, selector] of [
      ["proj-files", ".files-card"],
      ["proj-changes", '[data-kind="changes"]'],
    ]) {
      const stored = await storedRect(id);
      const expected = {
        x: world.panX + stored.x * world.zoom,
        y: world.panY + stored.y * world.zoom,
        w: stored.w * world.zoom,
      };
      const real = await realRect(page, selector);
      check(
        `${selector} posição X real bate com rect*zoom+pan em ${pct}% (esperado ${expected.x.toFixed(1)}, real ${real.x.toFixed(1)})`,
        approxEqual(real.x, expected.x),
        true,
      );
      check(
        `${selector} posição Y real bate com rect*zoom+pan em ${pct}% (esperado ${expected.y.toFixed(1)}, real ${real.y.toFixed(1)})`,
        approxEqual(real.y, expected.y),
        true,
      );
      check(
        `${selector} largura real bate com rect.w*zoom em ${pct}% (esperado ${expected.w.toFixed(1)}, real ${real.w.toFixed(1)})`,
        approxEqual(real.w, expected.w),
        true,
      );
    }
  }

  await setZoom(page, 100);

  // --- drag real (files card) ---
  const beforeDrag = await storedRect("proj-files");
  const header = await centerOf(page, ".files-card .card-head");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: header.x + 80, y: header.y + 60, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x + 80, y: header.y + 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterDrag = await storedRect("proj-files");
  check(
    `drag real move o rect de mundo em ~80px de x (antes ${beforeDrag.x.toFixed(0)}, depois ${afterDrag.x.toFixed(0)})`,
    approxEqual(afterDrag.x - beforeDrag.x, 80, 5),
    true,
  );

  // --- resize real (changes card) ---
  const beforeResize = await storedRect("proj-changes");
  const handle = await centerOf(page, '[data-kind="changes"] .card-resize-se');
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 50, y: handle.y + 40, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 50, y: handle.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterResize = await storedRect("proj-changes");
  check(
    `resize real cresce a largura de mundo em ~50px (antes ${beforeResize.w.toFixed(0)}, depois ${afterResize.w.toFixed(0)})`,
    approxEqual(afterResize.w - beforeResize.w, 50, 5),
    true,
  );

  // --- fechar real (files card) ---
  const closeBtn = await centerOf(page, ".files-card .card-head-actions button");
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  check("fechar real remove o files card de verdade", Number(await page.evalJs(`document.querySelectorAll('.files-card').length`)), 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
