// Pendentes #188 — investigação de "hover/textarea não responde" no browser
// card. Hipótese testada (2026-09-06): `isFocused` (BrowserCard.tsx, gate do
// paint rate em browser-registry.ts's setFocused) é puramente z-order
// topmost-ness (App.tsx: `zIndex === order.length - 1`), nunca foco real de
// DOM/teclado — um card em que o humano clicou de verdade (foco real,
// digitando) para de ser "focused" no sentido do app no instante em que
// QUALQUER outro card é levantado por cima, inclusive um spawn de agente
// via MCP sem nenhum clique humano na página de topo, e passaria a pintar
// a 8fps (UNFOCUSED_FRAME_RATE) daí em diante.
//
// HIPÓTESE REFUTADA por teste A/B direto: reproduzido o cenário exato
// (autônomo ligado, clique real no canvas, segundo card spawnado só via
// MCP, zero clique adicional na página de topo, foco real confirmado
// mantido, zIndex real confirmado menor que o máximo) e tanto o repaint de
// um `:hover` real quanto a digitação real de 5 caracteres na textarea
// embutida continuam rápidos (~10ms hover, <150ms pro texto assentar) SEM
// nenhuma mudança de código — testado contra o código original antes de
// escrever qualquer fix. Aparentemente o `setFrameRate` do Electron não
// atrasa de forma perceptível um repaint disparado por input real (hover/
// tecla), só corta o teto de FPS pra algo tipo animação/vídeo contínuo sem
// input associado. Mantido como teste de regressão real: prova que este
// cenário específico funciona hoje, não como reprodução do bug relatado.
// "Hover/textarea não responde" continua sem repro — provavelmente não é
// sobre a página embutida do browser card, e sim sobre a UI do próprio
// Stellar (ver Pendentes #188).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-focused-not-topmost-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}
// `fy` is the fraction of the canvas's own pixel HEIGHT to sample at — must
// match where the hover target actually sits in the CSS rect (#box only
// occupies the top half, see FIXTURE_HTML), NOT always dead-center.
async function measureHoverLatencyMs(page, canvasBox, fy = 0.25) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasBox.x - 100, y: canvasBox.y - 100, button: "none", pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 60));
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasBox.x, y: canvasBox.y, button: "none", pointerType: "mouse" });
  const start = Date.now();
  for (let i = 0; i < 30; i++) {
    const isGreen = await page.evalJs(`
      (() => {
        const canvas = document.querySelector('[data-role="browser-body"]');
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const d = ctx.getImageData(Math.floor(w/2), Math.floor(h*${fy}), 1, 1).data;
        return JSON.stringify(d[1] > 150 && d[0] < 100);
      })()
    `);
    if (JSON.parse(isGreen)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}
// Types `text` (real keydown/char/keyup per character, dispatched on the
// OUTER page — reaches the embedded field the same way BrowserCard.tsx's
// onCanvasKeyDown forwards it for a real user) at a realistic cadence, then
// measures how long the bottom-half canvas region (where #ta lives, see
// FIXTURE_HTML) takes to visually settle (stop changing) after the LAST
// keystroke — a proxy for "did every typed character actually paint
// promptly," not just "did the DOM value update" (already proven to work
// by smoke-browser.mjs regardless of focus/z-order).
async function typeSettleLatencyMs(page, text, cadenceMs = 60) {
  async function countNonWhiteBottomHalf() {
    return Number(
      await page.evalJs(`
        (() => {
          const canvas = document.querySelector('[data-role="browser-body"]');
          const ctx = canvas.getContext('2d');
          const w = canvas.width, h = canvas.height;
          const region = ctx.getImageData(0, Math.floor(h / 2), w, Math.floor(h / 2)).data;
          let n = 0;
          for (let i = 0; i < region.length; i += 4) {
            if (region[i] < 250 || region[i + 1] < 250 || region[i + 2] < 250) n++;
          }
          return n;
        })()
      `),
    );
  }
  const before = await countNonWhiteBottomHalf();
  const start = Date.now();
  for (const ch of text) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, text: ch });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}` });
    await new Promise((r) => setTimeout(r, cadenceMs));
  }
  const lastKeyAt = Date.now() - start;
  let last = -1;
  let stable = 0;
  let settleMs = null;
  for (let i = 0; i < 50; i++) {
    const n = await countNonWhiteBottomHalf();
    if (n === last && n > before) {
      stable++;
      if (stable >= 2) {
        settleMs = Date.now() - start;
        break;
      }
    } else {
      stable = 0;
    }
    last = n;
    await new Promise((r) => setTimeout(r, 40));
  }
  return { lastKeyAt, settleMs, grewAtAll: last > before };
}
async function moveMouseAway(page, canvasBox) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasBox.x - 100, y: canvasBox.y - 100, button: "none", pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 200));
}
async function rectOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.x, top: r.y, width: r.width, height: r.height });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}
async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

// #box fills the ENTIRE viewport on purpose — any point dispatched onto the
// canvas is guaranteed to land inside it, regardless of the embedded
// content's real pixel size (scaleFactor/supersample — see BrowserCard.tsx's
// toCanvasPoint doc comment) vs. the card's on-screen size.
// #box takes the top half of the viewport (hover target), #ta the bottom
// half (typing target) — kept apart so hovering the box never lands on the
// textarea and vice versa.
const FIXTURE_HTML = `
  <style>
    html, body { margin: 0; height: 100%; background: white; }
    #box { position: absolute; top: 0; left: 0; width: 100%; height: 50%; background: red; }
    #box:hover { background: lime; }
    #ta { position: absolute; top: 50%; left: 0; width: 100%; height: 50%; font-size: 80px; border: none; outline: none; margin: 0; }
  </style>
  <div id="box"></div>
  <textarea id="ta"></textarea>
`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Foco Real Nao Topmost Teste");
  await new Promise((r) => setTimeout(r, 500));

  // Liga modo autônomo (mesma sequência real de UI do smoke-mcp-autonomous-
  // mode.mjs) — feito ANTES de tocar no browser card, pra nenhum clique
  // deste trecho competir pelo foco do canvas depois.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[data-role="edit-session"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  const cancelCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === 'Cancelar');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(cancelCoords.x, cancelCoords.y);
  await new Promise((r) => setTimeout(r, 300));

  const seedCards = await toolJson("list_cards", {});
  const seedBashId = seedCards.cards.find((c) => c.kind === "terminal").id;
  const modeCheck = await toolJson("board_mode", { target: seedBashId });
  check("modo autônomo ligado de verdade (board_mode reflete)", modeCheck.autonomous, true);

  // Spawna o browser card via Rail (caminho humano real).
  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const cardsAfterBrowser = await toolJson("list_cards", {});
  const browserId = cardsAfterBrowser.cards.find((c) => c.kind === "browser").id;
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  // #box ocupa a metade de cima do canvas (alvo do hover), #ta a metade de
  // baixo (alvo da digitação) — ver FIXTURE_HTML.
  const canvasRect = await rectOf(page, '[data-role="browser-body"]');
  const hoverPoint = { x: canvasRect.left + canvasRect.width / 2, y: canvasRect.top + canvasRect.height * 0.25 };
  const typePoint = { x: canvasRect.left + canvasRect.width / 2, y: canvasRect.top + canvasRect.height * 0.75 };

  // Clique real na textarea embutida — foco real de DOM, e também topmost
  // (único card além do bash seedado, que não é kind:"browser" nem compete
  // por z-order visualmente aqui).
  await page.click(typePoint.x, typePoint.y);
  await new Promise((r) => setTimeout(r, 300));

  const hasDomFocusBefore = JSON.parse(
    await page.evalJs(`JSON.stringify(document.activeElement === document.querySelector('[data-role="browser-body"]'))`),
  );
  check("clique real no canvas dá foco de DOM de verdade", hasDomFocusBefore, true);

  // Controle/baseline: com o card topmost (estado atual), o :hover deve
  // repintar rápido — prova que o próprio mecanismo de medição funciona
  // antes de tirar qualquer conclusão do caso não-topmost abaixo.
  const baselineMs = await measureHoverLatencyMs(page, hoverPoint);
  console.log("hover repaint latency (topmost, baseline) =", baselineMs, "ms");
  check("controle: com o card TOPMOST, o :hover repinta rápido (<500ms)", baselineMs !== null && baselineMs < 500, true);
  await moveMouseAway(page, hoverPoint);

  // Spawna um SEGUNDO card só via MCP (spawn_agent, bash) — modo autônomo
  // já ligado, então isso NUNCA mostra modal nem exige nenhum clique na
  // página de topo. Isso é o "agente spawna um card enquanto o humano
  // ainda está mexendo em outro" do relato real.
  await callTool("spawn_agent", { provider: "bash", callerCardId: seedBashId, reason: "throttle repro" });
  await new Promise((r) => setTimeout(r, 500));

  const hasDomFocusAfter = JSON.parse(
    await page.evalJs(`JSON.stringify(document.activeElement === document.querySelector('[data-role="browser-body"]'))`),
  );
  check("...e o canvas do browser card AINDA tem foco real de DOM depois do spawn (nenhum clique aconteceu)", hasDomFocusAfter, true);

  // zIndex real (CSS inline, CardFrame.tsx) em vez de ordem no DOM — mais
  // confiável como fonte da verdade do que App.tsx realmente considera
  // "topmost" (zIndex === order.length - 1).
  const zIndexInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const frames = [...document.querySelectorAll('.card-frame')];
        const browserFrame = document.querySelector('[data-kind="browser"]').closest('.card-frame');
        const zIndices = frames.map((f) => Number(f.style.zIndex));
        const maxZ = Math.max(...zIndices);
        return JSON.stringify({ browserZ: Number(browserFrame.style.zIndex), maxZ, count: frames.length });
      })()
    `),
  );
  console.log("DEBUG zIndexInfo:", JSON.stringify(zIndexInfo));
  check("...e o browser card NÃO é mais o topmost (o card recém-spawnado é)", zIndexInfo.browserZ < zIndexInfo.maxZ, true);

  // Mede a latência de repintura de um :hover real — sem clicar de novo
  // (perderia o cenário: precisa continuar SEM ser topmost, só com foco).
  const becameGreenAtMs = await measureHoverLatencyMs(page, hoverPoint);
  console.log("hover repaint latency (focused-but-not-topmost) =", becameGreenAtMs, "ms");
  // A 60fps o :hover deve aparecer bem antes de ~300ms; a 8fps (bug antigo)
  // frequentemente nem aparece dentro da janela de poll, ou demora perto
  // do teto. Damos uma margem generosa (500ms) — o ponto não é medir fps
  // com precisão, é distinguir "está no rate rápido" de "travou no lento".
  check("com foco real (não-topmost), o :hover da página embutida repinta rápido (<500ms)", becameGreenAtMs !== null && becameGreenAtMs < 500, true);

  // Digita na textarea embutida (ainda focada, ainda não-topmost) e mede
  // quanto tempo a região leva pra parar de mudar depois da ÚLTIMA tecla —
  // 5 caracteres a 60ms de cadência real ~= última tecla + uns 40-80ms de
  // sobra pra pintar seria razoável a 60fps; muito mais que isso indica as
  // teclas visualmente "engasgando" atrás do rate baixo.
  const typing = await typeSettleLatencyMs(page, "abcde", 60);
  console.log("typing settle latency (focused-but-not-topmost) =", JSON.stringify(typing));
  check("...e digitar todos os 5 caracteres realmente pintou algo na tela", typing.grewAtAll, true);
  check(
    "...e o texto termina de assentar visualmente logo após a última tecla (<300ms depois)",
    typing.settleMs !== null && typing.settleMs - typing.lastKeyAt < 300,
    true,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
