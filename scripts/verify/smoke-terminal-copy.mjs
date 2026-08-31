// Pedido ao vivo (2026-08-31) — "eu não consigo copiar textos" nos
// terminais. Achado real: nenhum handler de cópia existia — xterm.js
// renderiza em canvas/WebGL (sem seleção de texto real do DOM), e sem um
// listener explícito escrevendo `term.getSelection()` na área de
// transferência, uma seleção visual nunca virava nada copiável. Fix
// (`useTerminal.ts`): Ctrl+Shift+C (não Ctrl+C sozinho — esse continua
// reservado pro SIGINT/interrupt, mesma convenção de todo terminal Linux
// de verdade) copia a seleção atual pra área de transferência real.
//
// Prova real: usa `window.__selectTerminalTextForTest` (terminal-
// registry.ts, hook só-de-teste, mesmo espírito de
// `window.__cardRenderCounts` do P1 — chama `term.select()`, a MESMA
// primitiva que o drag do mouse usa por baixo) pra selecionar um marker
// real impresso no terminal, dispara o Ctrl+Shift+C real via CDP, e lê a
// área de transferência real do SO.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9471;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-copy", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page);
  await new Promise((r) => setTimeout(r, 500));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  const MARKER = "COPYTEST-a1b2c3-real-selection";
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(`echo ${MARKER}\r`)})`);
  await new Promise((r) => setTimeout(r, 500));

  // Clear the clipboard first — a stale value from an earlier step (or
  // even the marker text typed as a command echo) could false-positive a
  // "clipboard has the marker" check without the copy handler ever firing.
  await page.evalJs(`navigator.clipboard.writeText("cleared-before-copy-test")`);
  await new Promise((r) => setTimeout(r, 100));

  // Focus the terminal FIRST — a click on it (even before this) clears
  // any existing xterm selection, so the real `term.select()` call below
  // has to happen AFTER focus, not before.
  const bodyCoords = JSON.parse(
    await page.evalJs(`
      (() => { const r = document.querySelector('.terminal-card-body').getBoundingClientRect(); return JSON.stringify({x: r.x + 10, y: r.y + 10}); })()
    `),
  );
  await page.click(bodyCoords.x, bodyCoords.y);
  await new Promise((r) => setTimeout(r, 200));

  const selected = JSON.parse(
    await page.evalJs(`JSON.stringify(window.__selectTerminalTextForTest(${JSON.stringify(cardId)}, ${JSON.stringify(MARKER)}))`),
  );
  check("uma seleção real foi feita no marker impresso (term.select real, não simulado)", selected, true);

  // Real Ctrl+Shift+C via CDP, exactly the modifiers Chromium reports for
  // that combo (Control=2, Shift=8 → 10).
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "C", code: "KeyC", modifiers: 10, windowsVirtualKeyCode: 67 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "C", code: "KeyC", modifiers: 10, windowsVirtualKeyCode: 67 });
  await new Promise((r) => setTimeout(r, 300));

  const clipboardAfter = await page.evalJs(`navigator.clipboard.readText()`);
  check("a área de transferência real do SO agora contém o texto selecionado", clipboardAfter, MARKER);

  // Sanity: Ctrl+C SOZINHO (sem Shift) continua mandando SIGINT/interrupt
  // pro processo real, não foi sequestrado pelo copy — dispara um comando
  // longo, interrompe com Ctrl+C sozinho, confirma que o processo real
  // recebeu o sinal (prompt volta), não que "copiou" de novo.
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, "sleep 30\\r")`);
  await new Promise((r) => setTimeout(r, 400));
  const clipboardBeforeCtrlC = await page.evalJs(`navigator.clipboard.readText()`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 });
  await new Promise((r) => setTimeout(r, 400));
  const clipboardAfterCtrlC = await page.evalJs(`navigator.clipboard.readText()`);
  check("Ctrl+C SOZINHO (sem Shift) não mexeu na área de transferência (continua sendo SIGINT)", clipboardAfterCtrlC, clipboardBeforeCtrlC);

  page.close();
} finally {
  await stopApp(app);
}
finish();
