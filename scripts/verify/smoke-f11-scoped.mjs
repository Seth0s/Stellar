// Achado ao vivo (2026-09-02) — usuário relatou o header do app sumindo
// "sem precedentes" no meio de sessões longas, sem trigger identificado.
// Causa: `App.tsx`'s handler global de F11 rodava ANTES do guard `typing`
// que já protegia os atalhos de ferramenta (v/p/c/s/?) — `useTerminal.ts`
// e `BrowserCard.tsx` só fazem `preventDefault()` no F11 (não
// `stopPropagation()`), então o keydown real ainda bubbla até o listener
// global em `window`. Um F11 apertado com foco dentro de QUALQUER
// terminal (uma TUI com bind próprio de F11) ou navegador embutido (uma
// página pedindo fullscreen) ligava o fullscreen REAL da janela do
// Stellar — escondendo `Titlebar.tsx` inteiro sem o usuário ter pedido
// isso do app em si.
//
// Prova real: um KeyboardEvent genuíno (não uma chamada direta à função)
// despachado no elemento que xterm.js/BrowserCard de fato focam, e um
// controle mostrando que F11 sem foco em nenhum card ainda funciona
// normalmente (a correção é escopada, não uma quebra geral do atalho).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-f11-scoped-${CDP_PORT}`, import.meta.url).pathname;

async function dispatchF11On(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false, reason: "element not found" });
        el.focus();
        const ev = new KeyboardEvent("keydown", { key: "F11", bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return JSON.stringify({ ok: true });
      })()
    `),
  );
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "F11Scope", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 600));

  check(
    "baseline: not fullscreen yet",
    await page.evalJs(`window.winControls.isFullscreen()`),
    false,
  );

  // F11 com foco dentro do textarea real que xterm.js usa pra capturar
  // teclado (o mesmo elemento que uma TUI rodando ali "veria" o F11).
  const termResult = await dispatchF11On(page, ".xterm-helper-textarea");
  check("terminal helper-textarea found and focused for the F11 dispatch", termResult.ok, true);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "F11 com foco DENTRO do terminal NÃO liga fullscreen (bug corrigido)",
    await page.evalJs(`window.winControls.isFullscreen()`),
    false,
  );
  check("...e o header/titlebar continua visível", await page.evalJs(`!!document.querySelector('.titlebar')`), true);

  // Mesmo teste pro canvas de um card de navegador.
  await spawnCard(page, "browser");
  await new Promise((r) => setTimeout(r, 600));
  const browserResult = await dispatchF11On(page, '[data-kind="browser"] canvas');
  check("browser card canvas found and focused for the F11 dispatch", browserResult.ok, true);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "F11 com foco DENTRO do navegador embutido NÃO liga fullscreen",
    await page.evalJs(`window.winControls.isFullscreen()`),
    false,
  );

  // Controle: F11 sem foco em nenhum card (ex.: canvas do board vazio)
  // continua funcionando normalmente -- a correção é escopada, não quebrou
  // o atalho pro caso real de uso.
  await page.evalJs(`document.querySelector('.viewport')?.focus?.(); document.activeElement?.blur?.();`);
  const bodyResult = await dispatchF11On(page, "body");
  check("F11 dispatch on body (nothing focused inside a card)", bodyResult.ok, true);
  await new Promise((r) => setTimeout(r, 600));
  check(
    "...e ESSE F11 continua ligando o fullscreen normalmente (atalho não quebrou em geral)",
    await page.evalJs(`window.winControls.isFullscreen()`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
