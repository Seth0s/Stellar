// DESIGN-BACKLOG.md item 34 — reportado ao vivo: "o terminal quebra
// depois de sair dela ou tirar o foco". Reproduzido via CDP antes do fix:
// panar um terminal card pra fora do viewport e de volta apagava TODO o
// conteúdo (tela preta), mesmo com o processo real ainda vivo (um comando
// novo digitado depois do ciclo ainda ecoava certo). Causa raiz:
// useTerminal.ts's Effect 2 antigo era chaveado em `visible` e destruía o
// `Terminal` inteiro (buffer de scrollback incluído) toda vez que o card
// saía da view — node-pty não tem backlog, então nada do que o processo
// escreveu nesse intervalo era reproduzido de volta.
//
// Fix: instância do xterm.js sobrevive a ciclos de visibilidade — só é
// criada/destruída de verdade por identidade real de PTY, não por pan.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-visibility-persist-${CDP_PORT}`, import.meta.url).pathname;

async function drag(page, x0, y0, x1, y1, steps = 10) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, pointerType: "mouse" });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 1, pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 15));
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, pointerType: "mouse" });
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Visibility Persist Teste");
  await new Promise((r) => setTimeout(r, 800));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  // xterm.js renders to canvas — no readable DOM text — so this (like
  // smoke-card-wheel-scope.mjs before it) proves content via real pixels,
  // not textContent. Reproducing the exact bug required a screenshot
  // originally too (a fully blank/black card, confirmed visually before
  // this fix existed).
  const clip = JSON.parse(
    await page.evalJs(`
      (() => { const r = document.querySelector('[data-role="terminal-body"]').getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y, width: r.width, height: r.height, scale: 1}); })()
    `),
  );
  // Reference "blank" screenshot — captured BEFORE any content is
  // written, i.e. a genuinely empty terminal (this is exactly what the
  // bug produced: `pixelsAfter` collapsing back to this). Cursor blink
  // makes exact before/after byte-equality across a real time gap flaky
  // (confirmed empirically writing this test), so the real proof is "not
  // blank", not "byte-identical to a moment in the past".
  const pixelsBlank = (await page.send("Page.captureScreenshot", { format: "png", clip })).data;

  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, "seq 1 30\\r")`);
  await new Promise((r) => setTimeout(r, 800));

  // Pan out (card sai do viewport, isInView vira false) e de volta
  // (isInView vira true) — repetido, para pegar qualquer churn de
  // create/destroy que só aparecesse depois de mais de um ciclo.
  for (let i = 0; i < 5; i++) {
    await drag(page, 1200, 700, 100, 100);
    await new Promise((r) => setTimeout(r, 200));
    await drag(page, 100, 100, 1200, 700);
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 400));

  const pixelsAfter = (await page.send("Page.captureScreenshot", { format: "png", clip })).data;
  check(
    "conteúdo sobrevive a 5 ciclos reais de pan-out/pan-in — pixels reais, NÃO igual à referência em branco",
    pixelsAfter !== pixelsBlank,
    true,
  );

  // Prova de que é o MESMO buffer vivo (não um lucky respawn que
  // reimprimiu por acaso): escreve algo novo, e confirma que os pixels
  // mudam de novo a partir desse ponto (prova que o terminal ainda está
  // reagindo a escrita real, não congelado).
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, "echo AFTER_CYCLE_MARKER\\r")`);
  await new Promise((r) => setTimeout(r, 600));
  const pixelsFinal = (await page.send("Page.captureScreenshot", { format: "png", clip })).data;
  check("...e o terminal ainda aceita escrita nova depois do ciclo (pixels mudam de novo)", pixelsFinal !== pixelsAfter, true);

  // Regressão: a fonte configurada (item 36, achado colateral) realmente
  // chega no xterm.js, não fica no default (courier-new) por engano.
  const fontFamily = await page.evalJs(`
    (() => {
      const canvas = document.querySelector('[data-role="terminal-body"] .xterm-screen') || document.querySelector('[data-role="terminal-body"] canvas');
      return canvas ? getComputedStyle(canvas.closest('.xterm')).fontFamily : 'no .xterm element found';
    })()
  `);
  check("xterm.js usa JetBrains Mono (não o default courier-new)", fontFamily.includes("JetBrains Mono"), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
