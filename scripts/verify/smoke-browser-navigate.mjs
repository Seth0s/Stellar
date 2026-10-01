// `browser_navigate` (task 18df327e) — navegação IN-APP contra o app REAL.
//
// O relato do dono: no CIEE, abrir `/estudante/curriculo` por `open_url` fez a
// aplicação reescrever a URL para `/` e renderizar uma página de 78
// caracteres. `open_url` troca `location`, o que REMONTA a SPA, e o route guard
// corre num estado recém-nascido que não reconhece a sessão em memória.
//
// O que este smoke mede, contra páginas reais servidas por HTTP local:
//
//   1. um router que escuta `popstate` (a assinatura que o React Router v6 com
//      BrowserRouter instala) navega, a MESMA instância sobrevive (o carimbo de
//      nascimento da página não muda = nenhum remount) e a chegada é medida;
//   2. um router cujo render chega num MICROTASK depois do `popstate` também
//      chega — o caso em que `pushState` sozinho já teria "funcionado" e a tool
//      teria mentido se olhasse só a URL;
//   3. um router que escuta SÓ `hashchange` chega (é por isso que a rota por
//      hash dispara os dois eventos, como o browser real faz);
//   4. uma página que NÃO escuta `popstate` NÃO vira `ok:true`: a URL muda, a
//      tela não, e a resposta é `no-arrival-signal` nomeado;
//   5. um route guard que reescreve a URL de volta é `navigation-refused-by-app`
//      com a URL OBSERVADA — o incidente do CIEE reproduzido, medido;
//   6. uma resposta que virou navegação de DOCUMENTO é `document-reloaded`;
//   7. URL de outra origem e `expectSelector` inválido são recusados SEM tocar
//      na página (a URL fica onde estava — medido, não afirmado);
//   8. `acbridge browser-navigate` faz o mesmo pela outra porta.
//
// Todas as checagens olham o estado da PÁGINA depois, não o retorno da call.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-navigate-${CDP_PORT}`);
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;

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
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}
async function runAcbridge(sockPath, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [ACBRIDGE_BIN, ...args], {
      env: { ...process.env, AGENT_CANVAS_SOCK: sockPath, AGENT_CANVAS_CARD_ID: "0" },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, stderr: (err.stderr ?? "").trim() };
  }
}

// ---------------------------------------------------------------------------
// As fixtures. Cada "flavor" é servida em QUALQUER caminho sob o próprio
// prefixo (document load também funciona) e a SPA decide a view pelo
// `location.pathname` — como uma SPA de verdade.
//
// O detalhe que faz este smoke valer: `window.__spaBornAt` é carimbado UMA vez
// no load da página. Se ele mudar depois de uma navegação, a página foi
// REMONTADA — que é exatamente o defeito relatado, e é medido NA PÁGINA, não
// inferido do retorno da tool.
// ---------------------------------------------------------------------------
function fixturePage(flavor) {
  const register = {
    // React Router v6 (BrowserRouter) assina `popstate` na window e renderiza
    // no próprio handler. É o caso "síncrono".
    react: `window.addEventListener("popstate", render);`,
    // Um router cujo render chega num MICROTASK depois do evento (a navegação
    // do Angular resolve por promise; o Vue enfileira o render). Aqui
    // `pushState` já "funcionou" e a tela só muda depois — se a tool decidisse
    // chegada olhando só a URL, este caso passaria mentindo.
    async: `window.addEventListener("popstate", function () { Promise.resolve().then(render); });`,
    // Router por HASH: escuta `hashchange`, não `popstate`. Só chega porque a
    // navegação in-app dispara os DOIS eventos, como o browser real faz.
    hash: `window.addEventListener("hashchange", render);`,
    // Página que NÃO escuta nada: a URL muda e a tela fica. É o caso em que a
    // resposta honesta é `no-arrival-signal`.
    none: `/* nenhum listener: a URL vai mudar e a tela não */`,
    // Route guard que RECUSA a rota e devolve a URL para a raiz — o incidente
    // do CIEE, reproduzido.
    guard: `window.addEventListener("popstate", function () { render(); });`,
    // A "navegação in-app" virou navegação de DOCUMENTO.
    reload: `window.addEventListener("popstate", function () { location.assign(PREFIX + "?rota=" + encodeURIComponent(location.pathname)); });`,
  }[flavor];
  // O guard só aceita a RAIZ do próprio prefixo; as outras flavors aceitam
  // qualquer rota sob ele. A recusa é `replaceState` + render: a URL volta, a
  // tela volta, e é isso que a tool precisa saber NOMEAR.
  const accepts =
    flavor === "guard" ? `route === PREFIX` : `route === PREFIX || route.indexOf(PREFIX + "/") === 0`;
  const views = {
    "/react/curriculo": "curriculo carregado",
    "/async/curriculo": "curriculo carregado (async)",
    "/none/curriculo": "NUNCA DEVERIA APARECER",
    "/guard/curriculo": "NUNCA DEVERIA APARECER",
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture ${flavor}</title></head>
<body style="margin:0">
  <div id="view">vazio</div>
  <div id="route">?</div>
  <div id="slot"></div>
  <script>
    var PREFIX = ${JSON.stringify("/" + flavor)};
    window.__spaBornAt = Date.now();
    window.__spaRenders = 0;
    function render() {
      var route = location.pathname;
      if (!(${accepts})) {
        history.replaceState(null, "", PREFIX + location.hash);
        route = location.pathname;
      }
      var views = ${JSON.stringify(views)};
      var view = views[route];
      // O sinal FORTE de chegada é um elemento que só EXISTE na view nova.
      // (Ligar/desligar display não serviria: querySelector acha elemento
      // invisível, e aí o sinal forte provaria nada.)
      var nova = route === "/react/curriculo" || route === "/async/curriculo";
      document.getElementById("slot").innerHTML = nova ? "<div id='esperado'>marcador</div>" : "";
      document.getElementById("view").textContent =
        (view || ("home de " + PREFIX)) + " | renders=" + window.__spaRenders;
      document.getElementById("route").textContent = route + location.hash;
      window.__spaRenders += 1;
    }
    ${register}
    render();
  </script>
</body></html>`;
}

const FLAVORS = ["react", "async", "hash", "none", "guard", "reload"];
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const flavor = FLAVORS.find((f) => path === `/${f}` || path.startsWith(`/${f}/`));
  if (!flavor) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("no fixture here");
    return;
  }
  // charset explícito: sem ele o Chromium decodifica UTF-8 como latin-1.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fixturePage(flavor));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

// Segunda origem REAL (outra porta = outra origem): é contra ela que a recusa
// cross-origin é medida, sem depender de rede externa nenhuma.
const otherServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><div id='view'>outro site</div></body></html>");
});
await new Promise((r) => otherServer.listen(0, "127.0.0.1", r));
const OTHER = `http://127.0.0.1:${otherServer.address().port}`;

/** Espera o seletor existir de verdade (o app leva um tempo variável para
 * montar o board e o popover; um `querySelector` cedo demais devolve null e o
 * smoke parece quebrado no produto). */
async function waitForSelector(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found === true) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`selector ${selector} never appeared within ${timeoutMs}ms`);
}

/** Cria o card de navegador pelo caminho que NÃO se traduz (`data-kind`),
 * igual ao smoke-browser-mcp-control.mjs — o título do rail é localizado e já
 * quebrou a suíte com o card em `about:blank`. */
async function createBrowserCard(page, url) {
  await waitForSelector(page, '[data-role="rail-add-card"]');
  const railBtn = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-role="rail-add-card"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(railBtn.x, railBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  await waitForSelector(page, '.popover-row[data-kind="browser"]');
  const browserRow = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('.popover-row[data-kind="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(browserRow.x, browserRow.y);
  await waitForSelector(page, '[data-role="browser-address"] input');
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))`,
    ),
  );
  const cardId = browserCards[browserCards.length - 1];
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  const deadline = Date.now() + 10000;
  let loaded = false;
  while (Date.now() < deadline) {
    const probe = await toolJson("browser_eval", { target: cardId, js: "!!document.getElementById('view')" });
    if (String(probe.result) === "true") {
      loaded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!loaded) throw new Error(`the browser card never loaded the fixture at ${url} — measuring now would measure an empty page`);
  await new Promise((r) => setTimeout(r, 400));
  return cardId;
}

/** Estado REAL da página, lido dela: rota, view e o carimbo de nascimento (o
 * que prova que NÃO houve remount). */
async function pageState(cardId) {
  const res = await toolJson("browser_eval", {
    target: cardId,
    js: `({ href: String(location.href), route: document.getElementById('route') ? document.getElementById('route').textContent : null, view: document.getElementById('view') ? document.getElementById('view').textContent : null, bornAt: window.__spaBornAt === undefined ? null : window.__spaBornAt, renders: window.__spaRenders === undefined ? null : window.__spaRenders })`,
  });
  return JSON.parse(String(res.result));
}

/** Carrega uma fixture por NAVEGAÇÃO DE DOCUMENTO (o mesmo mecanismo do
 * `open_url`). É setup, não medição — e serve de CONTROLE NEGATIVO: este é o
 * caminho que remonta a SPA, então o carimbo de nascimento TEM de mudar aqui.
 * Sem esse controle, todo "não remontou" do resto do smoke passaria por
 * vacuidade (um carimbo que nunca muda não prova nada). */
async function loadFixture(cardId, url) {
  await documentNavigate(cardId, url);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const probe = await toolJson("browser_eval", { target: cardId, js: "!!document.getElementById('view')" });
    if (String(probe.result) === "true") {
      await new Promise((r) => setTimeout(r, 300));
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`fixture ${url} never loaded`);
}

// `window.browser.navigate` é o MESMO caminho que a barra de endereços usa
// (document load), chamado pelo renderer via CDP — sem passar por MCP, porque
// ele é SETUP: o que este smoke mede é o que acontece DENTRO da página depois.
let documentNavigate = null;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  documentNavigate = (cardId, url) =>
    page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Navigate Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const cardId = await createBrowserCard(page, `${BASE}/react`);
  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;
  const nav = (args) => toolJson("browser_navigate", { target: cardId, ...args });

  // ---- 1. o caso que o relato pede: um router que escuta `popstate` -------
  const antes1 = await pageState(cardId);
  const res1 = await nav({ url: "/react/curriculo", expectSelector: "#esperado" });
  const depois1 = await pageState(cardId);
  check("browser_navigate navega numa SPA que escuta popstate", res1.ok, true);
  check("...nomeando o sinal que provou a chegada", res1.arrival, "expect-selector");
  check("...e o sinal forte realmente casou", res1.signal?.selectorFound, true);
  check("...carregando a URL pedida de verdade", new URL(depois1.href).pathname, "/react/curriculo");
  check("...com a VIEW da rota nova na tela", /curriculo carregado/.test(depois1.view ?? ""), true);
  check("...SEM remontar a SPA (carimbo de nascimento intacto)", depois1.bornAt, antes1.bornAt);
  check("...e com evidência de quanto esperou (probes/waitedMs)", res1.probes >= 1 && res1.waitedMs >= 0, true);

  // ---- 2. CONTROLE NEGATIVO: o detector de remount detecta remount --------
  await loadFixture(cardId, `${BASE}/async`);
  const antes2 = await pageState(cardId);
  check(
    "controle negativo: navegação de DOCUMENTO remonta a SPA (o carimbo muda)",
    antes2.bornAt !== antes1.bornAt,
    true,
  );

  // ---- 3. render num MICROTASK depois do popstate (o caso do Angular) ----
  const res3 = await nav({ url: "/async/curriculo", expectSelector: "#esperado", timeoutMs: 2000 });
  const depois3 = await pageState(cardId);
  check("router que renderiza num microtask depois do popstate também chega", res3.ok, true);
  check("...e a chegada é medida, não presumida", res3.arrival, "expect-selector");
  check("...com a view nova na tela", /curriculo carregado/.test(depois3.view ?? ""), true);
  check("...na MESMA instância da SPA", depois3.bornAt, antes2.bornAt);

  // ---- 4. router por HASH: escuta `hashchange`, não `popstate` -----------
  await loadFixture(cardId, `${BASE}/hash`);
  const antes4 = await pageState(cardId);
  const res4 = await nav({ url: "/hash#/rota-b", timeoutMs: 2000 });
  const depois4 = await pageState(cardId);
  check("router por hash (só escuta hashchange) chega", res4.ok, true);
  check("...com o hash na URL real", new URL(depois4.href).hash, "#/rota-b");
  check("...e a página REAGIU (o render do hashchange rodou)", depois4.renders > antes4.renders, true);
  check("...sem remontar", depois4.bornAt, antes4.bornAt);

  // ---- 5. página que NÃO escuta popstate: a URL mente, a tela não ---------
  await loadFixture(cardId, `${BASE}/none`);
  const antes5 = await pageState(cardId);
  const res5 = await nav({ url: "/none/curriculo", timeoutMs: 1500 });
  const depois5 = await pageState(cardId);
  check("página sem listener de popstate NÃO vira ok:true", res5.ok, false);
  check("...e é recusada por NOME", res5.code, "no-arrival-signal");
  check("...dizendo o que fazer (clicar no menu)", /browser_click/.test(res5.error ?? ""), true);
  check("...e a URL TEM de ter mudado (o pushState funcionou)", new URL(depois5.href).pathname, "/none/curriculo");
  check("...enquanto a TELA continua na view antiga", depois5.view, antes5.view);
  check("...sem remontar (a página nunca reagiu a nada)", depois5.bornAt, antes5.bornAt);

  // ---- 6. o route guard do relato: a aplicação REESCREVE a URL -----------
  await loadFixture(cardId, `${BASE}/guard`);
  const antes6 = await pageState(cardId);
  const res6 = await nav({ url: "/guard/curriculo", timeoutMs: 1500 });
  const depois6 = await pageState(cardId);
  check("route guard que devolve a URL para a raiz é recusado nomeadamente", res6.ok, false);
  check("...com o código do incidente", res6.code, "navigation-refused-by-app");
  check("...e a URL OBSERVADA no corpo da resposta", new URL(res6.observedUrl ?? "http://x/").pathname, "/guard");
  check("...apontando o caminho que funciona (clicar no menu)", /browser_click/.test(res6.error ?? ""), true);
  check("...e a página está mesmo na raiz", new URL(depois6.href).pathname, "/guard");
  check("...sem remontar (o guard rejeitou, não recarregou)", depois6.bornAt, antes6.bornAt);

  // ---- 7. virou navegação de DOCUMENTO: a promessa de in-app não vale ----
  await loadFixture(cardId, `${BASE}/reload`);
  const antes7 = await pageState(cardId);
  const res7 = await nav({ url: "/reload/curriculo", timeoutMs: 3000 });
  const depois7 = await pageState(cardId);
  check("resposta que virou document load é recusada como tal", res7.ok, false);
  check("...com o código certo", res7.code, "document-reloaded");
  check("...e a página FOI mesmo remontada (carimbo novo)", depois7.bornAt !== antes7.bornAt, true);

  // ---- 8. recusas ANTES de tocar na página -------------------------------
  await loadFixture(cardId, `${BASE}/react`);
  const antes8 = await pageState(cardId);
  const resOutroSite = await nav({ url: `${OTHER}/estudante/curriculo` });
  const depois8 = await pageState(cardId);
  check("URL de OUTRA origem é recusada", resOutroSite.ok, false);
  check("...nomeando open_url (trocar de site é troca de documento)", /open_url/.test(resOutroSite.error ?? ""), true);
  check("...e a origem no código da recusa", resOutroSite.code, "cross-origin");
  check("...sem ter navegado NADA (a URL do card não mudou)", depois8.href, antes8.href);

  const resSeletorRuim = await nav({ url: "/react/inicio", expectSelector: "???" });
  const depois8b = await pageState(cardId);
  check("expectSelector inválido é recusado antes de navegar", resSeletorRuim.code, "invalid-expect-selector");
  check("...sem ter navegado NADA (a URL do card não mudou)", depois8b.href, antes8.href);

  // ---- 9. já estar na rota: nada é afirmado ------------------------------
  const resJa = await nav({ url: "/react" });
  check("rota já carregada responde já-estava-lá", resJa.alreadyThere, true);
  check("...sem afirmar navegação nenhuma", resJa.navigated, false);

  // ---- 10. a outra porta: acbridge browser-navigate -----------------------
  const cli = await runAcbridge(sockPath, ["browser-navigate", cardId, "/react/curriculo", "--expect", "#esperado"]);
  check("acbridge browser-navigate roda e responde", cli.ok, true);
  let cliPayload = null;
  try {
    cliPayload = JSON.parse(cli.stdout);
  } catch {
    cliPayload = null;
  }
  check("...com o veredito medido em JSON (não um 'navigated' seco)", cliPayload?.arrival, "expect-selector");
  const depoisCli = await pageState(cardId);
  check("...e a página está na rota pedida", new URL(depoisCli.href).pathname, "/react/curriculo");

  // ---- 11. o veredito do smoke não é o veredito da tool ------------------
  // O que o smoke afirma sobre "a tela mudou" sai da PÁGINA (pageState), não do
  // `ok` da tool — é o que impede este arquivo de virar eco do produto.
  check(
    "a view lida da página bate com o que a tool afirmou",
    /curriculo carregado/.test(depoisCli.view ?? "") && cliPayload?.ok === true,
    true,
  );
} finally {
  await stopApp(app);
  server.close();
  otherServer.close();
}

finish();
