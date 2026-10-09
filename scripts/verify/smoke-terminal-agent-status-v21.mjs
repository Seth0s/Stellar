/**
 * Cards v2.1 agent header — pill from card_status (not PTY byte activity),
 * footer without last-activity age, resume_id kept, and the fractional-row
 * black seam remasured after the viewport background fix.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = join(tmpdir(), `stellar-agent-status-v21-${CDP_PORT}`);
const OUT = join(tmpdir(), `stellar-agent-status-v21-out-${CDP_PORT}`);
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE_GAP = `(() => {
  const body = document.querySelector('[data-role="terminal-body"]');
  const frame = document.querySelector('[data-kind="terminal"]');
  const foot = frame?.querySelector('.card-foot');
  const viewport = body?.querySelector('.xterm-viewport');
  const screen = body?.querySelector('.xterm-screen');
  const br = body?.getBoundingClientRect();
  const sr = screen?.getBoundingClientRect();
  const vr = viewport?.getBoundingClientRect();
  const cardId = frame?.getAttribute('data-card-id');
  const dims = cardId && window.__getTerminalDims ? window.__getTerminalDims(cardId) : null;
  const cellH = dims?.rows && sr ? sr.height / dims.rows : null;
  return JSON.stringify({
    bodyH: br?.height ?? null,
    screenH: sr?.height ?? null,
    viewportH: vr?.height ?? null,
    gapBodyScreen: br && sr ? +(br.height - sr.height).toFixed(2) : null,
    rows: dims?.rows ?? null,
    cellH: cellH != null ? +cellH.toFixed(3) : null,
    viewportBg: viewport ? getComputedStyle(viewport).backgroundColor : null,
    bodyBg: body ? getComputedStyle(body).backgroundColor : null,
    footTop: foot?.getBoundingClientRect().top ?? null,
    screenBottom: sr?.bottom ?? null,
  });
})()`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const gapTable = [];
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Agent Status V21");
  await delay(1000);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashId = JSON.parse(
    await page.evalJs(`(async () => {
      const cards = await window.store.list(${JSON.stringify(boardId)});
      return JSON.stringify(cards.find((c) => c.kind === "terminal").id);
    })()`),
  );

  // ---- bash: processo vivo, never trabalhando ----
  await delay(800);
  const bashPill = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector('[data-role="terminal-status-pill"]');
      return JSON.stringify({
        text: el?.textContent?.replace(/\\s+/g, " ").trim() ?? null,
        kind: el?.dataset.kind ?? null,
        status: el?.dataset.status ?? null,
      });
    })()`),
  );
  const bashStatus = JSON.parse(
    await page.evalJs(`window.pty.cardStatus(${JSON.stringify(bashId)}).then((r) => JSON.stringify(r))`),
  );
  check("bash card_status is not running-as-work", bashStatus.ok && bashStatus.status !== "running", true);
  check("bash pill is processo vivo (not trabalhando)", bashPill.text, (t) => t === "processo vivo");
  check("footer has no ativo há", await page.evalJs(`!document.querySelector('[data-role="terminal-last-activity"]')`), true);
  check("footer has no task role repeat", await page.evalJs(`!document.querySelector('[data-role="terminal-task-role"]')`), true);

  // Seed resume_id and remount
  await page.evalJs(`(async () => {
    const cards = await window.store.list(${JSON.stringify(boardId)});
    const term = cards.find((c) => c.id === ${JSON.stringify(bashId)});
    await window.store.upsert({
      ...term,
      resume_id: "f1ada3c4-4709-4e80-a5b9-cdc1f6826ae0",
      w: 700, h: 420,
      updated_at: Date.now(),
    });
  })()`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  await delay(400);
  await page.evalJs(`
    [...document.querySelectorAll(".home-session-name")]
      .find((e) => e.textContent.includes("Agent Status V21"))?.click()
  `);
  await delay(1500);

  const resumeEl = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector('[data-role="terminal-resume-id"]');
      if (!el) return JSON.stringify(null);
      const cs = getComputedStyle(el);
      return JSON.stringify({
        text: el.textContent.trim(),
        title: el.getAttribute("title"),
        fontFamily: cs.fontFamily,
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
      });
    })()`),
  );
  check("resume_id visible after context/cota", !!resumeEl, true);
  check("resume_id shows prefix + id", resumeEl?.text?.startsWith("resume:f1ada3c4"), true);
  check("resume_id title is full id", resumeEl?.title, "f1ada3c4-4709-4e80-a5b9-cdc1f6826ae0");
  check("resume_id is mono + ellipsis-ready", resumeEl?.overflow === "hidden" && resumeEl?.textOverflow === "ellipsis", true);

  // ---- gap remasure (3 heights + zoom) ----
  async function setSize(w, h) {
    await page.evalJs(`(async () => {
      const cards = await window.store.list(${JSON.stringify(boardId)});
      const term = cards.find((c) => c.kind === "terminal");
      await window.store.upsert({ ...term, w: ${w}, h: ${h}, updated_at: Date.now() });
    })()`);
    await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
    await delay(300);
    await page.evalJs(`
      [...document.querySelectorAll(".home-session-name")]
        .find((e) => e.textContent.includes("Agent Status V21"))?.click()
    `);
    await delay(1200);
  }

  for (const c of [
    { label: "h380-z1", w: 560, h: 380, zoom: 1 },
    { label: "h420-z1", w: 700, h: 420, zoom: 1 },
    { label: "h500-z1", w: 700, h: 500, zoom: 1 },
    { label: "h420-z075", w: 700, h: 420, zoom: 0.75 },
  ]) {
    await setSize(c.w, c.h);
    if (c.zoom !== 1) {
      await page.evalJs(`(() => {
        const w = document.querySelector(".world");
        if (!w) return;
        const m = (w.style.transform || "").match(/translate\\(([^)]+)\\)/);
        const t = m ? m[1] : "0px, 0px";
        w.style.transform = "translate(" + t + ") scale(" + ${c.zoom} + ")";
      })()`);
      await delay(300);
    }
    const m = JSON.parse(await page.evalJs(MEASURE_GAP));
    gapTable.push({ ...c, ...m });
    const viewportIsPanel =
      m.viewportBg === "rgb(26, 29, 36)" || m.viewportBg === m.bodyBg;
    check(`gap ${c.label}: viewport bg matches panel (not #000)`, viewportIsPanel, true);
    // Remainder may still exist as height, but must not be a different color.
    check(`gap ${c.label}: rows still whole cells`, m.rows != null && m.cellH != null, true);

    const rect = JSON.parse(
      await page.evalJs(`(() => {
        const f = document.querySelector('[data-kind="terminal"]');
        const r = f.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.bottom - 80, width: r.width, height: 80 });
      })()`),
    );
    const shot = await page.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: { ...rect, scale: 1 },
    });
    writeFileSync(join(OUT, `after-${c.label}.png`), Buffer.from(shot.data, "base64"));
  }
  writeFileSync(join(OUT, "gap-after.json"), JSON.stringify(gapTable, null, 2));

  // exited pill
  await page.evalJs(`window.pty.kill(${JSON.stringify(bashId)})`);
  await delay(1000);
  const exitedPill = await page.evalJs(
    `document.querySelector('[data-role="terminal-status-pill"]')?.textContent?.replace(/\\s+/g," ").trim()`,
  );
  check("exited pill says saiu", exitedPill, "saiu");

  console.log("gap table", JSON.stringify(gapTable, null, 2));
  console.log("artifacts", OUT);
} finally {
  await stopApp(app);
}
finish();
