// Achados ao vivo (2026-09-01), três sintomas com a mesma raiz — o bus
// não sabia dizer QUEM é cada card:
//
//   1. "list_cards doesn't surface browser cards — I need the card ID":
//      `index.ts`'s callback filtrava `kind === "terminal"`, então um card
//      de navegador (ou sticky/arquivos) só era endereçável se o próprio
//      agente o tivesse criado e guardado o id do retorno do `spawn_card`.
//   2. "eu renomeio os card dos agentes para Stellar, isso só está visual
//      em vez de funcional": renomear gravava `cards.label` e nada no bus
//      olhava esse campo — todo `target` era comparado só contra `c.id`.
//   3. "o modo automático não funciona de fato": o servidor MCP é um só,
//      compartilhado por todos os cards, e a identidade do chamador vinha
//      de um `callerCardId` OPCIONAL que o modelo tinha que lembrar de
//      preencher. Omitido (o caso comum), `getCardBoardId("")` dava
//      `undefined`, `autonomous` virava `false` e o board caía de volta no
//      modal de consentimento mesmo com o modo autônomo ligado.
//
// Os três checks abaixo batem contra o DOM real (`.modal` presente ou
// ausente), não só contra a resposta MCP: um auto-approve errado que pula
// o modal só aparece se você de fato procurar o modal.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9563;
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-card-identity", import.meta.url).pathname;

let nextRpcId = 1;
/** `url` explícito — o ponto inteiro deste arquivo é que `/mcp` e
 * `/mcp?card=<id>` são endereços com identidades diferentes. */
async function mcpCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  // Mesma razão de smoke-mcp-autonomous-mode.mjs: uma chamada que espera
  // na fila segura o HTTP aberto tempo suficiente pro transporte SSE
  // intercalar um ": keepalive" antes do "data:" de verdade.
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args, url = MCP_BASE) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args, url = MCP_BASE) {
  const result = await callTool(name, args, url);
  return JSON.parse(result.content[0].text);
}
async function hasModal(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.modal'))`));
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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Identidade de Card");
  await new Promise((r) => setTimeout(r, 500));

  const seeded = await toolJson("list_cards", {});
  const bash = seeded.cards.find((c) => c.kind === "terminal");
  check("list_cards traz `kind` em cada card", typeof bash?.kind, "string");
  check("...e traz `label` (null enquanto ninguém renomeou)", bash.label, null);

  // ---------------------------------------------------------------
  // Sintoma 2 — renomear um card passa a ser funcional, não decorativo.
  // ---------------------------------------------------------------
  const tag = await centerOf(page, ".terminal-card .card-tag");
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tag.x, y: tag.y, button: "left", clickCount: 2, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tag.x, y: tag.y, button: "left", clickCount: 2, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  check(
    "duplo clique real abre o input de rename",
    JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.card-tag-input'))`)),
    true,
  );
  await page.send("Input.insertText", { text: "Stellar" });
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 500));

  const renamed = await toolJson("list_cards", {});
  check("list_cards devolve o rótulo que o humano digitou", renamed.cards.find((c) => c.id === bash.id)?.label, "Stellar");

  const byLabel = await toolJson("card_status", { target: "Stellar" });
  check("um comando aceita o RÓTULO como target, não só o id", JSON.stringify(byLabel), JSON.stringify({ ok: true, status: "running" }));
  const byLabelCase = await toolJson("card_status", { target: "  stellar " });
  check("...com case e espaços nas pontas tolerados (é campo de texto livre)", byLabelCase.ok, true);
  const byBogus = await toolJson("card_status", { target: "não existe" });
  check("...e um alvo que não é nem id nem rótulo continua dando o erro de sempre", byBogus.ok, false);

  // ---------------------------------------------------------------
  // Sintoma 1 — um card não-terminal aparece na lista e é endereçável.
  // ---------------------------------------------------------------
  // Mesma URL real que smoke-mcp.mjs já usa pro mesmo fim — o extrator de
  // texto lê a página de verdade, então precisa de uma página de verdade.
  const openPromise = callTool("open_url", { url: "https://example.com", callerCardId: bash.id, reason: "teste de listagem" });
  await new Promise((r) => setTimeout(r, 600));
  await clickModalButton(page, "Permitir");
  await openPromise;
  await new Promise((r) => setTimeout(r, 1200));

  const withBrowser = await toolJson("list_cards", {});
  const browserCard = withBrowser.cards.find((c) => c.kind === "browser");
  check("um card de navegador aparece no list_cards (antes era invisível pro agente)", !!browserCard, true);
  check("...com a URL num campo próprio, não empurrada dentro de `cwd`", browserCard?.url?.startsWith("https://example.com"), true);
  check("...e sem vazar coluna reaproveitada: `cwd` de um navegador não é um caminho", browserCard?.cwd, "");

  const pageText = await toolJson("get_page_text", { target: browserCard.id });
  check("o id descoberto SÓ pelo list_cards serve mesmo pra operar o card", pageText.text?.includes("Example Domain"), true);

  const sendToBrowser = await toolJson("send_to_card", { target: browserCard.id, text: "oi" });
  check("send_to_card num card não-terminal explica o porquê em vez de dizer que o id não existe", sendToBrowser.error?.includes("browser card"), true);

  // ---------------------------------------------------------------
  // Sintoma 3 — modo autônomo com e sem identidade do chamador.
  // ---------------------------------------------------------------
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[title="Editar sessão"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  await clickModalButton(page, "Cancelar");
  await new Promise((r) => setTimeout(r, 400));
  check("modo autônomo ligado pela UI real", await page.evalJs(`document.querySelector('.topbar-autonomous-badge')?.textContent`), "autônomo");
  // Pré-condição explícita: os dois checks de modal abaixo só significam
  // alguma coisa se a tela estiver limpa antes deles.
  check("...e o modal de sessão de fato fechou antes dos checks de consentimento", await hasModal(page), false);

  // Controle: exatamente a chamada que o modelo faz quando esquece o
  // `callerCardId` opcional, no endereço genérico. É ESTE caso que fazia
  // o modo autônomo parecer não funcionar.
  const anonymousPromise = callTool("open_url", { url: "data:text/html,<h1>anonimo</h1>", reason: "sem identidade" }, MCP_BASE);
  await new Promise((r) => setTimeout(r, 700));
  check("sem nenhuma identidade, o modal ainda aparece (o board não é adivinhável)", await hasModal(page), true);
  await clickModalButton(page, "Negar");
  await anonymousPromise;
  await new Promise((r) => setTimeout(r, 400));

  // O caso real: a URL que `pty-registry.ts` registra pro processo daquele
  // card já carrega o id. Nenhum argumento a mais na chamada.
  const identifiedPromise = callTool("open_url", { url: "data:text/html,<h1>autonomo</h1>", reason: "identidade pela URL" }, `${MCP_BASE}?card=${encodeURIComponent(bash.id)}`);
  await new Promise((r) => setTimeout(r, 700));
  check("com a identidade carimbada na URL do MCP, NENHUM modal aparece", await hasModal(page), false);
  const identified = JSON.parse((await identifiedPromise).content[0].text);
  check("...e a chamada resolve ok:true sozinha, que é o modo autônomo funcionando", identified.ok, true);
} finally {
  finish();
  await stopApp(app);
}
