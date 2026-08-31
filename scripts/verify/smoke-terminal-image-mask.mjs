// Pedido ao vivo (2026-08-31) — "no claude aparece o path da imagem em vez
// [Image id], quero o mesmo efeito, mas mascarado". Confirmado com o
// usuário: só a APARÊNCIA muda — o que é ENVIADO pro PTY continua sendo o
// path absoluto real (a CLI rodando ali precisa dele pra ler o arquivo).
// `useTerminal.ts`'s `writeMasked` intercepta o ECO do path (o TTY ecoa de
// volta o que recebeu) antes de chegar em `term.write()`, substituindo por
// "[imagem #N]" — só na RENDERIZAÇÃO.
//
// Prova real, sem mock: um segundo listener de `window.pty.onData`,
// registrado direto pelo teste (independente do listener interno do app),
// prova que o PTY real recebeu o path completo de verdade — a mesma API
// que a CLI do outro lado do PTY também usaria. `read_card` (MCP) lê o
// texto REAL renderizado no buffer do xterm.js (via terminal-registry.ts),
// confirmando que a TELA mostra o placeholder mascarado, não o path.
import { existsSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9472;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-image-mask", import.meta.url).pathname;

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Image Mask Teste");
  await new Promise((r) => setTimeout(r, 600));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  // Segundo listener, independente do interno do app — captura tudo que
  // o PTY real emite, prova o que de fato circula por baixo.
  await page.evalJs(`
    (() => {
      window.__rawPtyChunks = '';
      window.pty.onData((id, data) => { window.__rawPtyChunks += data; });
    })()
  `);

  await page.evalJs(`window.clipboardImage.testWriteImage()`);

  const dispatchResult = JSON.parse(
    await page.evalJs(`
      (() => {
        const body = document.querySelector('.terminal-card-body');
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([0])], 'paste.png', { type: 'image/png' });
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = body.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("paste de imagem interceptado", dispatchResult, false);
  await new Promise((r) => setTimeout(r, 800));

  // Não reusar um path obtido de um `save()` chamado pelo próprio teste: o
  // handler interno do app (`writeImagePathToPty`) chama `save()` de novo
  // sozinho ao processar o paste, gerando SEU PRÓPRIO arquivo/timestamp —
  // confirmado ao investigar uma falha inicial deste teste (dois paths
  // diferentes). O path real de verdade só existe no que o PTY de fato
  // recebeu — extrai dali.
  const rawChunks = await page.evalJs(`window.__rawPtyChunks`);
  const pathMatch = rawChunks.match(/"(\/tmp\/stellar-pastes\/paste-[^"]+\.png)"/);
  check("o PTY real recebeu um path de imagem entre aspas (formato esperado)", Boolean(pathMatch), true);
  const realPath = pathMatch?.[1] ?? "";
  check("o arquivo real da imagem colada existe de fato em disco (path não é forjado)", existsSync(realPath), true);

  const rendered = await toolJson("read_card", { target: cardId });
  check("read_card resolve ok", rendered.ok, true);
  check("a TELA renderizada mostra o placeholder mascarado", rendered.text.includes("[imagem #1]"), true);
  check("...e NÃO mostra o path absoluto real (mascarado de verdade, não só um texto extra)", rendered.text.includes(realPath), false);

  // Uma segunda imagem colada incrementa o contador — prova que não é um
  // texto fixo, e que o mecanismo aguenta mais de um paste no mesmo card.
  await page.evalJs(`window.clipboardImage.testWriteImage()`);
  const dispatchResult2 = JSON.parse(
    await page.evalJs(`
      (() => {
        const body = document.querySelector('.terminal-card-body');
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([0])], 'paste2.png', { type: 'image/png' });
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = body.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("segundo paste de imagem também interceptado", dispatchResult2, false);
  await new Promise((r) => setTimeout(r, 800));
  const rendered2 = await toolJson("read_card", { target: cardId });
  check("o segundo placeholder incrementa o contador ([imagem #2])", rendered2.text.includes("[imagem #2]"), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
