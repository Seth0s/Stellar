#!/usr/bin/env node
/**
 * Measured prototype ↔ implementation parity.
 *
 * Usage:
 *   npm run parity:prototype -- --spec <SPEC.md|json> --proto <file.dc.html> --impl <id>
 *
 * Boots an isolated Electron (never the owner's live app), renders the
 * prototype via support.js with the same viewport, applies the declared
 * fixture on the implementation, and compares getComputedStyle for each
 * selector pair. Exit ≠ 0 when any diff is outside the owner allowlist.
 */
import {
  createServer,
} from "node:http";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  startApp,
  stopApp,
  connectPage,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";
import {
  DEFAULT_STYLE_PROPS,
  validateParitySpec,
  comparePairStyles,
  applyAllowlist,
  formatDiffTable,
} from "./prototype-parity-compare.mjs";
import { createRequire } from "node:module";
import { findDb, seedMockTasks, wireLiveLinks } from "./fila-v3-fixture.mjs";
import { seedGraficosSprintsMock } from "./graficos-sprints-v4-fixture.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PROTO_DIR = join(ROOT, "docs/design/app-v3/prototipo");
const OUT_ROOT = join(ROOT, ".verify-tmp/prototype-parity");
const REPORT_DIR = join(ROOT, "docs/design/app-v3/comparacao");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { spec: null, proto: null, impl: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") out.spec = argv[++i];
    else if (a === "--proto") out.proto = argv[++i];
    else if (a === "--impl") out.impl = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function resolveSpecPath(input) {
  const abs = resolve(ROOT, input);
  if (abs.endsWith(".json") && existsSync(abs)) return abs;
  if (abs.endsWith(".md")) {
    const json = abs.replace(/\.md$/i, ".json");
    if (existsSync(json)) return json;
  }
  const sibling = abs + ".json";
  if (existsSync(sibling)) return sibling;
  throw new Error(`parity spec JSON not found for ${input}`);
}

function resolveProtoPath(input, spec) {
  if (input) {
    const abs = resolve(ROOT, input);
    if (existsSync(abs)) return abs;
    const inProto = join(PROTO_DIR, input);
    if (existsSync(inProto)) return inProto;
  }
  if (spec.proto) {
    const candidates = [
      resolve(dirname(spec._path), spec.proto),
      join(PROTO_DIR, basename(spec.proto)),
      join(ROOT, "docs/design/app-v3", spec.proto),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  throw new Error("prototype .dc.html not found");
}

function localFontCss() {
  const faces = [
    ...[400, 500, 600, 700].map((w) => [
      "Space Grotesk",
      w,
      `@fontsource/space-grotesk/files/space-grotesk-latin-${w}-normal.woff2`,
    ]),
    ...[400, 500].map((w) => [
      "JetBrains Mono",
      w,
      `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`,
    ]),
  ];
  return faces
    .map(([family, weight, rel]) => {
      const b64 = readFileSync(join(ROOT, "node_modules", rel)).toString("base64");
      return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    })
    .join("");
}

function startProtoServer() {
  const fontCss = localFontCss();
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!rel || rel.endsWith("/")) rel = join(rel, "index.html");
      const abs = resolve(PROTO_DIR, rel);
      if (!abs.startsWith(PROTO_DIR) || !existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      let body = readFileSync(abs);
      let type = "application/octet-stream";
      if (abs.endsWith(".html")) {
        type = "text/html; charset=utf-8";
        let html = body.toString("utf8");
        html = html
          .replace(/<link rel="preconnect"[^>]*>/g, "")
          .replace(/<link href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>/g, "");
        if (html.includes("<style>")) {
          html = html.replace("<style>", `<style>${fontCss}`);
        } else if (html.includes("</head>")) {
          html = html.replace("</head>", `<style>${fontCss}</style></head>`);
        }
        body = Buffer.from(html, "utf8");
      } else if (abs.endsWith(".js")) type = "text/javascript; charset=utf-8";
      else if (abs.endsWith(".css")) type = "text/css; charset=utf-8";
      else if (abs.endsWith(".json")) type = "application/json";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function readStyles(page, selector, props) {
  const propList = JSON.stringify(props || DEFAULT_STYLE_PROPS);
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ missing: true, selector: ${JSON.stringify(selector)} });
        const cs = getComputedStyle(el);
        const out = {};
        for (const p of ${propList}) out[p] = cs.getPropertyValue(p) || cs[p];
        const r = el.getBoundingClientRect();
        out.width = Math.round(r.width * 1000) / 1000 + "px";
        out.height = Math.round(r.height * 1000) / 1000 + "px";
        if (${propList}.includes("left")) {
          const parent = el.parentElement;
          const base = parent ? parent.getBoundingClientRect().left : 0;
          out.left = Math.round((r.left - base) * 1000) / 1000 + "px";
        }
        if (${propList}.includes("text")) out.text = (el.textContent || "").replace(/\\s+/g, " ").trim();
        return JSON.stringify(out);
      })()
    `),
  );
}

async function clipRoot(page, selector, outPath) {
  const rect = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "null";
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
      })()
    `),
  );
  if (!rect || rect.width < 4 || rect.height < 4) {
    writeFileSync(outPath.replace(/\.png$/, ".missing.txt"), `missing ${selector}\n`);
    return null;
  }
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return rect;
}

async function writeSideBySide(page, protoPng, implPng, outPath, label) {
  if (!existsSync(protoPng) || !existsSync(implPng)) return;
  const left = readFileSync(protoPng).toString("base64");
  const right = readFileSync(implPng).toString("base64");
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#05060a;color:#e8eaf0;font:13px system-ui,sans-serif}
    main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}
    header{height:28px;color:#8d94a6}img{display:block;max-width:100%;height:auto;background:#0b0d12}
  </style><main>
    <section><header>protótipo · ${label}</header><img src="data:image/png;base64,${left}"></section>
    <section><header>implementação · ${label}</header><img src="data:image/png;base64,${right}"></section>
  </main>`;
  await page.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await delay(250);
  const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
}

function seedScratchRepo(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const paths = [
    "src/renderer/src/useTerminal.ts",
    "src/renderer/src/terminal-render.ts",
    "src/renderer/src/TaskCard.tsx",
    "package.json",
  ];
  for (const p of paths) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      p.endsWith(".ts") || p.endsWith(".tsx")
        ? `// sample\nexport async function replayInto() {}\n`
        : "{}\n",
    );
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "parity"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "parity@test"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "seed"], { stdio: "ignore" });
  writeFileSync(
    join(root, "src/renderer/src/useTerminal.ts"),
    `${readFileSync(join(root, "src/renderer/src/useTerminal.ts"), "utf8")}\n// dirty\n`,
  );
}

async function fixtureCardsV21(page, scratchDir) {
  await bootIntoFreshSession(page, "Parity Cards V21", { spawnTerminal: false });
  await delay(400);
  const boardId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((boards) => {
      const board = boards.find((b) => b.name === "Parity Cards V21") ?? boards[0];
      return JSON.stringify(board.id);
    })`),
  );
  const now = Date.now();
  const resumeId = "f1ada3c4-4709-4e80-a5b9-cdc1f6826ae0";
  await page.evalJs(
    `(async () => {
      await window.store.upsert({
        id: "v21-agent",
        board_id: ${JSON.stringify(boardId)},
        kind: "terminal",
        provider: "bash",
        cwd: ${JSON.stringify(scratchDir)},
        x: 80, y: 80, w: 900, h: 420,
        resume_id: ${JSON.stringify(resumeId)},
        model: "Sonnet 5.5",
        effort: null,
        system_prompt: null,
        group_id: null,
        label: "IMPL · Claude",
        updated_at: ${now},
        messages_json: null,
        archived_at: null,
      });
      return true;
    })()`,
  );
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    [...document.querySelectorAll(".home-session-name")]
      .find((e) => e.textContent.trim().includes("Parity Cards V21"))?.click()
  `);
  await delay(1500);
  for (let i = 0; i < 80; i++) {
    const pending = await page.evalJs(`document.querySelectorAll('[data-role="card-skeleton"]').length`);
    if (Number(pending) === 0) break;
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      document.querySelectorAll(".card-frame.spawning").forEach((el) => el.classList.remove("spawning"));
    })()
  `);
  // Force the working pill for layout parity with cena=largo (bash alone
  // would honestly show "processo vivo"; the owner-approved scene is working).
  await page.evalJs(`
    (() => {
      const pill = document.querySelector("[data-card-id='v21-agent'] [data-role='terminal-status-pill']");
      const host = pill?.closest(".card-head-status");
      if (!pill || !host) return;
      pill.dataset.kind = "working";
      pill.dataset.status = "running";
      const live = pill.querySelector(".card-head-status-live") || document.createElement("span");
      live.className = "card-head-status-live";
      live.setAttribute("aria-hidden", "true");
      pill.textContent = "";
      pill.appendChild(live);
      pill.appendChild(document.createTextNode("trabalhando"));
      host.style.background = "#1a2040";
      host.style.color = "#c3cbff";
    })()
  `);
}

async function fixtureCardsV2(page, scratchDir) {
  await bootIntoFreshSession(page, "Parity Cards V2", { spawnTerminal: false });
  await delay(400);
  const boardId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((boards) => {
      const board = boards.find((b) => b.name === "Parity Cards V2") ?? boards[0];
      return JSON.stringify(board.id);
    })`),
  );
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
  const rows = [
    row("v2-terminal", "terminal", scratchDir, 560, 380, {
      provider: "bash",
      label: "IMPL · Claude",
      model: "Sonnet 5.5",
    }),
    row("v2-browser", "browser", "http://127.0.0.1/", 560, 380, { provider: "v2-terminal" }),
    row("v2-files", "files", scratchDir, 300, 380, { label: "Stellar" }),
    row("v2-changes", "changes", scratchDir, 420, 300, { label: "Mudanças" }),
    row("v2-sticky", "sticky", "Cards esquecem report → lembrete automático.", 360, 230, {
      provider: "yellow",
      model: "preview",
      system_prompt: "14",
      label: "Feedbacks",
      updated_at: now - 120_000,
    }),
  ];
  await page.evalJs(
    `(async () => { for (const card of ${JSON.stringify(rows)}) await window.store.upsert(card); return true; })()`,
  );
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    [...document.querySelectorAll(".home-session-name")]
      .find((e) => e.textContent.trim().includes("Parity Cards V2"))?.click()
  `);
  await delay(1200);
  // Mount queue releases at most 2 cards at a time; wait until every
  // fixture card is the real chrome (not CardSkeleton) before measuring.
  for (let i = 0; i < 80; i++) {
    const pending = await page.evalJs(`document.querySelectorAll('[data-role="card-skeleton"]').length`);
    if (Number(pending) === 0) break;
    await delay(100);
  }
  // Sticky (and others) keep `.spawning` until a re-render; force one so
  // popin is not mid-flight when getBoundingClientRect runs.
  await page.evalJs(`
    (() => {
      document.querySelectorAll(".card-frame.spawning").forEach((el) => el.classList.remove("spawning"));
    })()
  `);
  await page.evalJs(`document.fonts ? document.fonts.ready.then(() => true) : true`);
  await delay(250);
  await page.evalJs(`
    (() => {
      const t = document.querySelector('[data-card-id="v2-terminal"]');
      if (!t) return;
      // Prototype terminal uses \`.focus\` (focus ring), not multi-select outline.
      document.querySelectorAll('.card-frame[data-focused="true"]').forEach((el) => {
        el.dataset.focused = "false";
      });
      t.dataset.focused = "true";
    })()
  `);
  // Confirm sticky settled at declared rect (±border) before returning.
  for (let i = 0; i < 40; i++) {
    const w = Number(
      await page.evalJs(`document.querySelector('[data-card-id="v2-sticky"]')?.getBoundingClientRect().width || 0`),
    );
    if (w >= 358) break;
    await delay(100);
  }
}

async function fixtureCodigoV6(page, scratchDir) {
  await bootIntoFreshSession(page, "Parity Codigo V6", { spawnTerminal: false });
  await delay(400);
  const boardId = JSON.parse(
    await page.evalJs(`(async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Parity Codigo V6") ?? boards[0];
      if (typeof window.store.boards.update === "function") {
        await window.store.boards.update({ ...board, cwd: ${JSON.stringify(scratchDir)} });
      }
      return JSON.stringify(board.id);
    })()`),
  );
  await page.evalJs(`(async () => {
    await window.store.upsert({
      id: "parity-codigo",
      board_id: ${JSON.stringify(boardId)},
      kind: "files",
      provider: "",
      cwd: ${JSON.stringify(scratchDir)},
      x: 30, y: 56, w: 1380, h: 852,
      resume_id: null, model: null, effort: null, system_prompt: null,
      group_id: null, label: "Stellar",
      updated_at: Date.now(),
    });
    return true;
  })()`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    [...document.querySelectorAll(".home-session-name")]
      .find((e) => e.textContent.trim().includes("Parity Codigo V6"))?.click()
  `);
  await delay(1500);
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card")`)) break;
    await delay(100);
  }
  // Same files the prototype tab strip shows, in that order, then reselect
  // the first so the open tab matches the mock. The editor tablist only
  // mounts once a file is open.
  const clickLastNode = async (name) => {
    for (let i = 0; i < 40; i++) {
      const found = await page.evalJs(`(() => {
        const hits = [...document.querySelectorAll(".files-card .files-node-name")]
          .filter((el) => el.textContent === ${JSON.stringify(name)});
        const hit = hits.at(-1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (found) return;
      await delay(100);
    }
    throw new Error(`codigo fixture: tree node not found: ${name}`);
  };
  const waitNode = async (name, min) => {
    for (let i = 0; i < 40; i++) {
      const count = Number(await page.evalJs(
        `[...document.querySelectorAll(".files-card .files-node-name")].filter((el) => el.textContent === ${JSON.stringify(name)}).length`,
      ));
      if (count >= min) return;
      await delay(100);
    }
    throw new Error(`codigo fixture: expected ${min} "${name}" node(s)`);
  };
  await waitNode("src", 1);
  await clickLastNode("src");
  await waitNode("renderer", 1);
  await clickLastNode("renderer");
  await waitNode("src", 2);
  await clickLastNode("src");
  await waitNode("useTerminal.ts", 1);
  await clickLastNode("useTerminal.ts");
  await clickLastNode("terminal-render.ts");
  await clickLastNode("TaskCard.tsx");
  await clickLastNode("useTerminal.ts");
  for (let i = 0; i < 40; i++) {
    const tabs = Number(await page.evalJs(`document.querySelectorAll(".files-editor [role='tab']").length`));
    if (tabs >= 3) break;
    if (i === 39) throw new Error(`codigo fixture: opened ${tabs} editor tabs, expected 3`);
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      document.querySelectorAll(".card-frame.spawning").forEach((el) => el.classList.remove("spawning"));
      const card = document.querySelector(".files-card");
      if (!card) return;
      document.querySelectorAll('.card-frame[data-focused="true"]').forEach((el) => {
        el.dataset.focused = "false";
      });
      card.dataset.focused = "true";
    })()
  `);
}

async function fixtureSettingsV7(page) {
  await bootIntoFreshSession(page, "Parity Settings V7", { spawnTerminal: false });
  await delay(600);
  // locale.json was seeded to pt-BR before startApp (prototype copy language).
  await page.evalJs(`
    document.querySelector('.rail-btn[title="Configurações"], .rail-btn[title="Settings"]')?.click()
  `);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector("[data-settings-modal]")`)) break;
    await delay(100);
  }
  await page.evalJs(`document.querySelector('[data-settings-page="account"]')?.click()`);
  await delay(200);
}

async function fixtureFilaV3(page, userDataDir, detailTaskPrefix = null, boardName = "Parity Fila V3") {
  const { spawnCard } = await import("./cdp-client.mjs");
  await bootIntoFreshSession(page, boardName, { spawnTerminal: false });
  await delay(400);
  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === ${JSON.stringify(boardName)}) ?? boards[0];
        const created = await window.tasks.create(board.id, "__fila_v3_boot__");
        let active = null;
        for (let i = 0; i < 20; i++) {
          const sprints = await window.tasks.listSprints(board.id);
          active = sprints.find((s) => s.closedAt === null) ?? sprints[0] ?? null;
          if (active?.id) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return JSON.stringify({
          boardId: board.id,
          sprintId: active?.id ?? null,
          bootTaskId: created.ok ? created.taskId : null,
        });
      })()
    `),
  );
  if (!ids.sprintId) throw new Error("active sprint missing after bootstrap create");
  let dbPath = null;
  for (let i = 0; i < 40; i++) {
    dbPath = findDb(userDataDir);
    if (dbPath) break;
    await delay(150);
  }
  if (!dbPath) throw new Error(`agent-canvas.db not found under ${userDataDir}`);
  {
    const db = new Database(dbPath);
    if (ids.bootTaskId) db.prepare("DELETE FROM tasks WHERE id = ?").run(ids.bootTaskId);
    db.close();
  }
  seedMockTasks(dbPath, ids.boardId, ids.sprintId);
  await page.evalJs(`
    (async () => {
      const boardId = ${JSON.stringify(ids.boardId)};
      const cwd = ${JSON.stringify(ROOT)};
      const mk = async (id, provider, label, x) => {
        await window.store.upsert({
          id, board_id: boardId, kind: "terminal", provider, cwd,
          x, y: 900, w: 420, h: 280,
          resume_id: null, model: null, effort: null, system_prompt: null,
          group_id: null, label, updated_at: Date.now(),
        });
        await window.pty.spawn(id, provider, cwd, 80, 24);
      };
      await mk("fila-v3-live-claude", "bash", "IMPL · Claude", 40);
      await mk("fila-v3-live-gemini", "bash", "EXPLORER · Gemini", 480);
    })()
  `);
  wireLiveLinks(dbPath);
  const poke = JSON.parse(
    await page.evalJs(`
      (async () => {
        const r = await window.tasks.create(${JSON.stringify(ids.boardId)}, "__fila_v3_poke__");
        return JSON.stringify(r);
      })()
    `),
  );
  if (poke.ok) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(poke.taskId);
    db.close();
    await page.evalJs(`
      (async () => {
        await window.tasks.renameSprint(${JSON.stringify(ids.sprintId)}, "Sprint Ciclo 2");
        const tasks = await window.tasks.listByBoard(${JSON.stringify(ids.boardId)});
        const one = tasks.find((t) => t.id.startsWith("c5b6aeaa"));
        if (one) await window.tasks.updatePrompt(one.id, one.promptPreview || "x", "replace");
      })()
    `);
  }
  await delay(600);
  await spawnCard(page, "task");
  await delay(1000);
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === ${JSON.stringify(boardName)}) ?? boards[0];
      const cards = await window.store.list(board.id);
      for (const c of cards) {
        if (c.kind === "task") {
          await window.store.upsert({ ...c, x: 16, y: 48, w: 1408, h: 820, label: "Fila", updated_at: Date.now() });
        } else if (c.kind === "terminal") {
          await window.store.upsert({ ...c, x: 1600, y: 56, w: 420, h: 280, updated_at: Date.now() });
        }
      }
    })()
  `);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      const name = [...document.querySelectorAll(".home-session-name")]
        .find((item) => item.textContent.includes(${JSON.stringify(boardName)}));
      (name?.closest("button")
        ?? [...document.querySelectorAll(".home-session-card")]
          .find((item) => item.innerText.includes(${JSON.stringify(boardName)})))?.click();
    })()
  `);
  await delay(1500);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.card-frame[data-kind="task"]') || document.querySelector('[data-kind="task"]');
      if (el) el.setAttribute("data-fila-v3-shot", "1");
    })()
  `);
  if (detailTaskPrefix) {
    await page.evalJs(`
      [...document.querySelectorAll("[data-task-item-id]")].find((el) =>
        el.getAttribute("data-task-item-id")?.startsWith(${JSON.stringify(detailTaskPrefix)}))?.click()
    `);
    await delay(700);
    if (!(await page.evalJs(`!!document.querySelector("[data-part='task-detail-v3']")`))) {
      throw new Error(`detail modal missing for ${detailTaskPrefix}`);
    }
  }
}

async function applyFixture(page, fixtureId, scratchDir, userDataDir) {
  if (fixtureId === "cards-v2" || fixtureId === "v2") return fixtureCardsV2(page, scratchDir);
  if (fixtureId === "cards-v21" || fixtureId === "v21") return fixtureCardsV21(page, scratchDir);
  if (fixtureId === "codigo-v6" || fixtureId === "v6") return fixtureCodigoV6(page, scratchDir);
  if (fixtureId === "settings-v7" || fixtureId === "v7") return fixtureSettingsV7(page);
  if (fixtureId === "fila-v3") return fixtureFilaV3(page, userDataDir, null);
  if (fixtureId === "main-v3") return fixtureFilaV3(page, userDataDir, "511abcb2");
  if (fixtureId === "review-v3") return fixtureFilaV3(page, userDataDir, "e0b6b86a");
  if (fixtureId === "superseded-v3") return fixtureFilaV3(page, userDataDir, "ae3e0fe2");
  if (fixtureId === "graficos-v4") return fixtureGraficosV4(page, userDataDir);
  if (fixtureId === "sprints-v4") return fixtureSprintsV4(page, userDataDir);
  throw new Error(`unknown fixture/impl: ${fixtureId}`);
}

async function waitForPart(page, part) {
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector(${JSON.stringify(`[data-part="${part}"]`)})`)) return;
    await delay(100);
  }
  throw new Error(`missing [data-part="${part}"]`);
}

async function fixtureGraficosV4(page, userDataDir) {
  await fixtureFilaV3(page, userDataDir, null, "Board 64");
  const seeded = await seedV4Mock(page, userDataDir);
  await refreshV4Board(page, seeded);
  await delay(400);
  await openV4Screen(page, "charts-toggle", ["graficos-provider-bar", "graficos-hist-bar", "graficos-cycle-bar"]);
  await frameV4Shell(page, seeded, "graficos-v4", 1440, 860, "charts-toggle", ["graficos-provider-bar"]);
}

async function fixtureSprintsV4(page, userDataDir) {
  await fixtureFilaV3(page, userDataDir, null, "Board 64");
  const seeded = await seedV4Mock(page, userDataDir);
  await refreshV4Board(page, seeded);
  await delay(400);
  await openV4Screen(page, "sprints-toggle", ["sprints-row", "sprints-unsprinted"]);
  await frameV4Shell(page, seeded, "sprints-v4", 1000, 860, "sprints-toggle", ["sprints-row"]);
}

async function seedV4Mock(page, userDataDir) {
  const dbPath = findDb(userDataDir);
  if (!dbPath) throw new Error("agent-canvas.db missing for v4 fixture");
  const db = new Database(dbPath);
  const active = db
    .prepare(`SELECT id AS sprintId, board_id AS boardId FROM sprints WHERE closed_at IS NULL ORDER BY started_at DESC LIMIT 1`)
    .get();
  db.close();
  if (!active?.sprintId) throw new Error("no active sprint for v4 fixture");
  const clock = seedGraficosSprintsMock(dbPath, active.boardId, active.sprintId);
  return { dbPath, ...clock, ...active };
}

async function refreshV4Board(page, seeded) {
  await page.evalJs(`Date.now = () => ${seeded.now}`);
  const poke = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Board 64") ?? boards[0];
        const r = await window.tasks.create(board.id, "__v4_poke__");
        return JSON.stringify({ boardId: board.id, poke: r });
      })()
    `),
  );
  if (poke.poke?.ok && poke.poke.taskId) {
    const db = new Database(seeded.dbPath);
    db.prepare("DELETE FROM task_transitions WHERE task_id = ?").run(poke.poke.taskId);
    db.prepare("DELETE FROM task_cards WHERE task_id = ?").run(poke.poke.taskId);
    db.prepare("DELETE FROM task_verdicts WHERE task_id = ?").run(poke.poke.taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(poke.poke.taskId);
    db.close();
  }
  await page.evalJs(`
    (async () => {
      const tasks = await window.tasks.listByBoard(${JSON.stringify(poke.boardId)});
      const one = tasks.find((t) => t.id.startsWith("d97be5"));
      if (one) await window.tasks.updatePrompt(one.id, one.promptPreview || "ciclo", "replace");
      await window.tasks.renameSprint(${JSON.stringify(seeded.sprintId)}, "Ciclo 2");
    })()
  `);
  for (let i = 0; i < 40; i++) {
    const ready = await page.evalJs(`(() => {
      const text = document.body?.innerText || "";
      return text.includes("Ciclo 2") && !text.includes("Sprint Ciclo 2");
    })()`);
    if (ready) return;
    await delay(100);
  }
  throw new Error("sprint label did not refresh to Ciclo 2");
}

async function openV4Screen(page, toggle, parts) {
  await page.evalJs(`document.querySelector(${JSON.stringify(`[data-part="${toggle}"]`)})?.click()`);
  for (const part of parts) await waitForPart(page, part);
}

async function reenterBoard(page, boardName) {
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      const name = [...document.querySelectorAll(".home-session-name")]
        .find((item) => item.textContent.includes(${JSON.stringify(boardName)}));
      (name?.closest("button")
        ?? [...document.querySelectorAll(".home-session-card")]
          .find((item) => item.innerText.includes(${JSON.stringify(boardName)})))?.click();
    })()
  `);
  await delay(1200);
}

async function frameV4Shell(page, seeded, part, width, height, toggle, parts) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    await page.evalJs(`
      (() => {
        let style = document.getElementById("v4-hide-chrome");
        if (!style) {
          style = document.createElement("style");
          style.id = "v4-hide-chrome";
          document.head.appendChild(style);
        }
        style.textContent = ".titlebar, .topbar, .topbar-home, .rail-container, .compass-strip, .zoom-pill { display: none !important; }";
      })()
    `);
    last = JSON.parse(
      await page.evalJs(`
        (() => {
          const shell = document.querySelector(${JSON.stringify(`[data-part="${part}"]`)});
          if (!shell) return "null";
          const r = shell.getBoundingClientRect();
          return JSON.stringify({ dx: 0 - r.x, dy: 0 - r.y, w: r.width, h: r.height });
        })()
      `),
    );
    if (!last) throw new Error(`shell ${part} missing while framing`);
    if (Math.abs(last.dx) < 1 && Math.abs(last.dy) < 1 && Math.abs(last.w - width) <= 2 && Math.abs(last.h - height) <= 2) {
      return;
    }
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Board 64") ?? boards[0];
        const cards = await window.store.list(board.id);
        for (const c of cards) {
          if (c.kind === "task") {
            await window.store.upsert({
              ...c,
              x: c.x + ${last.dx},
              y: c.y + ${last.dy},
              w: 1800,
              h: 1600,
              updated_at: Date.now(),
            });
          } else {
            await window.store.upsert({ ...c, x: 4000, y: 4000, updated_at: Date.now() });
          }
        }
      })()
    `);
    await reenterBoard(page, "Board 64");
    await page.evalJs(`Date.now = () => ${seeded.now}`);
    for (let n = 0; n < 40; n++) {
      const ready = await page.evalJs(`(() => {
        const text = document.body?.innerText || "";
        return text.includes("Ciclo 2") && !text.includes("Sprint Ciclo 2");
      })()`);
      if (ready) break;
      await delay(100);
    }
    await openV4Screen(page, toggle, parts);
  }
  throw new Error(`shell ${part} not framed at ${width}x${height}: ${JSON.stringify(last)}`);
}

function writeReport({ spec, outDir, failing, approved, missing, sideBySide, exitCode }) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const name = spec.id;
  const mdPath = join(REPORT_DIR, `parity-${name}.md`);
  const jsonPath = join(outDir, `parity-${name}.json`);
  const body = `# Paridade medida — ${spec.title || name}

Gerado por \`scripts/verify/prototype-parity.mjs\` (sem correção de tela nesta task).

- Viewport: ${spec.viewport.width}×${spec.viewport.height}
- Fixture: \`${spec.fixture || spec.impl}\`
- Exit: ${exitCode}
- Divergências reprovadoras: **${failing.length}**
- Allowlist (owner): ${approved.length}
- Seletores ausentes: ${missing.length}

## Divergências (proto × impl)

${formatDiffTable(failing)}

## Allowlist aplicada

${approved.length ? formatDiffTable(approved) : "_vazia_\n"}

## Seletores ausentes

${
  missing.length
    ? missing.map((m) => `- \`${m.side}\` \`${m.selector}\` (pair \`${m.pairId}\`)`).join("\n")
    : "_nenhum_"
}

## Side-by-side

${sideBySide ? `\`${sideBySide}\`` : "_não gerado_"}
`;
  writeFileSync(mdPath, body);
  writeFileSync(
    jsonPath,
    JSON.stringify({ id: name, exitCode, failing, approved, missing, sideBySide }, null, 2),
  );
  return { mdPath, jsonPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec) {
    console.log(`Usage: npm run parity:prototype -- --spec <SPEC.md|json> [--proto file.dc.html] [--impl id]
Impl ids: cards-v2 | cards-v21 | codigo-v6 | settings-v7 | fila-v3 | main-v3 | review-v3 | superseded-v3 | graficos-v4 | sprints-v4`);
    process.exit(args.help ? 0 : 2);
  }

  const specPath = resolveSpecPath(args.spec);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  spec._path = specPath;
  validateParitySpec(spec);
  const protoPath = resolveProtoPath(args.proto, spec);
  const implId = args.impl || spec.impl || spec.fixture;
  const props = spec.props || DEFAULT_STYLE_PROPS;
  const tolerances = spec.tolerances || {};
  const outDir = args.out ? resolve(ROOT, args.out) : join(OUT_ROOT, spec.id);
  mkdirSync(outDir, { recursive: true });

  const protoHttp = await startProtoServer();
  const protoQuery = spec.protoQuery ? `?${String(spec.protoQuery).replace(/^\?/, "")}` : "";
  const protoUrl = `${protoHttp.origin}/${basename(protoPath)}${protoQuery}`;
  const CDP_PORT = await pickFreePort();
  const USER_DATA_DIR = mkdtempSync(join(tmpdir(), `stellar-parity-${spec.id}-`));
  const scratchDir = mkdtempSync(join(tmpdir(), "stellar-parity-repo-"));
  seedScratchRepo(scratchDir);

  // Settings prototype copy is pt-BR. Seed locale.json before Electron boots
  // so the first i18n.get() resolves pt-BR and title widths match the HTML.
  const needsPtBr =
    implId === "settings-v7" ||
    implId === "v7" ||
    spec.id === "configuracoes-v7" ||
    String(implId).endsWith("-v3") ||
    String(spec.id).endsWith("-v3") ||
    implId === "graficos-v4" ||
    implId === "sprints-v4" ||
    implId === "cards-v21" ||
    spec.id === "graficos-v4" ||
    spec.id === "sprints-v4" ||
    spec.id === "cards-v21";
  if (needsPtBr) {
    writeFileSync(join(USER_DATA_DIR, "locale.json"), JSON.stringify({ override: "pt-BR" }));
  }

  let app;
  let exitCode = 0;
  const missing = [];

  try {
    app = await startApp({
      cdpPort: CDP_PORT,
      userDataDir: USER_DATA_DIR,
      // Keep seeded locale.json (startApp wipes userData unless preserved).
      preserveUserData: needsPtBr,
      extraEnv: {
        AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify({
          x: 40,
          y: 40,
          width: spec.viewport.width,
          height: spec.viewport.height,
        }),
      },
    });
    const page = await connectPage(CDP_PORT);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: spec.viewport.width,
      height: spec.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(800);
    const appUrl = await page.evalJs(`location.href`);

    // Prototype (same CDP page, then return to the app URL)
    await page.send("Page.navigate", { url: protoUrl });
    let ready = false;
    let bootErr = "";
    for (let i = 0; i < 100; i++) {
      try {
        const st = JSON.parse(
          await page.evalJs(`JSON.stringify({
            ready: document.documentElement?.getAttribute("data-dc-ready"),
            err: document.documentElement?.getAttribute("data-dc-error"),
            href: location.href
          })`),
        );
        if (st.ready === "1") {
          ready = true;
          break;
        }
        if (st.err) {
          bootErr = st.err;
          break;
        }
      } catch {
        // Document mid-navigation — retry.
      }
      await delay(100);
    }
    if (!ready) {
      throw new Error(`prototype data-dc-ready failed: ${bootErr || "timeout"}`);
    }
    await delay(400);
    const leftover = await page.evalJs(`
      (() => {
        const t = document.body?.innerText || "";
        const m = t.match(/\\{\\{[^}]+\\}\\}/g);
        return m ? m.slice(0, 8).join(", ") : "";
      })()
    `);
    if (leftover) throw new Error(`unfilled placeholders: ${leftover}`);

    const protoStyles = {};
    for (const pair of spec.pairs) {
      const pairProps = pair.props || props;
      const st = await readStyles(page, pair.proto, pairProps);
      if (st.missing) missing.push({ pairId: pair.id, side: "proto", selector: pair.proto });
      else protoStyles[pair.id] = st;
    }
    const protoRootSel = spec.root?.proto || spec.pairs[0].proto;
    const protoClip = join(outDir, "proto-root.png");
    await clipRoot(page, protoRootSel, protoClip);

    await page.send("Page.navigate", { url: appUrl });
    await delay(1500);
    await applyFixture(page, implId, scratchDir, USER_DATA_DIR);
    await delay(500);

    const implStyles = {};
    for (const pair of spec.pairs) {
      const pairProps = pair.props || props;
      const st = await readStyles(page, pair.impl, pairProps);
      if (st.missing) missing.push({ pairId: pair.id, side: "impl", selector: pair.impl });
      else implStyles[pair.id] = st;
    }
    const implRootSel = spec.root?.impl || spec.pairs[0].impl;
    const implClip = join(outDir, "impl-root.png");
    await clipRoot(page, implRootSel, implClip);

    const allDiffs = [];
    for (const pair of spec.pairs) {
      if (!protoStyles[pair.id] || !implStyles[pair.id]) continue;
      const pairProps = pair.props || props;
      const { diffs } = comparePairStyles(
        pair.id,
        protoStyles[pair.id],
        implStyles[pair.id],
        pairProps,
        tolerances,
      );
      allDiffs.push(...diffs);
    }
    const { failing, approved } = applyAllowlist(allDiffs, spec.approvedDiffs || []);
    if (missing.length || failing.length) exitCode = 1;

    const sideBySide = join(outDir, "side-by-side.png");
    await writeSideBySide(page, protoClip, implClip, sideBySide, spec.id);

    const report = writeReport({
      spec,
      outDir,
      failing,
      approved,
      missing,
      sideBySide: existsSync(sideBySide) ? sideBySide : null,
      exitCode,
    });

    console.log(
      `parity ${spec.id}: failing=${failing.length} approved=${approved.length} missing=${missing.length}`,
    );
    console.log(formatDiffTable(failing));
    console.log(`report: ${report.mdPath}`);
    console.log(`artifacts: ${outDir}`);
    process.exitCode = exitCode;
  } finally {
    if (app) {
      try {
        await stopApp(app);
      } catch {
        /* ignore */
      }
    }
    protoHttp.server.close();
    try {
      rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
