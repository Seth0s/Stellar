// Header responsivo por breakpoint (§2.1, próxima rodada) — abaixo de
// ~380px de largura do PRÓPRIO card (CSS Container Query em
// `.browser-card-address`, não @media de viewport), o badge de origem e
// o badge de console saem da linha principal — mas nada fica
// inacessível: os dois viram itens informativos dentro do popover do
// kebab. Verifica ao vivo, sem mock: um card real com dono real e
// console real com erro, encolhido de verdade abaixo do breakpoint via
// drag de resize, confirma via getComputedStyle que os badges realmente
// desaparecem da linha principal E que a informação real ainda existe
// (agora dentro do popover do kebab).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = 9540;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-header-responsive", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
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
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0"><script>console.error('boom');</script></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Header Responsive Teste");
  await new Promise((r) => setTimeout(r, 500));

  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;
  const spawnPromise = callTool("spawn_card", {
    kind: "browser",
    url: `http://127.0.0.1:${port}/`,
    callerCardId: bashCardId,
    reason: "smoke test",
  });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const cardId = (JSON.parse((await spawnPromise).content[0].text)).cardId;
  await new Promise((r) => setTimeout(r, 800));

  const ownerVisibleBefore = await page.evalJs(`getComputedStyle(document.querySelector('.browser-card-owner')).display`);
  const consoleBadgeVisibleBefore = await page.evalJs(`getComputedStyle(document.querySelector('.browser-card-console-badge')).display`);
  check("na largura normal, badge de origem está visível na linha principal", ownerVisibleBefore !== "none", true);
  check("na largura normal, badge de console está visível na linha principal", consoleBadgeVisibleBefore !== "none", true);

  // Fecha o card terminal (seed da sessão) antes de encolher — o board
  // cascateia posições sobrepostas por padrão, e `tryChangeRect` (App.tsx)
  // rejeita um resize que colidiria com outro card; `ownerCardId` já foi
  // capturado (é só o id, não depende do card ainda existir), então
  // fechar o terminal não afeta o que este teste verifica.
  const terminalCloseBtn = await centerOf(page, ".card-frame.terminal-card .card-head-actions button:last-child");
  await page.click(terminalCloseBtn.x, terminalCloseBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  // Terminal com processo vivo pede confirmação antes de fechar de verdade.
  await clickModalButton(page, "Fechar");
  await new Promise((r) => setTimeout(r, 500));
  const cardCountAfterClose = await page.evalJs(`document.querySelectorAll('.card-frame').length`);
  check("card terminal fechado de verdade (sobra só o browser card)", cardCountAfterClose, 1);

  // Encolhe o card de verdade abaixo do breakpoint (380px) via drag real
  // da alça de resize — não um valor forçado direto no store.
  const cardRectBefore = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('.card-frame.browser-card').getBoundingClientRect())`));
  const handle = await centerOf(page, ".card-frame.browser-card .card-resize");
  const targetWidth = 300;
  const shrinkBy = cardRectBefore.width - targetWidth;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x - shrinkBy, y: handle.y, button: "left", pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 200));
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x - shrinkBy, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));

  const addressWidthAfter = await page.evalJs(`document.querySelector('.browser-card-address').getBoundingClientRect().width`);
  check(`card real encolhido abaixo do breakpoint de 380px (largura real: ${addressWidthAfter})`, addressWidthAfter < 380, true);

  const ownerVisibleAfter = await page.evalJs(`getComputedStyle(document.querySelector('.browser-card-owner')).display`);
  const consoleBadgeVisibleAfter = await page.evalJs(`getComputedStyle(document.querySelector('.browser-card-console-badge')).display`);
  check("abaixo do breakpoint, badge de origem some de verdade da linha principal (@container real)", ownerVisibleAfter, "none");
  check("abaixo do breakpoint, badge de console some de verdade da linha principal", consoleBadgeVisibleAfter, "none");

  // Nada fica inacessível — a mesma info real aparece dentro do popover do kebab.
  const kebab = await centerOf(page, '.browser-card-address button[title="Mais opções"]');
  await page.click(kebab.x, kebab.y);
  await new Promise((r) => setTimeout(r, 250));
  const menuText = await page.evalJs(`document.querySelector('.browser-card-menu')?.textContent ?? ""`);
  check(`popover do kebab mostra a info real de origem (#${bashCardId})`, menuText.includes(bashCardId), true);
  check("popover do kebab mostra a info real de erro de console", menuText.toLowerCase().includes("erro"), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
