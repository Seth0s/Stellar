// DESIGN-BACKLOG.md 2.1 — "Terminal — Correção do Piscar/Flicker durante
// Arraste (Drag)", reportado ao vivo. Causa raiz encontrada lendo o código:
// `CardFrame.tsx`'s `onMove` (drag do header e do resize) chamava
// `onChange(rect)` — que sobe até `App.tsx`'s `changeRect`/`setCards` —
// direto, uma vez por `pointermove` CRU, sem nenhum agrupamento. Eventos de
// pointermove podem chegar bem mais rápido que a taxa real de atualização
// da tela, e `left`/`top` (usados por `CardFrame` pra posicionar) são
// propriedades de LAYOUT — cada evento virava seu próprio layout+paint
// forçado. Conteúdo DOM comum absorve isso sem sintoma visível; o canvas
// WebGL do xterm.js é exatamente o tipo de camada onde esse
// paint/composite redundante aparece como piscar visível.
// Fix: `rafThrottleRect` (CardFrame.tsx) agrupa múltiplos eventos crus no
// mesmo frame num único `onChange`, sem mudar a lógica de arraste em si.
// Captura de tela de canvas/WebGL não é confiável neste ambiente (ver
// AGENTS.md) — a prova real possível aqui é quantitativa, não visual:
// (a) uma rajada de pointermove sintéticos mais rápida que 1 frame produz
// BEM menos renders/commits do que eventos disparados (prova o
// coalescing), e (b) a posição final na tela e no banco continua exata
// (prova que agrupar não perde nem atrasa o resultado real do arraste).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-card-drag-raf-throttle-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Drag Throttle Teste");
  await new Promise((r) => setTimeout(r, 600));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  const before = JSON.parse(
    await page.evalJs(`
      (async () => {
        const head = document.querySelector('[data-kind="terminal"] .card-head');
        const r = head.getBoundingClientRect();
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        // window.store.list() retorna CardRow cru (colunas planas do banco:
        // x/y/w/h), não um Card com \`rect\` aninhado — esse aninhamento só
        // existe depois de \`fromRow\` no lado do renderer.
        const row = cards.find((c) => c.id === ${JSON.stringify(cardId)});
        return JSON.stringify({ x: r.x, y: r.y, dbX: row.x, dbY: row.y, renders: window.__cardRenderCounts?.[${JSON.stringify(cardId)}] ?? 0 });
      })()
    `),
  );

  // Down no header, uma rajada de N mouseMoved sem pausa artificial (o
  // round-trip do próprio CDP já é mais rápido que 16ms/frame), terminando
  // com um total conhecido de deslocamento (dx=200, dy=140), e up.
  const startX = before.x + 20;
  const startY = before.y + 10;
  const TOTAL_DX = 200;
  const TOTAL_DY = 140;
  const STEPS = 40;
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1, pointerType: "mouse",
  });
  // Não espera a resposta de cada `mouseMoved` individualmente — um
  // round-trip de CDP sozinho já costuma passar de 16ms, o que por si só
  // já espaçaria os eventos além de 1 frame e mascararia o throttle sendo
  // testado. Dispara a rajada inteira sem aguardar entre elas (só o
  // ENVIO via WebSocket, não a resposta), pra genuinamente chegar mais
  // rápido que 1 frame no processo Electron — só então aguarda todas
  // resolverem.
  const movePromises = [];
  for (let i = 1; i <= STEPS; i++) {
    const x = startX + Math.round((TOTAL_DX * i) / STEPS);
    const y = startY + Math.round((TOTAL_DY * i) / STEPS);
    movePromises.push(page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", pointerType: "mouse" }));
  }
  await Promise.all(movePromises);
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: startX + TOTAL_DX, y: startY + TOTAL_DY, button: "left", clickCount: 1, pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 400));

  const after = JSON.parse(
    await page.evalJs(`
      (async () => {
        const head = document.querySelector('[data-kind="terminal"] .card-head');
        const r = head.getBoundingClientRect();
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        // window.store.list() retorna CardRow cru (colunas planas do banco:
        // x/y/w/h), não um Card com \`rect\` aninhado — esse aninhamento só
        // existe depois de \`fromRow\` no lado do renderer.
        const row = cards.find((c) => c.id === ${JSON.stringify(cardId)});
        return JSON.stringify({ x: r.x, y: r.y, dbX: row.x, dbY: row.y, renders: window.__cardRenderCounts?.[${JSON.stringify(cardId)}] ?? 0 });
      })()
    `),
  );

  const rendersDuringDrag = after.renders - before.renders;
  check(
    `${STEPS} pointermove crus produziram BEM menos que ${STEPS} renders (rAF agrupou, got ${rendersDuringDrag})`,
    rendersDuringDrag > 0 && rendersDuringDrag < STEPS,
    true,
  );
  check("...mas produziram PELO MENOS um render (o drag continua atualizando de verdade)", rendersDuringDrag > 0, true);

  const actualDx = Math.round(after.x - before.x);
  const actualDy = Math.round(after.y - before.y);
  check("a posição final na TELA bate exatamente com o deslocamento total do drag (X)", actualDx, TOTAL_DX);
  check("...e em Y também — agrupar frames não perdeu nem atrasou o resultado", actualDy, TOTAL_DY);

  const persistedDx = Math.round(after.dbX - before.dbX);
  const persistedDy = Math.round(after.dbY - before.dbY);
  check("o rect persistido no banco também reflete o deslocamento total real (onCommit não regrediu, X)", persistedDx, TOTAL_DX);
  check("...e em Y também", persistedDy, TOTAL_DY);

  page.close();
} finally {
  await stopApp(app);
}
finish();
