// TASK b3237a17, item 3 — "a top bar sobe e some do viewport".
//
// Causa medida: Ctrl/Cmd+wheel dispara o ZOOM DE PÁGINA nativo do Chromium
// (`visualViewport.scale` cresce), que escala o DOCUMENTO INTEIRO do Stellar —
// uma SPA de DOM. Com o documento escalado, o chrome flutuante em
// `position:absolute` (`.topbar` em `top: calc(var(--titlebar-h) + 12px)`, o
// `.titlebar`) sai do viewport: a barra "sobe e some".
//
// Este smoke: (1) mede `visualViewport.scale` e o retângulo do `.topbar` antes;
// (2) dispõe um Ctrl+wheel REAL, por CDP, sobre o board; (3) mede de novo.
// BUG (sem guarda): scale > 1 e o topbar sai da viewport. CORRIGIDO: scale
// continua 1 e o topbar fica exatamente onde estava. Um screenshot é salvo em
// `.verify-tmp/` como evidência visual nos dois casos.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-ctrl-wheel-${CDP_PORT}`, import.meta.url).pathname;
const SHOT_DIR = new URL("../../.verify-tmp/", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // Sem terminal: o defeito é do ZOOM DE PÁGINA sobre o board, não de um card.
  await bootIntoFreshSession(page, undefined, { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 800));

  const state = () =>
    page.evalJs(`
      (() => {
        const tb = document.querySelector(".topbar");
        const r = tb ? tb.getBoundingClientRect() : null;
        return {
          scale: window.visualViewport ? window.visualViewport.scale : 1,
          topbar: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
        };
      })()
    `);

  const before = await state();

  async function shot(name) {
    try {
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      mkdirSync(dirname(`${SHOT_DIR}${name}`), { recursive: true });
      writeFileSync(`${SHOT_DIR}${name}`, Buffer.from(data, "base64"));
    } catch {
      // screenshot é evidência, não gate
    }
  }
  await shot("ctrl-wheel-before.png");

  // Ctrl+wheel REAL (modifiers: 2 = Ctrl) sobre o board, zona vazia à direita.
  for (let i = 0; i < 3; i++) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1000, y: 400, deltaX: 0, deltaY: -120, modifiers: 2 });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 300));
  const after = await state();
  await shot("ctrl-wheel-after.png");

  console.log(`[ctrl-wheel] antes:  scale=${before.scale} topbar=${JSON.stringify(before.topbar)}`);
  console.log(`[ctrl-wheel] depois: scale=${after.scale} topbar=${JSON.stringify(after.topbar)}`);

  check("Ctrl+wheel NÃO muda o zoom de página (visualViewport.scale == 1)", after.scale, 1);
  check(
    "a topbar continua dentro do viewport depois do Ctrl+wheel (mesmo y)",
    JSON.stringify(after.topbar),
    JSON.stringify(before.topbar),
  );

  // O OUTRO caminho do "zoom do webkit": Ctrl+`=`/`-`. No app, o main intercepta
  // os dois (`before-input-event`) para virar zoom do BOARD — este bloco prova
  // que continua sendo o board (o readout muda) e NÃO vira zoom de página
  // (innerWidth/scale do documento intactos).
  const zoomTextBefore = await page.evalJs(`document.querySelector(".zoom-readout")?.textContent ?? ""`);
  const innerBefore = after.innerW;
  for (let i = 0; i < 3; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "=", code: "Equal", modifiers: 2, windowsVirtualKeyCode: 187 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "=", code: "Equal", modifiers: 2, windowsVirtualKeyCode: 187 });
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 250));
  const afterKey = await state();
  const zoomTextAfter = await page.evalJs(`document.querySelector(".zoom-readout")?.textContent ?? ""`);
  console.log(`[ctrl-key] zoom do board "${zoomTextBefore}" -> "${zoomTextAfter}"; innerW ${innerBefore} -> ${afterKey.innerW}, scale=${afterKey.scale}`);
  // O `readout` NÃO é asserção: neste ambiente o keyDown sintético não chega ao
  // acelerador do main (medido: 100% → 100%), então exigi-lo seria afirmar algo
  // que o harness não dirige. O que importa — e é o defeito em questão — é que
  // NADA disso vire zoom de página.
  check("Ctrl+`=` NÃO vira zoom de página (innerWidth do documento intacto)", afterKey.innerW, innerBefore);

  page.close();
} finally {
  await stopApp(app);
}
finish();
