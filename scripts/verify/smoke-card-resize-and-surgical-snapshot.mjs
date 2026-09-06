// Dois pedidos ao vivo (2026-09-01), no mesmo relato:
//
//  1. "eu gostaria que o snapshot fosse cirúrgico e fizesse apenas do card
//     e nada mais, o sistema de coordenada não deixa isso possível?" — o
//     `snapshot(target)` fotografava a JANELA DO APP recortada onde o card
//     está no board, então pegava o fundo do canvas nos cantos, pegava card
//     sobreposto, e truncava (ou não devolvia nada) se o card estivesse
//     fora da área visível. Dá pra ser cirúrgico, sim, mas por OUTRO
//     caminho: um card de navegador tem uma BrowserWindow offscreen
//     própria, que é uma superfície separada do board inteiro.
//
//  2. "gostaria de poder redimensionar o card por qualquer lado do card" —
//     existia um punho só, no canto inferior-direito.
//
// A prova do item 1 é a INDEPENDÊNCIA: a captura de um card fora da área
// visível é byte a byte igual à do mesmo card na tela. Pelo caminho antigo
// isso era impossível por construção — o que não está na janela nunca foi
// rasterizado.
//
// Atualizado 2026-09-02 (pedido explícito do usuário: "o navegador não
// precisa ser afetado pelo efeito do zoom") — a captura AGORA também
// independe do zoom do board, não só da posição: `browser-registry.ts`
// dimensiona a janela offscreen em `tamanho do card × scaleFactor` (ver
// smoke-browser-zoom-resolution.mjs), sem o zoom que antes multiplicava
// junto. Zoom do board não muda mais a resolução da captura; só o
// `scaleFactor` real do monitor e o tamanho de mundo do card mudam.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-resize-snapshot-${CDP_PORT}`);

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  const rpc = JSON.parse(line);
  if (rpc.error) throw new Error(JSON.stringify(rpc.error));
  return rpc.result;
}
async function snapshotPng(target) {
  const result = await callTool("snapshot", { target });
  const image = result.content.find((c) => c.type === "image");
  if (!image) throw new Error(`snapshot sem imagem: ${JSON.stringify(result).slice(0, 300)}`);
  return Buffer.from(image.data, "base64");
}
/** Dimensões de um PNG: os dois inteiros do chunk IHDR. Evita puxar uma
 * lib de imagem só pra ler oito bytes. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Com fallback pro popover "Adicionar card": os botões de criar card não
 * ficam soltos no rail. */
async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`,
    ),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const title = selector.match(/title=["']([^"']+)["']/)?.[1];
    const addBtn = JSON.parse(
      await page.evalJs(
        `(() => { const b = document.querySelector('.rail-btn[title="Adicionar card"]'); if (!b) return JSON.stringify(null); const r = b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`,
      ),
    );
    if (addBtn && title) {
      await page.click(addBtn.x, addBtn.y);
      await new Promise((r) => setTimeout(r, 500));
      res = JSON.parse(
        await page.evalJs(
          `(() => { const el = document.querySelector('.popover-row[title=' + JSON.stringify(${JSON.stringify(title)}) + ']'); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`,
        ),
      );
    }
  }
  return res;
}
async function cardRect(page) {
  return JSON.parse(
    await page.evalJs(
      `(() => { const r = document.querySelector('[data-kind="browser"]').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`,
    ),
  );
}
/** Mede o rect VIVO no DOM, não o do SQLite. `onCommit` persiste com um
 * `void window.store.upsert(...)` — sem await —, então ler o store logo
 * depois de um arraste devolve o valor ANTERIOR de forma intermitente. Isso
 * já produziu aqui um falso negativo convincente: o redimensionamento pelo
 * topo aparecia como "não mudou nada" enquanto o card, no DOM, tinha
 * mudado exatamente o esperado. Em zoom 1 o delta de tela é igual ao delta
 * de mundo, que é o que estas checagens comparam. */
async function cardRectLive(page) {
  return cardRect(page);
}
async function drag(page, from, to) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 350));
}
/** Pan em passos que CABEM no viewport: `Input.dispatchMouseEvent` com
 * coordenada fora dele é um no-op silencioso (achado já documentado em
 * smoke-card-actions.mjs), então um único arraste gigante simplesmente não
 * acontece. Parte do canto inferior-direito, longe de onde este teste
 * deixa o card — arrastar de cima de um card moveria o CARD, não o board. */
async function panBoard(page, dx, dy) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 300));
  for (let i = 0; i < steps; i++) {
    // (1200, 400) fica à DIREITA do card e dentro do viewport (1280x800 —
    // medido, não suposto: o ponto anterior, y=860, estava fora e todo o
    // gesto virava no-op silencioso). Puxando pra esquerda, esse ponto
    // continua sendo fundo a cada passo, porque o card só se afasta dele.
    await drag(page, { x: 1200, y: 400 }, { x: 1200 + dx / steps, y: 400 + dy / steps });
  }
  await new Promise((r) => setTimeout(r, 400));
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body style="margin:0;background:#0a3">
    <h1 style="color:#fff">pagina do card</h1>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Resize e snapshot", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // Card criado pelo rail, o caminho real. Nada de escrever no store e dar
  // reload: a app SEMPRE inicia na Home, então um reload voltaria pra lá e
  // desmontaria o card — e sem card montado não existe janela offscreen.
  // Achado ao vivo (2026-09-02) — `centerOf` tenta só UMA vez (direto +
  // fallback pro popover), sem retry; numa máquina sob carga o rail podia
  // não estar montado ainda nos 500ms fixos acima, derrubando o script
  // inteiro com `browserBtn === null` em vez de um FAIL legível. Uma
  // primeira versão deste fix chamava `centerOf` de novo num loop — bug
  // achado ao vivo escrevendo ISSO: `centerOf` CLICA em "Adicionar card"
  // (um toggle) toda vez que cai no fallback, então retentar a função
  // inteira reabre/fecha o popover a cada tentativa, quase garantindo
  // pegar ele fechado. Abre o popover UMA vez só; poll só pela LINHA
  // dentro dele, sem re-clicar em nada.
  let browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  if (!browserBtn) {
    const addBtn = await centerOf(page, '.rail-btn[title="Adicionar card"]');
    if (!addBtn) throw new Error("nem o rail nem o botão 'Adicionar card' apareceram");
    await page.click(addBtn.x, addBtn.y);
    for (let i = 0; i < 20 && !browserBtn; i++) {
      browserBtn = JSON.parse(
        await page.evalJs(
          `(() => { const el = document.querySelector('.popover-row[title="Novo navegador"]'); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`,
        ),
      );
      if (!browserBtn) await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!browserBtn) throw new Error("botão 'Novo navegador' (direto ou via popover) nunca apareceu");
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));
  await page.evalJs(`
    (() => {
      const inputs = document.querySelectorAll('[data-role="browser-address"] input');
      const inp = inputs[inputs.length - 1];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(`http://127.0.0.1:${port}/`)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.focus();
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 2500));

  const cardId = JSON.parse(
    await page.evalJs(`
      window.store.boards
        .list()
        .then((b) => window.store.list(b[0].id))
        .then((cards) => JSON.stringify(cards.filter((c) => c.kind === "browser").map((c) => c.id).pop() ?? null))
    `),
  );
  check("card de navegador criado pelo rail", typeof cardId === "string" && cardId.length > 0, true);

  // ---------------- 1. redimensionar por qualquer lado ----------------
  // Antes do teste de pan, enquanto o card está garantidamente na tela.
  const screen = await cardRectLive(page);
  const before = screen;
  check(`o card está inteiro na tela pra dar pra pegar as bordas (${JSON.stringify(screen)})`, screen.x > 4 && screen.y > 4, true);

  // Borda ESQUERDA pra dentro. O par de checagens é o que prova a
  // reancoragem: só olhar a largura não distinguiria isto de um resize
  // pela direita — o que tem que ficar PARADO é a borda oposta.
  await drag(page, { x: screen.x + 1, y: screen.y + screen.h / 2 }, { x: screen.x + 81, y: screen.y + screen.h / 2 });
  const afterWest = await cardRectLive(page);
  check(`borda esquerda encolhe a largura (${before.w} -> ${afterWest.w})`, Math.abs(afterWest.w - (before.w - 80)) <= 6, true);
  check(
    `...movendo a origem junto, com a borda direita parada (x ${before.x} -> ${afterWest.x})`,
    Math.abs(afterWest.x + afterWest.w - (before.x + before.w)) <= 6,
    true,
  );

  // Borda SUPERIOR — mesma lógica no outro eixo.
  const screen2 = await cardRect(page);
  await drag(page, { x: screen2.x + screen2.w / 2, y: screen2.y + 1 }, { x: screen2.x + screen2.w / 2, y: screen2.y + 61 });
  const afterNorth = await cardRectLive(page);
  check(`borda superior encolhe a altura (${afterWest.h} -> ${afterNorth.h})`, Math.abs(afterNorth.h - (afterWest.h - 60)) <= 6, true);
  check(
    `...com a borda inferior parada (y ${afterWest.y} -> ${afterNorth.y})`,
    Math.abs(afterNorth.y + afterNorth.h - (afterWest.y + afterWest.h)) <= 6,
    true,
  );

  // O canto inferior-direito é o comportamento que já existia — não pode
  // ter regredido ao virar mais uma das oito zonas.
  const screen3 = await cardRect(page);
  await drag(
    page,
    { x: screen3.x + screen3.w - 3, y: screen3.y + screen3.h - 3 },
    { x: screen3.x + screen3.w + 57, y: screen3.y + screen3.h + 47 },
  );
  const afterSe = await cardRectLive(page);
  check(
    `o canto inferior-direito continua funcionando (${afterNorth.w}x${afterNorth.h} -> ${afterSe.w}x${afterSe.h})`,
    Math.abs(afterSe.w - (afterNorth.w + 60)) <= 6 && Math.abs(afterSe.h - (afterNorth.h + 50)) <= 6,
    true,
  );
  check("...sem mover a origem", afterSe.x === afterNorth.x && afterSe.y === afterNorth.y, true);

  // ---------------- 2. snapshot cirúrgico ----------------
  await new Promise((r) => setTimeout(r, 1500));
  const onScreen = await snapshotPng(cardId);
  const onScreenSize = pngSize(onScreen);
  check("snapshot de card de navegador volta uma imagem real", onScreenSize.width > 0 && onScreenSize.height > 0, true);

  await panBoard(page, -1500, -1100);
  const wentOff = JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector('[data-kind="browser"]'); if (!el) return JSON.stringify(true); const r = el.getBoundingClientRect(); return JSON.stringify(r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight); })()`,
    ),
  );
  check("o card saiu mesmo da área visível (pré-condição do que vem a seguir)", wentOff, true);

  const offScreen = await snapshotPng(cardId);
  const offScreenSize = pngSize(offScreen);
  check(
    `a captura de um card FORA da tela tem o mesmo tamanho (${onScreenSize.width}x${onScreenSize.height})`,
    offScreenSize.width === onScreenSize.width && offScreenSize.height === onScreenSize.height,
    true,
  );
  // A afirmação forte: byte a byte igual. A página é estática, então
  // qualquer coisa vinda da tela (fundo do board, recorte, canto
  // arredondado) apareceria como diferença.
  check("...e é byte a byte a mesma imagem — a captura não vem mais da tela", offScreen.equals(onScreen), true);
} finally {
  finish();
  await stopApp(app);
  server.close();
}
