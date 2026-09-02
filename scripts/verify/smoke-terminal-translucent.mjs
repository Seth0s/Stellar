// "Terminal, Revisitado" (2026-09-02) — transparência + blur, o item que o
// artifact de proposta marcou como "trade-off real, prototipar antes" e o
// usuário pediu pra implementar de verdade em seguida.
//
// Prova dois níveis, não só CSS: (1) o efeito visual real do card (classe
// `.translucent`, `backdrop-filter` computado, fundo de header/corpo
// zerado) e (2) o que realmente importa por baixo — `theme.background` do
// PRÓPRIO xterm.js mudando de opaco pra rgba com alpha (`terminal-
// registry.ts`'s `__getTerminalBackground`, mesmo padrão de teste já usado
// por `__getTerminalFontSize`). CSS sozinho no container não bastaria: o
// canvas do xterm pinta seu próprio fundo por célula, sem ler o CSS ao
// redor — se só o nível 1 passasse e o 2 não, o card pareceria translúcido
// mas o TEXTO do terminal continuaria numa caixa opaca por dentro.
import fs from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-translucent-${Date.now()}`, import.meta.url).pathname;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Translucent Teste");
  await delay(800);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const cards = await window.store.list(${JSON.stringify(boardId)});
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  // ---- estado inicial: opaco (padrão desligado) ----
  const before = await page.evalJs(`
    (() => {
      const card = document.querySelector('.terminal-card');
      const head = document.querySelector('.terminal-card .card-head');
      return JSON.stringify({
        hasClass: card.classList.contains('translucent'),
        headBg: window.getComputedStyle(head).backgroundColor,
        backdrop: window.getComputedStyle(card).backdropFilter || window.getComputedStyle(card).webkitBackdropFilter,
      });
    })()
  `);
  const beforeState = JSON.parse(before);
  check("card NÃO começa com .translucent (padrão desligado)", beforeState.hasClass, false);
  check("header começa opaco (--panel real, não transparente)", beforeState.headBg !== "rgba(0, 0, 0, 0)", true);

  const bgBefore = await page.evalJs(`window.__getTerminalBackground(${JSON.stringify(cardId)})`);
  check(`xterm.js's theme.background começa opaco (hex sem alpha): ${bgBefore}`, /^#[0-9a-f]{6}$/i.test(bgBefore), true);

  // ---- liga o toggle ----
  const btn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.terminal-card-translucent-btn');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(btn.x, btn.y);
  await delay(300);

  const after = await page.evalJs(`
    (() => {
      const card = document.querySelector('.terminal-card');
      const clip = card.querySelector('.card-clip');
      const head = document.querySelector('.terminal-card .card-head');
      const body = document.querySelector('.terminal-card-body');
      const cardCs = window.getComputedStyle(card);
      const clipCs = window.getComputedStyle(clip);
      return JSON.stringify({
        hasClass: card.classList.contains('translucent'),
        cardBg: cardCs.backgroundColor,
        headBg: window.getComputedStyle(head).backgroundColor,
        bodyBg: window.getComputedStyle(body).backgroundColor,
        backdrop: clipCs.backdropFilter || clipCs.webkitBackdropFilter,
      });
    })()
  `);
  const afterState = JSON.parse(after);
  check("card ganhou .translucent depois do clique real no botão", afterState.hasClass, true);
  check(
    "o PRÓPRIO .terminal-card (pai de .card-clip) virou transparente — achado ao vivo: sem isso, o fundo opaco do pai fica atrás do blur do filho e o efeito vidro não aparece",
    afterState.cardBg,
    "rgba(0, 0, 0, 0)",
  );
  check("header virou transparente (deixa o blur do shell aparecer, não pinta opaco por cima)", afterState.headBg, "rgba(0, 0, 0, 0)");
  check(".terminal-card-body também virou transparente pelo mesmo motivo", afterState.bodyBg, "rgba(0, 0, 0, 0)");
  check(
    `.card-clip (não mais .terminal-card — canto arredondado real, ver cards.css) ganhou backdrop-filter REAL (não 'none') — computado: "${afterState.backdrop}"`,
    !afterState.backdrop || afterState.backdrop === "none",
    false,
  );

  // ---- o que realmente importa: o fundo do PRÓPRIO xterm.js mudou ----
  const bgAfter = await page.evalJs(`window.__getTerminalBackground(${JSON.stringify(cardId)})`);
  check(`xterm.js's theme.background real virou rgba com alpha (não só CSS ao redor): ${bgAfter}`, /^rgba\(/i.test(bgAfter), true);
  check("...e é diferente do valor opaco de antes", bgAfter !== bgBefore, true);

  // ---- desliga de novo: reversível, não é uma mudança de mão única ----
  await page.click(btn.x, btn.y);
  await delay(300);
  const bgOffAgain = await page.evalJs(`window.__getTerminalBackground(${JSON.stringify(cardId)})`);
  check("desligar o toggle volta o fundo real do xterm pro valor opaco original", bgOffAgain, bgBefore);

  page.close();
} finally {
  await stopApp(app);
}
finish();
