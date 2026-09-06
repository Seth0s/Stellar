// DESIGN-BACKLOG.md item 12, Fase B — the chatbox card. Exercises the REAL
// plumbing end to end: safeStorage-backed key persistence (main/secrets.ts),
// the chat:send/token/done/error IPC contract (main/anthropic-client.ts),
// card creation via the real rail button, and sqlite persistence of the
// message history across a board reload.
//
// Deliberately does NOT prove real Anthropic API compatibility — there's no
// real key available to this harness, and spending real API budget isn't
// this suite's job (see AGENTS.md's changelog entry for this phase). A
// fake key against the real api.anthropic.com endpoint is used instead:
// this still exercises the real HTTPS/TLS path and the SDK's real error
// shape end-to-end, just via the expected-auth-failure branch rather than
// a real completion. A human should do one real send with a real key
// before trusting this against production traffic.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-${CDP_PORT}`, import.meta.url).pathname;

async function clickByTitle(page, title) {
  let coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title=${JSON.stringify(title)}]') || document.querySelector(\`button[title="\${${JSON.stringify(title)}}"]\`);
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!coords) {
    const addBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('.rail-btn[title="Adicionar card"]');
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (addBtn) {
      await page.click(addBtn.x, addBtn.y);
      await new Promise((r) => setTimeout(r, 250));
      coords = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector(\`.popover-row[title="\${${JSON.stringify(title)}}"]\`);
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
          })()
        `),
      );
    }
  }
  if (!coords) throw new Error(`no button titled "${title}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));

  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));
  check("a chat card appears on the board", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 1);
  check("no API key yet → the key-entry form shows instead of the composer", await page.evalJs(`!!document.querySelector('.chat-key-form')`), true);
  check("composer is hidden until a key is set", await page.evalJs(`!document.querySelector('.chat-composer')`), true);

  // Key round-trip through the real safeStorage-backed store (main/secrets.ts).
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.chat-key-form input[type="password"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'sk-ant-fake-smoke-test-key-000');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.chat-key-row button.primary');
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(saveCoords.x, saveCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  check("key form closes once a key is saved", await page.evalJs(`!document.querySelector('.chat-key-form')`), true);
  check("composer is now visible", await page.evalJs(`!!document.querySelector('.chat-composer')`), true);

  const hasKeyNow = JSON.parse(await page.evalJs(`window.secrets.hasKey('anthropic').then(JSON.stringify)`));
  check("secrets:has reports the key is now stored", hasKeyNow, true);

  // Send a real message — real user text gets committed immediately
  // (before any response), same as the "never lose what you typed" design.
  await page.evalJs(`
    (() => {
      const ta = document.querySelector('.chat-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'diga oi');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const sendCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.chat-send-btn');
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(sendCoords.x, sendCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  check("the user's own message renders immediately", await page.evalJs(`document.querySelector('.chat-msg.user')?.textContent`), "diga oi");
  check("a thinking indicator shows while the (fake-key) request is in flight", await page.evalJs(`!!document.querySelector('.chat-thinking-dots')`), true);

  // The fake key means the real api.anthropic.com call fails — either with
  // a real 401 (network reachable) or a connection error (sandboxed/no
  // egress). Either way chat:error must fire and the UI must show it, not
  // hang forever on the thinking indicator.
  const deadline = Date.now() + 15000;
  let errored = false;
  while (Date.now() < deadline) {
    errored = JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.chat-error'))`));
    if (errored) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check("a fake key surfaces a real error from the API call, not a silent hang", errored, true);
  check("the thinking indicator clears once the error lands", await page.evalJs(`!document.querySelector('.chat-thinking-dots')`), true);

  // Model picker — real sqlite persistence, not just local state.
  await page.evalJs(`
    (() => {
      const sel = document.querySelector('.chat-model-select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'claude-opus-5');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  // Reload the RENDERER only (Page.reload — same app process, same sqlite
  // connection alive in main) and confirm the user's message AND the
  // chosen model survived a real round trip through the store, not just
  // React state. NOT a full app restart: `startApp` unconditionally wipes
  // `userDataDir` on every call (see its own doc comment) specifically so
  // separate test runs never leak state into each other — exactly the
  // property that would defeat a real persistence check here.
  await page.send("Page.enable");
  await page.send("Page.reload");
  await new Promise((r) => setTimeout(r, 1500));
  const openCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.home-session-card');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!openCoords) throw new Error("no session card on Home after reload");
  await page.click(openCoords.x, openCoords.y);
  await new Promise((r) => setTimeout(r, 800));
  check(
    "after a renderer reload, the persisted user message is still there",
    await page.evalJs(`document.querySelector('.chat-msg.user')?.textContent`),
    "diga oi",
  );
  check(
    "...and the model choice persisted too",
    await page.evalJs(`document.querySelector('.chat-model-select')?.value`),
    "claude-opus-5",
  );
  page.close();
} finally {
  await stopApp(app);
}
finish();
