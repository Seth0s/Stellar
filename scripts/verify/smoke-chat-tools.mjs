// DESIGN-BACKLOG.md item 12, Fase C — the read_file/write_file tool loop
// (main/chat-tools.ts), consent gate, and diff rendering. There's no real
// API key available to this harness, so getting a real model to actually
// request a tool call isn't possible here — this drives the exact same
// real `executeTool` a real tool_use response would, via the test-only
// `chat.testSimulateTool` IPC hook (main/index.ts, guarded inert in any
// packaged build — same precedent as updater.ts's `testEmitAvailable`).
// Everything downstream of "which tool got requested" is 100% real: real
// fs reads/writes (confined to a throwaway scratch dir, never the real
// project root — passed as an explicit `root` argument per call,
// independent of whatever cwd the card itself happens to have), a real
// `diff` package unified patch, and the real consent round trip through
// the mounted ChatCard's own event listeners.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-chat-tools-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL(`../../.verify-tmp/smoke-chat-tools-scratch-${CDP_PORT}/`, import.meta.url));

rmSync(SCRATCH_ROOT, { recursive: true, force: true });
mkdirSync(SCRATCH_ROOT, { recursive: true });
writeFileSync(`${SCRATCH_ROOT}hello.txt`, "linha original\n");

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Tools Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));
  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));

  // Real card id — read straight from the app's own board state, not
  // scraped from a DOM attribute (CardFrame doesn't expose one).
  const realCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'chat').id);
      })()
    `),
  );
  check("chat card id resolved", typeof realCardId === "string" && realCardId.length > 0, true);

  // The tool-activity/diff UI lives behind the "configure sua API key"
  // gate (real usage can never reach tool activity without one — chat:send
  // itself checks) — testSimulateTool bypasses chat:send entirely, so a
  // key needs saving here too, same as a real session would already have.
  await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-smoke-test-key")`);
  // item 38 added a "Sessões de chat" toggle BEFORE the API key button in
  // .card-head-actions — select by title, not position.
  await page.evalJs(`
    (() => {
      const b = document.querySelector('.chat-card .card-head-actions button[title="API key"]');
      b?.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  // ---- read_file: real content, real UI tool-line ----
  const readResult = JSON.parse(
    await page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "read_file", { path: "hello.txt" }, ${JSON.stringify(SCRATCH_ROOT)})
        .then(JSON.stringify)
    `),
  );
  check("read_file returns the real file content", readResult.ok && readResult.text === "linha original\n", true);
  await new Promise((r) => setTimeout(r, 200));
  check(
    "the UI shows a done tool-line for the read",
    await page.evalJs(`!!document.querySelector('.chat-tool-line.done:not(.error)')`),
    true,
  );

  // ---- write_file, NEW file, DENIED — file must not be created ----
  const denyPromise = page.evalJs(`
    window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "write_file", { path: "new.txt", content: "conteúdo novo\\n" }, ${JSON.stringify(SCRATCH_ROOT)})
      .then(JSON.stringify)
  `);
  await new Promise((r) => setTimeout(r, 400));
  check("a diff block appears for the write request", await page.evalJs(`!!document.querySelector('.chat-diff-block')`), true);
  check("...marked as a new file", await page.evalJs(`!!document.querySelector('.chat-diff-new')`), true);
  check(
    "...with the proposed content shown as added lines",
    await page.evalJs(`!!document.querySelector('.chat-diff-line.add')`),
    true,
  );
  const denyCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-deny'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(denyCoords.x, denyCoords.y);
  const denyResult = JSON.parse(await denyPromise);
  check("denied write reports ok:false", denyResult.ok, false);
  check("...and the file genuinely was not created on disk", existsSync(`${SCRATCH_ROOT}new.txt`), false);
  check("the denial shows as a one-line summary after resolving", await page.evalJs(`!document.querySelector('.chat-diff-block')`), true);

  // ---- write_file, EXISTING file, ALLOWED — real diff, real disk write ----
  const allowPromise = page.evalJs(`
    window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "write_file", { path: "hello.txt", content: "linha modificada\\n" }, ${JSON.stringify(SCRATCH_ROOT)})
      .then(JSON.stringify)
  `);
  await new Promise((r) => setTimeout(r, 400));
  check("existing-file write is NOT marked as new", await page.evalJs(`!document.querySelector('.chat-diff-new')`), true);
  check("diff shows both a removed and an added line", await page.evalJs(`!!document.querySelector('.chat-diff-line.del') && !!document.querySelector('.chat-diff-line.add')`), true);
  const allowCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-allow'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(allowCoords.x, allowCoords.y);
  const allowResult = JSON.parse(await allowPromise);
  check("allowed write reports ok:true", allowResult.ok, true);
  check("...and the file's real content on disk actually changed", readFileSync(`${SCRATCH_ROOT}hello.txt`, "utf-8"), "linha modificada\n");

  // ---- path escape — confine()'s protection, surfaced as a normal tool error ----
  const escapeResult = JSON.parse(
    await page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "read_file", { path: "../../../../etc/passwd" }, ${JSON.stringify(SCRATCH_ROOT)})
        .then(JSON.stringify)
    `),
  );
  check("a path-escape attempt is refused, not silently allowed", escapeResult.ok, false);

  // ---- second provider (openai) — real end-to-end plumbing, same proof
  // shape as smoke-chat.mjs's Anthropic check: a fake key against the
  // REAL api.openai.com endpoint must surface a real structured error,
  // not hang or silently no-op. ----
  const openaiBtnCoords = JSON.parse(
    await page.evalJs(`(() => { const b = [...document.querySelectorAll('.chat-provider-picker button')].find(x => x.textContent === 'openai'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(openaiBtnCoords.x, openaiBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  // item 31 — openai now gets a curated dropdown too, same as anthropic
  // (only "generic" stays free text — arbitrary user endpoint, no fixed
  // list makes sense there).
  check("switching provider swaps the model field to a curated openai dropdown", await page.evalJs(`!!document.querySelector('.chat-model-select')`), true);
  check("...and resets to the openai default model id", await page.evalJs(`document.querySelector('.chat-model-select')?.value`), "gpt-5.6-terra");
  check("switching provider re-shows the key form (no openai key saved yet)", await page.evalJs(`!!document.querySelector('.chat-key-form')`), true);

  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.chat-key-form input[type="password"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'sk-fake-smoke-test-key-000');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.chat-key-row button.primary'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(saveCoords.x, saveCoords.y);
  await new Promise((r) => setTimeout(r, 300));

  await page.evalJs(`
    (() => {
      const ta = document.querySelector('.chat-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'oi');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const sendCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.chat-send-btn'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(sendCoords.x, sendCoords.y);
  const deadline = Date.now() + 15000;
  let openaiErrored = false;
  while (Date.now() < deadline) {
    openaiErrored = JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.chat-error'))`));
    if (openaiErrored) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check("a fake key surfaces a real error from api.openai.com too, not a silent hang", openaiErrored, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
