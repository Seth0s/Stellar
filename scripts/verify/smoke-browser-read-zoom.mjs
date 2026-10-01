// TASK b3237a17, item 1 — ZOOM DE LEITURA no card de navegador.
//
// O zoom do board é ÓPTICO e desacoplado da resolução do navegador (decisão do
// usuário, com smoke próprio: smoke-browser-zoom-resolution.mjs). Faltava um
// jeito de LER uma página num card pequeno. Este smoke prova as três coisas
// que o fix promete:
//   (a) o conteúdo FICA MAIOR (o rect de um elemento cresce ~25%);
//   (b) a resolução offscreen NÃO muda (`debugBridge.browserContentSize`
//       idêntico antes/depois) — o invariante do outro smoke continua válido,
//       porque o zoom de leitura NÃO entra no `resize()`;
//   (c) o clique continua caindo no alvo certo (a página é re-layoutizada pelo
//       Chromium, mas as coordenadas do `sendInputEvent` seguem corretas).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-read-zoom-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>readzoom</title><style>
  body{margin:0;font-family:sans-serif}
  #box{width:200px;height:100px;background:#f80}
  #btn{position:absolute;top:200px;left:20px;width:160px;height:48px}
</style></head><body>
  <div id="box"></div>
  <button id="btn" onclick="document.title='readzoom-clicked'">Salvar</button>
</body></html>`;

const server = createServer((_req, res) => {
  const body = Buffer.from(HTML, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Read Zoom", { spawnTerminal: false });
  await delay(500);

  const centerOf = (sel) =>
    page.evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);

  // Cria o card de navegador pelo rail.
  const add = await centerOf('[data-role="rail-add-card"]');
  await page.click(add.x, add.y);
  await delay(250);
  const browserOpt = await centerOf('.popover-row[data-kind="browser"]');
  await page.click(browserOpt.x, browserOpt.y);
  await delay(900);

  const boardId = await page.evalJs(`window.store.boards.list().then((b) => b[0].id)`);
  const cards = await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((c) => c.filter((x) => x.kind === "browser").map((x) => x.id))`);
  const cardId = cards[cards.length - 1];
  check("browser card real criado", typeof cardId === "string", true);

  const pageEval = async (js) => {
    const res = await page.evalJs(`window.browser.evalJs(${JSON.stringify(cardId)}, ${JSON.stringify(js)})`);
    if (!res?.ok) return null;
    try {
      return JSON.parse(res.result);
    } catch {
      return res.result;
    }
  };

  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  await delay(1200);

  const readState = async () => ({
    zoom: (await pageEval(`document.documentElement.style.getPropertyValue("zoom") || "1"`)) ?? "?",
    boxWidth: await pageEval(`document.getElementById("box").getBoundingClientRect().width`),
    content: await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`),
  });

  const before = await readState();
  check(`estado inicial sem zoom de leitura (zoom="${before.zoom}", box=${before.boxWidth}px)`, before.zoom, "1");

  // Abre o menu do kebab e clica o controle de zoom de leitura — por DOM (o
  // card pode ter nascido fora da viewport, e coordenadas de tela não
  // acertariam nada). O controle é o do MENU: o atalho Ctrl+`=`/`-` foi
  // descartado porque o main o intercepta antes do renderer (medido).
  const opened = await page.evalJs(`
    (() => { const b = document.querySelector('[data-role="browser-more-btn"]'); if (!b) return false; b.click(); return true; })()
  `);
  check("menu do card (kebab) aberto", opened, true);
  await delay(300);
  const clickedZoom = await page.evalJs(`
    (() => { const b = document.querySelector('[data-role="browser-read-zoom-in"]'); if (!b) return false; b.click(); return true; })()
  `);
  check("controle de 'zoom de leitura +' clicado", clickedZoom, true);
  await delay(600);

  const after = await readState();
  const dbgLabel = await page.evalJs(`document.querySelector('[data-role="browser-read-zoom-in"]')?.textContent ?? ""`);
  const dbgRaw = await pageEval(`document.documentElement.style.getPropertyValue("zoom")`);
  // Sonda: `browser.evalJs` embrulha a fonte num `await` — UMA expressão só.
  const probe = await page.evalJs(
    `window.browser.evalJs(${JSON.stringify(cardId)}, '(() => { document.documentElement.style.setProperty("zoom","1.3"); return document.documentElement.style.getPropertyValue("zoom"); })()')`,
  );
  console.log("[probe] direct evalJs:", JSON.stringify(probe));
  console.log(`[read-zoom] zoom "${before.zoom}"->"${after.zoom}"; box ${before.boxWidth}->${after.boxWidth}px; content ${JSON.stringify(before.content)} -> ${JSON.stringify(after.content)}`);
  console.log(`[read-zoom debug] botao="${dbgLabel}" rawStyleZoom=${JSON.stringify(dbgRaw)}`);

  check(`o zoom de leitura foi aplicado na PÁGINA (style.zoom="${after.zoom}")`, after.zoom, "1.25");
  check(
    `o conteúdo ficou MAIOR (box ${before.boxWidth} -> ${after.boxWidth}px, ~+25%)`,
    typeof after.boxWidth === "number" && after.boxWidth > before.boxWidth * 1.15,
    true,
  );
  check(
    "a resolução offscreen NÃO mudou (sem reflow — invariante do zoom desacoplado)",
    JSON.stringify(after.content),
    JSON.stringify(before.content),
  );

  // O clique ainda cai no alvo (a página re-layoutizada não quebra o mapeamento).
  const btn = await pageEval(`(() => { const r = document.getElementById("btn").getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  const contentW = after.content?.w ?? null;
  const innerW = await pageEval(`window.innerWidth`);
  const dip = contentW && innerW ? contentW / innerW : 1;
  await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseMove", x: ${Math.round(btn.x * dip)}, y: ${Math.round(btn.y * dip)} })`);
  await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseDown", x: ${Math.round(btn.x * dip)}, y: ${Math.round(btn.y * dip)}, button: "left", clickCount: 1 })`);
  await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseUp", x: ${Math.round(btn.x * dip)}, y: ${Math.round(btn.y * dip)}, button: "left", clickCount: 1 })`);
  await delay(400);
  const title = await pageEval(`document.title`);
  check(`com o zoom de leitura ativo, o clique ainda acerta o alvo (título: ${JSON.stringify(title)})`, title, "readzoom-clicked");

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
