// Achado ao vivo (2026-09-02, reportado pelo usuário): "no Claude ainda
// mostra o path completo" — a máscara visual de path de imagem colada
// (`useTerminal.ts`'s `writeMasked`, já provada contra um terminal `bash`
// simples em `smoke-terminal-image-mask.mjs`) falhava especificamente
// contra o provider `claude`. Causa raiz confirmada capturando os bytes
// crus de `pty:data` com um listener paralelo: `claude` redesenha sua
// própria caixa de input via códigos ANSI de cursor, e o espaço digitado
// depois do path colado nunca chega como um caractere de espaço literal
// no eco (vira parte do redesenho, ex. um `\r`) — o `needle` de match
// incluía esse espaço, nunca batia, e o buffer desistia mostrando o path
// cru. Corrigido em `useTerminal.ts`: o `needle` agora é só o path entre
// aspas (o que É ecoado de volta igual em qualquer CLI), o espaço
// continua sendo enviado ao PTY normalmente, só não faz mais parte do
// que precisa bater pra mascarar.
//
// Este teste roda contra um `claude` REAL (não bash) — o mesmo binário
// que reproduziu o bug ao vivo — provando que o placeholder mascarado
// aparece de verdade e o path cru não, com o CLI real de produção, não
// um provider mais simples que mascarava por coincidência.
import { existsSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-image-mask-claude-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Image Mask Claude Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const id = String(Date.now());
        await window.store.upsert({
          id, board_id: ${JSON.stringify(boardId)}, kind: 'terminal', provider: 'claude',
          cwd: ${JSON.stringify(process.cwd())}, x: 210, y: 220, w: 900, h: 700,
          resume_id: null, model: null, system_prompt: null, group_id: null, label: null,
          updated_at: Date.now(), messages_json: null, archived_at: null,
        });
        return JSON.stringify(id);
      })()
    `),
  );
  // Reload -- store.upsert() out-of-band não move card renderizado, mas
  // TAMBÉM não faz o app criar um card NOVO do zero; precisa do mesmo
  // round-trip Home->voltar que os outros testes de seed direto usam.
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  const target = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-name')?.textContent === 'Image Mask Claude Teste');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!target) throw new Error("could not find the seeded claude session on Home");
  await page.click(target.x, target.y);
  await new Promise((r) => setTimeout(r, 1500));
  // Deixa o claude real bootar de verdade (spawn + primeira tela) antes
  // de colar -- um paste cedo demais pode chegar antes do input estar
  // pronto pra receber.
  await new Promise((r) => setTimeout(r, 4000));

  await page.evalJs(`window.clipboardImage.testWriteImage()`);
  const dispatchResult = JSON.parse(
    await page.evalJs(`
      (() => {
        const body = document.querySelector('[data-role="terminal-body"]');
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([0])], 'paste.png', { type: 'image/png' });
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = body.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("paste de imagem interceptado (provider claude)", dispatchResult, false);
  await new Promise((r) => setTimeout(r, 1200));

  const rendered = await toolJson("read_card", { target: cardId });
  check("read_card resolve ok", rendered.ok, true);
  check("a TELA renderizada mostra o placeholder mascarado com claude real", rendered.text.includes("[imagem #1]"), true);
  check(
    "...e NÃO mostra o path absoluto real (mascarado de verdade, não o bug reportado)",
    /\/stellar-pastes\/paste-[^"]+\.png/.test(rendered.text),
    false,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
