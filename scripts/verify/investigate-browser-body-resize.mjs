// INVESTIGAÇÃO (task 29d8d5a1) — por que o `ResizeObserver` do
// `BrowserCard.tsx` NUNCA/POUCO corrige a altura do corpo, deixando o content
// size real da BrowserWindow offscreen preso no fallback `rect.h`
// (header+body juntos)? DESIGN-BACKLOG.md linha ~328 registra o defeito.
//
// Instrumenta `window.ResizeObserver` ANTES de o card de navegador montar —
// sem rebuild, sem tocar em `src/` — e responde com fato:
//   (a) quantos observers foram CONSTRUÍDOS;
//   (b) quantos CALLBACKS dispararam, e com que atraso;
//   (c) o elemento OBSERVADO é o MESMO `<canvas>` que está no DOM agora?
//   (d) o loop de render desta janela está THROTTLED? (rAF e um observer
//       de controle no `document.body`).
//
// Uso: node scripts/verify/investigate-browser-body-resize.mjs
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/investigate-body-resize-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Body Resize Probe", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  await page.evalJs(`
    (() => {
      // Registra TODA leitura de getBoundingClientRect do canvas — mostra a
      // EVOLUÇÃO da caixa (o transiente 784 para 852, se existir) e QUEM a leu
      // (a medição síncrona do app, o smoke/harness, o meu poll).
      window.__gbr = [];
      const origGbr = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        const r = origGbr.call(this);
        if (this.getAttribute && this.getAttribute("data-role") === "browser-body") window.__gbr.push({ t: Math.round(performance.now()), h: Math.round(r.height) });
        return r;
      };
      window.__roProbe = { constructed: 0, callbacks: 0, observed: 0, events: [], observedNode: null };
      const Orig = window.ResizeObserver;
      window.ResizeObserver = class extends Orig {
        constructor(cb) {
          super((entries, obs) => {
            window.__roProbe.callbacks++;
            for (const e of entries) {
              window.__roProbe.events.push({ t: Math.round(performance.now()), kind: "callback", role: (e.target && e.target.getAttribute && e.target.getAttribute("data-role")) || (e.target && e.target.tagName) || "?", w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) });
            }
            cb(entries, obs);
          });
          window.__roProbe.constructed++;
        }
        observe(el, opts) {
          window.__roProbe.observed++;
          if (el && el.getAttribute && el.getAttribute("data-role") === "browser-body") window.__roProbe.observedNode = el;
          window.__roProbe.events.push({ t: Math.round(performance.now()), kind: "observe", role: (el && el.getAttribute && el.getAttribute("data-role")) || (el && el.tagName) || "?" });
          return super.observe(el, opts);
        }
        disconnect() { window.__roProbe.events.push({ t: Math.round(performance.now()), kind: "disconnect" }); return super.disconnect(); }
      };
      window.__rafCount = 0;
      (function tick() { window.__rafCount++; requestAnimationFrame(tick); })();
      return true;
    })()
  `);

  const centerOf = (sel) =>
    page.evalJs(`
      (() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()
    `);
  const addBtn = await centerOf('[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf('.popover-row[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);

  const boardId = await page.evalJs(`window.store.boards.list().then((b) => b[0].id)`);
  let card = null;
  const cardDeadline = Date.now() + 3000;
  while (Date.now() < cardDeadline && !card) {
    await new Promise((r) => setTimeout(r, 100));
    const cards = await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((c) => c.filter((x) => x.kind === 'browser').map((x) => ({ id: x.id, w: x.w, h: x.h })))`);
    card = cards[cards.length - 1] ?? null;
  }

  // Poll: quando (se) o content size REAL aplicado deixa de ser o fallback
  // `rect.h × factor` e passa a bater com a caixa real do canvas × factor?
  const sample = () =>
    page.evalJs(`
      (async () => {
        const canvas = document.querySelector('[data-role="browser-body"]');
        const rect = canvas ? canvas.getBoundingClientRect() : null;
        const s = await window.debugBridge.browserContentSize(${JSON.stringify(card.id)});
        return {
          callbacks: window.__roProbe.callbacks,
          rafTicks: window.__rafCount,
          canvasRectH: rect ? Math.round(rect.height) : null,
          canvasLayoutH: canvas ? canvas.clientHeight : null,
          applied: s,
          observedNodeIsCurrentCanvas: window.__roProbe.observedNode === canvas,
          visibility: document.visibilityState,
          events: window.__roProbe.events,
        };
      })()
    `);

  const t0 = Date.now();
  let last = null;
  let prevKey = "";
  for (let i = 0; i < 60; i++) {
    last = await sample();
    const key = `canvasH=${last.canvasRectH} appliedH=${last.applied?.h ?? "?"} callbacks=${last.callbacks}`;
    if (key !== prevKey) {
      console.log(`t=${String(Date.now() - t0).padStart(5)}ms ${key}`);
      prevKey = key;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const gbr = await page.evalJs(`window.__gbr`);
  console.log("=== LEITURAS DA CAIXA DO CANVAS (getBoundingClientRect) ===");
  for (const r of gbr) console.log(JSON.stringify(r));

  console.log("=== RESULTADO ===");
  console.log(JSON.stringify({
    cardId: card?.id,
    rectH: card?.h,
    canvasLayoutH: last.canvasLayoutH,
    expectedAppliedH: last.canvasLayoutH === null ? null : Math.round(last.canvasLayoutH * 2),
    appliedH: last.applied?.h ?? null,
    observerCallbacks: last.callbacks,
    visibility: last.visibility,
    observedNodeIsCurrentCanvas: last.observedNodeIsCurrentCanvas,
  }, null, 2));
  console.log("=== RO EVENTS ===");
  for (const e of last.events) console.log(JSON.stringify(e));

  check("o card de navegador existe", typeof card?.id === "string", true);
  check("canvas no DOM", last.canvasLayoutH !== null, true);
  check("o nó observado é o MESMO canvas que está no DOM", last.observedNodeIsCurrentCanvas, true);
  // O que importa: o content size REAL aplicado bate com a caixa de LAYOUT do
  // corpo (não com o `getBoundingClientRect`, que o zoom do board escala).
  check(
    `content size real == caixa de corpo × factor (aplicado=${last.applied?.h}, layout=${last.canvasLayoutH})`,
    last.applied?.h,
    last.canvasLayoutH === null ? null : Math.round(last.canvasLayoutH * 2),
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
