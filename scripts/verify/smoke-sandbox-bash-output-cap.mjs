// Pre-release audit B4 — `runSandboxedBash` (main/sandbox.ts) used to
// append EVERY stdout/stderr chunk to an unbounded string for the whole
// life of the child process, only slicing to `MAX_OUTPUT_CHARS` at
// `close`. A command printing tens of MB inside the sandbox made main's
// own heap grow proportionally for as long as the command kept running
// (up to the full 60s `BASH_TIMEOUT_MS` budget), even though only the
// first 20KB would ever be shown. Fixed to cap the buffer AS DATA
// ARRIVES and ignore every chunk past the cap.
//
// Verifies live, via a real `chat.testSimulateTool` bash call approved
// through the real consent modal (not a direct sandbox.ts unit call —
// this exercises the full chat-tools.ts → askBashConsent → sandbox.ts
// path an actual agent would use): a command that genuinely prints 50MB
// inside the bwrap sandbox (1) still returns a truncated, bounded result
// (not the full 50MB), and (2) main's own real heap
// (`process.memoryUsage().heapUsed`, via a new test-only
// `debug:heap-used-mb` IPC) does not grow anywhere near 50MB while
// capturing it.
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-sandbox-bash-output-cap-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL(`../../.verify-tmp/smoke-sandbox-bash-output-cap-scratch-${CDP_PORT}/`, import.meta.url));

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sandbox Bash Output Cap Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));

  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));
  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'chat').id);
      })()
    `),
  );
  await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-smoke-test-key")`);
  await new Promise((r) => setTimeout(r, 200));
  await clickSelector(page, '.chat-card .card-head-actions button[title="API key"]');
  await new Promise((r) => setTimeout(r, 200));

  const heapBefore = JSON.parse(await page.evalJs(`window.debugBridge.heapUsedMb().then(JSON.stringify)`));
  check("baseline heap reading looks sane", typeof heapBefore === "number" && heapBefore > 0, true);

  const resultPromise = page.evalJs(`
    window.chat.testSimulateTool(${JSON.stringify(cardId)}, "bash", { command: "yes | head -c 50000000" }, ${JSON.stringify(SCRATCH_ROOT)})
      .then(JSON.stringify)
  `);
  await new Promise((r) => setTimeout(r, 500));
  check("a bash consent modal is really pending", await page.evalJs(`!!document.querySelector('.chat-bash-block')`), true);
  await clickSelector(page, ".chat-diff-allow");

  const result = JSON.parse(await resultPromise);
  check("the command reports success (real 50MB pipe, real exit code 0)", result.ok, true);
  check(
    "the returned text is capped near MAX_OUTPUT_CHARS (20000), nowhere close to the real 50MB produced",
    result.text.length < 21_000,
    true,
  );
  check("...marked as truncated", result.text.includes("[truncado]"), true);

  const heapAfter = JSON.parse(await page.evalJs(`window.debugBridge.heapUsedMb().then(JSON.stringify)`));
  const heapGrowthMb = heapAfter - heapBefore;
  check(
    `main's real heap grew by ${heapGrowthMb.toFixed(1)}MB capturing a 50MB command, nowhere near proportional`,
    heapGrowthMb < 15,
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
