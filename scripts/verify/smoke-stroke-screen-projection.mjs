// Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — quinto card kind
// migrado. Baixa urgência de nitidez pra Stroke especificamente (SVG
// vetorial nunca teve o problema de bitmap blur que motivou esta trilha
// -- ver §0.3 do plano), migrado por completude arquitetural (pra
// `.world` eventualmente perder o `scale(zoom)` quando os 9 kinds
// estiverem no mesmo modelo). Mesma prova real que sticky/files/changes
// já fizeram: DOM no lugar certo, posição batendo com a fórmula
// `rect*zoom+pan` em dois zooms, drag/resize/close reais.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9554;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-stroke-screen-projection", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Stroke Screen Projection", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 400));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));

  // Seed a stroke card row directly -- same shape App.tsx's toRow()/
  // parseStroke() round-trip through (cwd carries the {points,width,style}
  // JSON blob, provider carries the color). y well below the real
  // Topbar's own screen real estate (top ~46-82px) -- achado ao vivo no
  // teste de files/changes: um card semeado embaixo do topbar rouba o
  // clique de drag, sem ter nada a ver com o card em si.
  await page.evalJs(`
    (async () => {
      await window.store.upsert({
        id: 'proj-stroke', board_id: ${JSON.stringify(boardId)}, kind: 'stroke', provider: '#ff6b6b',
        cwd: ${JSON.stringify(JSON.stringify({ points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]], width: 3, style: "solid" }))},
        x: 60, y: 220, w: 300, h: 200,
        resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
        updated_at: Date.now(), messages_json: null, archived_at: null,
      });
    })()
  `);

  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  const target = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-name')?.textContent === 'Stroke Screen Projection');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!target) throw new Error("board card not found on Home");
  await page.click(target.x, target.y);
  await new Promise((r) => setTimeout(r, 800));

  check("stroke card real criado", Number(await page.evalJs(`document.querySelectorAll('.stroke-card').length`)), 1);
  check("stroke card vive em .cards-layer (migrado)", await page.evalJs(`!!document.querySelector('.cards-layer .stroke-card')`), true);
  check("stroke card NÃO vive mais em .world", await page.evalJs(`!!document.querySelector('.world .stroke-card')`), false);
  check(
    "a linha real (polyline SVG) ainda desenha os pontos certos",
    await page.evalJs(`document.querySelector('.stroke-card polyline')?.getAttribute('points')`),
    "10,10 50,50 90,20",
  );

  async function storedRect() {
    const cards = JSON.parse(
      await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards))`),
    );
    return cards.find((c) => c.id === "proj-stroke");
  }

  for (const pct of [150, 50]) {
    await setZoom(page, pct);
    const world = await worldState(page);
    check(`board real em ${pct}%`, Math.round(world.zoom * 100), pct);

    const stored = await storedRect();
    const expected = {
      x: world.panX + stored.x * world.zoom,
      y: world.panY + stored.y * world.zoom,
      w: stored.w * world.zoom,
    };
    const real = await realRect(page, ".stroke-card");
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
  const header = await centerOf(page, ".stroke-card .card-head");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: header.x + 70, y: header.y + 50, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x + 70, y: header.y + 50, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterDrag = await storedRect();
  check(
    `drag real move o rect de mundo em ~70px de x (antes ${beforeDrag.x.toFixed(0)}, depois ${afterDrag.x.toFixed(0)})`,
    approxEqual(afterDrag.x - beforeDrag.x, 70, 5),
    true,
  );

  // --- resize real ---
  const beforeResize = await storedRect();
  const handle = await centerOf(page, ".stroke-card .card-resize");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 40, y: handle.y + 30, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 40, y: handle.y + 30, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterResize = await storedRect();
  check(
    `resize real cresce a largura de mundo em ~40px (antes ${beforeResize.w.toFixed(0)}, depois ${afterResize.w.toFixed(0)})`,
    approxEqual(afterResize.w - beforeResize.w, 40, 5),
    true,
  );

  // --- fechar real ---
  const closeBtn = await centerOf(page, ".stroke-card .stroke-card-close");
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  check("fechar real remove o stroke card de verdade", Number(await page.evalJs(`document.querySelectorAll('.stroke-card').length`)), 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
