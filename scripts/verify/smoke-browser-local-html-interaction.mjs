// TASK 29d8d5a1 — "CARD DE NAVEGADOR NÃO REAGE A HTML (animação CSS,
// utf8/acentuação, click/scroll)". Este smoke MEDE os quatro, ao vivo, sem
// mock, contra uma fixture HTTP local — servida como o app exige (ver
// `browser-registry.ts`'s `normalizeUrl`: `file://` é RECUSADO por design;
// HTML local tem de vir por `http://`).
//
// O que ele prova, e como:
//   (1) ACENTUAÇÃO — `Content-Type: text/html; charset=utf-8` entrega o texto
//       certo; o MESMO corpo servido SEM charset é decodificado como latin-1
//       pelo Chromium e chega MOJIBAKE. (É a "limitação de plataforma" do
//       item 3 da task: o caminho certo é servir por http + charset.)
//   (2) ANIMAÇÃO CSS — o `<div>` com `@keyframes` move de verdade: duas
//       leituras do `getBoundingClientRect().x` com intervalo real diferem.
//   (3) CLICK — um mouse real (`window.browser.sendMouse`) no botão muda o
//       `document.title` da página.
//   (4) SCROLL — um wheel real (`window.browser.sendWheel`) move o `scrollY`.
//
// O clique/scroll daqui entram pelo caminho do REGISTRY (o mesmo que as tools
// MCP usam), não pelo mapeamento tela→conteúdo do `BrowserCard.tsx` — este
// smoke mede "a página reage ao input?", que é o que a task pede; o mapeamento
// do canvas tem smoke próprio (smoke-browser-click-zoom-precision.mjs).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-local-html-${CDP_PORT}`, import.meta.url).pathname;

const ACCENT = "Ação, coração, ção, ã, é, ü";
const HTML = `<!doctype html><html><head><title>local</title>
<style>
  body { margin: 0; height: 3000px; font-family: sans-serif; }
  #anim { position: absolute; top: 200px; left: 0; width: 40px; height: 40px; background: #c00;
          animation: slide 1.2s linear infinite alternate; }
  @keyframes slide { from { left: 0px; } to { left: 240px; } }
  #btn { position: absolute; top: 40px; left: 20px; width: 140px; height: 44px; }
</style></head>
<body>
  <div id="accent">${ACCENT}</div>
  <button id="btn" onclick="document.title='clicked-target'">Salvar</button>
  <div id="anim"></div>
</body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const body = Buffer.from(HTML, "utf8");
  if (path === "/utf8") {
    // O caminho CERTO: sem `charset=utf-8` o Chromium cai em latin-1.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html", "Content-Length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Local HTML Interaction", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const centerOf = (sel) =>
    page.evalJs(`
      (() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()
    `);
  const addBtn = await centerOf('[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf('.popover-row[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  const boardId = await page.evalJs(`window.store.boards.list().then((b) => b[0].id)`);
  const cards = await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((c) => c.filter((x) => x.kind === 'browser').map((x) => x.id))`);
  const cardId = cards[cards.length - 1];
  check("browser card real criado", typeof cardId === "string", true);

  // `window.browser.evalJs` devolve `{ok, result}` onde `result` é o valor já
  // SERIALIZADO em JSON — desembrulha e devolve o valor tipado.
  const pageEval = async (js) => {
    const res = await page.evalJs(`window.browser.evalJs(${JSON.stringify(cardId)}, ${JSON.stringify(js)})`);
    if (!res?.ok) return null;
    try {
      return JSON.parse(res.result);
    } catch {
      return res.result;
    }
  };

  async function navigate(url) {
    await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
    await new Promise((r) => setTimeout(r, 1200));
  }

  // ---------- (1a) acentuação CORRETA com charset=utf-8 ----------
  await navigate(`${base}/utf8`);
  const textUtf8 = await pageEval(`document.body.innerText`);
  check(`charset=utf-8 entrega o acento certo (lido: ${JSON.stringify((textUtf8 ?? "").slice(0, 40))})`, typeof textUtf8 === "string" && textUtf8.includes(ACCENT), true);

  // ---------- (2) animação CSS rodando ----------
  const x1 = await pageEval(`document.getElementById('anim').getBoundingClientRect().x`);
  await new Promise((r) => setTimeout(r, 350));
  const x2 = await pageEval(`document.getElementById('anim').getBoundingClientRect().x`);
  check(`animação CSS move de verdade (x: ${x1} → ${x2})`, typeof x1 === "number" && typeof x2 === "number" && x1 !== x2, true);

  // ---------- (3) click real reage ----------
  const scale = await pageEval(`(() => window.innerWidth)`);
  const contentW = (await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`))?.w ?? null;
  const btnCss = await pageEval(`(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  const dip = contentW && scale ? contentW / scale : 1;
  if (btnCss) {
    await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseMove", x: ${Math.round(btnCss.x * dip)}, y: ${Math.round(btnCss.y * dip)} })`);
    await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseDown", x: ${Math.round(btnCss.x * dip)}, y: ${Math.round(btnCss.y * dip)}, button: "left", clickCount: 1 })`);
    await page.evalJs(`window.browser.sendMouse(${JSON.stringify(cardId)}, { type: "mouseUp", x: ${Math.round(btnCss.x * dip)}, y: ${Math.round(btnCss.y * dip)}, button: "left", clickCount: 1 })`);
    await new Promise((r) => setTimeout(r, 400));
  }
  const title = await pageEval(`document.title`);
  check(`click real no botão muda o título da página (título: ${JSON.stringify(title)}, dip=${dip})`, title, "clicked-target");

  // ---------- (4) scroll real reage ----------
  const before = await pageEval(`window.scrollY`);
  await page.evalJs(`window.browser.sendWheel(${JSON.stringify(cardId)}, { x: 400, y: 300, deltaX: 0, deltaY: -400 })`);
  await new Promise((r) => setTimeout(r, 400));
  const after = await pageEval(`window.scrollY`);
  check(`wheel real move o scroll (scrollY: ${before} → ${after})`, typeof before === "number" && typeof after === "number" && after > before, true);

  // ---------- (1b) o CONTRASTE: mesmo corpo SEM charset ----------
  await navigate(`${base}/nocharset`);
  const textNoCharset = await pageEval(`document.body.innerText`);
  const broken = typeof textNoCharset === "string" && !textNoCharset.includes(ACCENT);
  console.log(`=== SEM charset → ${JSON.stringify((textNoCharset ?? "").slice(0, 40))} (quebrado=${broken}) ===`);
  // Não falha o run se o Chromium desta máquina farejar UTF-8: o que importa é
  // que o caminho COM charset foi medido correto acima. Registrado como fato.
  console.log(broken ? "MEDIDO: sem charset o acento QUEBRA (latin-1) — confirma a exigência http + charset=utf-8." : "MEDIDO: neste ambiente o Chromium farejou UTF-8 mesmo sem charset — a exigência continua sendo o caminho garantido.");

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
