// Pendentes #188, achado ao vivo — `centeredSlot`'s collision ring-search
// (board-model.ts) walks a new card's slot outward to dodge an existing
// one, up to ~720px per axis. Three 860×660 browser cards spawned
// back-to-back at a 1280×800 window collide badly enough that the ring
// search lands the newest one almost a full card-height below the fold,
// with nothing to pan the view back to it — the user clicks "add", nothing
// visibly happens. addTerminalCard/addCardOfKind (App.tsx) now recenter on
// the new card whenever it lands off-center; this guards that stays fixed.
//
// 2026-09-14 — same gap on the AGENT path: `spawnCardFor` used the same
// slot math but never called focusCard. Recentering on EVERY agent spawn
// would steal the human's viewport whenever any background card created
// something; policy is focus only after an explicit Permitir (allowAsk).
// Sticky stays auto-approved (toast + Compass) — this smoke exercises
// `kind:"files"`, which still goes through AgentAskModal.
import { mkdirSync, writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-card-spawn-offscreen-${CDP_PORT}`, import.meta.url).pathname;
const SHOTS_DIR = new URL(`../../.verify-tmp/smoke-card-spawn-offscreen-shots-${CDP_PORT}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Offscreen Spawn Smoke");
  await delay(500);

  async function spawnBrowserFromRail() {
    const addBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('[data-role="rail-add-card"]');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(addBtn.x, addBtn.y);
    await delay(300);
    const browserBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.popover-row')].find((x) => x.dataset.kind === 'browser');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(browserBtn.x, browserBtn.y);
    await delay(700);
  }

  // Same viewport-vs-card-size collision that originally triggered the bug:
  // 3 full-size browser cards spawned in a row at the same viewport center.
  await spawnBrowserFromRail();
  await spawnBrowserFromRail();
  await spawnBrowserFromRail();

  const viewport = JSON.parse(await page.evalJs(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`));
  const rects = JSON.parse(
    await page.evalJs(`
      (() => {
        const frames = [...document.querySelectorAll('[data-kind="browser"]')];
        return JSON.stringify(frames.map((f) => {
          const r = f.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }));
      })()
    `),
  );

  const last = rects[rects.length - 1];
  const lastCenterInView = last.cx >= 0 && last.cx <= viewport.w && last.cy >= 0 && last.cy <= viewport.h;
  check("the most recently rail-spawned browser card lands with its center in viewport", lastCenterInView, true);

  // --- agent spawn_card (files) after human Permitir must also land in view ---
  const bashId = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-kind="terminal"]');
        return JSON.stringify(el?.dataset?.cardId ?? el?.getAttribute('data-id') ?? null);
      })()
    `),
  );
  // Prefer MCP list_cards — DOM data-attr shape varies.
  const listed = JSON.parse((await callTool("list_cards", {})).content[0].text);
  const callerId = listed.cards.find((c) => c.kind === "terminal")?.id ?? bashId;
  check("have a terminal caller for spawn_card", typeof callerId, "string");

  const pending = callTool("spawn_card", { kind: "files", callerCardId: callerId, reason: "offscreen-smoke" });
  await delay(600);
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await pending).content[0].text);
  check("agent spawn_card files (Permitir) resolves ok", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  await delay(700);

  const filesGeom = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-kind="files"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          vw: window.innerWidth,
          vh: window.innerHeight,
        });
      })()
    `),
  );
  check("files card exists in DOM after approved agent spawn", filesGeom !== null, true);
  const filesCenterInView =
    filesGeom && filesGeom.cx >= 0 && filesGeom.cx <= filesGeom.vw && filesGeom.cy >= 0 && filesGeom.cy <= filesGeom.vh;
  check("approved agent-spawned files card has its center in viewport (not toast-only)", filesCenterInView, true);
  // Content must occupy screen pixels — not merely a topbar pill / toast.
  const overlapsViewport =
    filesGeom && filesGeom.right > 40 && filesGeom.bottom > 40 && filesGeom.left < filesGeom.vw - 40 && filesGeom.top < filesGeom.vh - 40;
  check("approved agent-spawned files card overlaps the viewport with real content area", overlapsViewport, true);

  mkdirSync(SHOTS_DIR, { recursive: true });
  const shotPath = `${SHOTS_DIR}/agent-files-in-view.png`;
  const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(shotPath, Buffer.from(data, "base64"));
  check("live screenshot written (agent files visible)", Buffer.from(data, "base64").length > 10_000, true);
  console.log(`screenshot: ${shotPath}`);

  page.close();
} finally {
  await stopApp(app);
}
finish();
