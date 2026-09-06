// Pendentes #188 — cobertura pro redesenho do mini-inspector como coluna
// dockável (protótipo HTML aprovado pelo usuário, 2026-09-06) e pro
// "Design Mode" (seleção de elemento pra enviar a um agente, item aberto
// na mesma sticky). smoke-browser-inspector.mjs já cobre Elements/
// Console/Responsivo — este arquivo cobre o que ficou faltando: dock/
// resize, Application (local/session storage + cookies reais), Network
// (session.webRequest real) e Design Mode (evalJs picker + window.pty.write).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-dock-${CDP_PORT}`, import.meta.url).pathname;

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
async function toolJson(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0">
  <h1 id="title">Fixture do dock</h1>
  <button id="btn" class="pick-me">clique aqui</button>
  <script>
    localStorage.setItem("stellar_k", "stellar_v");
    document.cookie = "stellar_c=stellar_cv; path=/";
    fetch("/api/ping").catch(() => {});
  </script>
</body></html>`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  if (req.url === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
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
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Inspector Dock Teste", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 500));

  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const cardIds = JSON.parse(
    await page.evalJs(
      `window.store.boards.list().then((b) => window.store.list(b[0].id)).then((cards) => JSON.stringify({ browser: cards.find((c) => c.kind === 'browser').id, terminal: cards.find((c) => c.kind === 'terminal').id }))`,
    ),
  );
  const browserId = cardIds.browser;
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 800));

  // --- abre o inspector e testa dock/resize ---
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
  await new Promise((r) => setTimeout(r, 400));

  const dockRight = await page.evalJs(`document.querySelector('[data-role="browser-inspector"]')?.getAttribute('data-dock')`);
  check("inspector abre ancorado à direita por padrão", dockRight, "right");

  const dockLeftBtn = await centerOf(page, '[data-role="inspector-dock-buttons"] button[title="Ancorar à esquerda"]');
  await page.click(dockLeftBtn.x, dockLeftBtn.y);
  await new Promise((r) => setTimeout(r, 250));
  const dockAfterLeft = await page.evalJs(`document.querySelector('[data-role="browser-inspector"]')?.getAttribute('data-dock')`);
  check("botão de dock à esquerda funciona de verdade (data-dock muda)", dockAfterLeft, "left");

  const inspRectBeforeResize = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelector('[data-role="browser-inspector"]').getBoundingClientRect())`),
  );
  const handle = await centerOf(page, '[data-role="inspector-resize-handle"]');
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 80, y: handle.y, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 80, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 250));
  const inspRectAfterResize = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelector('[data-role="browser-inspector"]').getBoundingClientRect())`),
  );
  check(
    "arrastar a alça de resize muda de verdade a largura do painel (dock esquerda, arrastar pra direita cresce)",
    inspRectAfterResize.width > inspRectBeforeResize.width,
    true,
  );

  const dockRightBtn = await centerOf(page, '[data-role="inspector-dock-buttons"] button[title="Ancorar à direita"]');
  await page.click(dockRightBtn.x, dockRightBtn.y);
  await new Promise((r) => setTimeout(r, 250));

  // --- Network ---
  const networkTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="network"]');
  await page.click(networkTab.x, networkTab.y);
  await new Promise((r) => setTimeout(r, 500));
  const networkRows = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-network-row"]')].map((r) => r.textContent))`),
  );
  check(
    "aba Network mostra a requisição real (session.webRequest, sem CDP) que a página disparou",
    networkRows.some((r) => r.includes("api/ping") && r.includes("200")),
    true,
  );

  // --- Application ---
  const appTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="application"]');
  await page.click(appTab.x, appTab.y);
  await new Promise((r) => setTimeout(r, 500));
  const localRows = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-storage-item"][data-area="local"]')].map((r) => r.textContent))`),
  );
  check("aba Application mostra 1 item de localStorage real", localRows.some((r) => r.includes("1")), true);

  const cookieItem = await centerOf(page, '[data-role="inspector-storage-item"][data-area="cookies"]');
  await page.click(cookieItem.x, cookieItem.y);
  await new Promise((r) => setTimeout(r, 400));
  const cookieRows = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-storage-table"] tbody tr td')].map((td) => td.textContent))`),
  );
  check(
    "cookies vêm de session.cookies.get de verdade (main process, não document.cookie da página)",
    cookieRows.some((t) => t.includes("stellar_c")) && cookieRows.some((t) => t.includes("stellar_cv")),
    true,
  );

  // --- fecha o inspector antes do Design Mode (evita competir por clique no canvas) ---
  const closeBtn = await centerOf(page, '[data-role="browser-inspector"] button[title="Fechar inspector"]');
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  // --- Design Mode ---
  const designBtn = await centerOf(page, '[data-role="browser-design-mode-btn"]');
  await page.click(designBtn.x, designBtn.y);
  await new Promise((r) => setTimeout(r, 250));
  const designActive = await page.evalJs(`document.querySelector('[data-role="browser-design-mode-btn"]')?.hasAttribute('data-active')`);
  check("botão de modo design liga de verdade (data-active)", designActive, true);

  // `window.browser.evalJs` já faz o JSON.stringify sozinho do que o script
  // devolve (browser-registry.ts) — devolver o objeto CRU aqui, não uma
  // string já stringificada (senão vira um double-encode e `.x`/`.y` saem
  // `undefined` do JSON.parse de fora).
  const btnPoint = JSON.parse(
    await page.evalJs(`
      window.browser.evalJs(${JSON.stringify(browserId)}, "(() => { const r = document.querySelector('#btn').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()")
        .then((r) => r.result)
    `),
  );
  await page.evalJs(`
    window.browser.sendMouse(${JSON.stringify(browserId)}, { type: "mouseMove", x: ${btnPoint.x}, y: ${btnPoint.y} });
    window.browser.sendMouse(${JSON.stringify(browserId)}, { type: "mouseDown", x: ${btnPoint.x}, y: ${btnPoint.y}, button: "left", clickCount: 1 });
    window.browser.sendMouse(${JSON.stringify(browserId)}, { type: "mouseUp", x: ${btnPoint.x}, y: ${btnPoint.y}, button: "left", clickCount: 1 });
    "ok"
  `);
  // Poll — o pick chega via `setInterval` de 200ms no lado do renderer
  // (BrowserCard.tsx), não instantâneo.
  let pickCardText = "";
  for (let i = 0; i < 10; i++) {
    pickCardText = await page.evalJs(`document.querySelector('[data-role="browser-design-card"]')?.textContent ?? ""`);
    if (pickCardText.includes("pick-me")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check(
    "clicar num elemento real da página (com o modo ativo) abre o popover de escolha com o elemento certo",
    pickCardText.includes("pick-me"),
    true,
  );

  const sendBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-design-card"] button')].find((x) => x.textContent.includes('Card') || x.querySelector('svg'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("popover lista pelo menos um terminal real do board pra enviar", sendBtn !== null, true);
  if (sendBtn) {
    await page.click(sendBtn.x, sendBtn.y);
    await new Promise((r) => setTimeout(r, 300));
    const popoverClosed = await page.evalJs(`!document.querySelector('[data-role="browser-design-card"]')`);
    check("enviar fecha o popover de escolha", popoverClosed, true);

    // O terminal desta prova renderiza via canvas (xterm.js) — a saída
    // real nunca aparece como texto no DOM (confirmado ao vivo: nem um
    // `window.pty.write` manual de controle apareceu no `textContent` do
    // card), e o objeto `window.pty` exposto por `contextBridge` vem
    // congelado — reatribuir `.write` pra espionar falha em silêncio (não
    // lança, só não faz nada). `read_card` (mesmo primitivo do
    // `smoke-mcp-read-card.mjs`) lê o buffer de verdade via IPC pro
    // processo main — é a única forma real de verificar a entrega.
    let readResult = { text: "" };
    for (let i = 0; i < 8; i++) {
      readResult = await toolJson("read_card", { target: cardIds.terminal });
      if (readResult.ok && readResult.text.includes("pick-me")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check(
      "o texto do elemento escolhido chegou de verdade no terminal (window.pty.write, mesmo primitivo do send_to_card)",
      readResult.ok && readResult.text.includes("pick-me"),
      true,
    );
  }

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
