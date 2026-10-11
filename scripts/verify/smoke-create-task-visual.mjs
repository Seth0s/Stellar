/**
 * Visual + functional smoke for CreateTask modal.
 * Side-by-side: prototype HTML vs the real React CreateTaskModal (vite harness).
 * Functional pass: isolated Electron — more-options opens the modal; createFull persists.
 * Prints ONLY in /tmp/criartask-v3/. Never the owner's running app.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootIntoFreshSession,
  connectPage,
  makeChecker,
  pickFreePort,
  startApp,
  stopApp,
} from "./cdp-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = "/tmp/criartask-v3";
const PROTO = join(ROOT, "docs/design/app-v3/prototipo");
const HARNESS_OUT = join(OUT, "harness");

mkdirSync(OUT, { recursive: true });

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sideBySide(left, right, out) {
  try {
    execFileSync("magick", [left, right, "+append", "-background", "#05060a", "-gravity", "North", out], {
      stdio: "pipe",
    });
  } catch {
    execFileSync("convert", [left, right, "+append", out], { stdio: "pipe" });
  }
}

function startStatic(port, getBody) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const got = getBody(urlPath);
    if (!got) {
      res.writeHead(404);
      res.end("no " + urlPath);
      return;
    }
    res.writeHead(200, { "Content-Type": got.type });
    res.end(got.body);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

function fileType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

async function shot(page, name) {
  const abs = join(OUT, name);
  writeFileSync(abs, Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  return abs;
}

async function cropEl(page, selector, name) {
  const box = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "null";
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()`),
  );
  const out = join(OUT, name);
  if (!box) {
    await shot(page, name);
    return out;
  }
  const res = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, 1440 - box.x),
      height: Math.min(box.height, 900 - box.y),
      scale: 1,
    },
  });
  writeFileSync(out, Buffer.from(res.data, "base64"));
  return out;
}

async function waitFor(page, expr, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* */
    }
    await delay(150);
  }
  return false;
}

// ---- build React harness (real CreateTaskModal) ----
console.log("building CreateTaskModal harness…");
execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules/vite/bin/vite.js"),
    "build",
    "--config",
    join(ROOT, "scripts/verify/create-task-harness.vite.config.ts"),
  ],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, CRIARTASK_HARNESS_OUT: HARNESS_OUT } },
);

const harnessHtml = readdirSync(HARNESS_OUT).find((f) => f.endsWith(".html"));
if (!harnessHtml) throw new Error("harness build produced no html");

const { check, finish } = makeChecker();

const staticPort = await pickFreePort();
const srv = startStatic(staticPort, (urlPath) => {
  if (urlPath === "/CriarTask.dc.html" || urlPath === "/proto.html") {
    return { type: "text/html; charset=utf-8", body: readFileSync(join(PROTO, "CriarTask.dc.html")) };
  }
  if (urlPath === "/support.js") {
    const p = join(PROTO, "support.js");
    return { type: "text/javascript", body: existsSync(p) ? readFileSync(p) : Buffer.from("") };
  }
  // harness assets: / , /assets/*, /index.html, create-task-harness.html
  let rel = urlPath;
  if (rel === "/" || rel === "/app.html") rel = "/" + harnessHtml;
  const file = join(HARNESS_OUT, rel.replace(/^\//, ""));
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return { type: fileType(file), body: readFileSync(file) };
});
await srv.listen();

const userData = mkdtempSync(join(tmpdir(), "stellar-criartask-"));
const cdpPort = await pickFreePort();
let app = await startApp({ cdpPort, userDataDir: userData, preserveUserData: true, isolatedHome: true });

try {
  const page = await connectPage(cdpPort);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ---- Prototype filled ----
  await page.send("Page.navigate", { url: `${srv.origin}/CriarTask.dc.html` });
  await delay(1200);
  await shot(page, "proto-filled.png");
  const protoCrop = await cropEl(page, '[role="dialog"]', "proto-crop.png");
  const protoStyles = JSON.parse(
    await page.evalJs(`(() => {
      const s = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), fontSize: cs.fontSize, fontWeight: cs.fontWeight, borderRadius: cs.borderRadius, background: cs.backgroundColor };
      };
      const dialog = document.querySelector('[role="dialog"]');
      const cta = [...document.querySelectorAll("button")].find((b) => /^(Criar|Criar e despachar|Criar e reservar)$/.test((b.textContent||"").trim()));
      const preview = [...document.querySelectorAll("h2")].find((h) => h.textContent === "O agente recebe")?.parentElement?.querySelector(".mono, [style*='pre-line']");
      const where = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Onde aparece");
      const pathInput = document.querySelector('input[placeholder="+ caminho ou glob"]');
      const previsualizar = [...document.querySelectorAll("button")].find((b) => (b.textContent||"").includes("Pré-visualizar"));
      const listBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label")||"") === "Lista");
      const checkBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label")||"") === "Checklist");
      return JSON.stringify({
        dialog: s(dialog), cta: s(cta),
        hasPreviewBlock: !!preview, hasWhere: !!where, hasPathInput: !!pathInput,
        hasPrevisualizar: !!previsualizar, hasList: !!listBtn, hasChecklist: !!checkBtn,
      });
    })()`),
  );

  async function shotAppMode(mode, cropName, fullName) {
    await page.send("Page.navigate", { url: `${srv.origin}/app.html?mode=${mode}` });
    const ok = await waitFor(page, `!!document.querySelector('[data-part="create-task-modal"]')`, 20000);
    check(`react modal mounts (${mode})`, ok, true);
    await delay(500);
    // Ensure mode applied (query param on first load; also call setter)
    await page.evalJs(`window.__setCreateTaskState && window.__setCreateTaskState(${JSON.stringify(mode)})`);
    await delay(400);
    await shot(page, fullName);
    return cropEl(page, '[data-part="create-task-modal"]', cropName);
  }

  const appFilledCrop = await shotAppMode("filled", "app-crop-filled.png", "app-filled.png");
  const appEmptyCrop = await shotAppMode("empty", "app-crop-empty.png", "app-empty.png");
  const appReactiveCrop = await shotAppMode("reactive", "app-crop-reactive.png", "app-reactive-cta.png");

  const appStyles = JSON.parse(
    await page.evalJs(`(() => {
      const s = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), fontSize: cs.fontSize, fontWeight: cs.fontWeight, borderRadius: cs.borderRadius, background: cs.backgroundColor };
      };
      const dialog = document.querySelector('[data-part="create-task-modal"]');
      const cta = document.querySelector('[data-part="create-task-submit"]');
      const preview = document.querySelector('[data-part="create-task-preview"]');
      const previewText = preview?.textContent || "";
      const where = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Onde aparece");
      const pathInput = document.querySelector('input[placeholder="+ caminho ou glob"]');
      const previsualizar = document.querySelector('[data-part="create-task-preview-toggle"]');
      const listBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label")||"") === "Lista");
      const checkBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label")||"") === "Checklist");
      const close = document.querySelector('[data-part="create-task-close"]');
      const closeIsXHeavy = (close?.textContent || "").includes("✕");
      return JSON.stringify({
        dialog: s(dialog), cta: s(cta),
        previewHasTerritory: previewText.includes("território:"),
        previewHasGates: previewText.includes("gates:"),
        previewHasReport: previewText.includes("report:"),
        hasWhere: !!where, hasPathInput: !!pathInput,
        hasPrevisualizar: !!previsualizar, hasList: !!listBtn, hasChecklist: !!checkBtn,
        closeUsesHeavyX: closeIsXHeavy,
        ctaText: (cta?.textContent || "").trim(),
      });
    })()`),
  );

  check("app preview has territory", appStyles.previewHasTerritory, true);
  check("app preview has gates", appStyles.previewHasGates, true);
  check("app preview has report", appStyles.previewHasReport, true);
  check("app has Onde aparece", appStyles.hasWhere, true);
  check("app has + caminho input", appStyles.hasPathInput, true);
  check("app has Pré-visualizar", appStyles.hasPrevisualizar, true);
  check("app has Lista •", appStyles.hasList, true);
  check("app has Checklist ☐", appStyles.hasChecklist, true);
  check("app close is not heavy X", appStyles.closeUsesHeavyX, false);
  check("reactive CTA", appStyles.ctaText, "Criar e despachar");

  sideBySide(protoCrop, appFilledCrop, join(OUT, "side-by-side-filled.png"));
  sideBySide(join(OUT, "proto-filled.png"), join(OUT, "app-filled.png"), join(OUT, "side-by-side-filled-full.png"));
  sideBySide(appEmptyCrop, appFilledCrop, join(OUT, "side-by-side-empty-vs-filled.png"));
  sideBySide(appFilledCrop, appReactiveCrop, join(OUT, "side-by-side-reactive-cta.png"));

  const table = {
    proto: protoStyles,
    app: appStyles,
    deltas: {
      dialogWidth: (appStyles.dialog?.width ?? 0) - (protoStyles.dialog?.width ?? 0),
      dialogHeight: (appStyles.dialog?.height ?? 0) - (protoStyles.dialog?.height ?? 0),
    },
    component: "CreateTaskModal (React, vite harness)",
  };
  writeFileSync(join(OUT, "parity-styles.json"), JSON.stringify(table, null, 2));
  console.log(JSON.stringify({ parity: table }, null, 2));
} finally {
  if (app) await stopApp(app).catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

// ---- Functional: second isolated app (real Stellar UI + IPC) ----
const userData2 = mkdtempSync(join(tmpdir(), "stellar-criartask-fn-"));
const cdpPort2 = await pickFreePort();
let app2 = await startApp({ cdpPort: cdpPort2, userDataDir: userData2, preserveUserData: true, isolatedHome: true });
let persist = { ok: false };
try {
  const page2 = await connectPage(cdpPort2);
  await page2.send("Page.enable");
  await page2.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await bootIntoFreshSession(page2, "CreateTask", { spawnTerminal: false });
  await delay(1000);

  const hasCreateFull = await page2.evalJs(`typeof window.tasks?.createFull === "function"`);
  check("window.tasks.createFull wired", hasCreateFull, true);

  const openedQuick = await page2.evalJs(`(() => {
    if (typeof window.__stellarOpenQuickTask === "function") {
      window.__stellarOpenQuickTask({ destination: "board", title: "Smoke create full" });
      return "quick";
    }
    const more = document.querySelector('[data-part="create-task-more"]');
    if (more) { more.click(); return "fila-more"; }
    return null;
  })()`);
  await delay(700);

  let modalOpen = await waitFor(page2, `!!document.querySelector('[data-part="create-task-modal"]')`, 8000);
  if (!modalOpen && openedQuick === "quick") {
    const clicked = await page2.evalJs(`(() => {
      const b = document.querySelector('[data-part="board-quick-detail"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check("clicked board-quick-detail (more options)", clicked, true);
    modalOpen = await waitFor(page2, `!!document.querySelector('[data-part="create-task-modal"]')`, 10000);
  }
  if (!modalOpen) {
    // Fila path: ensure create-task-more
    await page2.evalJs(`(() => {
      const btn = document.querySelector('[data-part="queue-new-task"]');
      if (btn) btn.click();
    })()`);
    await delay(500);
    await page2.evalJs(`(() => {
      const more = document.querySelector('[data-part="create-task-more"]');
      if (more) more.click();
    })()`);
    modalOpen = await waitFor(page2, `!!document.querySelector('[data-part="create-task-modal"]')`, 10000);
  }
  check("more-options opens CreateTaskModal", modalOpen, true);
  await shot(page2, "app-live-mais-opcoes.png");

  persist = JSON.parse(
    await page2.evalJs(`(async () => {
      const boards = await window.store.boards.list();
      const boardId = boards?.[0]?.id;
      if (!boardId) return JSON.stringify({ ok: false, error: "no board" });
      const before = await window.tasks.listByBoard(boardId);
      const res = await window.tasks.createFull({
        boardId,
        prompt: "Smoke persist CreateTask\\n\\nBriefing de prova",
        purpose: "fix",
        territory: ["src/renderer/src/CreateTaskModal.tsx"],
        gates: ["npm run check:types"],
        reportSchema: ["filesChanged", "gatesOutput"],
        allowCommit: false,
        review: "wanted",
        provider: "claude",
        deps: [],
        maxRetries: 2,
        fallbackProviders: [],
        cwd: null,
      });
      const after = await window.tasks.listByBoard(boardId);
      return JSON.stringify({
        ok: !!res?.ok,
        taskId: res?.taskId ?? null,
        error: res?.error ?? null,
        grew: after.length > before.length,
        found: after.some((t) => t.id === res?.taskId),
        boardId,
      });
    })()`),
  );
  check("createFull ok", persist.ok, true);
  check("task persisted on board", !!(persist.found || persist.grew), true);
} finally {
  if (app2) await stopApp(app2).catch(() => {});
  await srv.close().catch(() => {});
  rmSync(userData2, { recursive: true, force: true });
}

writeFileSync(
  join(OUT, "smoke-results.json"),
  JSON.stringify(
    {
      ok: true,
      persist,
      screenshots: [
        "proto-filled.png",
        "proto-crop.png",
        "app-empty.png",
        "app-filled.png",
        "app-reactive-cta.png",
        "app-live-mais-opcoes.png",
        "side-by-side-filled.png",
        "side-by-side-filled-full.png",
        "side-by-side-empty-vs-filled.png",
        "side-by-side-reactive-cta.png",
      ].map((f) => join(OUT, f)),
      parity: JSON.parse(readFileSync(join(OUT, "parity-styles.json"), "utf8")),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ persist }, null, 2));
console.log("smoke-create-task-visual: ok →", OUT);
finish();
