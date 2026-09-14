// Prova ao vivo: Ctrl+End rola o VIEWPORT do xterm até o fim (nunca
// pty.write), e o TerminalCard expõe a affordance de atalhos a partir do
// MESMO registro (`data-role="terminal-shortcuts-hint"` → popover com
// `terminal.scroll.toEnd` / Ctrl+End).
//
// Nota: `pty:write` exige origin "human"|"delivery"|"auto" — sem isso o
// main retorna cedo (no-op).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-scroll-to-end-${CDP_PORT}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 8000, everyMs = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await delay(everyMs);
  }
  return null;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page);

  const cardId = await waitFor(async () => {
    const id = JSON.parse(
      await page.evalJs(`
        (async () => {
          const boards = await window.store.boards.list();
          const cards = await window.store.list(boards[0].id);
          const term = cards.find((c) => c.kind === "terminal");
          if (!term) return JSON.stringify(null);
          const dims = window.__getTerminalDims?.(term.id);
          return JSON.stringify(dims ? term.id : null);
        })()
      `),
    );
    return id;
  });
  check("terminal registrado no xterm (dims disponíveis)", !!cardId, true);

  const dims = JSON.parse(
    await page.evalJs(`JSON.stringify(window.__getTerminalDims(${JSON.stringify(cardId)}))`),
  );
  const lines = Math.max(200, (dims?.rows ?? 40) * 4);
  await page.evalJs(
    `window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(`seq 1 ${lines}; echo SCROLL_END_MARKER\r`)}, "human")`,
  );

  const pos = await waitFor(async () => {
    const p = JSON.parse(
      await page.evalJs(`JSON.stringify(window.__getTerminalScrollPos(${JSON.stringify(cardId)}))`),
    );
    return p && p.baseY > 0 ? p : null;
  });
  check("depois do output, viewport está no fim", pos?.atBottom, true);
  check("há scrollback de verdade (baseY > 0)", (pos?.baseY ?? 0) > 0, true);
  check(
    "marcador do fim está no buffer",
    await page.evalJs(`window.__selectTerminalTextForTest(${JSON.stringify(cardId)}, "SCROLL_END_MARKER")`),
    true,
  );

  const scrollBy = -Math.max(30, Math.floor((pos?.baseY ?? 40) / 2));
  const scrolled = await page.evalJs(
    `window.__scrollTerminalLinesForTest(${JSON.stringify(cardId)}, ${JSON.stringify(scrollBy)})`,
  );
  check("scrollLines negativo aplicou no viewport", scrolled, true);

  const away = JSON.parse(
    await page.evalJs(`JSON.stringify(window.__getTerminalScrollPos(${JSON.stringify(cardId)}))`),
  );
  check("depois de rolar pra cima, NÃO está no fim", away?.atBottom, false);

  // Despacha keydown real no textarea focado — mesmo caminho do capture em
  // useTerminal (resolveTerminalShortcutKeydown → scrollToBottom). CDP
  // Input.dispatchKeyEvent com Ctrl+End é flaky neste harness quando o
  // card está parcialmente offscreen; o KeyboardEvent DOM exercita o
  // handler idêntico.
  const keyed = JSON.parse(
    await page.evalJs(`
      (() => {
        const ta = document.querySelector(".xterm-helper-textarea");
        if (!ta) return JSON.stringify({ ok: false, reason: "no-textarea" });
        ta.focus();
        const before = window.__getTerminalScrollPos(${JSON.stringify(cardId)});
        ta.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "End",
            code: "End",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        const after = window.__getTerminalScrollPos(${JSON.stringify(cardId)});
        return JSON.stringify({ ok: true, before, after });
      })()
    `),
  );
  check("keydown Ctrl+End despachado no textarea do xterm", keyed?.ok, true);
  check("antes do atalho NÃO estava no fim", keyed?.before?.atBottom, false);
  check("Ctrl+End voltou o viewport ao fim", keyed?.after?.atBottom, true);

  await page.evalJs(`
    (() => {
      document.querySelector('[data-kind="terminal"].card-frame')?.classList.add("selected");
      document.querySelector('[data-role="terminal-shortcuts-hint"]')?.click();
    })()
  `);

  const hintOpen = await waitFor(async () => {
    const h = JSON.parse(
      await page.evalJs(`
        (() => {
          const btn = document.querySelector('[data-role="terminal-shortcuts-hint"]');
          const pop = document.querySelector('[data-role="terminal-shortcuts-popover"]');
          const row = pop?.querySelector('[data-shortcut-id="terminal.scroll.toEnd"]');
          if (!pop || !row) return JSON.stringify(null);
          return JSON.stringify({
            found: !!btn,
            open: true,
            hasScrollToEnd: true,
            kbd: row.querySelector("kbd")?.textContent ?? null,
            rowCount: pop.querySelectorAll("[data-shortcut-id]").length,
          });
        })()
      `),
    );
    return h;
  });

  check("affordance no rodapé existe (data-role=terminal-shortcuts-hint)", !!hintOpen?.found, true);
  check("popover de atalhos abriu a partir do rodapé", !!hintOpen?.open, true);
  check("lista inclui terminal.scroll.toEnd do registro", hintOpen?.hasScrollToEnd, true);
  check("kbd mostra Ctrl+End (mesmo formatCombo do registro)", hintOpen?.kbd, "Ctrl+End");
  check("há mais de um atalho de terminal na lista (não lista à mão)", (hintOpen?.rowCount ?? 0) >= 5, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
