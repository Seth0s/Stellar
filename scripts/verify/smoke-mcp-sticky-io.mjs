// Achado ao vivo (2026-09-01): "o send_to_card só escreve em card de
// terminal — sticky é editável só por você, então o quadro vivo está no
// arquivo. (SEM LEITURA TAMBEM)". Um quadro de trabalho compartilhado entre
// humano e agente acabava num .md em vez de viver no board.
//
// `read_sticky`/`write_sticky` são tools próprias, não uma extensão de
// `read_card`/`send_to_card`: numa nota não existe Enter pra dar nem
// scrollback pra paginar. Decidido com o usuário, junto com as outras duas
// regras que este arquivo prova ao vivo:
//
//   * SEM modal de consentimento — uma nota é conteúdo do board, não um
//     efeito colateral em disco/processo (a categoria que AGENTS.md §3
//     cobre). A checagem de "nenhum modal" abaixo é contra o DOM real.
//   * A escrita é RECUSADA enquanto um humano está com aquela nota focada,
//     pra nunca apagar o que a pessoa está digitando. Essa é a única
//     proteção da escrita, então ela é checada com um foco de verdade
//     (clique real no textarea), não simulado.
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-sticky-io-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  return JSON.parse((await callTool(name, args)).content[0].text);
}
async function mcpCallAs(cardId, method, params) {
  const res = await fetch(`${MCP_URL}?card=${encodeURIComponent(cardId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJsonAs(cardId, name, args) {
  const rpc = await mcpCallAs(cardId, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
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
async function textareaValue(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('[data-role="sticky-textarea"]')?.value ?? null)`));
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sticky IO");
  await new Promise((r) => setTimeout(r, 500));

  const bashId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // Cria a nota pelo caminho normal (spawn_card) — achado ao vivo
  // (2026-09-06): kind:"sticky" agora é auto-aprovado, sem consentimento
  // nenhum (mesma classe de risco de write_sticky, que nunca pediu) —
  // resolve na hora, sem modal pra clicar.
  await callTool("spawn_card", { kind: "sticky", callerCardId: bashId, reason: "quadro vivo" });
  await new Promise((r) => setTimeout(r, 600));

  const stickyId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "sticky")?.id;
  check("o sticky criado aparece no list_cards com kind próprio", typeof stickyId, "string");

  const empty = await toolJson("read_sticky", { target: stickyId });
  check("read_sticky lê uma nota recém-criada (vazia, não erro)", JSON.stringify(empty), JSON.stringify({ ok: true, content: "" }));

  const written = await toolJson("write_sticky", { target: stickyId, content: "linha 1" });
  check("write_sticky resolve ok e devolve o conteúdo resultante", JSON.stringify(written), JSON.stringify({ ok: true, content: "linha 1" }));
  check("...sem pedir consentimento nenhum", await hasModal(page), false);
  check("...e o textarea REAL na tela mostra o texto", await textareaValue(page), "linha 1");

  const appended = await toolJson("write_sticky", { target: stickyId, content: "\nlinha 2", mode: "append" });
  check("mode:append acrescenta em vez de substituir", appended.content, "linha 1\nlinha 2");
  check("...refletido no textarea real", await textareaValue(page), "linha 1\nlinha 2");
  check("read_sticky devolve o mesmo que a escrita afirmou", (await toolJson("read_sticky", { target: stickyId })).content, "linha 1\nlinha 2");

  // path form — main reads the file (same confine + 512KB as FilesCard /
  // chat read_file). The smoke client is otherwise anonymous, so these
  // calls stamp `?card=` the way a real provider MCP URL does.
  const bashCwd = (await toolJson("list_cards", {})).cards.find((c) => c.id === bashId)?.cwd;
  check("o card bash tem cwd de verdade (pré-condição da forma path)", typeof bashCwd === "string" && bashCwd.length > 0, true);
  if (typeof bashCwd === "string" && bashCwd.length > 0) {
    const fromFileName = `smoke-write-sticky-from-file-${CDP_PORT}.md`;
    const fromFileAbs = join(bashCwd, fromFileName);
    writeFileSync(fromFileAbs, "from file\nAna 001");
    try {
      const fromFile = await toolJsonAs(bashId, "write_sticky", { target: stickyId, path: fromFileName });
      check("write_sticky path form lê o arquivo no main", fromFile.content, "from file\nAna 001");
      writeFileSync(fromFileAbs, "\nappended from file");
      const fromFileAppend = await toolJsonAs(bashId, "write_sticky", {
        target: stickyId,
        path: fromFileName,
        mode: "append",
      });
      check("write_sticky path form honra append", fromFileAppend.content, "from file\nAna 001\nappended from file");
      const both = await toolJsonAs(bashId, "write_sticky", {
        target: stickyId,
        content: "x",
        path: fromFileName,
      });
      check("content e path juntos são recusados", both.ok, false);
      const escaped = await toolJsonAs(bashId, "write_sticky", { target: stickyId, path: "/etc/passwd" });
      check("path fora do cwd do card é recusado", escaped.ok, false);
      const restored = await toolJson("write_sticky", { target: stickyId, content: "linha 1\nlinha 2" });
      check("inline continua válido depois da forma path", restored.content, "linha 1\nlinha 2");
    } finally {
      try {
        unlinkSync(fromFileAbs);
      } catch {
        /* already gone */
      }
    }
  }

  // --- a proteção: humano editando a nota AGORA ---
  const ta = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-role="sticky-textarea"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  await page.click(ta.x, ta.y);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "o clique real focou o textarea (pré-condição da checagem seguinte)",
    JSON.parse(await page.evalJs(`JSON.stringify(document.activeElement?.dataset.role === "sticky-textarea")`)),
    true,
  );

  const refused = await toolJson("write_sticky", { target: stickyId, content: "APAGARIA TUDO" });
  check("write_sticky é recusada enquanto um humano tem a nota focada", refused.ok, false);
  check("...com um erro que diz o porquê, não um 'no such card'", refused.error?.includes("being edited"), true);
  check("...e o texto do humano continua intacto na tela", await textareaValue(page), "linha 1\nlinha 2");

  await page.evalJs(`document.activeElement.blur()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterBlur = await toolJson("write_sticky", { target: stickyId, content: "depois do blur" });
  check("...e volta a funcionar assim que o humano sai da nota", afterBlur.content, "depois do blur");

  // --- alvos errados dão erro que ensina, não erro genérico ---
  const wrongKind = await toolJson("read_sticky", { target: bashId });
  check("read_sticky num terminal explica o kind em vez de dizer que o id não existe", wrongKind.error?.includes("terminal card"), true);
  // Um `mode` inválido nem chega ao handler: o `z.enum` do schema recusa
  // antes. O SDK devolve isso como um RESULTADO de tool cujo texto é a
  // mensagem de validação (não como `rpc.error` e não como um `{ok:false}`
  // em JSON) — daí ler `content[0].text` cru aqui, em vez de `toolJson`,
  // que tentaria dar `JSON.parse` numa frase em inglês. `message-bus.ts`
  // valida o mesmo `mode` por conta própria de qualquer jeito, porque o
  // acbridge fala com o bus direto pelo socket, sem passar por zod nenhum.
  const wrongMode = (await callTool("write_sticky", { target: stickyId, content: "x", mode: "prepend" })).content[0].text;
  check("um mode inválido é recusado antes de tocar na nota", /invalid/i.test(wrongMode), true);
  check("...e a nota continua com o conteúdo anterior", (await toolJson("read_sticky", { target: stickyId })).content, "depois do blur");
} finally {
  finish();
  await stopApp(app);
}
