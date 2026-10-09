/**
 * Smoke: FilesCard IDE shell (Codigo.dc.html V6) — activity rail + side title.
 * Isolated instance only.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startApp,
  stopApp,
  connectPage,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-code-ide-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let app = null;
try {
  app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
  });
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Code IDE smoke", { spawnTerminal: false });
  await delay(400);

  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Code IDE smoke') ?? boards[0];
      await window.store.upsert({
        id: 'codeide1',
        board_id: board.id,
        kind: 'files',
        provider: '',
        cwd: ${JSON.stringify(ROOT)},
        x: 40, y: 40, w: 900, h: 600,
        resume_id: null, model: null, effort: null, system_prompt: null,
        group_id: null, label: 'Files',
        updated_at: Date.now(),
      });
    })()
  `);
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await delay(300);
  await page.evalJs(`
    [...document.querySelectorAll('.home-session-name')]
      .find((e) => e.textContent.trim().includes('Code IDE smoke'))?.click()
  `);
  await delay(1000);

  const ok = await page.evalJs(`!!document.querySelector('[aria-label="Painéis"]')`);
  if (!ok) throw new Error("activity rail missing");
  const filesBtn = await page.evalJs(`!!document.querySelector('[aria-label="Arquivos"], [aria-label="Files"]')`);
  if (!filesBtn) throw new Error("Arquivos rail button missing");

  console.log("smoke-code-card-ide: ok");
  await stopApp(app);
  process.exit(0);
} catch (err) {
  console.error("smoke-code-card-ide: FAIL", err);
  try {
    if (app) await stopApp(app);
  } catch {
    /* ignore */
  }
  process.exit(1);
}
