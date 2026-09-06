// DESIGN-BACKLOG.md item 28 — Gemini + generic OpenAI-compatible provider
// no cluster de providers do ChatCard. Prova real, sem mock: os IPCs de
// secrets/chat de verdade, com um endpoint HTTP local de verdade fazendo
// o papel de "modelo local" (Ollama/vLLM-like) pro provider genérico —
// não um endpoint fake nunca chamado, um servidor Node real respondendo
// no protocolo Chat Completions.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-providers-${CDP_PORT}`, import.meta.url).pathname;

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

// A real HTTP server speaking the OpenAI Chat Completions shape — plays
// the role of a local model endpoint (Ollama/vLLM-style). Records the
// request it actually received so the test can assert the real client hit
// THIS endpoint (baseURL routing genuinely worked), not just that it
// didn't crash.
let lastRequest = null;
const localModelServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body || "{}") };
    // The real client always requests `stream: true` (openai-client.ts's
    // `.chat.completions.stream()`) — a plain JSON response here isn't a
    // valid double for a real OpenAI-compatible endpoint, the SDK's
    // streaming parser just sees zero SSE chunks and errors ("request
    // ended without sending any chunks", found empirically writing this
    // test). Real SSE framing, same shape any actual endpoint sends.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "olá do modelo local de teste" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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
  await bootIntoFreshSession(page, "Chat Providers Teste");
  await new Promise((r) => setTimeout(r, 600));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  // ---- 1. Gemini aparece no picker e vira o provider ativo ----
  await clickButtonWithText(page, ".chat-provider-picker button", "gemini");
  await new Promise((r) => setTimeout(r, 300));
  const geminiActive = await page.evalJs(
    `[...document.querySelectorAll('.chat-provider-picker button')].find((b) => b.textContent.trim() === 'gemini')?.className`,
  );
  check("gemini fica marcado como provider ativo no picker", geminiActive?.includes("active"), true);
  // item 31 — gemini agora ganha dropdown curado (não mais campo livre),
  // mesmo padrão que anthropic já tinha.
  const geminiModel = await page.evalJs(`document.querySelector('.chat-model-select')?.value`);
  check("trocar pra gemini já preenche um modelo default sensato", geminiModel, "gemini-3.7-flash");

  // ---- 2. custom (generic): exige endpoint, salva key+baseURL, e o
  // round-trip real de chat bate no endpoint configurado ----
  await clickButtonWithText(page, ".chat-provider-picker button", "custom");
  await new Promise((r) => setTimeout(r, 300));

  const saveBtn = await centerOf(page, ".chat-key-form button.primary");
  await page.click(saveBtn.x, saveBtn.y); // sem endpoint/key ainda — deve ficar desabilitado, não fazer nada
  await new Promise((r) => setTimeout(r, 200));
  const stillShowingForm = await page.evalJs(`!!document.querySelector('.chat-key-form')`);
  check("botão salvar fica desabilitado sem endpoint+key pro provider custom", stillShowingForm, true);

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
  const saveBtn2 = await centerOf(page, ".chat-key-form button.primary");
  await page.click(saveBtn2.x, saveBtn2.y);
  await new Promise((r) => setTimeout(r, 400));
  const formGoneAfterSave = await page.evalJs(`!document.querySelector('.chat-key-form')`);
  check("form fecha depois de salvar endpoint+key do provider custom", formGoneAfterSave, true);

  // Persistência real: getBaseURL devolve o que foi salvo (não é
  // otimista/local-only).
  const savedBaseUrl = await page.evalJs(`window.secrets.getBaseURL('generic')`);
  check("baseURL do provider custom foi persistido de verdade (lido de volta via IPC)", savedBaseUrl, `http://127.0.0.1:${localModelPort}/v1`);

  // Manda uma mensagem real — o cliente OpenAI-compatible precisa bater
  // no endpoint configurado, não em api.openai.com.
  const modelInput = await centerOf(page, ".chat-model-input");
  await page.click(modelInput.x, modelInput.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.chat-model-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, "test-local-model");
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
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
  await new Promise((r) => setTimeout(r, 2500));

  check("a request de chat real bateu no endpoint local configurado (não api.openai.com)", lastRequest !== null, true);
  check("...com o modelo correto no corpo da request", lastRequest?.body?.model, "test-local-model");
  const assistantReply = await page.evalJs(`[...document.querySelectorAll('.chat-msg.assistant')].map((el) => el.textContent).join(' | ')`);
  check("...e a resposta real do endpoint local apareceu na UI", assistantReply?.includes("olá do modelo local de teste"), true);

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => localModelServer.close(r));
}
finish();
