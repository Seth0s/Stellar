// Pre-release audit B1 — `buildWriteConsent` (main/chat-tools.ts) used to
// silently treat an EXISTING file over `MAX_FILE_BYTES` (512KB) the same
// as a brand-new one: `readFile` returns `{ tooLarge: true }`, which fell
// through with `oldContent` left at `""`, so the diff shown to a human
// displayed the ENTIRE new content as pure addition ("new file"), when
// really a large real file was about to be silently overwritten. Fixed to
// refuse the write outright (no consent modal at all — an honest diff
// isn't possible without reading the file, which is exactly what the size
// limit exists to bound). Verifies against a REAL >512KB file on disk, via
// the same `chat.testSimulateTool` hook smoke-chat-tools.mjs already uses.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9442;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-write-consent-large-file", import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL("../../.verify-tmp/smoke-chat-write-consent-large-file-scratch/", import.meta.url));

rmSync(SCRATCH_ROOT, { recursive: true, force: true });
mkdirSync(SCRATCH_ROOT, { recursive: true });
const originalContent = "x".repeat(600 * 1024); // 600KB, over the 512KB MAX_FILE_BYTES limit
writeFileSync(`${SCRATCH_ROOT}big.txt`, originalContent);

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
  await bootIntoFreshSession(page, "Chat Write Consent Large File Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));
  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));

  const realCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'chat').id);
      })()
    `),
  );

  const writePromise = page.evalJs(`
    window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "write_file", { path: "big.txt", content: "tentativa de sobrescrever\\n" }, ${JSON.stringify(SCRATCH_ROOT)})
      .then(JSON.stringify)
  `);
  await new Promise((r) => setTimeout(r, 500));

  check("NO diff/consent modal ever appears for a write against an oversized existing file", await page.evalJs(`!document.querySelector('.chat-diff-block')`), true);

  const writeResult = JSON.parse(await writePromise);
  check("the write is refused outright (ok:false)", writeResult.ok, false);
  check("...with an honest reason naming the size limit, not a generic error", writeResult.text?.includes("512"), true);
  check(
    "the file's real content on disk is completely untouched (not silently overwritten)",
    readFileSync(`${SCRATCH_ROOT}big.txt`, "utf-8"),
    originalContent,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
