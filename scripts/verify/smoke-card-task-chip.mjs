// The task chip in the agent card header stays whole.
//
// Isolated Electron profile (own userData and ports), never the owner's app.
// A terminal card is linked to a task over MCP, then the header is measured:
// the chip must be as wide as its own text (no clipping), never overlap the
// pill or the action buttons, at the default card width and at narrower ones.
// Screenshots go to CARD_CHIP_OUT (default /tmp/card-chip).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const OUT_DIR = process.env.CARD_CHIP_OUT ?? "/tmp/card-chip";
mkdirSync(OUT_DIR, { recursive: true });
const TAG = process.env.CARD_CHIP_TAG ?? "after";

const CDP_PORT = await pickFreePort();
// Short on purpose: the profile's unix socket path must stay under the ~108 byte limit.
const USER_DATA_DIR = `/tmp/scc-${CDP_PORT}`;

const { check, finish } = makeChecker();
// A stand-in agent binary that just stays alive, so the card reads "processo vivo"
// like the owner's, without launching a real agent.
const FAKE_BIN = `/tmp/scc-bin-${CDP_PORT}`;
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(`${FAKE_BIN}/claude`, "#!/bin/sh\nexec sleep 600\n");
chmodSync(`${FAKE_BIN}/claude`, 0o755);

let app;
try {
  app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
    isolatedHome: true,
    extraEnv: { PATH: `${FAKE_BIN}:${process.env.PATH}` },
  });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(1000);
  await bootIntoFreshSession(page, "Card chip", { spawnTerminal: true });
  await delay(600);

  // MCP now only answers an authenticated card, so the link is made from the
  // seed shell: its acbridge is attributed to that card, and the task is linked
  // to an agent card (the header chip is an agent-card feature).
  const boardId = await page.evalJs(`window.store.boards.list().then((b) => (b.find((x) => x.name === "Card chip") ?? b[0]).id)`);
  const shell = await page.evalJs(`document.querySelector('.card-frame[data-kind="terminal"]')?.dataset.cardId`);
  check("the seed shell card exists", typeof shell, "string");
  const seed = "chip-agent";
  const agentRow = (w) => ({
    id: seed, board_id: boardId, kind: "terminal", provider: "claude", cwd: "/tmp", x: 60, y: 60, w, h: 380,
    resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null,
    updated_at: Date.now(), messages_json: null, archived_at: null,
  });
  // The board only reads cards when it opens: leave to Home and come back.
  const reopen = async () => {
    await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
    for (let i = 0; i < 80 && !(await page.evalJs(`!!document.querySelector(".home-session-card")`)); i++) await delay(100);
    await page.evalJs(`(() => { const n = [...document.querySelectorAll(".home-session-name")].find((x) => x.textContent.includes("Card chip")); (n?.closest("button") ?? document.querySelector(".home-session-card"))?.click(); return true; })()`);
    for (let i = 0; i < 80 && !(await page.evalJs(`!!document.querySelector('[data-card-id="${seed}"] [data-role="terminal-task-chip"], [data-card-id="${seed}"] .card-head')`)); i++) await delay(100);
    await delay(500);
  };
  await page.evalJs(`window.store.upsert(${JSON.stringify(agentRow(640))}).then(() => true)`);
  await reopen();
  check("the agent card is mounted", await page.evalJs(`!!document.querySelector('[data-card-id="${seed}"]')`), true);
  const shellAfter = await page.evalJs(`document.querySelector('.card-frame[data-kind="terminal"]:not([data-card-id="${seed}"])')?.dataset.cardId`);
  const json = JSON.stringify({ prompt: "Chip do header inteiro", provider: "claude", cardId: seed, boardId }).replace(/'/g, "'\\''");
  await delay(600);
  // The shell may still be starting: type the command again if no task shows up.
  let taskId = null;
  for (let attempt = 0; attempt < 4 && !taskId; attempt++) {
    await page.evalJs(`window.pty.write(${JSON.stringify(shellAfter ?? shell)}, ${JSON.stringify(`acbridge create-task '${json}'\r`)}, "human")`);
    for (let i = 0; i < 24 && !taskId; i++) {
      taskId = await page.evalJs(`window.tasks.listByBoard(${JSON.stringify(boardId)}).then((t) => t[0]?.id ?? null)`);
      if (!taskId) await delay(250);
    }
  }
  check("the task exists", typeof taskId, "string");
  const chipSel = `[data-card-id="${seed}"] [data-role="terminal-task-chip"]`;
  let appeared = false;
  for (let attempt = 0; attempt < 4 && !appeared; attempt++) {
    await page.evalJs(`window.pty.write(${JSON.stringify(shellAfter ?? shell)}, ${JSON.stringify(`acbridge update-task ${taskId} '{"status":"running"}'\r`)}, "human")`);
    for (let i = 0; i < 24 && !appeared; i++) {
      appeared = await page.evalJs(`!!document.querySelector(${JSON.stringify(chipSel)})`);
      if (!appeared) await delay(250);
    }
  }
  check("the header shows the task chip", appeared, true);
  if (!appeared) throw new Error("no chip");

  const shot = async (name) => {
    const rect = JSON.parse(await page.evalJs(`(() => { const r = document.querySelector('[data-card-id="${seed}"] .card-head').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }); })()`));
    const res = await page.send("Page.captureScreenshot", { format: "png", clip: { ...rect, x: Math.max(0, rect.x - 4), y: Math.max(0, rect.y - 4), width: rect.width + 8, height: rect.height + 8, scale: 2 } });
    writeFileSync(`${OUT_DIR}/${TAG}-${name}.png`, Buffer.from(res.data, "base64"));
  };

  // One reading of the header: the chip's box vs its own text, and whether it
  // touches a neighbour. `scrollWidth > clientWidth` is the clipping signature.
  const measure = async () =>
    JSON.parse(
      await page.evalJs(`(() => {
        const head = document.querySelector('[data-card-id="${seed}"] .card-head');
        const chip = head.querySelector('[data-role="terminal-task-chip"]');
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        const c = box(chip);
        const range = document.createRange();
        range.selectNodeContents(chip);
        const text = range.getBoundingClientRect();
        const others = [...head.querySelectorAll('button, [data-role="terminal-status-pill"]')]
          .filter((el) => el !== chip && el.getBoundingClientRect().width > 0)
          .map((el) => ({ role: el.getAttribute("aria-label") ?? el.dataset.role ?? el.className, ...box(el) }));
        const overlaps = others.filter((o) => o.l < c.r - 0.5 && o.r > c.l + 0.5 && o.t < c.b && o.b > c.t).map((o) => o.role);
        const headBox = box(head);
        return JSON.stringify({
          text: chip.textContent,
          chipW: Math.round(c.w * 10) / 10,
          chipH: Math.round(c.h * 10) / 10,
          textW: Math.round(text.width * 10) / 10,
          textOverflow: Math.round((text.width - c.w) * 10) / 10,
          overlaps,
          insideHead: c.l >= headBox.l && c.r <= headBox.r,
        });
      })()`),
    );

  // Real card widths: the card re-reads its rect, so narrow mode (< 520) behaves
  // as it does for the owner.
  const widths = [640, 560, 520, 480, 420, 340];
  for (const w of widths) {
    await page.evalJs(`window.store.upsert(${JSON.stringify(agentRow(w))}).then(() => true)`);
    await reopen();
    const m = await measure();
    const label = `${w}px`;
    console.log(`CHIP ${label} ${JSON.stringify(m)}`);
    await shot(label);
    check(`${label}: the chip box holds its whole text`, m.textOverflow <= 0.5, true);
    check(`${label}: the chip text keeps the # and the id`, /^#[0-9a-f]{4,}/.test(m.text), true);
    check(`${label}: nothing overlaps the chip`, JSON.stringify(m.overlaps), "[]");
    check(`${label}: the chip stays inside the header`, m.insideHead, true);
  }
} finally {
  if (app) await stopApp(app);
}
finish();
