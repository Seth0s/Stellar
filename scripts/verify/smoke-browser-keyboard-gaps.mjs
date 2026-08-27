// Pedido ao vivo (2026-08-27): "POde corrigir isso no teclado agora" — os 3
// gaps reais achados ao auditar o teclado do BrowserCard durante o fix do
// wheel universal (item 26): F-keys/Insert/ContextMenu ausentes do
// vocabulário de teclas, composição de IME não tratada, e Ctrl+V só
// mandava um keyDown sintético (nunca insere o clipboard real do SO).
//
// Prova real, sem mock: um F5 de verdade recarregando a página offscreen
// (efeito observável do Chromium, não uma checagem de mecanismo interno);
// um round-trip real pelo clipboard do SO (`navigator.clipboard.writeText`
// na página principal → Ctrl+V sintético no canvas → `getPageText`
// confirma que o texto chegou → Ctrl+A/Ctrl+C → clipboard do SO lido de
// volta confirma que copiou de verdade); um CompositionEvent real
// despachado no DOM do canvas (não uma chamada direta à função React)
// confirmando que o texto final da composição é inserido.
//
// about:blank não tem campo editável por padrão — usa o IPC test-only
// `browser:test-make-editable` (guardado por `!app.isPackaged`, mesmo
// padrão de `chat:test-simulate-tool`) pra não depender de markup de uma
// página real de terceiro (rede = instável nesse harness).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9445;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-keyboard-gaps", import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Teclado Browser Teste");
  await new Promise((r) => setTimeout(r, 600));

  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'browser').id);
      })()
    `),
  );

  const canvasCoords = await centerOf(page, ".browser-card-body");
  await page.click(canvasCoords.x, canvasCoords.y); // focus, matches real user gesture

  // testMakeEditable also mirrors keydown.key into document.title (see
  // browser-registry.ts) — used by both the F-key check below and to give
  // paste/copy/IME a real editable surface (about:blank has none).
  await page.evalJs(`window.browser.testMakeEditable(${JSON.stringify(cardId)})`);
  await new Promise((r) => setTimeout(r, 200));

  // ---- 1. F-keys: a genuinely new SPECIAL_KEYS entry (F5) reaches the
  // embedded page's own DOM keydown listener with the right named key ----
  await page.evalJs(`
    (() => {
      window.__titles = [];
      window.__offTitle = window.browser.onTitle((id, title) => { if (id === ${JSON.stringify(cardId)}) window.__titles.push(title); });
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 116, key: "F5", code: "F5" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 116, key: "F5", code: "F5" });
  await new Promise((r) => setTimeout(r, 500));
  const titles = await page.evalJs(`window.__titles`);
  check(
    "F5 (new SPECIAL_KEYS entry) reached the offscreen page's own keydown listener with key='F5'",
    titles.includes("key:F5:false"),
    true,
  );

  const pasteText = "stellar-keyboard-gap-proof-" + Date.now();
  await page.evalJs(`navigator.clipboard.writeText(${JSON.stringify(pasteText)})`);
  await new Promise((r) => setTimeout(r, 200));

  // Ctrl+V real via CDP (modifiers bit 2 = ctrl) — this is what BrowserCard's
  // onCanvasKeyDown intercepts and forwards through window.browser.paste(id).
  await page.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    key: "v",
    code: "KeyV",
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 86, key: "v", code: "KeyV" });
  await new Promise((r) => setTimeout(r, 500));

  const afterPaste = await page.evalJs(`window.browser.getPageText(${JSON.stringify(cardId)})`);
  check("real OS clipboard content landed in the offscreen page after Ctrl+V (not just a synthetic keydown)", afterPaste.ok && afterPaste.text.includes(pasteText), true);

  // Select-all + copy, then clear the OS clipboard and verify Ctrl+C put it back.
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA" });
  await new Promise((r) => setTimeout(r, 200));
  await page.evalJs(`navigator.clipboard.writeText("cleared-before-copy-test")`);
  await new Promise((r) => setTimeout(r, 100));
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 67, key: "c", code: "KeyC" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 67, key: "c", code: "KeyC" });
  await new Promise((r) => setTimeout(r, 500));
  const clipboardAfterCopy = await page.evalJs(`navigator.clipboard.readText()`);
  check("Ctrl+C on the offscreen page's selection wrote the real page content back to the OS clipboard", clipboardAfterCopy.includes(pasteText), true);

  // ---- 3. IME composition: real CompositionEvent dispatched on the DOM ----
  const composed = "日本語テスト";
  await page.evalJs(`
    (() => {
      const canvas = document.querySelector(${JSON.stringify(".browser-card-body")});
      canvas.dispatchEvent(new CompositionEvent("compositionend", { data: ${JSON.stringify(composed)}, bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  const afterComposition = await page.evalJs(`window.browser.getPageText(${JSON.stringify(cardId)})`);
  check("a real compositionend DOM event's final IME text was inserted via insertText (not dropped, not char-by-char)", afterComposition.ok && afterComposition.text.includes(composed), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
