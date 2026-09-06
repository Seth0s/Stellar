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
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-sticky-screen-projection-${CDP_PORT}`, import.meta.url).pathname;

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
        const el = document.querySelector('[data-kind="sticky"]');
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
  check("sticky card real criado", Number(await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`)), 1);

  // --- DOM real: dentro de .cards-layer, NÃO dentro de .world ---
  const inCardsLayer = await page.evalJs(`!!document.querySelector('.cards-layer [data-kind="sticky"]')`);
  const inWorld = await page.evalJs(`!!document.querySelector('.world [data-kind="sticky"]')`);
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

    // Achado ao vivo (2026-09-01, screenshot de um sticky em zoom ~86%):
    // o corpo da nota parava bem antes do rodapé do card, deixando uma
    // faixa vazia que crescia conforme se afastava — e só embaixo, nunca
    // nas laterais. `.card-scale` (o wrapper que a Trilha B introduziu,
    // dimensionado no `rect` de mundo e escalado por `transform`) é um
    // flex item do `.sticky-card`, que é `flex-direction: column`; com o
    // `flex-shrink: 1` padrão, todo zoom < 1 encolhia o item pro tamanho
    // do container ANTES do transform, e o `scale(zoom)` multiplicava de
    // novo — altura visual `rect.h * zoom²`. A largura escapava por ser
    // eixo transversal com tamanho explícito, o que explica a assimetria
    // do sintoma. Esta é uma checagem de PROPORÇÃO interna (o corpo
    // encosta no rodapé do próprio card), então ela é imune ao offset de
    // viewport/zoom de página que afeta os três checks absolutos acima.
    const fill = JSON.parse(
      await page.evalJs(`
        (() => {
          const ta = document.querySelector('[data-kind="sticky"] [data-role="sticky-textarea"]');
          const frame = ta.closest('.card-frame');
          const a = ta.getBoundingClientRect();
          const f = frame.getBoundingClientRect();
          return JSON.stringify({ gap: f.bottom - a.bottom, frameH: f.height });
        })()
      `),
    );
    check(
      `o corpo da nota vai até o rodapé do card em ${pct}% (sobra ${fill.gap.toFixed(1)}px de ${fill.frameH.toFixed(0)}px)`,
      Math.abs(fill.gap) <= 3,
      true,
    );
  }

  // Volta pra 100% pra deixar o resto do teste em terreno conhecido.
  await setZoom(page, 100);

  // --- drag real ---
  const beforeDrag = await stickyStoredRect();
  const header = await centerOf(page, '[data-kind="sticky"] .card-head');
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
  // 2026-09-02: o grip visual `.card-resize` foi removido — `.card-resize-se`
  // é a zona invisível de hit-test que ocupa o mesmo canto.
  const handle = await centerOf(page, '[data-kind="sticky"] .card-resize-se');
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
  // Nota ganhou um 2º botão no header (toggle editar/preview,
  // 2026-09-02) — mesma convenção de ChatCard/BrowserCard agora:
  // ambos vivem em `.card-head-actions`, close é sempre o último.
  const closeBtn = await centerOf(page, '[data-kind="sticky"] .card-head-actions button:last-child');
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const cardCountAfterClose = await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`);
  check("fechar real remove o sticky card de verdade (animação pop não trava)", cardCountAfterClose, 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
