// Rail "Mídia" — human path: click the rail item → OS file dialog → card
// with content. Native `dialog.showOpenDialog` cannot be driven by CDP
// (same limit as `fs:pick-directory` / `export:capture-rect-test`).
//
// What this proves:
//   1. The rail popover exposes `[data-kind="media"]`.
//   2. Clicking it runs `addMediaCardFromPicker` → `pickMediaFile`.
//   3. `pickMediaFileTestNext(path)` arms the NEXT real pick IPC in main
//      (contextBridge freezes `window.fs` — in-page replacement is a no-op).
//      Same `resolvePickedMediaFile` / `decideSpawnMediaPath` as after a
//      real dialog returns a path; then board-assets copy + visible card
//      with `naturalWidth > 0`.
//   4. Screenshot of the card (not toast / pill).
//   5. Armed cancel (`""`) creates no ghost card.
//
// What this does NOT prove:
//   - That the OS dialog chrome actually opens on screen (CDP cannot
//     click native dialogs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  spawnCard,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-rail-media-pick-${CDP_PORT}`, import.meta.url).pathname;
const FIXTURES_DIR = new URL(`../../.verify-tmp/smoke-rail-media-pick-fixtures-${CDP_PORT}`, import.meta.url).pathname;
const SHOTS_DIR = new URL(`../../.verify-tmp/smoke-rail-media-pick-shots-${CDP_PORT}`, import.meta.url).pathname;

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(FIXTURES_DIR, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });
const pngPath = join(FIXTURES_DIR, "rail-pick.png");
// Distinct teal so the shot is obviously content, not an empty chrome shell.
writeFileSync(pngPath, makePng(160, 100, [20, 160, 140]));

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Rail Media Pick", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 400));

  // Arm the NEXT real `pickMediaFile` IPC in main (contextBridge freezes
  // `window.fs` — in-page replacement of pickMediaFile is a no-op).
  const seamOk = JSON.parse(
    await page.evalJs(`
      (async () => {
        if (typeof window.fs?.pickMediaFileTestNext !== "function") {
          return JSON.stringify({ ok: false, error: "no test seam" });
        }
        const r = await window.fs.pickMediaFileTestNext(${JSON.stringify(pngPath)});
        return JSON.stringify(r);
      })()
    `),
  );
  check("seam de teste pickMediaFileTestNext armado", seamOk.ok, true);

  await spawnCard(page, "media");
  // createMediaCardFromPath is async (copy + natural size).
  let appeared = false;
  for (let i = 0; i < 40; i++) {
    appeared = JSON.parse(
      await page.evalJs(`JSON.stringify(!!document.querySelector('[data-kind="media"]'))`),
    );
    if (appeared) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("card media nasceu após clique no rail + caminho injetado", appeared, true);

  const content = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = document.querySelector('[data-kind="media"]');
        if (!card) return JSON.stringify({ ok: false, error: "no card" });
        const r = card.getBoundingClientRect();
        const inView = r.width > 40 && r.height > 40 && r.bottom > 0 && r.right > 0
          && r.top < window.innerHeight && r.left < window.innerWidth;
        const img = card.querySelector('[data-role="media-content"] img, img');
        const naturalWidth = img ? img.naturalWidth : 0;
        const complete = img ? img.complete : false;
        return JSON.stringify({
          ok: true,
          inView,
          naturalWidth,
          complete,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      })()
    `),
  );
  check("card media está na viewport", content.inView, true);

  // Wait for the image decode if the card is there but pixels not yet ready.
  let naturalWidth = content.naturalWidth ?? 0;
  for (let i = 0; i < 30 && !(naturalWidth > 0); i++) {
    await new Promise((r) => setTimeout(r, 100));
    const again = JSON.parse(
      await page.evalJs(`
        (() => {
          const img = document.querySelector('[data-kind="media"] img');
          return JSON.stringify({ naturalWidth: img ? img.naturalWidth : 0 });
        })()
      `),
    );
    naturalWidth = again.naturalWidth;
  }
  check("conteúdo da imagem visível (naturalWidth > 0)", naturalWidth > 0, true);

  const shotPath = join(SHOTS_DIR, "rail-media-pick.png");
  const clip = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-kind="media"]');
        if (!el) return JSON.stringify(null);
        el.click();
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        return JSON.stringify({
          x: Math.max(0, r.x),
          y: Math.max(0, r.y),
          width: Math.min(r.width, vw - Math.max(0, r.x)),
          height: Math.min(r.height, vh - Math.max(0, r.y)),
          scale: window.devicePixelRatio || 1,
        });
      })()
    `),
  );
  check("clip do card para screenshot", !!clip && clip.width > 0, true);
  if (clip) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png", clip, fromSurface: true });
    writeFileSync(shotPath, Buffer.from(data, "base64"));
    check("screenshot escrito", true, true);
    console.log(`SHOT ${shotPath}`);
  }

  // Cancel contract: `""` arms a simulated dialog cancel (returns null);
  // no new card, no toast path.
  const beforeCancel = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-kind="media"]').length)`),
  );
  await page.evalJs(`(async () => { await window.fs.pickMediaFileTestNext(""); return true; })()`);
  await spawnCard(page, "media");
  await new Promise((r) => setTimeout(r, 400));
  const afterCancel = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-kind="media"]').length)`),
  );
  check("cancelar o diálogo não cria card fantasma", afterCancel, beforeCancel);
} finally {
  await stopApp(app);
}
finish();
