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
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = 9599;
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
const USER_DATA_DIR = join(tmpdir(), "stellar-verify-browser-mcp-control");
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
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0">
    <button id="btn" onclick="document.getElementById('btn').textContent='clicked'">click me</button>
    <input id="inp" type="text" />
    <div id="scrollbox" style="height:100px;overflow:auto;">
      <div style="height:2000px;">tall content</div>
    </div>
    <div id="info">ready</div>
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
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
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

async function createBrowserCard(page, url) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inputs = document.querySelectorAll('.browser-card-address input');
        const el = inputs[inputs.length - 1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inputs = document.querySelectorAll('.browser-card-address input');
      const inp = inputs[inputs.length - 1];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(url)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))
    `),
  );
  return browserCards[browserCards.length - 1];
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

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
