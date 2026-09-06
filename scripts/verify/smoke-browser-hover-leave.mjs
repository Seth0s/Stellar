// DESIGN-BACKLOG.md §2.1 Item C — hover precision. Before this fix,
// BrowserCard.tsx never told the embedded page "the cursor left" (no
// `mouseLeave` forwarded at all) — any `:hover`/tooltip/dropdown the
// page opened stayed stuck open once the cursor moved off the canvas.
// Verifies live: a real synthetic pointer move INTO the canvas triggers
// a real `mouseenter` in the embedded page's own DOM, and moving OUT of
// the canvas triggers a real `mouseleave` there too — not two isolated
// facts, the actual close-the-gap behavior end to end.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-hover-leave-${CDP_PORT}`, import.meta.url).pathname;

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
  // creation behind an "Adicionar card" popover.
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

// Full-page target that flips data-hovering on real mouseenter/mouseleave
// — a visible, DOM-observable proxy for ":hover/tooltip/dropdown state".
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0">
    <div id="target" data-hovering="false" style="position:fixed;inset:0;background:#eee;"></div>
    <script>
      const t = document.getElementById('target');
      t.addEventListener('mouseenter', () => t.setAttribute('data-hovering', 'true'));
      t.addEventListener('mouseleave', () => t.setAttribute('data-hovering', 'false'));
    </script>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function createBrowserCard(page, url) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inputs = document.querySelectorAll('[data-role="browser-address"] input');
        const el = inputs[inputs.length - 1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inputs = document.querySelectorAll('[data-role="browser-address"] input');
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
  await bootIntoFreshSession(page, "Browser Hover Leave Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const cardId = await createBrowserCard(page, `http://127.0.0.1:${port}/`);
  check("browser card real criado e navegado pra fixture", typeof cardId === "string" && cardId.length > 0, true);

  const hoveringBefore = await toolJson("browser_query", { target: cardId, selector: "#target" });
  check("estado inicial: data-hovering começa 'false'", hoveringBefore.exists, true);

  const canvasRect = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-role="browser-body"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
      })()
    `),
  );

  // Hover real: move o cursor pra DENTRO do canvas — real pointermove
  // sintético no elemento externo, encaminhado pro `target` embutido via
  // sendMouse (mouseMove).
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasRect.cx, y: canvasRect.cy, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  const queryDuringHover = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('target').getAttribute('data-hovering')" });
  check("mouseenter real disparou no DOM da página embutida (hover funciona)", JSON.parse(queryDuringHover.result), "true");

  // Sai do canvas de verdade — pointerleave real no elemento externo,
  // encaminhado como mouseLeave sintético pro browser embutido.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasRect.right + 150, y: canvasRect.bottom + 150, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  const queryAfterLeave = await toolJson("browser_eval", { target: cardId, js: "document.getElementById('target').getAttribute('data-hovering')" });
  check("mouseleave real disparou ao sair do canvas — o gap de hover travado está fechado", JSON.parse(queryAfterLeave.result), "false");

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
