// Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — 9º e último card kind
// migrado, fechando o §0.8 ponto 2 do plano (todos os 9 kinds, nenhum
// órfão no modelo antigo). Mesmo padrão aditivo (`screenProjected`/
// `panX`/`panY`) e mesmo wrap em `createPortal` que os outros 8 já usam —
// ChatCard não tem nenhum mecanismo próprio de coordenada (sem canvas,
// sem correctZoomCoords, sem transform interno de zoom/pan como
// MediaCard) que pudesse interagir mal com a projeção, então o risco
// aqui é o mais baixo do lote.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = 9572;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-screen-projection", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Chat Screen Projection Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  await spawnCard(page, "chat");
  await new Promise((r) => setTimeout(r, 500));
  check("chat card real criado", Number(await page.evalJs(`document.querySelectorAll('.chat-card').length`)), 1);

  check("chat card vive em .cards-layer (migrado)", await page.evalJs(`!!document.querySelector('.cards-layer .chat-card')`), true);
  check("chat card NÃO vive mais em .world", await page.evalJs(`!!document.querySelector('.world .chat-card')`), false);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  async function chatStoredRect() {
    const cards = JSON.parse(
      await page.evalJs(`
        window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'chat')))
      `),
    );
    return cards[cards.length - 1];
  }
  async function chatRealRect() {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector('.chat-card');
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

    const stored = await chatStoredRect();
    const expected = {
      x: world.panX + stored.x * world.zoom,
      y: world.panY + stored.y * world.zoom,
      w: stored.w * world.zoom,
    };
    const real = await chatRealRect();
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

  // --- drag real (via .card-tag, o mesmo elemento que smoke-render-
  // memoization.mjs já usa pro chat card) ---
  const beforeDrag = await chatStoredRect();
  const tag = await centerOf(page, ".chat-card .card-tag");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tag.x, y: tag.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tag.x + 80, y: tag.y + 60, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tag.x + 80, y: tag.y + 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterDrag = await chatStoredRect();
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
  const beforeResize = await chatStoredRect();
  const handle = await centerOf(page, ".chat-card .card-resize-se");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 50, y: handle.y + 40, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 50, y: handle.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterResize = await chatStoredRect();
  check(
    `resize real cresce a largura de mundo em ~50px (antes ${beforeResize.w.toFixed(0)}, depois ${afterResize.w.toFixed(0)})`,
    approxEqual(afterResize.w - beforeResize.w, 50, 5),
    true,
  );

  // --- fechar real ---
  const closeBtn = await centerOf(page, ".chat-card .card-head-actions button:last-child");
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const cardCountAfterClose = await page.evalJs(`document.querySelectorAll('.chat-card').length`);
  check("fechar real remove o chat card de verdade", cardCountAfterClose, 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
