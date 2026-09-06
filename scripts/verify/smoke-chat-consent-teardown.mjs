// Pre-release audit B2 — a pending write/bash consent (main/index.ts's
// `pendingWriteConsents`/`pendingBashConsents`) used to have no owner
// lifecycle: if the chat card asking for it closed, or the whole window
// reloaded, nothing would ever call `chat:write-resolve`/`chat:bash-resolve`
// for that request — the provider's tool loop (`await hooks.askWriteConsent`/
// `askBashConsent` in chat-tools.ts) would hang forever, since a human can
// never click a button that no longer exists. Fixed by resolving every
// pending consent owned by a card as DENIED the moment that card closes
// (`resolveConsentsForCard(cardId)`, wired to a new `chat:card-closed` IPC
// sent from App.tsx's `finalizeCloseCard`), and resolving EVERY pending
// consent as denied on any main-frame navigation/reload
// (`win.webContents.on("did-start-navigation", ...)` → `resolveConsentsForCard(null)`).
// Verifies both teardown paths live: real `testSimulateTool` calls that
// register a real pending consent (confirmed via the real diff/bash modal
// appearing), then real UI actions (clicking the real close button; a real
// CDP `Page.reload`) that must resolve them rather than leave them hanging.
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-consent-teardown-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL(`../../.verify-tmp/smoke-chat-consent-teardown-scratch-${CDP_PORT}/`, import.meta.url));

rmSync(SCRATCH_ROOT, { recursive: true, force: true });
mkdirSync(SCRATCH_ROOT, { recursive: true });

async function clickByTitle(page, title) {
  let coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title=${JSON.stringify(title)}]') || document.querySelector(\`button[title=${JSON.stringify(title)}]\`);
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
          const b = document.querySelector('[data-role="rail-add-card"]');
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
            const b = document.querySelector(\`.popover-row[title=${JSON.stringify(title)}]\`);
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

async function clickSelector(page, selector) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(coords.x, coords.y);
}

async function newChatCard(page) {
  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));
  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const chats = cards.filter((c) => c.kind === 'chat');
        return JSON.stringify(chats[chats.length - 1].id);
      })()
    `),
  );
  await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-smoke-test-key")`);
  await new Promise((r) => setTimeout(r, 200));
  // Only the FIRST card in a run mounts before any key exists — its own
  // `hasKey` effect auto-opens the key form (`showKeyForm=true`), which
  // needs closing so the messages/tool-activity view (where pendingWrite/
  // pendingBash actually render) is the one showing. A later card mounts
  // with the key already persisted, so its own effect leaves the form
  // closed already — toggling unconditionally would wrongly re-open it.
  if (JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.chat-card .chat-key-form'))`))) {
    await clickSelector(page, '.chat-card .card-head-actions button[title="API key"]');
    await new Promise((r) => setTimeout(r, 200));
  }
  return cardId;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Consent Teardown Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));

  // ---- Part 1: closing the chat card denies its pending WRITE consent ----
  const cardId1 = await newChatCard(page);
  check("card 1 id resolved", typeof cardId1 === "string" && cardId1.length > 0, true);

  await page.evalJs(`
    (() => {
      window.__b2WritePromise = window.chat.testSimulateTool(${JSON.stringify(cardId1)}, "write_file", { path: "closed-card.txt", content: "não deveria ser escrito\\n" }, ${JSON.stringify(SCRATCH_ROOT)});
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  check("a write consent modal is really pending before closing the card", await page.evalJs(`!!document.querySelector('.chat-diff-block')`), true);

  // Close button: last button in this ChatCard's own .card-head-actions
  // (no title attribute — the API key/sessions buttons before it do).
  await clickSelector(page, ".chat-card .card-head-actions button:last-child");
  await new Promise((r) => setTimeout(r, 400)); // close animation (180ms) + margin

  const race1 = await page.evalJs(`
    Promise.race([
      window.__b2WritePromise.then((r) => JSON.stringify({ timedOut: false, result: r })),
      new Promise((r) => setTimeout(() => r(JSON.stringify({ timedOut: true })), 3000)),
    ])
  `);
  const parsed1 = JSON.parse(race1);
  check("closing the card resolves the pending write consent instead of hanging", parsed1.timedOut, false);
  check("...as denied (ok:false)", parsed1.result?.ok, false);
  check("...and the file was genuinely never written", existsSync(`${SCRATCH_ROOT}closed-card.txt`), false);

  // ---- Part 2: a window reload denies a pending BASH consent ----
  const cardId2 = await newChatCard(page);
  check("card 2 id resolved", typeof cardId2 === "string" && cardId2.length > 0, true);

  await page.evalJs(`
    (() => {
      window.chat.testSimulateTool(${JSON.stringify(cardId2)}, "bash", { command: "echo deveria-ser-negado > marker.txt" }, ${JSON.stringify(SCRATCH_ROOT)})
        .then((r) => sessionStorage.setItem("b2BashResult", JSON.stringify(r)))
        .catch((e) => sessionStorage.setItem("b2BashResult", JSON.stringify({ ok: false, text: String(e) })));
      return true;
    })()
  `);
  let bashModalSeen = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.chat-bash-block'))`))) {
      bashModalSeen = true;
      break;
    }
  }
  check("a bash consent modal is really pending before reloading", bashModalSeen, true);

  await page.send("Page.enable");
  await page.send("Page.reload", { ignoreCache: false });

  // Wait for the app to actually come back up (same readiness signal
  // bootIntoFreshSession itself polls for) rather than a fixed sleep.
  let reloaded = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if (JSON.parse(await page.evalJs(`JSON.stringify(typeof window.store !== 'undefined' && !!document.body)`))) {
        reloaded = true;
        break;
      }
    } catch {
      // context still mid-navigation — keep polling
    }
  }
  check("the window actually finished reloading", reloaded, true);
  await new Promise((r) => setTimeout(r, 500));

  const bashResultRaw = await page.evalJs(`sessionStorage.getItem("b2BashResult")`);
  check("the pending bash consent resolved (not lost/still hanging) across the reload", typeof bashResultRaw === "string", true);
  const bashResult = bashResultRaw ? JSON.parse(bashResultRaw) : null;
  check("...as denied (ok:false)", bashResult?.ok, false);
  check("...and the command genuinely never ran", existsSync(`${SCRATCH_ROOT}marker.txt`), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
