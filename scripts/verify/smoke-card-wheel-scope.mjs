// Pedido ao vivo (2026-08-27): "o scroll está sendo interceptado pelo app
// também, fazendo dar zoom no app e ao mesmo a janela" — scroll sobre
// QUALQUER card zoomava o canvas por baixo (`useWorldTransform.ts`'s
// `onWheel` no `.viewport`, sem exceção nenhuma por padrão). Fix universal
// em CardFrame.tsx: todo card vira uma zona onde wheel nunca vaza pro
// board. Zoom via scroll só no fundo vazio de verdade.
//
// Mudança de comportamento deliberada, confirmada com o usuário: um
// BrowserCard sem foco tinha uma exceção própria ("deixa vazar pro zoom
// do board") — deixa de existir. Sem foco, wheel sobre um navegador
// embutido agora não faz nada até um clique focar o card.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";
import fs from "node:fs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-card-wheel-scope-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

async function wheelAt(page, x, y, deltaY) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

async function readZoom(page) {
  return page.evalJs(`document.querySelector('.zoom-readout')?.textContent`);
}

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // spawnTerminal:true (default) já cria um terminal bash real.
  await bootIntoFreshSession(page, "Wheel Scope Teste");
  await new Promise((r) => setTimeout(r, 600));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  // Gera scrollback real (200 linhas) — sem isso o terminal recém-aberto
  // não tem o que rolar, e o teste de "rolou de verdade" ficaria vazio.
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, "seq 1 200\\r")`);
  await new Promise((r) => setTimeout(r, 1500));

  const zoomBefore = await readZoom(page);
  const termCoords = await centerOf(page, '[data-role="terminal-body"]');
  // Achado ao investigar este mesmo teste: `.xterm-viewport`'s `scrollTop`
  // NÃO reflete a posição real de scroll nesta versão do xterm.js — o
  // scroll de verdade vive num overlay próprio (`.xterm-scrollable-
  // element`, estilo VS Code), sem uma propriedade DOM simples e estável
  // pra ler de fora. Prova real, sem depender de detalhe interno da lib:
  // clip de pixels reais (`Page.captureScreenshot`) antes/depois do wheel
  // — bytes diferentes = conteúdo visualmente mudou de verdade. Confirmado
  // manualmente com screenshot: "200" no fundo antes, "199" depois de um
  // wheel-up (real scroll, não um artefato de teste).
  const termClip = JSON.parse(
    await page.evalJs(`
      (() => { const r = document.querySelector('[data-role="terminal-body"]').getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y, width: r.width, height: r.height, scale: 1}); })()
    `),
  );
  const pixelsBefore = (await page.send("Page.captureScreenshot", { format: "png", clip: termClip })).data;

  // deltaY negativo = gesto de rolar PRA CIMA (convenção padrão de WheelEvent).
  await wheelAt(page, termCoords.x, termCoords.y, -400);
  await new Promise((r) => setTimeout(r, 400));

  const zoomAfterTerminalScroll = await readZoom(page);
  const pixelsAfter = (await page.send("Page.captureScreenshot", { format: "png", clip: termClip })).data;
  check("scrolling over the terminal does NOT change the canvas zoom", zoomAfterTerminalScroll, zoomBefore);
  check("...and the terminal's own scrollback genuinely moved (real pixels changed, not a no-op)", pixelsAfter !== pixelsBefore, true);

  // ---- files card: mesma garantia, sem exceção por tipo ----
  await spawnCard(page, "files");
  await new Promise((r) => setTimeout(r, 600));
  const filesTreeCoords = await centerOf(page, ".files-card");
  check("files card coords found", !!filesTreeCoords, true);
  const zoomBeforeFiles = await readZoom(page);
  await wheelAt(page, filesTreeCoords.x, filesTreeCoords.y, -200);
  await new Promise((r) => setTimeout(r, 300));
  check("scrolling over the files tree does NOT change the canvas zoom either", await readZoom(page), zoomBeforeFiles);

  // ---- fundo vazio: zoom via scroll continua funcionando (não regrediu) ----
  const emptyBgCoords = JSON.parse(await page.evalJs(`JSON.stringify({x: window.innerWidth - 40, y: window.innerHeight - 40})`));
  check(
    "sanity: that corner is genuine empty background, not a card",
    await page.evalJs(`JSON.stringify(!document.elementFromPoint(${emptyBgCoords.x}, ${emptyBgCoords.y})?.closest('.card-frame'))`),
    "true",
  );
  const zoomBeforeBg = await readZoom(page);
  await wheelAt(page, emptyBgCoords.x, emptyBgCoords.y, -400);
  await new Promise((r) => setTimeout(r, 300));
  check("scrolling over genuine empty background STILL zooms the canvas (not a regression)", await readZoom(page) !== zoomBeforeBg, true);

  // ---- browser card, sem foco: wheel não faz mais zoom-through, nem rola a página ----
  await spawnCard(page, "browser");
  await new Promise((r) => setTimeout(r, 1200)); // deixa a página carregar
  const browserCoords = await centerOf(page, ".browser-card");
  check("browser card coords found", !!browserCoords, true);
  const zoomBeforeBrowser = await readZoom(page);
  await wheelAt(page, browserCoords.x, browserCoords.y, -400);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "scrolling over an UNFOCUSED browser card no longer zooms the board (deliberate behavior change, confirmed with the user)",
    await readZoom(page),
    zoomBeforeBrowser,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
