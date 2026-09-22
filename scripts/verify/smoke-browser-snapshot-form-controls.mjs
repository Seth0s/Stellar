// `browser_snapshot` OMITIA os controles de formulário escondidos — e listava
// os que não dão para clicar (task 4bdb257e, irmã do P0 do clique).
//
// Relato do dono: numa tela de perguntas o snapshot listou 2 elementos numa
// página com ~40 rádios; noutra, a lista de rádios de "Dados adicionais" não
// apareceu. O padrão que causa é o mais comum da web: input de rádio
// invisível com um label estilizado por cima — o snapshot perguntava
// visibilidade ao PRÓPRIO input e descartava todos.
//
// MEDIDO contra o build anterior (o probe que originou este arquivo):
//   opacity:0 + label for        -> OMITIDO  (o caso do relato)
//   display:none + label visível -> OMITIDO  (clicar o label funciona!)
//   visibility:hidden + label    -> OMITIDO
//   left:-9999px                 -> LISTADO  (e o clique não acontece)
//   width:0;height:0             -> LISTADO  (e o clique não acerta o input)
//   sr-only/clip + label ancestral -> LISTADO (funcionava)
//
// A fixture tem DOIS GRUPOS e uma forma de esconder de cada tipo, de
// propósito: um input só passa por vacuidade, e "checked: false" sem saber de
// que grupo é não informa nada numa tela com 40 rádios. Os dois negativos
// (passo de formulário fechado e `<template>`) ficam no mesmo arquivo: listar
// o que não dá para clicar é a mentira oposta, tão ruim quanto a omissão.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-snapshot-form-${CDP_PORT}`);

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
/** `browser_eval` devolve `JSON.stringify(raw)` — uma camada a mais quando o
 * resultado já é string. Desfaz até duas (mesmo helper do smoke do clique). */
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

// A fixture. Cada grupo tem 2 opções; uma forma de esconder por grupo; os
// rótulos são o que um humano lê e clica.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font:14px monospace}
  label.opt{display:block}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style></head><body>
<label class="opt" for="g1a">g1 A (opacity 0)</label><input type="radio" name="g1" id="g1a" style="opacity:0;position:absolute;width:1px;height:1px">
<label class="opt" for="g1b">g1 B (opacity 0)</label><input type="radio" name="g1" id="g1b" style="opacity:0;position:absolute;width:1px;height:1px">

<label class="opt" for="g2a">g2 A (off-screen)</label><input type="radio" name="g2" id="g2a" style="position:absolute;left:-9999px">
<label class="opt" for="g2b">g2 B (off-screen)</label><input type="radio" name="g2" id="g2b" style="position:absolute;left:-9999px">

<label class="opt" for="g3a">g3 A (0x0)</label><input type="radio" name="g3" id="g3a" style="appearance:none;width:0;height:0">
<label class="opt" for="g3b">g3 B (0x0)</label><input type="radio" name="g3" id="g3b" style="appearance:none;width:0;height:0">

<label class="opt"><input type="radio" name="g4" id="g4a" class="sr-only"><span>g4 A (sr-only + label ancestral)</span></label>
<label class="opt"><input type="radio" name="g4" id="g4b" class="sr-only"><span>g4 B (sr-only + label ancestral)</span></label>

<label class="opt" for="g5a">g5 A (display none)</label><input type="radio" name="g5" id="g5a" style="display:none">
<label class="opt" for="g5b">g5 B (display none)</label><input type="radio" name="g5" id="g5b" style="display:none">

<label class="opt" for="g6a">g6 A (visibility hidden)</label><input type="radio" name="g6" id="g6a" style="visibility:hidden">

<!-- NEGATIVO 1: passo de formulário que ainda não abriu -->
<div style="display:none">
  <label for="g9a">g9 A (passo fechado)</label><input type="radio" name="g9" id="g9a">
</div>

<!-- NEGATIVO 2: template -->
<template id="tpl"><label for="g10a">g10 A (template)</label><input type="radio" name="g10" id="g10a"></template>

<!-- controles visíveis comuns, para provar que nada regrediu -->
<input id="titulo" type="text" placeholder="Titulo do campo">
<textarea id="obs" placeholder="obs"></textarea>
<select id="sel"><option>a</option></select>
<label for="cb1">aceito os termos</label><input type="checkbox" id="cb1" style="opacity:0;position:absolute;width:1px;height:1px">
<button id="multilabel" aria-labelledby="first second"></button><span hidden id="first">Primeiro</span><span hidden id="second">Segundo</span>
<input id="escondido-de-verdade" type="text" style="display:none" value="nao clicavel">
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Snapshot form", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // O rail so existe DENTRO de um board, e o app leva um tempo variavel pra
  // monta-lo (medido: sob carga da maquina, o clique no rail caia em null e o
  // smoke parecia quebrado no produto). Espera ele existir, com prazo.
  async function waitForSelector(selector, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found === true) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`selector ${selector} never appeared within ${timeoutMs}ms`);
  }
  await waitForSelector('[data-role="rail-add-card"]');
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

  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)} )`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const here = parseEval((await toolJson("browser_eval", { target: cardId, js: "location.pathname" })).result);
    if (here === "/") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await toolJson("browser_eval", { target: cardId, js: "document.fonts.ready.then(() => 'fonts')" });
  await new Promise((r) => setTimeout(r, 800));

  const snap = await toolJson("browser_snapshot", { target: cardId });
  check("snapshot respondeu ok", snap.ok, true);
  const items = Array.isArray(snap.elements) ? snap.elements : [];
  const byName = (name) => items.find((el) => el.name === name);

  // --- 1. as quatro formas de esconder: listadas, com o ref no alvo certo ---
  for (const [label, id] of [
    ["g1 A (opacity 0)", "g1a"],
    ["g2 A (off-screen)", "g2a"],
    ["g3 A (0x0)", "g3a"],
    ["g4 A (sr-only + label ancestral)", "g4a"],
    ["g5 A (display none)", "g5a"],
    ["g6 A (visibility hidden)", "g6a"],
  ]) {
    const item = byName(label);
    check(`escondido por ${label.split("(")[1]?.replace(")", "") ?? "?"}: listado como rádio`, item?.role, "radio");
    check(`...com ref apontando para o label (via: "label")`, item?.via, "label");
    // O ref tem de ser CLICÁVEL de verdade, e é isso que o item promete.
    const clicked = item ? await toolJson("browser_click", { target: cardId, ref: item.ref }) : { ok: false };
    await new Promise((r) => setTimeout(r, 120));
    const checked = parseEval(
      (await toolJson("browser_eval", { target: cardId, js: `JSON.stringify(Boolean(document.getElementById(${JSON.stringify(id)}).checked))` }))
        .result,
    );
    check(`...e clicar o ref MARCA o controle escondido (${id})`, clicked.ok === true && checked === true, true);
    if (!clicked.ok || checked !== true) console.log(`  detalhe ${id}: ${JSON.stringify(clicked)}`);
  }

  // --- 2. checked/group: por grupo, sempre presente --------------------------
  const snap2 = await toolJson("browser_snapshot", { target: cardId });
  const items2 = Array.isArray(snap2.elements) ? snap2.elements : [];
  const g1a = items2.find((el) => el.name === "g1 A (opacity 0)");
  const g1b = items2.find((el) => el.name === "g1 B (opacity 0)");
  check("o rádio marcado diz checked: true", g1a?.checked, true);
  check("o irmão do MESMO grupo diz checked: false (não omitido)", g1b?.checked, false);
  check("...e os dois dizem de que grupo são", g1a?.group === "g1" && g1b?.group === "g1", true);

  // --- 3. os negativos: NÃO listar o que não dá para clicar -----------------
  check("passo de formulário fechado fica de fora", !!byName("g9 A (passo fechado)"), false);
  check("conteúdo de <template> fica de fora", !!byName("g10 A (template)"), false);
  check("input display:none SEM label associado fica de fora", items2.some((el) => el.name === "nao clicavel"), false);

  // --- 4. nada regrediu no que já funcionava ---------------------------------
  check("input de texto continua listado pelo label", byName("Titulo do campo")?.role, "textbox");
  check("textarea continua listado", items2.some((el) => el.role === "textbox"), true);
  check("select continua listado como combobox", items2.some((el) => el.role === "combobox"), true);
  check(
    "aria-labelledby com dois ids escondidos resolve o nome (split por espaço)",
    items2.some((el) => el.name === "Primeiro Segundo"),
    true,
  );

  finish();
} finally {
  await stopApp(app);
  server.close();
}
