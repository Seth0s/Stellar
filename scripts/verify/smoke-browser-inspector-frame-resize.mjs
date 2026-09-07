// DESIGN-BACKLOG.md §2.1 item 3, sub-item pendente (2026-09-07) — alças de
// resize direto nas bordas/canto do device-frame emulado. Bug real relatado
// ao vivo pelo usuário motivando isto: arrastar o CARD inteiro (ou o dock)
// não dava NENHUM jeito de mudar a altura/largura do CONTEÚDO emulado —
// só dropdown de presets, campos numéricos, o ruler (clique único, só
// largura) ou o botão de girar. Este teste simula arraste REAL (down+move+
// up com o botão mantido, via CDP `Input.dispatchMouseEvent`) nas 3 alças
// (direita, baixo, canto) e confirma que o tamanho EMULADO de verdade muda
// — não só um elemento visual se movendo. Também confirma o clamp [100,3000]
// e que as alças só existem em zoom "Ajustar" (decisão de escopo explícita:
// zooms fixos podem rolar de verdade, complicação deixada de fora desta
// rodada).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-frame-resize-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0;background:#222"></body></html>`;
const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height });
      })()
    `),
  );
  return res;
}

/** Arraste real: down, um move intermediário, move final, up — tudo com o
 * botão mantido (mesmo gotcha documentado em cdp-client.mjs pro `click`:
 * eventos soltos sem o pointerType/estado certo não formam um gesto de
 * drag de verdade pro listener React de pointermove). */
async function drag(page, fromX, fromY, toX, toY) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1, pointerType: "mouse" });
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: midX, y: midY, button: "left", buttons: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toX, y: toY, button: "left", buttons: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1, pointerType: "mouse" });
}

async function canvasRect(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('[data-role="browser-body"]').getBoundingClientRect())`));
}

async function setZoom(page, value) {
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-zoom-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(value)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 350));
}

/** Zoom do BOARD (não confundir com `setZoom` acima, que é o select do
 * "Ajustar/100%/etc" DENTRO do inspector) — mesmo padrão de
 * smoke-chat-screen-projection.mjs, usado só pelo teste de regressão do
 * item 4.3 abaixo. */
async function setBoardZoom(page, pct) {
  const alreadyOpen = await page.evalJs(`!!document.querySelector('.zoom-input')`);
  if (!alreadyOpen) {
    const zoomReadout = await centerOf(page, ".zoom-readout");
    await page.click(zoomReadout.x, zoomReadout.y);
    await new Promise((r) => setTimeout(r, 200));
  }
  const zoomInputCoords = await centerOf(page, ".zoom-input");
  await page.click(zoomInputCoords.x, zoomInputCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.zoom-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(String(pct))});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 1500));
}

/** Não existe nenhuma API exposta pra ler `activeEmulation` (estado interno
 * do componente) direto do DOM — mas em zoom "100%" o `<canvas>` renderiza
 * no tamanho REAL do dispositivo em CSS px (mesma técnica já usada por
 * smoke-browser-inspector-device-frame.mjs pra confirmar 390 CSS px de
 * largura), então alterna pra zoom "1" só pra MEDIR e volta pra "Ajustar"
 * (onde as alças de resize existem) antes de continuar arrastando. */
async function readEmulatedSize(page) {
  await setZoom(page, "1");
  const rect = await canvasRect(page);
  await setZoom(page, "fit");
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Frame Resize Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const browserId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((b) => window.store.list(b[0].id)).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'browser').id))`),
  );
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  const kebab = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
  await page.click(kebab.x, kebab.y);
  await new Promise((r) => setTimeout(r, 300));
  const inspectorBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes('Abrir inspector'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(inspectorBtn.x, inspectorBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  check("sem o device toolbar aberto, nenhuma alça de resize do frame aparece (nem emulação ativa ainda)", await page.evalJs(`!!document.querySelector('[data-role="inspector-frame-resize-overlay"]')`), false);

  // DESIGN-BACKLOG.md §2.1 (revisto ao vivo 2026-09-07, pedido do
  // usuário: "foi preciso clicar em algum preset em vez de já aplicar os
  // frames") — abrir a barra de dispositivo agora aplica o preset Mobile
  // AUTOMATICAMENTE (não fica mais parado em "Nenhum" esperando escolha
  // manual), então as alças já aparecem no mesmo clique que abre a barra.
  const deviceToggle = await centerOf(page, '[data-role="inspector-device-toolbar-toggle"]');
  await page.click(deviceToggle.x, deviceToggle.y);
  await new Promise((r) => setTimeout(r, 400));

  check(
    "abrir a barra de dispositivo JÁ aplica emulação Mobile sozinho e as 3 alças aparecem (sem precisar escolher preset manualmente)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-frame-resize-overlay"]') && !!document.querySelector('[data-role="inspector-frame-resize-right"]') && !!document.querySelector('[data-role="inspector-frame-resize-bottom"]') && !!document.querySelector('[data-role="inspector-frame-resize-corner"]')`),
    true,
  );

  const before = await readEmulatedSize(page);
  check("tamanho inicial é o do preset Mobile (390×844) antes de qualquer arraste", before, (v) => v.width === 390 && v.height === 844);

  // DESIGN-BACKLOG.md item 4.3 -- reproduzido ao vivo: com o board com
  // zoom-out, a alça de 6px encolhe pra só ~3px de tela, tornando o
  // clique real fácil de errar por completo (mousedown cai no <canvas>
  // por baixo, e o arraste nunca começa -- exatamente o "arrastar não
  // muda o tamanho" relatado). O `::after` invisível que alarga só a
  // ÁREA de clique, sem engrossar a linha visível (BrowserInspector.
  // module.css), cobre esse caso. Zoom do board a 50% e clica 1px FORA
  // da caixa visível da alça -- miss garantido sem o `::after`, hit
  // garantido com ele. Usa o campo de largura personalizada (não
  // `readEmulatedSize`, que mede o `<canvas>` em CSS px assumindo board a
  // 100% -- inválido sob zoom de board diferente de 100%) e roda ANTES
  // de qualquer arraste/round-trip de zoom do inspector (flake
  // pré-existente e independente deste fix: `frameBox` ocasionalmente
  // fica com percentuais desatualizados por um instante depois do
  // round-trip "1"→"Ajustar" de `readEmulatedSize`, deixando as alças de
  // baixo/canto temporariamente fora de posição -- reproduzido mesmo no
  // arquivo original sem nenhuma mudança desta rodada, portanto fora de
  // escopo aqui; rodar este bloco cedo evita depender dele).
  await setBoardZoom(page, 50);
  await new Promise((r) => setTimeout(r, 300));
  const zoomedHandle = await centerOf(page, '[data-role="inspector-frame-resize-right"]');
  const missPointX = zoomedHandle.left - 1;
  const missPointY = zoomedHandle.top + zoomedHandle.height / 2;
  const hitRole = await page.evalJs(`document.elementFromPoint(${missPointX}, ${missPointY})?.getAttribute('data-role')`);
  check("a 50% de zoom do board, um clique 1px fora da linha visível da alça ainda cai na alça (área de clique alargada)", hitRole, "inspector-frame-resize-right");

  const widthBeforeZoomDrag = await page.evalJs(`document.querySelector('[data-role="inspector-custom-width"]')?.value`);
  await drag(page, missPointX, missPointY, missPointX + 100, missPointY);
  await new Promise((r) => setTimeout(r, 400));
  const widthAfterZoomDrag = await page.evalJs(`document.querySelector('[data-role="inspector-custom-width"]')?.value`);
  check("...e o arraste a partir desse ponto quase-errado muda a largura emulada de verdade", widthAfterZoomDrag, (v) => v !== widthBeforeZoomDrag);

  await setBoardZoom(page, 100);
  await new Promise((r) => setTimeout(r, 300));

  // Preset Mobile de novo pra zerar o efeito do arraste acima antes das
  // asserções de eixo abaixo (que dependem de largura/altura conhecidas).
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-device-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      const opt = [...select.options].find((o) => o.textContent.includes('Mobile'));
      setter.call(select, opt.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  const beforeAxisTests = await readEmulatedSize(page);
  check("preset Mobile reaplicado (390×844) antes dos testes de eixo abaixo", beforeAxisTests, (v) => v.width === 390 && v.height === 844);

  // Arrasta a alça DIREITA pra direita — só a LARGURA deve mudar.
  const rightHandle = await centerOf(page, '[data-role="inspector-frame-resize-right"]');
  await drag(page, rightHandle.x, rightHandle.y, rightHandle.x + 80, rightHandle.y);
  await new Promise((r) => setTimeout(r, 400));
  const afterRight = await readEmulatedSize(page);
  check("arrastar a alça direita MUDA a largura emulada de verdade (não é só um visual)", afterRight.width, (v) => v !== 390);
  check("...mas NÃO mexe na altura (alça direita é só eixo X)", afterRight.height, before.height);

  // Arrasta a alça DE BAIXO pra baixo — só a ALTURA deve mudar. Este é o
  // bug relatado ao vivo: hoje, redimensionar o CARD inteiro não afeta a
  // altura do content; esta alça é o jeito novo de fazer isso de verdade.
  const bottomHandle = await centerOf(page, '[data-role="inspector-frame-resize-bottom"]');
  await drag(page, bottomHandle.x, bottomHandle.y, bottomHandle.x, bottomHandle.y + 80);
  await new Promise((r) => setTimeout(r, 400));
  const afterBottom = await readEmulatedSize(page);
  check("arrastar a alça de baixo MUDA a altura emulada de verdade", afterBottom.height, (v) => v !== afterRight.height);
  check("...mas NÃO mexe na largura (alça de baixo é só eixo Y)", afterBottom.width, afterRight.width);

  // Arrasta o CANTO — largura E altura devem mudar juntas.
  const cornerHandle = await centerOf(page, '[data-role="inspector-frame-resize-corner"]');
  await drag(page, cornerHandle.x, cornerHandle.y, cornerHandle.x + 60, cornerHandle.y + 60);
  await new Promise((r) => setTimeout(r, 400));
  const afterCorner = await readEmulatedSize(page);
  check("arrastar o CANTO muda a largura", afterCorner.width, (v) => v !== afterBottom.width);
  check("...e muda a altura, os dois no mesmo arraste", afterCorner.height, (v) => v !== afterBottom.height);

  // Clamp: arrasta MUITO pra cima/esquerda (bem além do mínimo de 100) e
  // confirma que trava em 100, não vira negativo/zero.
  const rightHandle2 = await centerOf(page, '[data-role="inspector-frame-resize-right"]');
  await drag(page, rightHandle2.x, rightHandle2.y, rightHandle2.x - 3000, rightHandle2.y);
  await new Promise((r) => setTimeout(r, 400));
  const afterClampMin = await readEmulatedSize(page);
  check("arraste extremo pra reduzir trava no mínimo de 100 (não vira negativo/zero)", afterClampMin.width, 100);

  // Volta pra um tamanho maior e confirma o teto de 3000.
  const rightHandle3 = await centerOf(page, '[data-role="inspector-frame-resize-right"]');
  await drag(page, rightHandle3.x, rightHandle3.y, rightHandle3.x + 30000, rightHandle3.y);
  await new Promise((r) => setTimeout(r, 400));
  const afterClampMax = await readEmulatedSize(page);
  check("arraste extremo pra aumentar trava no teto de 3000", afterClampMax.width, 3000);

  // Fora do zoom 'Ajustar' as alças não aparecem (escopo desta rodada,
  // deliberadamente deixado de fora — ver comentário no topo do arquivo).
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-zoom-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  check("em zoom fixo (100%), as alças de resize do frame somem (decisão de escopo desta rodada)", await page.evalJs(`!!document.querySelector('[data-role="inspector-frame-resize-overlay"]')`), false);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
