// Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — 9º e último card kind
// migrado (junto com Chat, mesmo commit), fechando o §0.8 ponto 2 do
// plano (todos os 9 kinds, nenhum órfão no modelo antigo). O de MENOR
// risco do lote inteiro: o encaminhamento de ponteiro/teclado
// (`onVideoPointerMove` etc., RemoteWindowCard.tsx) usa só movimento
// RELATIVO (`e.movementX/Y`), nunca lê zoom/pan do board — ao contrário
// de Terminal, não existe nenhum mecanismo de correção de coordenada que
// pudesse quebrar sob projeção. `getDisplayMedia()` não completa de
// verdade num ambiente CDP headless (precisa do picker real do
// xdg-desktop-portal), então este teste cobre só o que é próprio da
// Trilha B — posição/DOM/drag/resize/close — deixando o fluxo de captura
// de tela real fora de escopo (já não tinha smoke test cobrindo isso
// antes desta migração).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = 9573;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-remote-window-screen-projection", import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
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

function approxEqual(a, b, tol = 1.5) {
  return Math.abs(a - b) <= tol;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Remote Window Screen Projection Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  await spawnCard(page, "remote-window");
  await new Promise((r) => setTimeout(r, 500));
  check("remote-window card real criado", Number(await page.evalJs(`document.querySelectorAll('.remote-window-card').length`)), 1);

  check("remote-window card vive em .cards-layer (migrado)", await page.evalJs(`!!document.querySelector('.cards-layer .remote-window-card')`), true);
  check("remote-window card NÃO vive mais em .world", await page.evalJs(`!!document.querySelector('.world .remote-window-card')`), false);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  async function storedRect() {
    const cards = JSON.parse(
      await page.evalJs(`
        window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'remote-window')))
      `),
    );
    return cards[cards.length - 1];
  }
  async function realRect() {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector('.remote-window-card');
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()
      `),
    );
  }

  for (const pct of [150, 50]) {
    await setZoom(page, pct);
    const world = await worldState(page);
    check(`board real em ${pct}% (leitura real via .world style: ${world.zoom})`, Math.round(world.zoom * 100), pct);

    const stored = await storedRect();
    const expected = {
      x: world.panX + stored.x * world.zoom,
      y: world.panY + stored.y * world.zoom,
      w: stored.w * world.zoom,
    };
    const real = await realRect();
    check(
      `posição X real bate com rect*zoom+pan em ${pct}% (esperado ${expected.x.toFixed(1)}, real ${real.x.toFixed(1)})`,
      approxEqual(real.x, expected.x),
      true,
    );
    check(
      `posição Y real bate com rect*zoom+pan em ${pct}% (esperado ${expected.y.toFixed(1)}, real ${real.y.toFixed(1)})`,
      approxEqual(real.y, expected.y),
      true,
    );
    check(
      `largura real bate com rect.w*zoom em ${pct}% (esperado ${expected.w.toFixed(1)}, real ${real.w.toFixed(1)})`,
      approxEqual(real.w, expected.w),
      true,
    );
  }

  await setZoom(page, 100);

  // --- drag real ---
  const beforeDrag = await storedRect();
  const tag = await centerOf(page, ".remote-window-card .card-tag");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tag.x, y: tag.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tag.x + 80, y: tag.y + 60, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tag.x + 80, y: tag.y + 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterDrag = await storedRect();
  check(
    `drag real move o rect de mundo em ~80px de x (antes ${beforeDrag.x.toFixed(0)}, depois ${afterDrag.x.toFixed(0)})`,
    approxEqual(afterDrag.x - beforeDrag.x, 80, 5),
    true,
  );
  check(
    `drag real move o rect de mundo em ~60px de y (antes ${beforeDrag.y.toFixed(0)}, depois ${afterDrag.y.toFixed(0)})`,
    approxEqual(afterDrag.y - beforeDrag.y, 60, 5),
    true,
  );

  // --- resize real ---
  const beforeResize = await storedRect();
  const handle = await centerOf(page, ".remote-window-card .card-resize");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 50, y: handle.y + 40, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 50, y: handle.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterResize = await storedRect();
  check(
    `resize real cresce a largura de mundo em ~50px (antes ${beforeResize.w.toFixed(0)}, depois ${afterResize.w.toFixed(0)})`,
    approxEqual(afterResize.w - beforeResize.w, 50, 5),
    true,
  );

  // --- fechar real ---
  const closeBtn = await centerOf(page, ".remote-window-card .card-head-actions button:last-child, .remote-window-card .card-head button:last-child");
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const cardCountAfterClose = await page.evalJs(`document.querySelectorAll('.remote-window-card').length`);
  check("fechar real remove o remote-window card de verdade", cardCountAfterClose, 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
