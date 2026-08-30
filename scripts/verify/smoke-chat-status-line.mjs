// DESIGN-BACKLOG.md item 57 ponto 7 — chatbox tinha nenhuma noção de
// status: sem duração de turno, sem contagem de tokens/contexto. Prova
// real, sem mock: um endpoint HTTP local de verdade (mesmo papel de
// "modelo local" que smoke-chat-providers.mjs já estabeleceu) responde com
// um `usage` de verdade no formato real de streaming da OpenAI
// (`stream_options.include_usage`, chunk final com `choices: []` +
// `usage`), e o teste confirma que ESSE número real (não estimado) aparece
// na status-line renderizada, e que a request real enviada pelo cliente
// pediu `stream_options: {include_usage: true}` (sem isso, a resposta
// nunca carrega usage nenhum — confirmado nos tipos do SDK da OpenAI).
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9466;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-status-line", import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}
async function clickButtonWithText(page, selector, text) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!coords) throw new Error(`button with text "${text}" not found in ${selector}`);
  await page.click(coords.x, coords.y);
}
function setControlledValue(selector, propType, value) {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.${propType}.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `;
}

const REAL_INPUT_TOKENS = 1234;
const REAL_OUTPUT_TOKENS = 56;

let lastRequest = null;
const localModelServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    lastRequest = { body: JSON.parse(body || "{}") };
    // Artificial delay — a truly instant local round-trip leaves no
    // reliable window to observe the "still in flight" live status text
    // below before it's already replaced by the final one.
    await new Promise((r) => setTimeout(r, 600));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "resposta de teste com usage real" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    // Real shape of a streamed OpenAI usage chunk (only sent when the
    // request carries `stream_options.include_usage: true`): empty
    // `choices`, top-level `usage`.
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: REAL_INPUT_TOKENS, completion_tokens: REAL_OUTPUT_TOKENS, total_tokens: REAL_INPUT_TOKENS + REAL_OUTPUT_TOKENS } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => localModelServer.listen(0, "127.0.0.1", r));
const localModelPort = localModelServer.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Status Line Teste");
  await new Promise((r) => setTimeout(r, 600));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const initialStatus = await page.evalJs(`document.querySelector('.chat-foot-status')?.textContent ?? null`);
  check("nenhuma status-line antes do primeiro turno (nada fabricado)", initialStatus, null);

  // Configura o provider "custom" apontando pro servidor local — mesmo
  // fluxo de smoke-chat-providers.mjs.
  await clickButtonWithText(page, ".chat-provider-picker button", "custom");
  await new Promise((r) => setTimeout(r, 300));
  const baseUrlInput = await centerOf(page, '.chat-key-form input[type="text"]');
  await page.click(baseUrlInput.x, baseUrlInput.y);
  await page.evalJs(setControlledValue('.chat-key-form input[type="text"]', "HTMLInputElement", `http://127.0.0.1:${localModelPort}/v1`));
  const keyInput = await centerOf(page, '.chat-key-form input[type="password"]');
  await page.click(keyInput.x, keyInput.y);
  await page.evalJs(setControlledValue('.chat-key-form input[type="password"]', "HTMLInputElement", "local-fake-key"));
  const saveBtn = await centerOf(page, ".chat-key-form button.primary");
  await page.click(saveBtn.x, saveBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  const composer = await centerOf(page, ".chat-composer textarea");
  await page.click(composer.x, composer.y);
  await page.evalJs(setControlledValue(".chat-composer textarea", "HTMLTextAreaElement", "oi"));

  const sendBtn = await centerOf(page, ".chat-send-btn");
  await page.click(sendBtn.x, sendBtn.y);
  await new Promise((r) => setTimeout(r, 350));
  const liveStatus = await page.evalJs(`document.querySelector('.chat-foot-status')?.textContent ?? null`);
  check("enquanto a resposta está em voo, a status-line mostra tempo decorrido ao vivo", /^\d+\.\ds$/.test(liveStatus ?? ""), true);

  await new Promise((r) => setTimeout(r, 2000));

  check(
    "a request real pediu stream_options.include_usage (sem isso o usage nunca chega)",
    lastRequest?.body?.stream_options?.include_usage,
    true,
  );

  const finalStatus = await page.evalJs(`document.querySelector('.chat-foot-status')?.textContent ?? null`);
  check(
    "status-line final mostra os tokens de contexto/resposta REAIS vindos do servidor (não estimados)",
    finalStatus?.includes("1.2k in / 56 out"),
    true,
  );
  check("...com uma duração no formato Ns.s", /^\d+\.\ds/.test(finalStatus ?? ""), true);

  const statusTitle = await page.evalJs(`document.querySelector('.chat-foot-status')?.title ?? null`);
  check(
    "o title (tooltip) do status detalha os números reais por extenso",
    statusTitle?.includes(`${REAL_INPUT_TOKENS} tokens de contexto`) && statusTitle?.includes(`${REAL_OUTPUT_TOKENS} tokens de resposta`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => localModelServer.close(r));
}
finish();
