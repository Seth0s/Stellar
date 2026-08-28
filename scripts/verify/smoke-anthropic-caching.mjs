// DESIGN-BACKLOG.md item 30 — user asked directly: the Messages API has
// no server-side session concept ("api key não tem sessão_id"), so
// "persistência real" only pays off cost-wise if prompt caching is
// actually wired up (Anthropic's `cache_control` breakpoints — OpenAI/
// Gemini cache automatically, no marker needed there). Before this,
// anthropic-client.ts sent zero `cache_control` anywhere — every turn of
// every conversation reprocessed the whole growing transcript at full
// price. Proof via a real mocked api.anthropic.com endpoint (SSE in
// Anthropic's actual event format, not assumed) — inspects the REAL
// request body the SDK sent, not the source code.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9456;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-anthropic-caching", import.meta.url).pathname;

let lastRequestBody = null;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequestBody = JSON.parse(body || "{}");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const msgStart = {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "oi do mock" } })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
// Real SDK behavior, not a Stellar-specific override — @anthropic-ai/sdk
// reads this env var itself (confirmed in its own .d.ts) to redirect
// every request, same mechanism a real deployment could use for a proxy.
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}
async function typeInto(page, selector, value) {
  const coords = await centerOf(page, selector);
  await page.click(coords.x, coords.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Anthropic Caching Teste");
  await new Promise((r) => setTimeout(r, 800));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  await typeInto(page, '.chat-key-form input[type="password"]', "sk-ant-fake-for-test");
  const saveBtn = await centerOf(page, ".chat-key-row button.primary");
  await page.click(saveBtn.x, saveBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  await typeInto(page, ".chat-composer textarea", "oi");
  const sendBtn = await centerOf(page, ".chat-send-btn");
  await page.click(sendBtn.x, sendBtn.y);
  await new Promise((r) => setTimeout(r, 1500));

  check("a request real bateu no endpoint mockado (não um no-op)", lastRequestBody !== null, true);

  const tools = lastRequestBody.tools ?? [];
  const lastTool = tools[tools.length - 1];
  const otherTools = tools.slice(0, -1);
  check("a última tool da lista (delegate_to_agent) tem cache_control ephemeral", lastTool?.cache_control?.type, "ephemeral");
  check(
    "...e as outras 3 tools NÃO têm cache_control (só um breakpoint no fim, não um por tool)",
    otherTools.every((t) => t.cache_control === undefined),
    true,
  );

  const lastMsg = lastRequestBody.messages?.[lastRequestBody.messages.length - 1];
  const lastBlock = Array.isArray(lastMsg?.content) ? lastMsg.content[lastMsg.content.length - 1] : null;
  check("a última mensagem vira um content block (não mais string pura)", Array.isArray(lastMsg?.content), true);
  check("...com cache_control ephemeral no último bloco", lastBlock?.cache_control?.type, "ephemeral");
  check("...e o texto real da mensagem sobrevive à conversão pra block", lastBlock?.text, "oi");

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
