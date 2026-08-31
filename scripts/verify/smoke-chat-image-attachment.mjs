// DESIGN-BACKLOG.md 2.1 — "Chatbox — Suporte a Imagens e Anexos no
// Composer" (itens 65.5/66), segundo item da lista priorizada aprovada
// pelo usuário em 2026-08-31 (item 1, flicker no drag, já concluído).
//
// Decisão de arquitetura tomada implementando: `ChatMessage.content` vira
// `string | ChatContentBlock[]`, mas o bloco de imagem guarda só um PATH
// em disco (mesmo diretório `stellar-pastes` que `useTerminal.ts` já usa
// pro terminal) — NUNCA base64 persistido em `messages_json`. O main
// process (anthropic-client.ts/openai-client.ts) só lê o arquivo e
// converte pra base64 na hora de montar a request de verdade.
//
// Prova real, sem mock: um servidor HTTP local de verdade fazendo o papel
// de endpoint OpenAI-compatible (mesma técnica de smoke-chat-providers.mjs)
// — a request que ELE recebe de verdade precisa conter um `image_url` com
// um data URI base64 real, provando que o path virou bytes de verdade na
// hora certa. Paste E drop testados via o mesmo truque de
// ClipboardEvent/DragEvent sintético com DataTransfer+File já usado por
// smoke-terminal-links-paste.mjs/smoke-terminal-image-mask.mjs.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9485;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-image-attachment", import.meta.url).pathname;

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
async function setInputValue(page, selector, value) {
  const el = await centerOf(page, selector);
  await page.click(el.x, el.y);
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

let lastRequest = null;
const localModelServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequest = { url: req.url, body: JSON.parse(body || "{}") };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "vi a imagem" }, finish_reason: null }] })}\n\n`,
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
  await bootIntoFreshSession(page, "Chat Anexo Teste");
  await new Promise((r) => setTimeout(r, 600));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  await clickButtonWithText(page, ".chat-provider-picker button", "custom");
  await new Promise((r) => setTimeout(r, 300));
  await setInputValue(page, '.chat-key-form input[type="text"]', `http://127.0.0.1:${localModelPort}/v1`);
  await setInputValue(page, '.chat-key-form input[type="password"]', "local-fake-key");
  const saveBtn = await centerOf(page, ".chat-key-form button.primary");
  await page.click(saveBtn.x, saveBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  await setInputValue(page, ".chat-model-input", "test-local-model");

  // ---- 1. paste de imagem no composer vira um anexo pendente (preview), sem mandar nada ainda ----
  // Não usa o clipboard do SO aqui de propósito (diferente do terminal) —
  // o composer é uma textarea comum, `clipboardData.items`/`getAsFile()`
  // já entrega um `File` de verdade sintetizado no próprio evento, sem
  // precisar tocar `window.clipboardImage.save()`.
  const dispatchPaste = JSON.parse(
    await page.evalJs(`
      (async () => {
        const textarea = document.querySelector('.chat-composer textarea');
        // 1x1 PNG vermelho real (mesmo usado por clipboard-image.ts's
        // testWriteClipboardImage) — o paste sintético do COMPOSER usa um
        // File de verdade, não depende do clipboard do SO.
        const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], "anexo.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = textarea.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("paste de imagem no composer é interceptado (preventDefault chamado)", dispatchPaste, false);
  await new Promise((r) => setTimeout(r, 600));

  const strip1 = await page.evalJs(`document.querySelectorAll('.chat-attachment-thumb').length`);
  check("um anexo pendente aparece na tira do composer, ANTES de enviar", strip1, 1);
  check("...e a mensagem ainda NÃO foi enviada (nenhuma request bateu no endpoint)", lastRequest === null, true);

  // ---- 2. drop de uma SEGUNDA imagem também vira anexo (drag-and-drop) ----
  const dispatchDrop = JSON.parse(
    await page.evalJs(`
      (async () => {
        const textarea = document.querySelector('.chat-composer textarea');
        const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], "anexo2.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const evt = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        const notPrevented = textarea.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("drop de imagem no composer também é interceptado (preventDefault chamado)", dispatchDrop, false);
  await new Promise((r) => setTimeout(r, 600));
  const strip2 = await page.evalJs(`document.querySelectorAll('.chat-attachment-thumb').length`);
  check("agora são 2 anexos pendentes (paste + drop)", strip2, 2);

  // ---- 3. remover um anexo funciona ----
  const removeBtn = await centerOf(page, ".chat-attachment-remove");
  await page.click(removeBtn.x, removeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const stripAfterRemove = await page.evalJs(`document.querySelectorAll('.chat-attachment-thumb').length`);
  check("remover um anexo pendente funciona (volta pra 1)", stripAfterRemove, 1);

  // ---- 4. envia texto + o anexo restante — request real bate no endpoint com um content block de imagem ----
  await setInputValue(page, ".chat-composer textarea", "o que tem nessa imagem?");
  const sendBtn = await centerOf(page, ".chat-send-btn");
  await page.click(sendBtn.x, sendBtn.y);
  await new Promise((r) => setTimeout(r, 2000));

  check("a request de chat real bateu no endpoint local (com a imagem)", lastRequest !== null, true);
  const lastUserMsg = lastRequest?.body?.messages?.findLast?.((m) => m.role === "user");
  check("...o content da última mensagem do usuário virou um ARRAY de blocos (texto + imagem)", Array.isArray(lastUserMsg?.content), true);
  const textBlock = lastUserMsg?.content?.find?.((b) => b.type === "text");
  const imageBlock = lastUserMsg?.content?.find?.((b) => b.type === "image_url");
  check("...com o bloco de texto certo", textBlock?.text, "o que tem nessa imagem?");
  check("...e um bloco image_url com um data URI base64 REAL (não um path, não vazio)", imageBlock?.image_url?.url?.startsWith("data:image/png;base64,") && imageBlock.image_url.url.length > 100, true);

  const attachmentsClearedAfterSend = await page.evalJs(`document.querySelectorAll('.chat-attachment-thumb').length`);
  check("a tira de anexos pendentes esvazia depois de enviar", attachmentsClearedAfterSend, 0);

  const assistantReply = await page.evalJs(`[...document.querySelectorAll('.chat-msg.assistant')].map((el) => el.textContent).join(' | ')`);
  check("a resposta real do endpoint apareceu na UI", assistantReply?.includes("vi a imagem"), true);

  // ---- 5. a mensagem ENVIADA (bolha do usuário) também mostra a miniatura de verdade, lida de volta via IPC ----
  await new Promise((r) => setTimeout(r, 400));
  const sentImgSrc = await page.evalJs(`document.querySelector('.chat-msg.user .chat-msg-image')?.getAttribute('src')`);
  check("a bolha enviada mostra a miniatura real (data URI, lida de volta do disco via IPC)", sentImgSrc?.startsWith("data:image/png;base64,"), true);

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => localModelServer.close(r));
}
finish();
