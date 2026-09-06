// Pedido ao vivo (2026-08-31) — item 4: o botão de enviar só desabilitava
// durante a inferência, sem nenhum jeito de parar. `window.chat.cancel`
// (main/anthropic-client.ts, main/openai-client.ts) já existia — best-
// effort, aborta o stream em voo — mas nunca tinha UI. Fix: o mesmo botão
// de enviar vira um botão de parar (ícone/classe diferentes) enquanto
// `streaming !== null`, chamando `window.chat.cancel`; o texto parcial já
// gerado é commitado como a mensagem final (não descartado).
//
// Prova real: um endpoint local de verdade que streama devagar (chunks
// espaçados), dando uma janela real pra clicar em "parar" no meio da
// resposta — sem mock de `window.chat`, o clique dispara o IPC real, que
// aborta o fetch real contra este servidor.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-stop-button-${CDP_PORT}`, import.meta.url).pathname;

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

// Streams "um" then "dois" then "tres" then "quatro" then "cinco", ~600ms
// apart — long enough to click "parar" after a couple of chunks land, and
// NEVER sends [DONE]/finish_reason if the connection gets aborted first
// (confirms the client genuinely closed the connection, not that the
// server just happened to finish fast).
let requestClosed = false;
const chunks = ["um ", "dois ", "tres ", "quatro ", "cinco "];
const localModelServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= chunks.length) {
      res.write(`data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      clearInterval(timer);
      return;
    }
    res.write(
      `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: chunks[i] }, finish_reason: null }] })}\n\n`,
    );
    i++;
  }, 600);
  req.on("close", () => {
    requestClosed = true;
    clearInterval(timer);
  });
});
await new Promise((r) => localModelServer.listen(0, "127.0.0.1", r));
const localModelPort = localModelServer.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Stop Button Teste");
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
      setter.call(el, "conta devagar");
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const sendBtn = await centerOf(page, ".chat-send-btn");
  await page.click(sendBtn.x, sendBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  check("o botão de enviar virou um botão de parar durante a inferência", await page.evalJs(`!!document.querySelector('.chat-stop-btn')`), true);

  // Deixa 2 chunks reais chegarem (~1.2s) antes de parar.
  await new Promise((r) => setTimeout(r, 1300));
  const streamingTextBeforeStop = await page.evalJs(`document.querySelector('.chat-msg-md, .chat-msg-text')?.textContent ?? ''`);
  check("algum texto real já chegou via streaming antes de parar", streamingTextBeforeStop.trim().length > 0, true);

  const stopBtn = await centerOf(page, ".chat-stop-btn");
  await page.click(stopBtn.x, stopBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  check("o botão volta a ser o de enviar depois de parar", await page.evalJs(`!document.querySelector('.chat-stop-btn')`), true);
  check("a conexão real com o servidor foi genuinamente fechada (cancel real, não só UI)", requestClosed, true);

  // Nunca deixa passar dos 5 chunks — se passou, o abort não interrompeu
  // nada de verdade (o servidor só terminou sozinho antes do clique).
  const chunksReceivedBeforeStop = streamingTextBeforeStop.trim().split(" ").filter(Boolean).length;
  check("o abort aconteceu ANTES do servidor terminar sozinho (não é coincidência de timing)", chunksReceivedBeforeStop < chunks.length, true);

  const messages = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const card = cards.find((c) => c.kind === 'chat');
        return JSON.stringify(JSON.parse(card.messages_json).messages);
      })()
    `),
  );
  check("a mensagem do usuário foi commitada", messages.some((m) => m.role === "user" && m.content === "conta devagar"), true);
  const assistantMsg = messages.find((m) => m.role === "assistant");
  check("o texto PARCIAL gerado até o stop virou a mensagem final do assistente (não descartado)", assistantMsg?.content?.trim().length > 0, true);
  // Compara contra os chunks brutos que o servidor mandou até o momento do
  // stop (não o `.textContent` pós-render de Markdown, que normaliza
  // espaços diferente da string crua armazenada).
  check(
    "...e é exatamente os chunks recebidos até o clique (nem mais, nem menos)",
    assistantMsg?.content,
    chunks.slice(0, chunksReceivedBeforeStop).join(""),
  );
  check("...nunca chegou aos chunks depois do stop ('tres'/'quatro'/'cinco')", /tres|quatro|cinco/.test(assistantMsg?.content ?? ""), false);

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => localModelServer.close(r));
}
finish();
