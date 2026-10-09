/**
 * Fila V3 visual proof — prototype vs implementation, SAME framing and
 * SAME mock ids/titles/states from Fila/Main/Review/Superseded.dc.html.
 * Also writes getComputedStyle proto × impl tables. Isolated Electron only.
 */
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startApp, stopApp, connectPage, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";
import { findDb, seedMockTasks, wireLiveLinks } from "./fila-v3-fixture.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PROTO_DIR = join(ROOT, "docs/design/app-v3/prototipo");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-fila-v3-"));
const SHOT_DIR = join(ROOT, ".verify-tmp/v3-fila-shots");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOT_DIR, { recursive: true });

/** Prototype placeholders — shown state opens Falhas/Substituídas rails. */
function expandFilaProto(html) {
  return html
    .replaceAll("{{fTudo}}", "chip chipOn")
    .replaceAll("{{fVoce}}", "chip")
    .replaceAll("{{fVivas}}", "chip")
    .replaceAll("{{goTudo}}", "")
    .replaceAll("{{goVoce}}", "")
    .replaceAll("{{goVivas}}", "")
    .replaceAll("{{showStrip}}", "true")
    .replaceAll("{{openFail}}", "true")
    .replaceAll("{{closedFail}}", "false")
    .replaceAll("{{openSup}}", "true")
    .replaceAll("{{closedSup}}", "false")
    .replaceAll("{{toggleFail}}", "")
    .replaceAll("{{toggleSup}}", "")
    .replaceAll('hint-placeholder-val="{{ true }}"', "")
    .replaceAll('hint-placeholder-val="{{ false }}"', "")
    .replaceAll("<sc-if", "<div")
    .replaceAll("</sc-if>", "</div>")
    .replaceAll('value="{{showStrip}}"', "")
    .replaceAll('value="{{openFail}}"', "")
    .replaceAll('value="{{closedFail}}"', 'style="display:none"')
    .replaceAll('value="{{openSup}}"', "")
    .replaceAll('value="{{closedSup}}"', 'style="display:none"')
    .replaceAll('onClick="{{toggleFail}}"', "")
    .replaceAll('onClick="{{toggleSup}}"', "");
}

function expandDetailProto(html, tab = "resumo") {
  const on = (k) => (tab === k ? "tab on" : "tab");
  return html
    .replaceAll("{{tabResumo}}", on("resumo"))
    .replaceAll("{{tabContrato}}", on("contrato"))
    .replaceAll("{{tabRel}}", on("rel"))
    .replaceAll("{{tabMud}}", on("mud"))
    .replaceAll("{{tabTrilha}}", on("trilha"))
    .replaceAll("{{goResumo}}", "")
    .replaceAll("{{goContrato}}", "")
    .replaceAll("{{goRel}}", "")
    .replaceAll("{{goMud}}", "")
    .replaceAll("{{goTrilha}}", "")
    .replaceAll("{{showResumo}}", tab === "resumo" ? "true" : "false")
    .replaceAll("{{showContrato}}", tab === "contrato" ? "true" : "false")
    .replaceAll("{{showRel}}", tab === "rel" ? "true" : "false")
    .replaceAll("{{showMud}}", tab === "mud" ? "true" : "false")
    .replaceAll("{{showTrilha}}", tab === "trilha" ? "true" : "false")
    .replaceAll('hint-placeholder-val="{{ true }}"', "")
    .replaceAll('hint-placeholder-val="{{ false }}"', "")
    .replaceAll("<sc-if", "<div")
    .replaceAll("</sc-if>", "</div>")
    .replaceAll('value="{{showResumo}}"', tab === "resumo" ? "" : 'style="display:none"')
    .replaceAll('value="{{showContrato}}"', tab === "contrato" ? "" : 'style="display:none"')
    .replaceAll('value="{{showRel}}"', tab === "rel" ? "" : 'style="display:none"')
    .replaceAll('value="{{showMud}}"', tab === "mud" ? "" : 'style="display:none"')
    .replaceAll('value="{{showTrilha}}"', tab === "trilha" ? "" : 'style="display:none"')
    .replaceAll(/onClick="\{\{[^"]+\}\}"/g, "");
}

async function clipSelector(page, selector, outPath) {
  const viewport = JSON.parse(
    await page.evalJs(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })`),
  );
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
  if (!rect || rect.width < 10 || rect.height < 10) throw new Error(`clip miss: ${selector}`);
  // Clamp to the visible viewport — oversized cards otherwise make CDP drop the clip.
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(rect.width, viewport.w - x);
  const height = Math.min(rect.height, viewport.h - y);
  if (width < 10 || height < 10) throw new Error(`clip clamped empty: ${selector} rect=${JSON.stringify(rect)} vp=${JSON.stringify(viewport)}`);
  console.log("clip", selector, { x, y, width, height }, "raw", rect, "vp", viewport);
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { x, y, width, height, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return { x, y, width, height };
}

async function measureStyles(page, probes) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const probes = ${JSON.stringify(probes)};
        const props = ["fontSize","fontWeight","padding","gap","color","backgroundColor","borderRadius","borderTopColor","width","height","display"];
        const out = {};
        for (const [name, sel] of Object.entries(probes)) {
          const el = document.querySelector(sel);
          if (!el) { out[name] = null; continue; }
          const cs = getComputedStyle(el);
          const row = {};
          for (const p of props) row[p] = cs[p];
          const r = el.getBoundingClientRect();
          row.box = { w: Math.round(r.width), h: Math.round(r.height) };
          out[name] = row;
        }
        return JSON.stringify(out);
      })()
    `),
  );
}

function sideBySide(leftPath, rightPath, outPath) {
  try {
    const sharp = require("sharp");
    return Promise.all([sharp(leftPath).metadata(), sharp(rightPath).metadata()]).then(async ([lm, rm]) => {
      const h = Math.max(lm.height, rm.height);
      const gap = 16;
      const w = lm.width + gap + rm.width;
      const canvas = sharp({
        create: { width: w, height: h, channels: 4, background: { r: 5, g: 6, b: 10, alpha: 1 } },
      });
      const left = await sharp(leftPath).toBuffer();
      const right = await sharp(rightPath).toBuffer();
      await canvas
        .composite([
          { input: left, left: 0, top: 0 },
          { input: right, left: lm.width + gap, top: 0 },
        ])
        .png()
        .toFile(outPath);
    });
  } catch {
    // ImageMagick fallback (sharp is not always installed in this tree).
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync(
        "magick",
        [leftPath, rightPath, "+append", "-background", "#05060a", "-gravity", "North", outPath],
        { stdio: "pipe" },
      );
    } catch (err) {
      writeFileSync(
        outPath.replace(/\.png$/, ".note.txt"),
        `side-by-side failed\nleft=${leftPath}\nright=${rightPath}\n${err}\n`,
      );
    }
  }
}

const FILA_PROBES = {
  tile: '[data-part="queue-tile"]',
  columnWaiting: '[data-part="queue-column"][data-column="waiting"]',
  columnHead: '[data-part="queue-column"][data-column="waiting"] h2, section[aria-label="Esperando"] h2',
  filterChip: '[data-part="queue-toolbar"] button, [role="group"][aria-label="Filtro"] button',
  needsStrip: '[data-part="needs-you-card"], [aria-label="Precisa de você"] > div',
  rail: '[data-part="queue-rail-failed"], button.rail',
};

const DETAIL_PROBES = {
  dialog: '[data-part="task-detail-v3"] [role="dialog"], section[role="dialog"]',
  title: "#task-detail-v3-title, #ttl",
  agora: '[data-part="agora-banner"], section[role="dialog"] > div[style*="border-radius: 12px"]',
  tab: '[data-part="task-detail-v3"] nav button, nav[aria-label="Seções"] button',
  aside: '[data-part="task-detail-v3"] aside, aside[aria-label]',
};

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: {
    AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify({ x: 40, y: 40, width: 1440, height: 900 }),
  },
});

let failed = null;
const measures = {};
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  const appUrl = await page.evalJs(`location.href`);

  // --- Prototypes ----------------------------------------------------------
  for (const [name, file, expand, selector] of [
    ["fila", "Fila.dc.html", expandFilaProto, "body > x-dc > div, body div[style*='1440px']"],
    ["main", "Main.dc.html", (h) => expandDetailProto(h, "resumo"), 'section[role="dialog"]'],
    ["review", "Review.dc.html", (h) => expandDetailProto(h, "resumo"), 'section[role="dialog"]'],
    ["superseded", "Superseded.dc.html", (h) => expandDetailProto(h, "resumo"), 'section[role="dialog"]'],
  ]) {
    const raw = readFileSync(join(PROTO_DIR, file), "utf8");
    const expanded = expand(raw);
    const unfilled = [...expanded.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
    if (unfilled.length) {
      writeFileSync(join(SHOT_DIR, `${name}-proto-unfilled.txt`), unfilled.join("\n"));
      console.log("unfilled placeholders", name, unfilled);
    }
    const path = join(SHOT_DIR, `${name}-proto-expanded.html`);
    writeFileSync(path, expanded);
    await page.send("Page.navigate", { url: `file://${path}` });
    await delay(500);
    // Prefer the first big surface if x-dc wrapper confuses the selector.
    const selOk = await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`);
    const clipSel = selOk ? selector : "body > div, body";
    const out = join(SHOT_DIR, `proto-${name}.png`);
    await clipSelector(page, name === "fila" ? "body > div, body div" : clipSel, out);
    measures[`proto-${name}`] = await measureStyles(page, name === "fila" ? {
      tile: ".tile",
      columnHead: 'section[aria-label="Esperando"] h2',
      filterChip: '[role="group"][aria-label="Filtro"] button',
      needsStrip: 'section[aria-label="Precisa de você"] > div',
      rail: "button.rail",
    } : DETAIL_PROBES);
    console.log("wrote", out);
  }

  await page.send("Page.navigate", { url: appUrl });
  await delay(1500);
  await bootIntoFreshSession(page, "Fila V3 shots", { spawnTerminal: false });
  await delay(800);

  // Establish an active sprint via the store write path (SQL alone does not
  // create sprints or push task:changed).
  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Fila V3 shots") ?? boards[0];
        const boot = await window.tasks.create(board.id, "__fila_v3_bootstrap__");
        const sprints = await window.tasks.listSprints(board.id);
        const active = sprints.find((s) => s.closedAt === null) ?? sprints[0];
        return JSON.stringify({
          boardId: board.id,
          sprintId: active?.id ?? null,
          bootTaskId: boot.ok ? boot.taskId : null,
        });
      })()
    `),
  );
  console.log("board", ids);
  if (!ids.sprintId) throw new Error("active sprint missing after bootstrap create");

  let dbPath = null;
  for (let i = 0; i < 40; i++) {
    dbPath = findDb(USER_DATA_DIR);
    if (dbPath) break;
    await delay(150);
  }
  if (!dbPath) throw new Error(`agent-canvas.db not found under ${USER_DATA_DIR}`);

  // Drop the bootstrap row, then insert the fixed mock set with the live sprint id.
  {
    const db = new Database(dbPath);
    if (ids.bootTaskId) db.prepare("DELETE FROM tasks WHERE id = ?").run(ids.bootTaskId);
    db.close();
  }
  seedMockTasks(dbPath, ids.boardId, ids.sprintId);

  // Live PTYs so Rodando stays Rodando (DADOS §3: running + cardAlive).
  const liveCards = JSON.parse(
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
          const spawn = await window.pty.spawn(id, provider, cwd, 80, 24);
          return { id, spawnOk: !spawn?.error, spawn };
        };
        const a = await mk("fila-v3-live-claude", "bash", "IMPL · Claude", 40);
        const b = await mk("fila-v3-live-gemini", "bash", "EXPLORER · Gemini", 480);
        return JSON.stringify({ a, b });
      })()
    `),
  );
  console.log("liveCards", liveCards);

  wireLiveLinks(dbPath);

  // SQL writes do not push task:changed — poke create then updatePrompt.
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
        if (one) await window.tasks.updatePrompt(one.id, one.promptPreview || "Terminal: scroll e desenho travam depois de sair da sessão e voltar", "replace");
      })()
    `);
  }
  await delay(800);

  await spawnCard(page, "task");
  await delay(1200);

  // Size the Fila card + park live terminals off-canvas, then reload the
  // board so React picks up store.upsert rects (same pattern as card-v2 chrome).
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Fila V3 shots") ?? boards[0];
      const cards = await window.store.list(board.id);
      for (const c of cards) {
        if (c.kind === "task") {
          await window.store.upsert({
            ...c,
            x: 16, y: 48, w: 1408, h: 820,
            label: "Fila",
            updated_at: Date.now(),
          });
        } else if (c.kind === "terminal") {
          await window.store.upsert({
            ...c,
            x: 1600, y: 56, w: 420, h: 280,
            updated_at: Date.now(),
          });
        }
      }
    })()
  `);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      const name = [...document.querySelectorAll(".home-session-name")]
        .find((item) => item.textContent.includes("Fila V3 shots"));
      const button = name?.closest("button")
        ?? [...document.querySelectorAll(".home-session-card")]
          .find((item) => item.innerText.includes("Fila V3 shots"));
      button?.click();
    })()
  `);
  await delay(1500);

  const hasBoard = await page.evalJs(`!!document.querySelector('[data-part="queue-board"]')`);
  if (!hasBoard) throw new Error("queue-board missing after seed");
  const tileCount = Number(await page.evalJs(`document.querySelectorAll('[data-part="queue-tile"]').length`));
  console.log("tileCount", tileCount);
  if (tileCount < 5) throw new Error(`expected seeded tiles, got ${tileCount}`);

  // Remount with archive total so "Ver todas as 212" matches the prototype.
  // Rails already start open (shown state); do not click them (that would collapse).
  await page.evalJs(`window.__STELLAR_FILA_DONE_TOTAL__ = 212`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await delay(100);
  }
  await page.evalJs(`
    (() => {
      window.__STELLAR_FILA_DONE_TOTAL__ = 212;
      const name = [...document.querySelectorAll(".home-session-name")]
        .find((item) => item.textContent.includes("Fila V3 shots"));
      (name?.closest("button")
        ?? [...document.querySelectorAll(".home-session-card")]
          .find((item) => item.innerText.includes("Fila V3 shots")))?.click();
    })()
  `);
  await delay(1200);
  const railsOpen = await page.evalJs(`
    !!document.querySelector('[data-part="queue-column"][data-column="failed"]')
    && !!document.querySelector('[data-part="queue-column"][data-column="superseded"]')
  `);
  if (!railsOpen) throw new Error("Falhas/Substituídas columns should start open");

  // Reset canvas zoom so the 1408px card is not optically shrunk in the clip.
  await page.evalJs(`
    (() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /^(100%|reset|1:1)$/i.test((b.textContent || "").trim())
        || b.getAttribute("aria-label")?.toLowerCase().includes("zoom"));
      btn?.click();
      document.querySelector(".topbar-zoom-reset, [data-part='zoom-reset']")?.click();
    })()
  `);
  await delay(200);

  const implFila = join(SHOT_DIR, "impl-fila.png");
  await page.evalJs(`
    (() => {
      const el = document.querySelector('.card-frame[data-kind="task"]')
        || document.querySelector('[data-kind="task"]');
      if (el) el.setAttribute('data-fila-v3-shot', '1');
    })()
  `);
  const cardRect = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-fila-v3-shot="1"]');
        if (!el) return "null";
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
      })()
    `),
  );
  console.log("cardRect", cardRect);
  await clipSelector(page, '[data-fila-v3-shot="1"]', implFila);
  measures["impl-fila"] = await measureStyles(page, FILA_PROBES);
  console.log("wrote", implFila);

  // Open running detail (#511abcb2)
  await page.evalJs(`
    [...document.querySelectorAll('[data-task-item-id]')].find((el) =>
      el.getAttribute('data-task-item-id')?.startsWith('511abcb2'))?.click()
  `);
  await delay(600);
  const hasDetail = await page.evalJs(`!!document.querySelector('[data-part="task-detail-v3"]')`);
  if (hasDetail) {
    const implMain = join(SHOT_DIR, "impl-main.png");
    await clipSelector(page, '[data-part="task-detail-v3"] [role="dialog"]', implMain);
    measures["impl-main"] = await measureStyles(page, DETAIL_PROBES);
    console.log("wrote", implMain);
    await page.evalJs(`document.querySelector('[data-part="task-detail-v3"] [aria-label]')?.closest('[role=dialog]')?.querySelector('button[aria-label]')?.click()`);
    // close via backdrop
    await page.evalJs(`document.querySelector('[data-part="task-detail-v3"] .modal-backdrop')?.click()`);
    await delay(400);
  }

  // Open review task
  await page.evalJs(`
    [...document.querySelectorAll('[data-task-item-id]')].find((el) =>
      el.getAttribute('data-task-item-id')?.startsWith('e0b6b86a'))?.click()
  `);
  await delay(600);
  if (await page.evalJs(`!!document.querySelector('[data-part="task-detail-v3"]')`)) {
    const implReview = join(SHOT_DIR, "impl-review.png");
    await clipSelector(page, '[data-part="task-detail-v3"] [role="dialog"]', implReview);
    measures["impl-review"] = await measureStyles(page, DETAIL_PROBES);
    console.log("wrote", implReview);
    await page.evalJs(`document.querySelector('[data-part="task-detail-v3"] .modal-backdrop')?.click()`);
    await delay(400);
  }

  // Expand superseded rail and open detail
  await page.evalJs(`document.querySelector('[data-part="queue-rail-superseded"]')?.click()`);
  await delay(300);
  await page.evalJs(`
    [...document.querySelectorAll('[data-task-item-id]')].find((el) =>
      el.getAttribute('data-task-item-id')?.startsWith('ae3e0fe2'))?.click()
  `);
  await delay(600);
  if (await page.evalJs(`!!document.querySelector('[data-part="task-detail-v3"]')`)) {
    const implSup = join(SHOT_DIR, "impl-superseded.png");
    await clipSelector(page, '[data-part="task-detail-v3"] [role="dialog"]', implSup);
    measures["impl-superseded"] = await measureStyles(page, DETAIL_PROBES);
    console.log("wrote", implSup);
  }

  // Side-by-side composites
  for (const name of ["fila", "main", "review", "superseded"]) {
    const left = join(SHOT_DIR, `proto-${name}.png`);
    const right = join(SHOT_DIR, `impl-${name}.png`);
    if (existsSync(left) && existsSync(right)) {
      await sideBySide(left, right, join(SHOT_DIR, `side-by-side-${name}.png`));
    }
  }

  // Diff table
  const table = [];
  for (const key of Object.keys(measures["proto-fila"] || {})) {
    table.push({
      element: key,
      proto: measures["proto-fila"]?.[key],
      impl: measures["impl-fila"]?.[key],
    });
  }
  writeFileSync(join(SHOT_DIR, "computed-style-fila.json"), JSON.stringify({ table, all: measures }, null, 2));
  const md = ["# proto × impl getComputedStyle — Fila", "", "| Element | Prop | Proto | Impl | Match |", "|---|---|---|---|---|"];
  for (const row of table) {
    if (!row.proto && !row.impl) {
      md.push(`| ${row.element} | — | missing | missing | no |`);
      continue;
    }
    const props = ["fontSize", "fontWeight", "padding", "gap", "color", "backgroundColor", "borderRadius"];
    for (const p of props) {
      const a = row.proto?.[p] ?? "—";
      const b = row.impl?.[p] ?? "—";
      md.push(`| ${row.element} | ${p} | ${a} | ${b} | ${a === b ? "yes" : "no"} |`);
    }
  }
  writeFileSync(join(SHOT_DIR, "computed-style-fila.md"), md.join("\n"));
  console.log("wrote measures", join(SHOT_DIR, "computed-style-fila.md"));
} catch (err) {
  failed = err;
  console.error(err);
} finally {
  await stopApp(app);
}

if (failed) {
  console.error("CAPTURE FAILED", failed);
  process.exit(1);
}
console.log("SHOT_DIR", SHOT_DIR);
