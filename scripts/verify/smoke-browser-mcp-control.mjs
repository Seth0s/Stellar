// DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa" —
// verifies the 5 new browser_* MCP tools (mcp-server.ts) and their
// acbridge CLI equivalents (resources/bin/acbridge) both drive a REAL
// already-open browser card and produce a REAL, observable effect on
// its page — never asserting just "the call didn't throw". Follows
// smoke-mcp-connectors.mjs's dual-surface pattern (runAcbridge +
// mcpCall/callTool/toolJson) so both frontends this app supports get
// genuine end-to-end coverage, not just the MCP one.
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
// os.tmpdir(), not a .verify-tmp/ dir under this worktree — confirmed live
// that AF_UNIX's sockaddr_un.sun_path has a real, small max length, and
// this worktree's own path is already long enough
// (.claude/worktrees/<branch>/) that ANY .verify-tmp/<name>/agent-canvas.sock
// under it overflows it: message-bus.ts's socket bind failed with EINVAL
// regardless of how short the leaf dirname was — not an app bug, silently
// disables acbridge for the whole run (message-bus.ts's own `server.on
// ("error", ...)` catches it so the app itself doesn't crash — but every
// acbridge call then fails with ENOENT). smoke-mcp-connectors.mjs's own
// acbridge check happened to still read as PASS through this: it only
// asserts `.ok === false` for a rejected-by-validation call, which an
// ENOENT connection failure also satisfies — a real, separate weak-
// assertion gap in that file, not proof acbridge was actually reachable.
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-mcp-control-${CDP_PORT}`);
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;

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

// Fixture: a real button that mutates its own text on click, a real
// input, a real scrollable container, and a static readback element —
// enough surface for all 5 tools to prove a genuine page-state change.
const server = createServer((req, res) => {
  // Endpoint que sempre falha — é ele que reproduz o cenário relatado
  // ("o botão de salvar não faz nada porque a API deu 500"): a página não
  // mostra NADA quando ele falha, de propósito, e é justamente esse o caso
  // que browser_network tem que conseguir explicar.
  if (req.url === "/api/salvar") {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(`{"error":"boom"}`);
    return;
  }
  // charset explícito: sem ele o Chromium decodifica os bytes UTF-8 como
  // latin-1 e "Título" chega como "TÃ­tulo" — o que fez uma checagem de
  // nome acessível falhar por motivo que não tinha nada a ver com ela.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body style="margin:0">
    <button id="btn" onclick="document.getElementById('btn').textContent='clicked'">click me</button>
    <input id="inp" type="text" />
    <div id="scrollbox" style="height:100px;overflow:auto;">
      <div style="height:2000px;">tall content</div>
    </div>
    <div id="info">ready</div>

    <!-- Superfície pros achados de 2026-09-01. O botão de salvar imita o
         defeito silencioso: dispara um fetch que dá 500, engole o erro e
         não muda nada na tela. Um "aria-label" num botão de ícone e um
         "label" associado ao input existem pra provar que o snapshot lê o
         nome que o HUMANO vê, não o innerText cru. -->
    <button id="save" onclick="fetch('/api/salvar',{method:'POST'}).then(r=>r.json()).catch(()=>{})">Adicionar nota</button>
    <button id="icone" aria-label="Fechar painel">&times;</button>
    <label for="titulo">Título da nota</label>
    <input id="titulo" type="text" />
    <button id="boom" onclick="console.error('falha-de-proposito')">gerar erro</button>
    <button id="tarde" onclick="setTimeout(()=>{document.getElementById('atrasado').textContent='pronto'},800)">demorar</button>
    <div id="atrasado"></div>
    <span hidden id="escondido">invisivel</span>

    <!-- Superfície do nome acessível: dois spans ESCONDIDOS referenciados por
         aria-labelledby (o nome tem de sair do texto deles, não do innerText
         renderizado) e um texto com espaços múltiplos, que o nome tem de
         colapsar. -->
    <span hidden id="first">Primeiro</span>
    <span hidden id="second">Segundo</span>
    <button id="multilabel" aria-labelledby="first second"></button>
    <button id="espacos">multiple   spaces  here</button>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved most card
  // creation behind an "Adicionar card" popover — same fallback as
  // smoke-browser-unfocused-throttle.mjs.
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('[data-role="rail-add-card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

/** Espera o seletor existir de verdade (o app leva um tempo variavel para
 * montar o board e o popover; um `querySelector` cedo demais devolve null e
 * o smoke parece quebrado no produto). */
async function waitForSelector(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found === true) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`selector ${selector} never appeared within ${timeoutMs}ms`);
}

async function createBrowserCard(page, url) {
  // O rail era achado pelo TITULO (`.rail-btn[title="Novo navegador"]`), que
  // e LOCALIZADO: em locale en o titulo e "Web Browser", o clique caia fora,
  // o card ficava em `about:blank` e o smoke inteiro media uma pagina vazia —
  // 20 falhas que nao tinham nada a ver com o produto (medido em 2026-09-22,
  // e o mesmo defeito ja documentado em cdp-client.mjs para
  // `.provider-picker-btn[title=...]`). O card entra pelo que NAO se traduz:
  // o botao do rail e a linha do popover por `data-kind`.
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
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))
    `),
  );
  const cardId = browserCards[browserCards.length - 1];

  // Navegação pela MESMA chamada que a barra de endereços faz depois de
  // parsear o texto (`window.browser.navigate`) — digitar na barra e mandar
  // Enter era o outro trecho que media a página errada: medido em 2026-09-22,
  // o card ficava em `about:blank` e o smoke media o vazio (o Enter sintético
  // depende de foco/tecla que o card offscreen não recebe de forma confiável).
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  // A prova de que a fixture carregou é medida NA PÁGINA do card (um botão que
  // só existe na fixture), não no `url` do store — este último não é campo em
  // que se possa confiar para "o documento carregou".
  const deadline = Date.now() + 10000;
  let loaded = false;
  while (Date.now() < deadline) {
    const probe = await toolJson("browser_eval", { target: cardId, js: "!!document.getElementById('btn')" });
    // `browser_eval` devolve `JSON.stringify(raw)`: um booleano chega como a
    // STRING "true", não como `true` (a mesma armadilha documentada no smoke
    // do clique). Comparar com `=== true` dava falso negativo — o guarda
    // dizia que a fixture não carregou com a página já carregada.
    if (probe.result === true || String(probe.result) === "true") {
      loaded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!loaded) throw new Error(`the browser card never loaded the fixture at ${url} — measuring now would measure an empty page`);
  await new Promise((r) => setTimeout(r, 600));
  return cardId;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser MCP Control Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const cardId = await createBrowserCard(page, `http://127.0.0.1:${port}/`);
  check("browser card real criado e navegado pra fixture", typeof cardId === "string" && cardId.length > 0, true);

  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;

  // browser_click via MCP — clica o botão de verdade, estado da página muda.
  const clickRes = await toolJson("browser_click", { target: cardId, selector: "#btn" });
  check("browser_click (MCP) reporta sucesso", clickRes.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  const btnTextAfterClick = await toolJson("browser_query", { target: cardId, selector: "#btn" });
  check("browser_click (MCP) realmente clicou — texto do botão mudou pra 'clicked'", btnTextAfterClick.text, "clicked");

  // browser_type via MCP — preenche um campo de verdade.
  const typeRes = await toolJson("browser_type", { target: cardId, selector: "#inp", text: "hello mcp" });
  check("browser_type (MCP) reporta sucesso", typeRes.ok, true);
  const inpQuery = await toolJson("browser_query", { target: cardId, selector: "#inp" });
  check("browser_type (MCP) realmente preencheu o campo", inpQuery.value, "hello mcp");

  // browser_scroll via MCP — rola de verdade um container aninhado (scrollTop muda).
  const scrollBefore = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('scrollbox').scrollTop" });
  const scrollRes = await toolJson("browser_scroll", { target: cardId, dy: 300, selector: "#scrollbox" });
  check("browser_scroll (MCP) reporta sucesso", scrollRes.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  const scrollAfter = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('scrollbox').scrollTop" });
  check(
    `browser_scroll (MCP) realmente rolou o container (scrollTop ${scrollBefore.result} -> ${scrollAfter.result})`,
    Number(scrollAfter.result) > Number(scrollBefore.result),
    true,
  );

  // browser_query via MCP — texto/rect reais de um elemento estático.
  const infoQuery = await toolJson("browser_query", { target: cardId, selector: "#info" });
  check("browser_query (MCP) reporta texto real", infoQuery.text, "ready");
  check("browser_query (MCP) reporta rect real com largura/altura positivas", infoQuery.rect?.width > 0 && infoQuery.rect?.height > 0, true);

  // browser_eval via MCP — roda JS de verdade e retorna o valor certo.
  // Achado ao vivo (2026-09-01, relato de um agente): um seletor estilo
  // Playwright falhava com "Script failed to execute, this normally means
  // an error was thrown" — a frase genérica do Electron pra qualquer
  // exceção dentro do executeJavaScript. Sem saber que o motor aqui é o
  // `querySelector` da própria página, o agente adivinhou e caiu pra
  // browser_eval com busca manual por textContent.
  const badSelector = await toolJson("browser_click", { target: cardId, selector: "button:has-text('ready')" });
  check("um seletor inválido é recusado como tal", badSelector.ok, false);
  check("...dizendo que é CSS puro e nomeando o que não é suportado", /Playwright/.test(badSelector.error ?? "") && /has-text/.test(badSelector.error ?? ""), true);
  check("...sem a frase genérica do Electron", /Script failed to execute/.test(badSelector.error ?? ""), false);

  // A distinção que faltava: seletor VÁLIDO que não casa não é erro de
  // seletor. Em click é falha (não há o que clicar); em query é resposta.
  const noMatchClick = await toolJson("browser_click", { target: cardId, selector: "#nao-existe-mesmo" });
  check("um seletor válido sem correspondência dá outra mensagem, não a de inválido", /no element matches/.test(noMatchClick.error ?? ""), true);
  const noMatchQuery = await toolJson("browser_query", { target: cardId, selector: "#nao-existe-mesmo" });
  check("browser_query com seletor válido sem match continua sendo ok:true/exists:false", noMatchQuery.ok && noMatchQuery.exists === false, true);
  const badQuery = await toolJson("browser_query", { target: cardId, selector: "div:has-text('x')" });
  check("...mas um seletor inválido em query é ok:false, não 'não existe'", badQuery.ok, false);

  const evalRes = await toolJson("browser_eval", { target: cardId, js: "2 + 40" });
  check("browser_eval (MCP) roda JS e retorna o valor certo", evalRes.result, "42");

  // --- mesma bateria via acbridge CLI, provando paridade real (não só doc) ---

  const clickCli = await runAcbridge(sockPath, ["browser-click", cardId, "#inp"]);
  check("browser-click (acbridge) reporta sucesso", clickCli.ok, true);

  // insertText insere no cursor, não substitui — mesmo comportamento de
  // um humano clicando um campo já preenchido e digitando; limpa antes
  // pra manter a asserção abaixo exata em vez de checar um append.
  await toolJson("browser_eval", { target: cardId, js: "document.getElementById('inp').value = ''" });
  const typeCli = await runAcbridge(sockPath, ["browser-type", cardId, "#inp", "via", "acbridge"]);
  check("browser-type (acbridge) reporta sucesso", typeCli.ok, true);
  const inpAfterCli = await toolJson("browser_query", { target: cardId, selector: "#inp" });
  check("browser-type (acbridge) realmente preencheu o campo", inpAfterCli.value, "via acbridge");

  const scrollBeforeCli = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('scrollbox').scrollTop" });
  const scrollCli = await runAcbridge(sockPath, ["browser-scroll", cardId, "0", "300", "#scrollbox"]);
  check("browser-scroll (acbridge) reporta sucesso", scrollCli.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  const scrollAfterCli = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('scrollbox').scrollTop" });
  check("browser-scroll (acbridge) realmente rolou o container", Number(scrollAfterCli.result) > Number(scrollBeforeCli.result), true);

  const queryCli = await runAcbridge(sockPath, ["browser-query", cardId, "#info"]);
  check("browser-query (acbridge) reporta sucesso", queryCli.ok, true);
  const queryCliParsed = JSON.parse(queryCli.stdout);
  check("browser-query (acbridge) retorna o texto real do elemento", queryCliParsed.text, "ready");

  const evalCli = await runAcbridge(sockPath, ["browser-eval", cardId, "1", "+", "1"]);
  check("browser-eval (acbridge) reporta sucesso", evalCli.ok, true);
  check("browser-eval (acbridge) roda JS e retorna o valor certo", evalCli.stdout, "2");

  // ============================================================
  // Achados de 2026-09-01 (relato de um agente que dirigiu o navegador):
  // sem estas quatro, mirar exigia já saber o seletor, esperar era dormir
  // e torcer, e uma falha silenciosa não tinha diagnóstico nenhum.
  // ============================================================

  // --- browser_snapshot: refs pra mirar sem saber o seletor ---
  const snap = await toolJson("browser_snapshot", { target: cardId });
  check("browser_snapshot lista os elementos interativos", snap.ok && snap.elements.length > 0, true);
  const salvar = snap.elements.find((el) => el.name === "Adicionar nota");
  check("...achando o botão pelo nome que o humano LÊ na tela", !!salvar, true);
  check("...com papel semântico, não só a tag", salvar?.role, "button");
  // A razão de existir o nome acessível: um botão de ícone não tem texto
  // nenhum, e um input não tem texto próprio — o innerText cru acharia "".
  check("...usando aria-label num botão de ícone", snap.elements.some((el) => el.name === "Fechar painel"), true);
  check("...e o <label> associado num input", snap.elements.some((el) => el.name === "Título da nota" && el.role === "textbox"), true);
  check("elemento invisível fica de fora (mirá-lo daria um clique que não acontece)", snap.elements.some((el) => el.name === "invisivel"), false);
  // O que estas duas medem: o nome vem dos ids de `aria-labelledby` separados
  // por ESPAÇO (os spans estão `hidden`, então o nome tem de sair do textContent
  // deles) e o texto visível é colapsado sem comer letra nenhuma.
  check("aria-labelledby com múltiplos ids resolve nome certo (split por espaço, não por 's')", snap.elements.some((el) => el.name === "Primeiro Segundo"), true);
  check("texto com múltiplos espaços colapsa certo sem comer a letra 's'", snap.elements.some((el) => el.name === "multiple spaces here"), true);

  const titulo = snap.elements.find((el) => el.name === "Título da nota");
  const typedByRef = await toolJson("browser_type", { target: cardId, ref: titulo.ref, text: "por ref" });
  check("browser_type aceita ref do snapshot", typedByRef.ok, true);
  check(
    "...e escreveu no elemento certo",
    (await toolJson("browser_query", { target: cardId, selector: "#titulo" })).value,
    "por ref",
  );
  const queriedByRef = await toolJson("browser_query", { target: cardId, ref: salvar.ref });
  check("browser_query também aceita ref", queriedByRef.ok && queriedByRef.text === "Adicionar nota", true);

  // --- browser_console ---
  await toolJson("browser_click", { target: cardId, selector: "#boom" });
  await new Promise((r) => setTimeout(r, 500));
  const consoleErrors = await toolJson("browser_console", { target: cardId, level: "error" });
  check("browser_console entrega os erros que a página logou", consoleErrors.messages.some((m) => m.message.includes("falha-de-proposito")), true);

  // --- browser_network: o cenário do relato, ponta a ponta ---
  const beforeSave = await toolJson("browser_query", { target: cardId, selector: "#save" });
  await toolJson("browser_click", { target: cardId, ref: salvar.ref });
  await new Promise((r) => setTimeout(r, 800));
  check(
    "o botão de salvar não muda NADA na tela quando a API falha (é o defeito silencioso)",
    (await toolJson("browser_query", { target: cardId, selector: "#save" })).text,
    beforeSave.text,
  );
  const failed = await toolJson("browser_network", { target: cardId, failedOnly: true });
  check("browser_network explica o que a tela escondeu", failed.requests.some((r) => r.url.includes("/api/salvar") && r.status === 500), true);
  const filtered = await toolJson("browser_network", { target: cardId, urlContains: "/api/salvar" });
  check("...e dá pra filtrar por URL", filtered.requests.length > 0, true);

  // --- browser_wait_for ---
  await toolJson("browser_click", { target: cardId, selector: "#tarde" });
  const waited = await toolJson("browser_wait_for", { target: cardId, text: "pronto", timeoutMs: 5000 });
  check("browser_wait_for volta assim que o texto aparece", waited.ok, true);
  const timedOut = await toolJson("browser_wait_for", { target: cardId, text: "nunca-vai-aparecer", timeoutMs: 1200 });
  check("...e falha com um timeout explícito quando não aparece", timedOut.ok === false && /timed out/.test(timedOut.error ?? ""), true);
  const goneOk = await toolJson("browser_wait_for", { target: cardId, selector: "#nao-existe", gone: true, timeoutMs: 1500 });
  check("...com gone:true esperando sumir (já ausente resolve na hora)", goneOk.ok, true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
