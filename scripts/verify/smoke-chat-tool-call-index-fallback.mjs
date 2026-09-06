// Pedido ao vivo (2026-08-31) — item 3: "erro: Chat completion stream
// contains an invalid tool call index: undefined, mesmo a api ter sido
// usada (vi o uso), não renderiza corretamente." Achado ao vivo: o SDK
// `openai` reconstrói tool_calls de um stream pelo campo `delta.tool_calls[
// ].index`, e joga um erro seco (`ChatCompletionStream.ts`'s "invalid tool
// call index") se algum endpoint "compatível" (confirmado real com gemini
// via GEMINI_OPENAI_BASE_URL) manda esse campo faltando — mesmo já tendo
// processado a chamada real no servidor (billing genuíno, resposta nunca
// renderizada). Fix (`openai-client.ts`): esse erro específico dispara um
// fallback pra uma chamada NÃO-streaming da MESMA requisição — sem parsing
// incremental pra quebrar nesse gap específico.
//
// Prova real: um endpoint local que streama um tool_call SEM `index` (a
// causa raiz exata) — o SDK deve jogar o erro internamente — e cujo
// fallback não-streaming (`stream` ausente/false no corpo) devolve uma
// resposta de texto simples válida. Confirma que a mensagem chega
// renderizada em vez do card travar em erro.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-tool-call-index-fallback-${CDP_PORT}`, import.meta.url).pathname;

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

let streamingRequests = 0;
let nonStreamingRequests = 0;
const localModelServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (parsed.stream) {
      streamingRequests++;
      // A causa raiz exata: um delta de tool_call SEM `index` — non-
      // conformante com o spec real da OpenAI, mas exatamente o que foi
      // visto ao vivo vindo de um endpoint "compatível" real.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "t",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      nonStreamingRequests++;
      // O fallback não-streaming — resposta de texto simples válida,
      // provando que o card renderiza algo real em vez de travar no erro.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "t",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "resposta real via fallback não-streaming" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    }
  });
});
await new Promise((r) => localModelServer.listen(0, "127.0.0.1", r));
const localModelPort = localModelServer.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Tool Call Fallback Teste");
  await new Promise((r) => setTimeout(r, 600));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  await clickButtonWithText(page, ".chat-provider-picker button", "custom");
  await new Promise((r) => setTimeout(r, 300));
  const baseUrlInput = await centerOf(page, '.chat-key-form input[type="text"]');
  await page.click(baseUrlInput.x, baseUrlInput.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.chat-key-form input[type="text"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(`http://127.0.0.1:${localModelPort}/v1`)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const keyInput = await centerOf(page, '.chat-key-form input[type="password"]');
  await page.click(keyInput.x, keyInput.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.chat-key-form input[type="password"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, "local-fake-key");
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveBtn = await centerOf(page, ".chat-key-form button.primary");
  await page.click(saveBtn.x, saveBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  const composer = await centerOf(page, ".chat-composer textarea");
  await page.click(composer.x, composer.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.chat-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, "oi");
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const sendBtn = await centerOf(page, ".chat-send-btn");
  await page.click(sendBtn.x, sendBtn.y);
  await new Promise((r) => setTimeout(r, 2000));

  check("o endpoint recebeu a request streaming original (a que quebra)", streamingRequests, 1);
  check("...e o fallback não-streaming foi disparado depois do erro do SDK", nonStreamingRequests, 1);
  check("nenhum erro apareceu na UI (o card não travou travado)", await page.evalJs(`!document.querySelector('.chat-error')`), true);
  const assistantReply = await page.evalJs(`[...document.querySelectorAll('.chat-msg.assistant')].map((el) => el.textContent).join(' | ')`);
  check("a resposta real do fallback apareceu renderizada na UI", assistantReply?.includes("resposta real via fallback não-streaming"), true);

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => localModelServer.close(r));
}
finish();
