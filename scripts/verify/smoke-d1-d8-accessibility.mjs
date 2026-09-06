import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-d1-d8-accessibility-${CDP_PORT}`, import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();

try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sessão Acessibilidade", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 600));

  // 1. D6 — Verifica aria-labels na Rail e Topbar
  const railLabels = JSON.parse(
    await page.evalJs(`
      (() => {
        const btns = Array.from(document.querySelectorAll('.rail-btn'));
        return JSON.stringify(btns.map(b => ({
          title: b.getAttribute('title'),
          ariaLabel: b.getAttribute('aria-label')
        })));
      })()
    `)
  );
  check("D6: Rail buttons possuem aria-label", railLabels.length > 0 && railLabels.every(b => !!b.ariaLabel), true);

  const topbarHomeAria = await page.evalJs(`
    document.querySelector('.topbar-home')?.getAttribute('aria-label') ?? ''
  `);
  check("D6: Topbar home possui aria-label", topbarHomeAria.includes("Home") || topbarHomeAria.includes("inicial"), true);

  // 2. D1 — Verifica calha de proteção da Rail (card nasce livrando a barra lateral)
  let initialCardBounds = null;
  for (let i = 0; i < 20; i++) {
    initialCardBounds = JSON.parse(
      await page.evalJs(`
        (() => {
          const card = document.querySelector('.card-frame');
          if (!card) return null;
          const r = card.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()
      `)
    );
    if (initialCardBounds) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  check("D1: Card inicial nasce livrando a Rail (x >= 70)", initialCardBounds?.x >= 70, true);

  // 3. D8 — Verifica indicador de status dot acessível
  const statusDot = JSON.parse(
    await page.evalJs(`
      (() => {
        const dot = document.querySelector('.card-status-dot');
        if (!dot) return null;
        return JSON.stringify({
          role: dot.getAttribute('role'),
          ariaLabel: dot.getAttribute('aria-label')
        });
      })()
    `)
  );
  check("D8: Indicador card-status-dot possui role='status'", statusDot?.role, "status");
  check("D8: Indicador card-status-dot possui aria-label descritivo", !!statusDot?.ariaLabel, true);

  // 4. D5 — Verifica useModal com ShortcutsOverlay (?)
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "?", text: "?" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "?", text: "?" });
  await new Promise((r) => setTimeout(r, 400));

  const modalA11y = JSON.parse(
    await page.evalJs(`
      (() => {
        const modal = document.querySelector('.modal.shortcuts-modal');
        if (!modal) return JSON.stringify(null);
        return JSON.stringify({
          role: modal.getAttribute('role'),
          ariaModal: modal.getAttribute('aria-modal'),
          ariaLabelledby: modal.getAttribute('aria-labelledby')
        });
      })()
    `)
  );
  check("D5: Modal possui role='dialog'", modalA11y?.role, "dialog");
  check("D5: Modal possui aria-modal='true'", modalA11y?.ariaModal, "true");

  // Testa fechar modal via tecla Escape
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 400));

  const modalClosed = JSON.parse(await page.evalJs(`JSON.stringify(!document.querySelector('.modal.shortcuts-modal'))`));
  check("D5: Modal fecha ao pressionar tecla Escape", modalClosed, true);

  // 5. D2 — Verifica compensação de borda em baixo zoom
  await page.evalJs(`
    (() => {
      const zoomOutBtn = document.querySelector('.zoom-pill button[title="Diminuir zoom"]');
      if (zoomOutBtn) {
        for (let i = 0; i < 8; i++) zoomOutBtn.click();
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));

  const borderComp = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = document.querySelector('.card-frame');
        if (!card) return null;
        return JSON.stringify({
          cardBorderW: card.style.getPropertyValue('--card-border-w'),
          cardShadow: card.style.getPropertyValue('--card-shadow')
        });
      })()
    `)
  );
  check("D2: Compensação dinâmica de borda ativa em zoom out", !!borderComp?.cardBorderW, true);

  // 6. D3 — Verifica Offscreen Pips ao arrastar card para fora da tela
  const headPos = JSON.parse(
    await page.evalJs(`
      (() => {
        const head = document.querySelector('.card-head');
        if (!head) return null;
        const r = head.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `)
  );
  check("Card head encontrado para arrasto", !!headPos, true);

  if (headPos) {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: headPos.x, y: headPos.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: headPos.x - 1800, y: headPos.y - 1400, button: "left", pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: headPos.x - 1800, y: headPos.y - 1400, button: "left", clickCount: 1, pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 500));
  }

  const pipInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const pips = Array.from(document.querySelectorAll('.offscreen-pip'));
        const layer = document.querySelector('.offscreen-pips-layer');
        return JSON.stringify({
          hasLayer: !!layer,
          pipsCount: pips.length,
          edge: pips[0]?.getAttribute('data-edge'),
          title: pips[0]?.getAttribute('title')
        });
      })()
    `)
  );
  check("D3: Camada de Offscreen Pips montada na viewport", pipInfo?.hasLayer, true);
  check("D3: Pip direcional apontando para card fora da tela", pipInfo?.pipsCount > 0, true);

  // Testa clique no Pip para focar de volta no card
  await page.evalJs(`
    (() => {
      const pip = document.querySelector('.offscreen-pip');
      if (pip) pip.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));

  const cardBackInView = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = document.querySelector('.card-frame');
        if (!card) return false;
        const r = card.getBoundingClientRect();
        return JSON.stringify(r.x + r.width > 0 && r.x < window.innerWidth && r.y + r.height > 0 && r.y < window.innerHeight);
      })()
    `)
  );
  check("D3: Clique no Offscreen Pip traz o card de volta ao campo de visão", cardBackInView, true);

  finish();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await stopApp(app);
}
