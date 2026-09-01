// Trilha B, Item 4 (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — StickyCard é o
// primeiro card kind migrado pra renderização screen-projected: em vez de
// viver dentro de `.world` (que tem `transform: translate(panX,panY)
// scale(zoom)` aplicado, então o card se posiciona com o rect de MUNDO
// cru e deixa o CSS escalar visualmente), agora ele é portado (React
// `createPortal`) pra dentro de `.cards-layer` (sem scale nenhum) e
// calcula seu próprio retângulo de TELA via `worldRectToScreen`
// (board-model.ts), a mesma fórmula já usada e testada em produção pelo
// IPC de snapshot.
//
// Verifica ao vivo, sem mock: o card real acaba no DOM certo
// (`.cards-layer`, não `.world`), sua posição real na tela
// (`getBoundingClientRect()`) bate com a fórmula `rect*zoom+pan` em DOIS
// níveis de zoom diferentes (não só 100%, onde um bug de projeção
// poderia cancelar por coincidência — foi exatamente assim que o bug de
// clique do navegador ficou invisível até hoje), e que drag/resize/close
// continuam funcionando de verdade nesse modo novo.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9551;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-sticky-screen-projection", import.meta.url).pathname;

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

async function setZoom(page, pct) {
  // A popover do zoom-pill fica aberta depois de um Enter anterior (só
  // Escape fecha) — clicar o readout de novo alternaria ela pra FECHADA
  // em vez de abrir. Só clica se o input ainda não estiver visível.
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
  // >0.28s — passa da transição CSS de `.card-frame.reflow`/qualquer
  // outra em andamento (achado ao vivo hoje: medir mid-transição dá
  // valor errado, pior ainda sob carga real de máquina — visto ao vivo
  // com outras instâncias Electron rodando em paralelo). Folga generosa.
  await new Promise((r) => setTimeout(r, 1500));
}

async function worldState(page) {
  const style = await page.evalJs(`document.querySelector('.world')?.getAttribute('style') ?? ""`);
  const m = style.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
  if (!m) throw new Error(`could not parse .world style: ${style}`);
  return { panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3]) };
}

async function stickyRealRect(page) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.sticky-card');
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
  await bootIntoFreshSession(page, "Sticky Screen Projection Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const stickyBtn = await centerOf(page, '.rail-btn[title="Nova nota adesiva"]');
  await page.click(stickyBtn.x, stickyBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  check("sticky card real criado", Number(await page.evalJs(`document.querySelectorAll('.sticky-card').length`)), 1);

  // --- DOM real: dentro de .cards-layer, NÃO dentro de .world ---
  const inCardsLayer = await page.evalJs(`!!document.querySelector('.cards-layer .sticky-card')`);
  const inWorld = await page.evalJs(`!!document.querySelector('.world .sticky-card')`);
  check("sticky card real vive em .cards-layer (migrado)", inCardsLayer, true);
  check("sticky card real NÃO vive mais em .world", inWorld, false);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));

  async function stickyStoredRect() {
    const cards = JSON.parse(
      await page.evalJs(`
        window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'sticky')))
      `),
    );
    return cards[cards.length - 1];
  }

  // --- posição real bate com a fórmula, em DOIS zooms diferentes ---
  for (const pct of [150, 50]) {
    await setZoom(page, pct);
    const world = await worldState(page);
    check(`board real em ${pct}% (leitura real via .world style: ${world.zoom})`, Math.round(world.zoom * 100), pct);

    const stored = await stickyStoredRect();
    const expected = {
      x: world.panX + stored.x * world.zoom,
      y: world.panY + stored.y * world.zoom,
      w: stored.w * world.zoom,
      h: stored.h * world.zoom,
    };
    const real = await stickyRealRect(page);
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

  // Volta pra 100% pra deixar o resto do teste em terreno conhecido.
  await setZoom(page, 100);

  // --- drag real ---
  const beforeDrag = await stickyStoredRect();
  const header = await centerOf(page, ".sticky-card .card-head");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: header.x + 80, y: header.y + 60, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x + 80, y: header.y + 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterDrag = await stickyStoredRect();
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
  const beforeResize = await stickyStoredRect();
  const handle = await centerOf(page, ".sticky-card .card-resize");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 50, y: handle.y + 40, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 50, y: handle.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterResize = await stickyStoredRect();
  check(
    `resize real cresce a largura de mundo em ~50px (antes ${beforeResize.w.toFixed(0)}, depois ${afterResize.w.toFixed(0)})`,
    approxEqual(afterResize.w - beforeResize.w, 50, 5),
    true,
  );

  // --- fechar real (animação pop) ---
  // `.card-head button` sozinho pegaria os 4 botões de swatch de cor
  // primeiro (`querySelector` pega o primeiro match) — o botão de
  // fechar é filho DIRETO de `.card-head-inner`, os swatches estão
  // aninhados mais fundo dentro do próprio label.
  const closeBtn = await centerOf(page, ".sticky-card .card-head-inner > button");
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const cardCountAfterClose = await page.evalJs(`document.querySelectorAll('.sticky-card').length`);
  check("fechar real remove o sticky card de verdade (animação pop não trava)", cardCountAfterClose, 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
