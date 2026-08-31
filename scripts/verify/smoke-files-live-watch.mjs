import { promises as fs } from "node:fs";
import { join } from "node:path";
import { startApp, stopApp, bootIntoFreshSession, spawnCard, makeChecker, connectPage } from "./cdp-client.mjs";

const CDP_PORT = 9520 + Math.floor(Math.random() * 300);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-files-live-watch-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
await fs.mkdir(USER_DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, expr, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await page.evalJs(expr);
      if (res) return true;
    } catch {
      // transient expression error while rendering
    }
    await delay(150);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await bootIntoFreshSession(page, { name: "smoke-files-live-watch" });

  // 1. Spawn a FilesCard
  await spawnCard(page, "files");
  
  const cardMounted = await waitFor(
    page,
    `(() => !!document.querySelector(".files-tree"))()`,
    5000,
  );
  check("files card mounted", cardMounted, true);

  // 2. Obtain the root folder path from the FilesCard footer
  const rootDir = await page.evalJs(`
    (() => {
      const el = document.querySelector(".files-card-foot-text");
      return el?.textContent || "";
    })()
  `);
  check("files card root dir found", !!rootDir && rootDir.length > 0, true);

  // 3. Write a new file externally to that directory
  const testFileName = `agent-live-${Date.now()}.txt`;
  const testFilePath = join(rootDir, testFileName);
  await fs.writeFile(testFilePath, "Hello live watcher!", "utf8");

  // 4. Verify that the new file automatically appears in the tree without clicking or manual reload
  const appeared = await waitFor(
    page,
    `(() => {
      const nodes = Array.from(document.querySelectorAll(".files-node-name"));
      return nodes.some(n => n.textContent === "${testFileName}");
    })()`,
    5000,
  );
  check("new file appeared in files tree automatically via live watch", appeared, true);

  // 5. Delete the file externally
  await fs.unlink(testFilePath);

  // 6. Verify that the file automatically disappears from the tree
  const disappeared = await waitFor(
    page,
    `(() => {
      const nodes = Array.from(document.querySelectorAll(".files-node-name"));
      return !nodes.some(n => n.textContent === "${testFileName}");
    })()`,
    5000,
  );
  check("deleted file disappeared from files tree automatically via live watch", disappeared, true);

  finish();
} finally {
  await stopApp(app);
}
