// Drop a PNG onto a live bash terminal: the absolute path is typed into
// the PTY (quoted, no Enter). Destination under the cursor owns the
// gesture — the empty canvas must NOT create a MediaCard.
import { existsSync } from "node:fs";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-file-drop-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal File Drop");
  await new Promise((r) => setTimeout(r, 800));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === "terminal")?.id ?? null);
      })()
    `),
  );
  check("bash terminal card exists", Boolean(cardId), true);

  await page.evalJs(`
    (() => {
      window.__rawPtyChunks = "";
      window.pty.onData((id, data) => { window.__rawPtyChunks += data; });
    })()
  `);

  // Synthetic PNG File (no OS path) — same path as image-paste: saveBytes
  // then type the resulting absolute path into the PTY.
  const dropResult = JSON.parse(
    await page.evalJs(`
      (async () => {
        const frame = document.querySelector('[data-kind="terminal"][data-card-id]');
        if (!frame) return JSON.stringify({ ok: false, reason: "no-frame" });
        const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], "drop.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        frame.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
        frame.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
        const highlighted = frame.className.includes("dropTarget") || /dropTarget/.test(frame.className);
        const dropEvt = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        const notPrevented = frame.dispatchEvent(dropEvt);
        return JSON.stringify({ ok: true, highlighted, notPrevented });
      })()
    `),
  );
  check("drop dispatched on terminal frame", dropResult.ok, true);
  check("drop was intercepted (preventDefault)", dropResult.notPrevented, false);
  await new Promise((r) => setTimeout(r, 900));

  const rawChunks = await page.evalJs(`window.__rawPtyChunks`);
  const pathMatch = String(rawChunks).match(/'(\/[^']*stellar-pastes\/[^']+\.png)'/);
  check("PTY received a single-quoted stellar-pastes image path", Boolean(pathMatch), true);
  const realPath = pathMatch?.[1] ?? "";
  check("dropped image file exists on disk", realPath !== "" && existsSync(realPath), true);
  check("no Enter was typed after the path (no trailing \\r right after path)", !String(rawChunks).includes(`${realPath}'\r`), true);

  const mediaCount = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.filter((c) => c.kind === "media").length);
      })()
    `),
  );
  check("drop on terminal did not create a MediaCard", mediaCount, 0);
} finally {
  await stopApp(app);
}
finish();
