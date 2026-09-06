// Achado ao vivo (2026-09-04) — "quando faço resize e existe caracteres
// no caminho, sempre tem o efeito de seleção de texto que acaba
// quebrando o resize". A zona de resize (`.card-resize-*`, CardFrame.tsx)
// invade de propósito ~7px pra DENTRO do card (comentário em cards.css)
// pra facilitar acertar a borda — mas em cards de texto (sticky) isso
// pousa o pointerdown a poucos pixels do conteúdo selecionável.
// `onResizePointerDown` chamava `stopPropagation()` mas nunca
// `preventDefault()`, então o navegador iniciava sua PRÓPRIA seleção de
// texto nativa em paralelo ao mousemove do drag — o mesmo gesto disputado
// pelos dois, varrendo a seleção pelo card inteiro enquanto o resize
// tentava acontecer. Fix: `preventDefault()` no pointerdown da zona
// (suprime o mousedown de compatibilidade que dispara a seleção) +
// `user-select: none` na própria zona como defesa extra.
//
// Reproduz com uma sticky cheia de texto (não uma vazia — o bug só
// aparece quando há conteúdo selecionável embaixo/perto da zona de
// resize) e confirma as DUAS coisas: o resize aconteceu de verdade, E
// `document.getSelection()` ficou vazio depois do drag.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-card-resize-no-text-select-${CDP_PORT}`, import.meta.url).pathname;

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
  // `.rail-btn[title="..."]` pra um kind de card (ex.: sticky) não é um
  // botão direto — é uma linha dentro da popover "Adicionar card" (mesmo
  // título, `RAIL_CREATE_TITLE`, Rail.tsx). Abre a popover e procura de
  // novo como `.popover-row` antes de desistir — mesmo fallback que
  // smoke-terminal-font-zoom.mjs/smoke-sticky-screen-projection.mjs já
  // usam pro mesmo caso.
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
  if (!res) throw new Error(`selector not found: ${selector}`);
  return res;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Resize Sem Selecionar Texto Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // Cria um sticky (botão dedicado no Rail, não a popover genérica de
  // "Adicionar card") e enche de texto real (linhas longas o bastante
  // pra cobrir toda a largura do card, inclusive perto da borda/canto
  // onde a zona de resize vive) — uma sticky vazia não reproduz o bug.
  const stickyBtn = await centerOf(page, '.rail-btn[title="Nova nota adesiva"]');
  await page.click(stickyBtn.x, stickyBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  check("sticky card real criado", Number(await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`)), 1);

  const textarea = await centerOf(page, '[data-kind="sticky"] textarea');
  await page.click(textarea.x, textarea.y);
  const longText = Array.from({ length: 8 }, (_, i) => `linha de conteúdo bem longa número ${i} pra cobrir a largura toda do card`).join("\n");
  await page.evalJs(`
    (() => {
      const ta = document.querySelector('[data-kind="sticky"] textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(longText)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const beforeRect = await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-kind="sticky"]');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ w: r.width, h: r.height });
    })()
  `);
  const before = JSON.parse(beforeRect);

  // Drag de resize real pelo canto SE — mesmo mecanismo de mouse cru que
  // smoke-sticky-screen-projection.mjs já usa pra resize, atravessando
  // por CIMA do texto que agora enche o card.
  const handle = await centerOf(page, '[data-kind="sticky"] .card-resize-se');
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  // Movimento em vários passos pequenos (não um salto só) — mais fiel a
  // um drag real, dá tempo pro navegador "morder a isca" da seleção se o
  // preventDefault não estivesse funcionando.
  for (let i = 1; i <= 5; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: handle.x + i * 16,
      y: handle.y + i * 12,
      button: "left",
      pointerType: "mouse",
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 80, y: handle.y + 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));

  const afterRect = await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-kind="sticky"]');
      const r = el.getBoundingClientRect();
      return JSON.stringify({ w: r.width, h: r.height });
    })()
  `);
  const after = JSON.parse(afterRect);
  check(`resize real aconteceu (largura antes ${before.w.toFixed(0)}, depois ${after.w.toFixed(0)})`, after.w > before.w + 20, true);

  const selectedText = await page.evalJs(`JSON.stringify((document.getSelection()?.toString() ?? '').trim())`);
  check(`nenhum texto foi selecionado durante o resize (seleção: ${JSON.stringify(JSON.parse(selectedText))})`, JSON.parse(selectedText), "");

  page.close();
} finally {
  await stopApp(app);
}
finish();
