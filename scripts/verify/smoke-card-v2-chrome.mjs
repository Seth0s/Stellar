import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, connectPageRaw, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOTYPE_PATH = join(PROJECT_ROOT, "docs/design/app-v3/prototipo/Cards.dc.html");
const OUT_DIR = join(tmpdir(), "stellar-cards-v2-comparison");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = join(tmpdir(), `stellar-cards-v2-${CDP_PORT}`);
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-cards-v2-git-"));
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(OUT_DIR, { recursive: true });

const sourceServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Card V2 fixture</title><main>fixture local para o smoke</main>");
});
await new Promise((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/configuracoes`;

execFileSync("git", ["init", "-b", "main", SCRATCH_DIR], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "Stellar Smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
writeFileSync(join(SCRATCH_DIR, "README.md"), "Card chrome fixture\n");
execFileSync("git", ["-C", SCRATCH_DIR, "add", "README.md"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "fixture"], { stdio: "ignore" });
writeFileSync(join(SCRATCH_DIR, "README.md"), "Card chrome fixture\nchanged\n");
writeFileSync(join(SCRATCH_DIR, "new-file.ts"), "export const fixture = true;\n");

let app;
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await bootIntoFreshSession(page, "Cards V2 chrome", { spawnTerminal: false });
  await wait(400);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Cards V2 chrome") ?? boards[0];
    if (!board) throw new Error("no board after bootIntoFreshSession");
    return JSON.stringify(board.id);
  })`));
  const imageResult = JSON.parse(await page.evalJs(`window.boardAssets.copyFromPath(${JSON.stringify(boardId)}, ${JSON.stringify(join(PROJECT_ROOT, "build/icon.png"))}).then((result) => JSON.stringify(result))`));
  check("isolated board accepted a copied local image fixture", imageResult.ok, true);
  if (!imageResult.ok) throw new Error(`copyFromPath failed: ${imageResult.error}`);

  const now = Date.now();
  const row = (id, kind, cwd, w, h, extra = {}) => ({
    id,
    board_id: boardId,
    kind,
    provider: "",
    cwd,
    x: 60,
    y: 60,
    w,
    h,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: id.replace("v2-", ""),
    updated_at: now,
    messages_json: null,
    archived_at: null,
    ...extra,
  });
  const browserOwnerId = "v2-terminal";
  const mediaData = JSON.stringify({ assetPath: imageResult.path, rotation: 0, view: { zoom: 1, panX: 0, panY: 0 } });
  const rows = [
    row(browserOwnerId, "terminal", SCRATCH_DIR, 560, 380, { provider: "bash", label: "IMPL · bash" }),
    row("v2-browser", "browser", sourceUrl, 560, 380, { provider: browserOwnerId }),
    row("v2-files", "files", SCRATCH_DIR, 300, 380),
    row("v2-changes", "changes", SCRATCH_DIR, 420, 300),
    row("v2-sticky", "sticky", "Cards esquecem report → lembrete automático.", 360, 230, {
      provider: "yellow", model: "preview", system_prompt: "14", updated_at: now - 120_000,
    }),
    row("v2-chat", "chat", SCRATCH_DIR, 560, 380, {
      provider: "generic", model: null, messages_json: JSON.stringify({ messages: [] }),
    }),
    row("v2-media", "media", mediaData, 560, 380, { provider: "image" }),
    row("v2-task", "task", "", 560, 380),
  ];
  await page.evalJs(`(async () => { for (const card of ${JSON.stringify(rows)}) await window.store.upsert(card); return true; })()`);

  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  let homeReady = false;
  for (let i = 0; i < 80; i++) {
    homeReady = await page.evalJs(`!!document.querySelector(".home-session-card")`);
    if (homeReady) break;
    await wait(100);
  }
  if (!homeReady) throw new Error("Home session list did not appear after fixture rows were inserted");
  const sessionClicked = await page.evalJs(`(() => {
    const name = [...document.querySelectorAll(".home-session-name")].find((item) => item.textContent.includes("Cards V2 chrome"));
    const button = name?.closest("button") ?? [...document.querySelectorAll(".home-session-card")].find((item) => item.innerText.includes("Cards V2 chrome"));
    button?.click();
    return !!button;
  })()`);
  if (!sessionClicked) throw new Error("Cards V2 chrome session card was not found on Home");

  const expectedKinds = ["terminal", "browser", "files", "changes", "sticky", "chat", "media", "task"];
  const implementationReady = await page.evalJs(`new Promise((resolve) => { const start = Date.now(); const poll = () => { const found = ${JSON.stringify(expectedKinds)}.every((kind) => document.querySelector('.card-frame[data-card-id^="v2-"][data-kind="' + kind + '"]')); if (found || Date.now() - start > 12000) resolve(found); else setTimeout(poll, 100); }; poll(); })`);
  check("one real app card of every V2 kind is mounted", implementationReady, true);
  if (!implementationReady) throw new Error("Not all fixture cards mounted after reopening the isolated board");
  await wait(900);

  const chromeMetrics = JSON.parse(await page.evalJs(`JSON.stringify(${JSON.stringify(expectedKinds)}.map((kind) => {
    const frame = document.querySelector('.card-frame[data-card-id^="v2-"][data-kind="' + kind + '"]');
    const head = frame?.querySelector(".card-head");
    const foot = frame?.querySelector(".card-foot");
    const icon = frame?.querySelector(".card-head-icon");
    return {
      kind,
      head: head ? Number.parseFloat(getComputedStyle(head).height) : null,
      foot: foot ? Number.parseFloat(getComputedStyle(foot).height) : null,
      icon: icon ? [Number.parseFloat(getComputedStyle(icon).width), Number.parseFloat(getComputedStyle(icon).height)] : null,
    };
  }))`));
  check("all eight headers measure 42px", chromeMetrics.map((item) => item.head), (values) => values.length === 8 && values.every((value) => value === 42));
  check("all eight footers measure 28px", chromeMetrics.map((item) => item.foot), (values) => values.length === 8 && values.every((value) => value === 28));
  check("all eight type tiles measure 24×24px", chromeMetrics.map((item) => item.icon), (values) => values.length === 8 && values.every((value) => value?.[0] === 24 && value?.[1] === 24));
  const browserStatusReady = await page.evalJs(`new Promise((resolve) => { const start = Date.now(); const poll = () => { const code = document.querySelector('[data-card-id="v2-browser"] .card-foot-status')?.textContent?.trim(); if (code === "200" || Date.now() - start > 8000) resolve(code === "200"); else setTimeout(poll, 100); }; poll(); })`);
  check("browser footer receives the measured HTTP 200 response", browserStatusReady, true);
  check("media image footer receives natural dimensions", await page.evalJs(`!!document.querySelector('[data-card-id="v2-media"] .card-foot')?.textContent?.match(/\\d+ × \\d+/)`), true);
  check("sticky footer uses the persisted update timestamp", await page.evalJs(`document.querySelector('[data-card-id="v2-sticky"] .card-foot')?.textContent?.includes("editada há 2 min")`), true);

  async function showOnly(id, focused) {
    const rect = JSON.parse(await page.evalJs(`(() => {
      for (const frame of document.querySelectorAll(".card-frame")) {
        frame.style.display = "none";
        frame.dataset.focused = "false";
      }
      const frame = document.querySelector('.card-frame[data-card-id="${id}"]');
      if (!frame) return JSON.stringify(null);
      frame.style.display = "flex";
      frame.style.left = "100px";
      frame.style.top = "100px";
      frame.dataset.focused = ${JSON.stringify(String(focused))};
      return JSON.stringify(frame.getBoundingClientRect().toJSON());
    })()`));
    if (!rect) throw new Error(`Could not position ${id} for capture`);
    // Body ResizeObserver + delayed fits need a couple frames after display:flex.
    await wait(400);
    return rect;
  }

  const terminalIconOk = await page.evalJs(`(() => {
    const icon = document.querySelector('[data-card-id="v2-terminal"] .card-head-icon svg');
    return !!icon && icon.getBoundingClientRect().width >= 10;
  })()`);
  check("terminal type tile renders a visible SVG glyph", terminalIconOk, true);
  const terminalPill = await page.evalJs(`document.querySelector('[data-card-id="v2-terminal"] .card-head-status')?.textContent?.trim() ?? ""`);
  check("terminal status pill uses a short untruncated label", terminalPill, (text) => text === "rodando" || text === "trabalhando" || text.startsWith("saiu ") || text === "erro");

  const cases = [
    { kind: "terminal", id: "v2-terminal", width: 560, height: 380, sourceLabel: "Card de terminal" },
    { kind: "browser", id: "v2-browser", width: 560, height: 380, sourceLabel: "Card de navegador" },
    { kind: "files", id: "v2-files", width: 300, height: 380, sourceLabel: "Card de arquivos" },
    { kind: "changes", id: "v2-changes", width: 420, height: 300, sourceLabel: "Card de mudanças" },
    { kind: "sticky", id: "v2-sticky", width: 360, height: 230, sourceLabel: "Nota" },
    { kind: "chat", id: "v2-chat", width: 560, height: 380, sourceLabel: null },
    { kind: "media", id: "v2-media", width: 560, height: 380, sourceLabel: null },
    { kind: "task", id: "v2-task", width: 560, height: 380, sourceLabel: null },
  ];
  const implementationClips = new Map();
  for (const item of cases) {
    for (const focused of [false, true]) {
      const rect = await showOnly(item.id, focused);
      const result = await page.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      implementationClips.set(`${item.kind}:${focused}`, Buffer.from(result.data, "base64"));
    }
  }

  // Proof that xterm fills the body after chrome 42/28: cols/rows must track the body box.
  // Refresh the focused terminal clip AFTER the fit proof write so the side-by-side
  // pair shows the body filled, not the pre-write scrollback-only frame.
  const terminalProofRect = await showOnly("v2-terminal", true);
  await page.evalJs(`window.pty.write(${JSON.stringify("v2-terminal")}, ${JSON.stringify("printf '%s\\n' 'FIT-PROOF line fills the terminal body width _______________________________'; echo COLS_ROWS_PROBE\r")}, "human")`);
  await wait(500);
  const fitProof = JSON.parse(await page.evalJs(`(() => {
    const body = document.querySelector('[data-card-id="v2-terminal"] [data-role="terminal-body"]');
    const dims = window.__getTerminalDims("v2-terminal");
    const br = body?.getBoundingClientRect();
    const screen = body?.querySelector(".xterm-screen");
    const sr = screen?.getBoundingClientRect();
    return JSON.stringify({
      body: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
      screen: sr ? { w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      cols: dims?.cols ?? null,
      rows: dims?.rows ?? null,
    });
  })()`));
  check("terminal body is shorter than the card by the 42+28 chrome", fitProof.body?.h, (h) => h != null && h <= 380 - 70 + 2 && h >= 380 - 70 - 8);
  // Floor-to-cell leaves at most one cell of unused width/height on the trailing edge.
  check("terminal xterm screen fills the body width", { screen: fitProof.screen, body: fitProof.body }, (pair) => !!pair.screen && !!pair.body && Math.abs(pair.screen.w - pair.body.w) <= 12);
  check("terminal xterm screen fills the body height", { screen: fitProof.screen, body: fitProof.body }, (pair) => !!pair.screen && !!pair.body && Math.abs(pair.screen.h - pair.body.h) <= 16);
  check("terminal PTY cols track body width (> 60 at 560px card)", fitProof.cols, (cols) => typeof cols === "number" && cols >= 60);
  check("terminal PTY rows track body height (> 12 at 380px card)", fitProof.rows, (rows) => typeof rows === "number" && rows >= 12);
  writeFileSync(join(OUT_DIR, "terminal-fit-proof.json"), JSON.stringify(fitProof, null, 2));
  {
    const shot = await page.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: { x: terminalProofRect.x, y: terminalProofRect.y, width: terminalProofRect.width, height: terminalProofRect.height, scale: 1 },
    });
    const buf = Buffer.from(shot.data, "base64");
    writeFileSync(join(OUT_DIR, "terminal-fit-proof.png"), buf);
    implementationClips.set("terminal:true", buf);
  }
  const changesPill = await page.evalJs(`(() => {
    const frame = document.querySelector('[data-card-id="v2-changes"]');
    if (frame) { frame.style.display = "flex"; }
    return document.querySelector('[data-card-id="v2-changes"] .card-head-status')?.textContent?.trim() ?? "";
  })()`);
  check("changes status pill keeps full «não commitado»", changesPill, "não commitado");
  page.close();

  const fontFaces = [
    ...[400, 500, 600, 700].map((weight) => ["Space Grotesk", weight, `@fontsource/space-grotesk/files/space-grotesk-latin-${weight}-normal.woff2`]),
    ...[400, 500].map((weight) => ["JetBrains Mono", weight, `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`]),
  ].map(([family, weight, relativePath]) => {
    const font = readFileSync(join(PROJECT_ROOT, "node_modules", relativePath)).toString("base64");
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${font}) format("woff2")}`;
  }).join("");
  // data: URLs truncate once the inlined woff2 payloads grow past the
  // browser URL limit, so the prototype is written to disk and opened as
  // file:// — same fonts, no network dependency on fonts.googleapis.com.
  const prototypeHtml = readFileSync(PROTOTYPE_PATH, "utf8")
    .replace('<script src="./support.js"></script>', "")
    .replace(/<link rel="preconnect"[^>]*>/g, "")
    .replace(/<link href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>/g, "")
    .replace("<style>", `<style>${fontFaces}`);
  const prototypeFile = join(OUT_DIR, "Cards.dc.fonts.html");
  writeFileSync(prototypeFile, prototypeHtml);
  const prototypeUrl = `file://${prototypeFile}`;
  const comparePage = await connectPageRaw(CDP_PORT);
  await comparePage.send("Page.enable");
  await comparePage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await comparePage.send("Page.navigate", { url: prototypeUrl });
  let prototypeReady = false;
  for (let i = 0; i < 100; i++) {
    prototypeReady = await comparePage.evalJs(`!!document.querySelector("section.card")`);
    if (prototypeReady) break;
    await wait(100);
  }
  check("approved Cards.dc.html rendered at 1440×900", prototypeReady, true);
  if (!prototypeReady) throw new Error("Cards.dc.html did not expose its card samples after navigation");
  await wait(1200);
  const fontsReady = await comparePage.evalJs(`(async () => {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('400 13px "Space Grotesk"'),
      document.fonts.load('600 13px "Space Grotesk"'),
      document.fonts.load('400 12px "JetBrains Mono"'),
    ]);
    return document.fonts.check('13px "Space Grotesk"') && document.fonts.check('12px "JetBrains Mono"');
  })()`);
  check("prototype font families loaded from the project font packages", fontsReady, true);

  const prototypeClips = new Map();
  for (const item of cases) {
    const referenceLabel = item.sourceLabel ?? "Card de terminal";
    for (const focused of [false, true]) {
      const rect = JSON.parse(await comparePage.evalJs(`(() => {
        const cards = [...document.querySelectorAll("section.card")];
        for (const card of cards) card.classList.remove("focus");
        const card = cards.find((candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(referenceLabel)});
        if (!card) return JSON.stringify(null);
        if (${JSON.stringify(focused)}) card.classList.add("focus");
        return JSON.stringify(card.getBoundingClientRect().toJSON());
      })()`));
      if (!rect) throw new Error(`Prototype sample not found: ${referenceLabel}`);
      const result = await comparePage.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      prototypeClips.set(`${item.kind}:${focused}`, Buffer.from(result.data, "base64"));
    }
  }

  async function writePair(item, focused) {
    const key = `${item.kind}:${focused}`;
    const left = prototypeClips.get(key).toString("base64");
    const right = implementationClips.get(key).toString("base64");
    const state = focused ? "foco" : "sem-foco";
    const refLabel = item.sourceLabel ? `protótipo · ${item.kind} · ${state}` : `protótipo · anatomia comum · ${item.kind} sem amostra · ${state}`;
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#05060a;color:#e8eaf0;font:13px system-ui,sans-serif}
      main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;width:1440px}
      section{min-width:0}header{height:28px;color:#8d94a6}img{display:block;max-width:100%;height:auto;background:#0b0d12}
    </style><main><section><header>${refLabel}</header><img src="data:image/png;base64,${left}"></section>
      <section><header>implementação · ${item.kind} · ${state}</header><img src="data:image/png;base64,${right}"></section></main>`;
    await comparePage.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await wait(220);
    const shot = await comparePage.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const path = join(OUT_DIR, `${item.kind}-${state}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  }

  const screenshotPaths = [];
  for (const item of cases) {
    for (const focused of [false, true]) screenshotPaths.push(await writePair(item, focused));
  }
  check("side-by-side prototype/implementation screenshots written for 8 kinds × 2 focus states", screenshotPaths.length, 16);
  console.log(`screenshots: ${screenshotPaths.join("\n")}`);
  comparePage.close();
} finally {
  sourceServer.close();
  if (app) await stopApp(app);
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}
finish();
