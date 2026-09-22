// `browser_click` devolvia `{ok, x, y}` e NADA sobre em que tinha clicado.
//
// Achado ao vivo (relato do dono, incidente P0 num formulário de vestibular
// que avisa "as respostas não poderão ser editadas depois"): três chamadas
// com seletores DIFERENTES devolveram as MESMAS coordenadas (x:1322.99
// y:852 — o centro da viewport, que é onde `scrollIntoView({block:"center"})`
// põe o alvo) e a resposta não permitia perceber em que elemento o clique
// caiu. Ficaram marcadas perguntas que ele nunca mirou.
//
// Este smoke NÃO testa frase: testa EFEITO na página. Cada cenário é um dos
// modos de falha medidos ANTES do conserto, todos com a tool respondendo
// `ok: true`: alvo coberto por overlay (o clique acertava o overlay);
// `scroll-behavior: smooth` (o rect era lido antes do scroll andar e o clique
// caía em `html`, 3000px acima do alvo); ponto fora da viewport
// (`elementFromPoint` não devolvia nada e o clique seguia); `selector:
// "button"` casando N elementos (clicava o primeiro sem dizer qual); e a
// coordenada devolvida por uma chamada REUSADA depois de um reflow, que
// acertava outra pergunta — o cenário real do dono, reproduzido de forma
// determinística na página /reflow.
//
// Nasceu VERMELHO contra o build anterior ao conserto (evidência no relatório
// da task 050f8866): é esse vermelho que prova que ele mede comportamento.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
// `os.tmpdir()`, não `.verify-tmp/` sob a árvore: o caminho do socket unix do
// message-bus (`<userData>/agent-canvas.sock`) estoura `sun_path` quando a
// árvore é um worktree profundo — medido, o app sobe e o acbridge some sem
// erro visível.
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-click-truth-${CDP_PORT}`);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
/** `browser_eval` devolve `JSON.stringify(raw)` — uma string ela mesma
 * stringificada quando o resultado é string (`location.pathname` chega como
 * `"\"/flow\""`). Desfaz até duas camadas; é o que transforma "o que a
 * página respondeu" em valor de verdade em vez de um palpite. */
function parseEval(raw) {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}
// fixtures do smoke de browser_click (ver o cabeçalho em s1)
const CLICK_LOG = `
  window.__clicks = [];
  document.addEventListener('click', (e) => {
    const t = e.target;
    const named = (t && t.closest && t.closest('[data-alvo]')) || t;
    window.__clicks.push({
      alvo: named && named.getAttribute && named.getAttribute('data-alvo'),
      id: (t && t.id) || null,
      tag: t && t.tagName,
      isTrusted: e.isTrusted,
      x: e.clientX,
      y: e.clientY,
    });
  }, true);
`;

function radioRowsPage(count) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;font:14px monospace}
    label.row{display:block;height:80px;width:1400px;border:1px solid #ccc;box-sizing:border-box}
  </style></head><body>
  <div id="rows"></div>
  <script>
    ${CLICK_LOG}
    for (let i = 1; i <= ${count}; i++) {
      const lab = document.createElement('label');
      lab.className = 'row';
      lab.setAttribute('data-alvo', 'q' + i);
      const inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'q' + i; inp.setAttribute('data-alvo', 'q' + i);
      const span = document.createElement('span');
      span.textContent = 'pergunta ' + i;
      lab.appendChild(inp); lab.appendChild(span);
      document.getElementById('rows').appendChild(lab);
    }
  </script></body></html>`;
}

const PAGES = {
  "/flow": `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;font:14px monospace}
    .box{position:absolute;width:160px;height:60px}
  </style></head><body>
  <button class="box" id="b2" style="left:600px;top:20px">B2</button>
  <button class="box" id="b4" style="left:600px;top:300px">B4</button>
  <script>${CLICK_LOG}</script></body></html>`,
  // 40 linhas × 80px = 3200px de documento numa viewport de ~850: qualquer
  // alvo mais fundo é CENTRADO pelo scrollIntoView, e o centro da viewport é
  // o mesmo para todos eles — a origem das coordenadas idênticas do relato.
  "/rows": radioRowsPage(80),
  "/multi": `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <button id="salvar">Salvar</button>
  <button id="sair">Sair da conta</button>
  <script>${CLICK_LOG}</script></body></html>`,
  "/cover": `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    #under{position:absolute;left:40px;top:40px;width:200px;height:80px}
    #over{position:absolute;left:0;top:0;width:100%;height:300px;background:rgba(0,0,0,0.05);border-bottom:2px solid #333}
  </style></head><body>
  <button id="under">alvo coberto</button>
  <div id="over"></div>
  <script>${CLICK_LOG}</script></body></html>`,
  "/smooth": `<!doctype html><html><head><meta charset="utf-8"><style>
    html{scroll-behavior:smooth} html,body{margin:0;padding:0;font:14px monospace}
    #spacer{height:3000px}
  </style></head><body>
  <button id="decoy">decoy</button>
  <div id="spacer">spacer</div>
  <button id="deep">alvo fundo da pagina</button>
  <script>${CLICK_LOG}</script></body></html>`,
  // O reflow determinístico do cenário real: marcar QUALQUER pergunta faz o
  // aviso de validação aparecer ACIMA da lista, empurrando as linhas 160px
  // para baixo. A coordenada devolvida na chamada anterior passa a apontar
  // para outra pergunta.
  "/reflow": `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;font:14px monospace}
    label.row{display:block;height:80px;width:1400px;border:1px solid #ccc;box-sizing:border-box}
    #banner{height:0;overflow:hidden;background:#fee}
    /* overflow-anchor:none DE PROPÓSITO: sem isso o scroll anchoring do
       Chromium compensa o crescimento do aviso e mantém a pergunta sob a
       coordenada antiga — medido ao vivo, a reprodução virava falso verde. */
    html,body,#rows,#banner{overflow-anchor:none}
  </style></head><body>
  <div id="banner">corrija suas respostas</div>
  <div id="rows"></div>
  <script>
    ${CLICK_LOG}
    document.addEventListener('change', () => { document.getElementById('banner').style.height = '160px'; });
    for (let i = 1; i <= 12; i++) {
      const lab = document.createElement('label');
      lab.className = 'row';
      lab.setAttribute('data-alvo', 'q' + i);
      const inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'q' + i; inp.setAttribute('data-alvo', 'q' + i);
      const span = document.createElement('span');
      span.textContent = 'pergunta ' + i;
      lab.appendChild(inp); lab.appendChild(span);
      document.getElementById('rows').appendChild(lab);
    }
  </script></body></html>`,
  // Guarda de diálogo nativo (browser-native-dialog-decision.ts): clicar este
  // botão abriria o seletor de arquivo do SO e levaria o card junto.
  "/upload": `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <button id="up">Enviar arquivo</button>
  <input type="file" id="file" style="display:none">
  <script>${CLICK_LOG}</script></body></html>`,
};

const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGES[path] ?? PAGES["/flow"]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Click factual", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // O card de navegador entra pela UI (rail → Adicionar card → navegador):
  // `open_url` é a outra porta e exige consentimento humano.
  const railBtn = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-role="rail-add-card"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(railBtn.x, railBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const browserRow = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('.popover-row[data-kind="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(browserRow.x, browserRow.y);
  await new Promise((r) => setTimeout(r, 1000));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardIds = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))`,
    ),
  );
  const cardId = cardIds[cardIds.length - 1];
  check("card de navegador real criado", typeof cardId === "string" && cardId.length > 0, true);

  /** Navegação por `window.browser.navigate` — a MESMA chamada que a barra de
   * endereços do card faz depois de parsear o texto; usar a barra aqui só
   * acrescentaria foco/teclado ao que este smoke quer medir. */
  async function navigate(path) {
    await page.evalJs(
      `window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}${path}`)})`,
    );
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const here = await toolJson("browser_eval", { target: cardId, js: "location.pathname" });
      if (parseEval(here.result) === path) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // O listener de cliques da fixture é instalado no parse do documento;
    // zerar a lista aqui evita medir o que ficou do cenário anterior.
    await toolJson("browser_eval", { target: cardId, js: "window.__clicks = []; 'ready'" });
  }

  async function clicks() {
    const r = await toolJson("browser_eval", { target: cardId, js: "JSON.stringify(window.__clicks)" });
    const value = parseEval(r.result);
    return Array.isArray(value) ? value : [];
  }
  async function radiosChecked() {
    const r = await toolJson("browser_eval", {
      target: cardId,
      js: "JSON.stringify([...document.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.getAttribute('data-alvo')))",
    });
    const value = parseEval(r.result);
    return Array.isArray(value) ? value : [];
  }

  // --- 1. o caminho normal continua funcionando, e agora NOMEIA o alvo ------
  await navigate("/flow");
  const stable = await toolJson("browser_click", { target: cardId, selector: "#b2" });
  await new Promise((r) => setTimeout(r, 200));
  check("clique por seletor: ok", stable.ok, true);
  check("...marcado como clicado", stable.clicked, true);
  check("...e a resposta DIZ em que clicou (id)", stable.target?.id, "b2");
  check("...sem aviso quando o seletor casa um só", stable.warning, null);
  check("...e o clique chegou MESMO no botão", (await clicks())[0]?.id, "b2");
  // --- 1b. o caminho por `ref` (browser_snapshot → clique) continua igual ---
  // Era o que funcionava "de primeira" no relato (o alvo que o humano lê na
  // tela); a reescrita do caminho de clique não pode tê-lo perdido.
  const snap = await toolJson("browser_snapshot", { target: cardId });
  const refB4 = snap.elements.find((el) => el.name === "B4");
  check("snapshot do card devolve o botão B4 com ref", typeof refB4?.ref, "string");
  const byRef = await toolJson("browser_click", { target: cardId, ref: refB4?.ref });
  await new Promise((r) => setTimeout(r, 250));
  check("clique por ref: ok", byRef.ok, true);
  check("...e nomeia o alvo", byRef.target?.id, "b4");


  // --- 2. coordenada idêntica não é identidade ------------------------------
  // Dois alvos distintos, ambos centrados pelo scroll: as coordenadas são as
  // mesmas (era isso que confundia o dono) e a resposta agora distingue os
  // dois pelo NOME.
  await navigate("/rows");
  const q20 = await toolJson("browser_click", { target: cardId, selector: 'label[data-alvo="q20"]' });
  const q60 = await toolJson("browser_click", { target: cardId, selector: 'label[data-alvo="q60"]' });
  await new Promise((r) => setTimeout(r, 250));
  console.log(`coordenadas devolvidas: q20=(${q20.x}, ${q20.y}) q60=(${q60.x}, ${q60.y})`);
  check(
    "dois alvos distintos devolvem a MESMA coordenada (centro da viewport)",
    Math.abs(q20.x - q60.x) <= 0.5 && Math.abs(q20.y - q60.y) <= 0.5,
    true,
  );
  check("...mas a resposta os distingue pelo alvo nomeado", q20.target?.text !== q60.target?.text, true);
  check("...nomeando o primeiro como 'pergunta 20'", q20.target?.text, "pergunta 20");
  check("...nomeando o segundo como 'pergunta 60'", q60.target?.text, "pergunta 60");
  const rowsClicks = await clicks();
  // Um clique humano num `<label>` gera DOIS eventos (o do label e o
  // sintetizado no `<input>` de dentro), então a asserção é sobre o conjunto
  // de perguntas atingidas, não sobre a contagem de eventos.
  check("...e cada clique acertou a PRÓPRIA pergunta", [...new Set(rowsClicks.map((c) => c.alvo))].join(","), "q20,q60");
  check("...sem marcar nenhuma outra", (await radiosChecked()).join(","), "q20,q60");

  // --- 3. seletor que casa N elementos: clica o primeiro e AVISA -----------
  await navigate("/multi");
  const multi = await toolJson("browser_click", { target: cardId, selector: "button" });
  await new Promise((r) => setTimeout(r, 200));
  check("seletor 'button' casando 2: ok", multi.ok, true);
  check("...a resposta diz qual dos dois foi clicado", multi.target?.id, "salvar");
  check("...e diz quantos casaram", multi.matched, 2);
  check("...com aviso explícito de multi-match", /matched 2 elements/.test(multi.warning ?? ""), true);

  // --- 4. alvo coberto por overlay: recusa NOMEANDO os dois ----------------
  await navigate("/cover");
  const covered = await toolJson("browser_click", { target: cardId, selector: "#under" });
  await new Promise((r) => setTimeout(r, 200));
  check("alvo coberto: NÃO é sucesso", covered.ok, false);
  check("...marcado como não clicado", covered.clicked, false);
  check("...a recusa nomeia o alvo pretendido", /#under/.test(covered.error ?? ""), true);
  check("...e nomeia quem está por cima", /#over/.test(covered.error ?? ""), true);
  check("...e NADA foi clicado na página", (await clicks()).length, 0);

  // --- 5. `scroll-behavior: smooth`: o clique cai no alvo, não na posição
  // velha ------------------------------------------------------------------
  await navigate("/smooth");
  const deep = await toolJson("browser_click", { target: cardId, selector: "#deep" });
  await new Promise((r) => setTimeout(r, 400));
  check("alvo 3000px abaixo com scroll suave: ok", deep.ok, true);
  check("...nomeia o alvo", deep.target?.id, "deep");
  check("...e o clique acertou o #deep de verdade", (await clicks()).map((c) => c.id).join(","), "deep");


  // --- 6. ponto fora da viewport: recusa, nunca `ok: true` ------------------
  await navigate("/flow");
  const outside = await toolJson("browser_click", { target: cardId, x: 200, y: 9000 });
  await new Promise((r) => setTimeout(r, 200));
  check("ponto 9000px abaixo da viewport: NÃO é sucesso", outside.ok, false);
  check("...marcado como não clicado", outside.clicked, false);
  check(
    "...e a recusa explica que o ponto está fora da viewport",
    /outside the page's viewport/.test(outside.error ?? ""),
    true,
  );

  // --- 7. o cenário do dono: coordenada reusada depois de um reflow --------
  await navigate("/reflow");
  const first = await toolJson("browser_click", { target: cardId, selector: 'label[data-alvo="q6"]' });
  await new Promise((r) => setTimeout(r, 250));
  check("pergunta 6 por seletor: ok", first.ok, true);
  check("...e nomeada na resposta", first.target?.text, "pergunta 6");
  // O que está sob a coordenada devolvida AGORA, medido na própria página —
  // o aviso de validação empurrou a lista 160px para baixo.
  const hitRaw = await toolJson("browser_eval", {
    target: cardId,
    js: `(() => {
      const el = document.elementFromPoint(${first.x}, ${first.y});
      const row = el && el.closest ? el.closest('[data-alvo]') : null;
      return JSON.stringify(row ? row.getAttribute('data-alvo') : (el ? el.tagName : null));
    })()`,
  });
  const hit = parseEval(hitRaw.result);
  check("o reflow pôs OUTRA pergunta sob a coordenada devolvida", hit !== "q6" && hit !== null, true);
  const reuse = await toolJson("browser_click", { target: cardId, x: first.x, y: first.y });
  await new Promise((r) => setTimeout(r, 250));
  check("reusar a coordenada: a resposta diz em que clicou", typeof reuse.target?.text, "string");
  check("...nomeando o que está ali DE FATO", reuse.target?.text, `pergunta ${String(hit).replace("q", "")}`);

  // --- 8. recusas antigas continuam com as MESMAS frases -------------------
  const noMatch = await toolJson("browser_click", { target: cardId, selector: "#nao-existe-mesmo" });
  check("seletor válido sem correspondência mantém a frase de antes", /no element matches/.test(noMatch.error ?? ""), true);
  const badSelector = await toolJson("browser_click", { target: cardId, selector: "button:has-text('x')" });
  check("seletor inválido continua explicando que é CSS puro", /Playwright/.test(badSelector.error ?? ""), true);

  // --- 9. guarda de diálogo nativo sobreviveu ao reescrito -----------------
  await navigate("/upload");
  const upload = await toolJson("browser_click", { target: cardId, selector: "#up" });
  await new Promise((r) => setTimeout(r, 200));
  check("botão que abriria o seletor de arquivo do SO: recusado", upload.ok, false);
  check("...pela mesma razão de antes", /native file chooser/.test(upload.error ?? ""), true);
  check("...sem clicar nada", (await clicks()).length, 0);

  finish();
} finally {
  await stopApp(app);
  server.close();
}
