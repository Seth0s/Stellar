/**
 * Codigo V6 visual proof — prototype vs implementation, SAME framing:
 * card-only crop, same open file (useTerminal.ts), live agent with territory.
 * Isolated Electron + /tmp repo — never the owner's live app.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  startApp,
  stopApp,
  connectPage,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PROTO = join(ROOT, "docs/design/app-v3/prototipo/Codigo.dc.html");
const ACBRIDGE_BIN = join(ROOT, "resources/bin/acbridge");
const CDP_PORT = await pickFreePort();
// Short path: AF_UNIX sun_path ~108 chars; profiles/<uuid>/agent-canvas.sock
// under a long .verify-tmp path can fail to bind (see smoke-gate-lock).
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-v6c-"));
const SHOT_DIR = new URL("../../.verify-tmp/v6-codigo-shots/", import.meta.url).pathname;
const REPO = `/tmp/stellar-v6-codigo-repo-${CDP_PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function findSocketPath(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findSocketPath(path);
      if (nested) return nested;
    } else if (entry.name === "agent-canvas.sock" && statSync(path).isSocket()) {
      return path;
    }
  }
  return null;
}

async function waitForSock(root, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const sock = findSocketPath(root);
    if (sock) return sock;
    await delay(150);
  }
  return null;
}

/** Real create_task with card id via this instance's bus sock (under profiles/). */
async function acbridge(sockPath, cardId, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ACBRIDGE_BIN, ...args], {
      env: {
        ...process.env,
        AGENT_CANVAS_SOCK: sockPath,
        AGENT_CANVAS_CARD_ID: cardId || "",
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, code: err.code, stdout: (err.stdout ?? "").trim(), stderr: (err.stderr ?? "").trim() };
  }
}

function seedRepo(root) {
  rmSync(root, { recursive: true, force: true });
  const paths = [
    "src/renderer/src/useTerminal.ts",
    "src/renderer/src/terminal-render.ts",
    "src/renderer/src/TaskCard.tsx",
    "src/renderer/src/TerminalCard.module.css",
    "src/renderer/src/styles/tokens.css",
    "src/main/message-bus.ts",
    "src/main/screen-turn-state.ts",
    "src/main/board-context.seed.json",
    "tests/terminal-replay.test.ts",
    "docs/MOBILE_V1.md",
    "resources/relay/build.sh",
    "resources/relay/icon.png",
    "package.json",
  ];
  for (const p of paths) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    if (p.endsWith(".png")) {
      writeFileSync(
        abs,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
    } else if (p.endsWith(".json")) writeFileSync(abs, "{}\n");
    else if (p.endsWith(".css")) writeFileSync(abs, ".x { color: red; }\n");
    else if (p.endsWith(".sh")) writeFileSync(abs, "#!/bin/sh\necho ok\n");
    else if (p.endsWith(".md")) writeFileSync(abs, "# doc\n");
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) {
      writeFileSync(
        abs,
        `// sample\nasync function replayInto(term: Terminal, replay: Replay) {\n  await fitVerified(term);\n  if (replay.scrollback) await writeChunked(term, replay.scrollback, 64 * 1024);\n  term.scrollToBottom();\n}\n`,
      );
    } else writeFileSync(abs, "");
  }
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=v6@test", "-c", "user.name=v6", "commit", "-m", "seed"], {
    cwd: root,
  });
  const u = join(root, "src/renderer/src/useTerminal.ts");
  const t = join(root, "src/renderer/src/TaskCard.tsx");
  writeFileSync(u, `${readFileSync(u, "utf8")}\n// dirty by agent\n`);
  writeFileSync(t, `${readFileSync(t, "utf8")}\n// dirty\n`);
}

function expandPrototypeHtml(html) {
  return html
    .replaceAll("{{aFiles}}", "ab abOn")
    .replaceAll("{{aSearch}}", "ab")
    .replaceAll("{{aGit}}", "ab")
    .replaceAll("{{aAgents}}", "ab")
    .replaceAll("{{aProb}}", "ab")
    .replaceAll("{{sideTitle}}", "Arquivos")
    .replaceAll("{{sFiles}}", "true")
    .replaceAll("{{sSearch}}", "false")
    .replaceAll("{{sGit}}", "false")
    .replaceAll("{{sAgents}}", "false")
    .replaceAll("{{sProb}}", "false")
    .replaceAll('hint-placeholder-val="{{ true }}"', "")
    .replaceAll('hint-placeholder-val="{{ false }}"', "")
    .replaceAll("<sc-if", "<div")
    .replaceAll("</sc-if>", "</div>")
    .replaceAll('value="{{sFiles}}"', 'data-side="files"')
    .replaceAll('value="{{sSearch}}"', 'style="display:none"')
    .replaceAll('value="{{sGit}}"', 'style="display:none"')
    .replaceAll('value="{{sAgents}}"', 'style="display:none"')
    .replaceAll('value="{{sProb}}"', 'style="display:none"')
    .replaceAll('onClick="{{goFiles}}"', "")
    .replaceAll('onClick="{{goSearch}}"', "")
    .replaceAll('onClick="{{goGit}}"', "")
    .replaceAll('onClick="{{goAgents}}"', "")
    .replaceAll('onClick="{{goProb}}"', "");
}

async function clipSelector(page, selector, outPath) {
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
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return { outPath, rect };
}

async function clickModalAllow(page) {
  for (let i = 0; i < 20; i++) {
    const hit = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) =>
            /Permitir|Allow|Sim|OK/i.test(x.textContent || ''));
          if (!b) return "null";
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    if (hit) {
      await page.click(hit.x, hit.y);
      return true;
    }
    await delay(150);
  }
  return false;
}

mkdirSync(SHOT_DIR, { recursive: true });
seedRepo(REPO);

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: {
    AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify({ x: 40, y: 40, width: 1440, height: 900 }),
  },
});

let failed = null;
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);

  // Remember the app URL before leaving for the prototype shot.
  const appUrl = await page.evalJs(`location.href`);

  // --- Prototype (same window, then return) --------------------------------
  const protoHtmlPath = join(SHOT_DIR, "prototype-expanded.html");
  writeFileSync(protoHtmlPath, expandPrototypeHtml(readFileSync(PROTO, "utf8")));
  await page.send("Page.navigate", { url: `file://${protoHtmlPath}` });
  let protoReady = false;
  for (let i = 0; i < 30; i++) {
    protoReady = await page.evalJs(`!!document.querySelector('section[aria-label="Card de código"]')`);
    if (protoReady) break;
    await delay(100);
  }
  if (!protoReady) {
    const href = await page.evalJs(`location.href`);
    const body = await page.evalJs(`(document.body?.innerText || '').slice(0, 200)`);
    throw new Error(`prototype section missing; href=${href}; body=${body}`);
  }
  await delay(400);
  const protoPath = join(SHOT_DIR, "prototype-1440.png");
  await clipSelector(page, 'section[aria-label="Card de código"]', protoPath);
  console.log("wrote", protoPath);

  await page.send("Page.navigate", { url: appUrl });
  await delay(1500);

  // --- Implementation ------------------------------------------------------
  await bootIntoFreshSession(page, "Codigo V6 shots", { spawnTerminal: true });
  await delay(800);

  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === 'Codigo V6 shots') ?? boards[0];
        // Board root = capture repo so territory/cwd match the files card.
        if (typeof window.store.boards.update === 'function') {
          await window.store.boards.update({ ...board, cwd: ${JSON.stringify(REPO)} });
        } else if (typeof window.store.boards.upsert === 'function') {
          await window.store.boards.upsert({ ...board, cwd: ${JSON.stringify(REPO)} });
        }
        const cards = await window.store.list(board.id);
        const bash = cards.find((c) => c.kind === 'terminal');
        await window.store.upsert({
          id: 'codigo1440',
          board_id: board.id,
          kind: 'files',
          provider: '',
          cwd: ${JSON.stringify(REPO)},
          // Below the app topbar (~48px) so the clip of .files-card is not
          // painted over by SESSÕES / session chrome.
          x: 30, y: 56, w: 1380, h: 820,
          resume_id: null, model: null, effort: null, system_prompt: null,
          group_id: null, label: 'Stellar',
          updated_at: Date.now(),
        });
        if (bash) {
          await window.store.upsert({
            ...bash,
            cwd: ${JSON.stringify(REPO)},
            provider: bash.provider || 'claude',
            label: 'IMPL · Claude',
            updated_at: Date.now(),
          });
        }
        return JSON.stringify({ boardId: board.id, agentId: bash?.id ?? null });
      })()
    `),
  );
  console.log("board/agent", ids);

  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await delay(400);
  await page.evalJs(`
    [...document.querySelectorAll('.home-session-name')]
      .find((e) => e.textContent.trim().includes('Codigo V6 shots'))?.click()
  `);
  await delay(1500);

  if (!ids.agentId) throw new Error("no live terminal card from boot");
  const sockPath = await waitForSock(USER_DATA_DIR);
  console.log("sock", sockPath, "userData", USER_DATA_DIR);
  if (!sockPath) throw new Error(`agent-canvas.sock not found under ${USER_DATA_DIR}`);
  // Identity is socket-peer ancestry only — run acbridge INSIDE the card PTY.
  const createPayload = JSON.stringify({
    boardId: ids.boardId,
    prompt: "v6 codigo capture — touch useTerminal",
    territory: ["src/renderer/src/useTerminal.ts", "src/renderer/src/terminal-render.ts"],
    cardId: ids.agentId,
    reportSchema: ["filesChanged", "decisaoTomada"],
  });
  const marker = `V6_CREATE_TASK_${CDP_PORT}`;
  const shellCmd =
    `acbridge create-task ${JSON.stringify(createPayload)}; echo ${marker}:$?\n`;
  await page.evalJs(
    `window.pty.write(${JSON.stringify(ids.agentId)}, ${JSON.stringify(shellCmd)}, "human")`,
  );
  let createdOk = false;
  let taskId = null;
  for (let i = 0; i < 40; i++) {
    await delay(250);
    const probe = JSON.parse(
      await page.evalJs(`
        (async () => {
          const tasks = await window.tasks.listByBoard(${JSON.stringify(ids.boardId)});
          const hit = (tasks || []).find((t) =>
            (t.promptPreview || '').includes('v6 codigo capture') ||
            (t.territory || []).some((p) => String(p).includes('useTerminal')));
          return JSON.stringify({
            count: (tasks || []).length,
            taskId: hit?.id ?? null,
            territory: hit?.territory ?? null,
            cardAlive: hit?.cardAlive ?? null,
            cards: hit?.cards ?? null,
          });
        })()
      `),
    );
    if (probe.taskId && Array.isArray(probe.territory) && probe.territory.length > 0) {
      createdOk = true;
      taskId = probe.taskId;
      console.log("create_task via pty", probe);
      break;
    }
    if (i === 39) console.log("create_task probe last", probe);
  }
  if (!createdOk) throw new Error("create_task via pty did not produce a territory task");
  await clickModalAllow(page);
  await delay(800);

  const hasCard = await page.evalJs(`!!document.querySelector('.files-card')`);
  if (!hasCard) throw new Error("files card did not load");

  // Focus the files card shell so Ctrl+P / tree clicks land on it.
  await page.evalJs(`
    (() => {
      const card = document.querySelector('.files-card');
      card?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      card?.click();
      const ide = card?.querySelector('[class*="ide"]');
      if (ide && !ide.hasAttribute('tabindex')) ide.setAttribute('tabindex', '-1');
      ide?.focus();
    })()
  `);
  await delay(200);

  async function clickTreeName(name, { preferCollapsed = false } = {}) {
    const ok = await page.evalJs(`
      (() => {
        const rows = [...document.querySelectorAll('.files-card [class*="treeRow"]')];
        const matches = rows.filter((r) => {
          const n = r.querySelector('.files-node-name')?.textContent?.trim();
          return n === ${JSON.stringify(name)};
        });
        let row = matches[matches.length - 1];
        if (${preferCollapsed ? "true" : "false"}) {
          row = matches.find((r) => (r.querySelector('[class*="chev"]')?.textContent || '').includes('▸')) ?? row;
        }
        if (!row) return false;
        row.click();
        return true;
      })()
    `);
    return ok;
  }

  async function waitExpanded(name, tries = 12) {
    for (let i = 0; i < tries; i++) {
      const open = await page.evalJs(`
        (() => {
          const rows = [...document.querySelectorAll('.files-card [class*="treeRow"]')];
          const row = rows.find((r) => r.querySelector('.files-node-name')?.textContent?.trim() === ${JSON.stringify(name)});
          const chev = row?.querySelector('[class*="chev"]')?.textContent || '';
          return chev.includes('▾');
        })()
      `);
      if (open) return true;
      await delay(200);
    }
    return false;
  }

  for (const name of ["src", "renderer", "src"]) {
    const hit = await clickTreeName(name, { preferCollapsed: true });
    console.log("expand", name, hit);
    await delay(500);
    console.log("expanded?", name, await waitExpanded(name));
  }
  let opened = await clickTreeName("useTerminal.ts");
  console.log("open useTerminal.ts via tree", opened);

  // Fallback: Ctrl+P goto with fuzzy results (same surface as the handoff).
  if (!opened) {
    await page.evalJs(`
      (() => {
        const ide = document.querySelector('.files-card [class*="ide"]');
        ide?.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true }));
      })()
    `);
    await delay(300);
    await page.evalJs(`
      (() => {
        const input = document.querySelector('.files-card [class*="goTo"] input, .files-card [class*="searchInput"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'useTerminal');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await delay(700);
    opened = await page.evalJs(`
      (() => {
        const hits = [...document.querySelectorAll('.files-card [class*="goToHit"]')];
        const hit = hits.find((b) => /useTerminal/.test(b.textContent || '')) ?? hits[0];
        if (!hit) return false;
        hit.click();
        return true;
      })()
    `);
    console.log("open useTerminal.ts via Ctrl+P", opened);
  }
  await delay(800);

  // Territory warn — click Edit anyway so the editor stays open with gutter.
  await page.evalJs(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /Editar mesmo assim|Edit anyway/i.test(b.textContent || ''));
      btn?.click();
    })()
  `);
  await delay(1500);

  for (let i = 0; i < 30; i++) {
    const ready = await page.evalJs(`!!document.querySelector('.files-card .code-editor .cm-content')`);
    if (ready) break;
    await delay(200);
  }

  // Put cursor on the function so the breadcrumb symbol resolves (prototype parity).
  await page.evalJs(`
    (() => {
      const line = [...document.querySelectorAll('.files-card .cm-line')]
        .find((el) => /async function replayInto/.test(el.textContent || ''));
      if (!line) return false;
      const r = line.getBoundingClientRect();
      const x = r.x + Math.min(40, r.width / 2);
      const y = r.y + r.height / 2;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        line.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
      }
      return true;
    })()
  `);
  await delay(400);

  // Ctrl+P: blur CodeMirror (it eats keys), focus the IDE shell, then CDP Ctrl+P.
  const sidePt = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.files-card [class*="sideTitle"]')
          || document.querySelector('.files-card [aria-label="Arquivos"]')
          || document.querySelector('.files-card');
        if (!el) return "null";
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (sidePt) await page.click(sidePt.x, sidePt.y);
  await delay(100);
  await page.evalJs(`
    (() => {
      const active = document.activeElement;
      if (active && typeof active.blur === 'function') active.blur();
      const ide = document.querySelector('.files-card [class*="ide"]');
      if (ide && !ide.hasAttribute('tabindex')) ide.setAttribute('tabindex', '-1');
      ide?.focus();
    })()
  `);
  await delay(100);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "p",
    code: "KeyP",
    text: "p",
    modifiers: 2,
    windowsVirtualKeyCode: 80,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "p",
    code: "KeyP",
    modifiers: 2,
    windowsVirtualKeyCode: 80,
  });
  await delay(400);
  let gotoOpened = await page.evalJs(`!!document.querySelector('.files-card [class*="goTo"]')`);
  // Fallback: invoke the same state path the key handler uses (feature proof).
  if (!gotoOpened) {
    await page.evalJs(`
      (() => {
        const ide = document.querySelector('.files-card [class*="ide"]');
        if (!ide) return;
        ide.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'p', code: 'KeyP', ctrlKey: true, metaKey: false,
          bubbles: true, cancelable: true, composed: true,
        }));
      })()
    `);
    await delay(300);
    gotoOpened = await page.evalJs(`!!document.querySelector('.files-card [class*="goTo"]')`);
  }
  if (gotoOpened) {
    await page.send("Input.insertText", { text: "useT" });
    await delay(800);
  }
  const gotoHits = JSON.parse(
    await page.evalJs(`
      (() => {
        const hits = [...document.querySelectorAll('.files-card [class*="goToHit"]')].map((b) => (b.textContent || '').trim());
        return JSON.stringify({
          opened: !!document.querySelector('.files-card [class*="goTo"]'),
          hitCount: hits.length,
          hits: hits.slice(0, 5),
        });
      })()
    `),
  );
  console.log("Ctrl+P", gotoHits);
  writeFileSync(join(SHOT_DIR, "ctrlp-facts.json"), JSON.stringify(gotoHits, null, 2));
  if (gotoHits.opened) {
    const ctrlpPath = join(SHOT_DIR, "ctrlp-1440.png");
    await clipSelector(page, ".files-card", ctrlpPath);
    console.log("wrote", ctrlpPath);
  }
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(250);

  // Close SESSÕES popover, then hide fixed app chrome that paints OVER the
  // card's screen rect (topbar is position:fixed — clip of .files-card still
  // includes those pixels). Restore after the shot.
  for (let i = 0; i < 4; i++) {
    const open = await page.evalJs(`!!document.querySelector('.board-list')`);
    if (!open) break;
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await delay(120);
  }
  await page.evalJs(`
    (() => {
      window.__v6ChromeHidden = [];
      for (const sel of ['.topbar', '.topbar-home', '.rail', '.board-list', '.popover']) {
        for (const el of document.querySelectorAll(sel)) {
          window.__v6ChromeHidden.push([el, el.style.visibility]);
          el.style.visibility = 'hidden';
        }
      }
    })()
  `);
  await delay(150);
  const sessionsStill = await page.evalJs(`!!document.querySelector('.board-list') && getComputedStyle(document.querySelector('.board-list')).visibility !== 'hidden'`);
  console.log("sessionsPopover", sessionsStill ? "STILL_OPEN" : "closed");

  const implPath = join(SHOT_DIR, "impl-1440.png");
  await clipSelector(page, ".files-card", implPath);
  await page.evalJs(`
    (() => {
      for (const [el, vis] of window.__v6ChromeHidden || []) el.style.visibility = vis;
      window.__v6ChromeHidden = null;
    })()
  `);
  console.log("wrote", implPath);

  const sidePath = join(SHOT_DIR, "side-by-side-1440.png");
  execFileSync("magick", [protoPath, implPath, "+append", "-resize", "x900>", sidePath]);
  console.log("wrote", sidePath);

  const facts = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = document.querySelector('.files-card');
        const rail = document.querySelector('[aria-label="Painéis"]');
        const sideTitle = document.querySelector('[class*="sideTitle"]');
        const agentDots = document.querySelectorAll('[class*="agentDot"]').length;
        const langBadges = document.querySelectorAll('[class*="langBadge"]').length;
        const gitLetters = [...document.querySelectorAll('[class*="gitLetter"]')].map((e) => e.textContent);
        const editor = document.querySelector('.code-editor .cm-content');
        const minimap = document.querySelector('[class*="minimap"]');
        const agentGut = document.querySelector('.cm-agent-gutter');
        const gutMarks = document.querySelectorAll('.cm-agent-gutter .cm-gutterElement').length;
        const crumbs = document.querySelector('[class*="crumbs"]')?.textContent ?? '';
        const diffPane = document.querySelector('[aria-label*="HEAD"], [aria-label*="antes"]');
        const warn = !!document.querySelector('[class*="warnOverlay"], [class*="warnDialog"]');
        const agentsPanel = (card?.innerText || '').includes('IMPL') || (card?.innerText || '').match(/agente/i);
        const headGoto = document.querySelector('.files-card [class*="headGoto"] input');
        const headPill = document.querySelector('.files-card [class*="headAgentsPill"]');
        const sessionsPopover = !!document.querySelector('.board-list');
        const treeNames = [...document.querySelectorAll('.files-card .files-node-name')].map((n) => n.textContent.trim());
        const autosaveUi = /auto-save/i.test(card?.innerText || '') || [...document.querySelectorAll('.files-card button, .files-card label')].some((el) => /^(Salvar|auto-save)$/i.test((el.textContent || '').trim()));
        return JSON.stringify({
          hasRail: !!rail,
          sideTitle: sideTitle?.textContent?.trim() ?? null,
          hasEditor: !!editor,
          hasMinimap: !!minimap,
          hasAgentGutter: !!agentGut,
          gutterElements: gutMarks,
          hasDiffPane: !!diffPane,
          territoryWarnVisible: warn,
          agentDots,
          langBadges,
          gitLetters,
          crumbs: crumbs.slice(0, 160),
          agentsHint: !!agentsPanel,
          hasHeadGoto: !!headGoto,
          headGotoPlaceholder: headGoto?.getAttribute('placeholder') ?? null,
          hasHeadAgentsPill: !!headPill,
          headAgentsPillText: headPill?.textContent?.trim() ?? null,
          sessionsPopover,
          autosaveUi,
          treeNamesSample: treeNames.filter((n) => /Terminal|TaskCard|useTerminal|terminal-render/.test(n)),
          cardTextSample: (card?.innerText || '').slice(0, 800),
        });
      })()
    `),
  );
  writeFileSync(join(SHOT_DIR, "impl-dom-facts.json"), JSON.stringify(facts, null, 2));
  console.log("dom facts", facts);
} catch (err) {
  failed = err;
  console.error("capture FAILED", err);
} finally {
  try {
    await stopApp(app);
  } catch (e) {
    console.error("stopApp", e);
  }
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(`${USER_DATA_DIR}-home`, { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
  console.log("cleaned userData +", REPO);
}

if (failed) process.exit(1);
console.log("capture-codigo-v6-shots: ok");
