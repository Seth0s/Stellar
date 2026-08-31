// DESIGN-BACKLOG.md item 12, Fase D — the `bash` tool (main/sandbox.ts's
// real bwrap invocation, consent gate, UI block) and the `delegate_to_agent`
// tool (reuses the EXISTING spawn_agent consent/spawn flow). Same
// `chat.testSimulateTool` test-only hook as smoke-chat-tools.mjs — this
// drives the REAL `executeTool`, so everything downstream of "which tool
// got requested" is genuinely real: a real bwrap child process, real
// filesystem confinement (proven by a write escaping the sandboxed root
// failing on disk, not just an assertion about return value), real
// process-namespace isolation, and a real spawn_agent consent round trip
// producing a real second terminal card on the board.
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9442;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-sandbox", import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL("../../.verify-tmp/smoke-chat-sandbox-scratch/", import.meta.url));

rmSync(SCRATCH_ROOT, { recursive: true, force: true });
mkdirSync(SCRATCH_ROOT, { recursive: true });

let bwrapPresent = true;
try {
  execFileSync("bwrap", ["--version"], { stdio: "ignore" });
} catch {
  bwrapPresent = false;
}

async function clickByTitle(page, title) {
  let coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.rail-btn[title=${JSON.stringify(title)}]') || document.querySelector(\`button[title=${JSON.stringify(title)}]\`);
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!coords) {
    const addBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('.rail-btn[title="Adicionar card"]');
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (addBtn) {
      await page.click(addBtn.x, addBtn.y);
      await new Promise((r) => setTimeout(r, 250));
      coords = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector(\`.popover-row[title=${JSON.stringify(title)}]\`);
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
          })()
        `),
      );
    }
  }
  if (!coords) throw new Error(`no button titled "${title}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Chat Sandbox Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));
  await clickByTitle(page, "Novo chatbox");
  await new Promise((r) => setTimeout(r, 300));

  const realCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'chat').id);
      })()
    `),
  );
  check("chat card id resolved", typeof realCardId === "string" && realCardId.length > 0, true);

  // Same key-form dismissal as smoke-chat-tools.mjs — the tool-activity/
  // consent UI lives behind it, testSimulateTool bypasses chat:send's own
  // key-check so a key needs saving here too.
  await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-smoke-test-key")`);
  // item 38 added a "Sessões de chat" toggle BEFORE the API key button in
  // .card-head-actions — select by title, not position.
  await page.evalJs(`
    (() => {
      const b = document.querySelector('.chat-card .card-head-actions button[title="API key"]');
      b?.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  if (!bwrapPresent) {
    // Machine doesn't have bwrap — verify the honest refusal path instead
    // (no consent prompt, no unsandboxed fallback execution).
    const result = JSON.parse(
      await page.evalJs(`
        window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "bash", { command: "echo should-not-run" }, ${JSON.stringify(SCRATCH_ROOT)})
          .then(JSON.stringify)
      `),
    );
    check("bash refuses outright when bwrap is unavailable (no fallback)", result.ok, false);
    check("...and never shows a consent prompt for it", await page.evalJs(`!document.querySelector('.chat-bash-block')`), true);
  } else {
    // ---- bash, DENIED — command must not run ----
    const denyPromise = page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "bash", { command: "echo denied > deny-marker.txt" }, ${JSON.stringify(SCRATCH_ROOT)})
        .then(JSON.stringify)
    `);
    await new Promise((r) => setTimeout(r, 400));
    check("a bash consent block appears", await page.evalJs(`!!document.querySelector('.chat-bash-block')`), true);
    check("...showing the real command text", await page.evalJs(`document.querySelector('.chat-bash-command')?.textContent`), "echo denied > deny-marker.txt");
    const denyCoords = JSON.parse(
      await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-deny'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
    );
    await page.click(denyCoords.x, denyCoords.y);
    const denyResult = JSON.parse(await denyPromise);
    check("denied bash reports ok:false", denyResult.ok, false);
    check("...and genuinely never ran (no marker file on disk)", existsSync(`${SCRATCH_ROOT}deny-marker.txt`), false);

    // ---- bash, ALLOWED — real sandboxed execution, real proof of confinement ----
    const allowPromise = page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "bash", {
        command: "echo real-write > inside.txt && cat inside.txt && (echo escape > /etc/smoke-test-escape.txt) 2>&1; ps aux | wc -l"
      }, ${JSON.stringify(SCRATCH_ROOT)}).then(JSON.stringify)
    `);
    await new Promise((r) => setTimeout(r, 400));
    const allowCoords = JSON.parse(
      await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-allow'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
    );
    await page.click(allowCoords.x, allowCoords.y);
    const allowResult = JSON.parse(await allowPromise);
    check("allowed bash reports ok:true", allowResult.ok, true);
    check("...and the write genuinely landed on disk inside root", existsSync(`${SCRATCH_ROOT}inside.txt`), true);
    check("...with the real content", readFileSync(`${SCRATCH_ROOT}inside.txt`, "utf-8").trim(), "real-write");
    check("...while the write OUTSIDE root was genuinely refused by the OS, not just denied by consent", existsSync("/etc/smoke-test-escape.txt"), false);
    // `text` ends with sandbox.ts's own trailing "[exit code: N]" line, so
    // the `ps aux | wc -l` count is the last NON-EMPTY line before that
    // (stdout can end with its own blank line, e.g. from `ps ... | wc -l`).
    const psLines = allowResult.text.trim().split("\n").filter((l) => l.trim() !== "");
    const psCount = Number(psLines[psLines.length - 2]);
    check(
      "...and the process list inside the sandbox is isolated (a handful of processes, not this host's real full list)",
      Number.isFinite(psCount) && psCount > 0 && psCount < 20,
      true,
    );

    // A tool-line for the completed bash call should render (post-hoc,
    // unlike "running" which is deliberately suppressed — see ChatCard.tsx).
    check("a done tool-line renders for the completed bash call", await page.evalJs(`!!document.querySelector('.chat-tool-line.done:not(.error)')`), true);

    // Real bug found live while writing pre-release audit S5's own smoke
    // test (`smoke-sandbox-home-occlusion.mjs`): `.chat-msg` (cards.css)
    // was `display: flex` with no `flex-direction`, defaulting to `row`.
    // With a done bash decision already sitting in `.chat-msg.assistant`
    // (the "ps aux" one above — its `.chat-tool-line-label` is long and
    // `white-space: nowrap`, no `min-width: 0`), a THIRD bash consent
    // block rendered as a flex-ROW sibling gets squeezed to ~2px wide,
    // positioned thousands of pixels outside the viewport — confirmed
    // live via `elementFromPoint` at its own computed click coordinates
    // returning nothing. Fixed with `flex-direction: column`. This is
    // the regression check: a THIRD bash call, chained right after the
    // "ps aux" one above with no other UI interaction in between, must
    // render a real, on-screen, clickable consent block.
    const thirdBashPromise = page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "bash", { command: "echo third-bash-ok" }, ${JSON.stringify(SCRATCH_ROOT)})
        .then(JSON.stringify)
    `);
    await new Promise((r) => setTimeout(r, 500));
    const thirdBashRect = JSON.parse(
      await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-allow'); if (!b) return "null"; const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y, w: r.width, h: r.height}); })()`),
    );
    check(
      "a third chained bash consent block renders on-screen, not squeezed off to the side by a prior sibling's long label",
      thirdBashRect && thirdBashRect.w > 20 && thirdBashRect.x >= 0 && thirdBashRect.x < 1280,
      true,
    );
    const thirdBashCoords = { x: thirdBashRect.x + thirdBashRect.w / 2, y: thirdBashRect.y + thirdBashRect.h / 2 };
    await page.click(thirdBashCoords.x, thirdBashCoords.y);
    const thirdBashResult = JSON.parse(await thirdBashPromise);
    check("...and clicking it at those real coordinates actually resolves the consent (ok:true)", thirdBashResult.ok, true);
  }

  // ---- delegate_to_agent — reuses the EXISTING spawn_agent consent
  // modal (AgentAskModal), a real card must appear on approval. ----
  const boardCountBefore = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.length);
      })()
    `),
  );
  const delegatePromise = page.evalJs(`
    window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "delegate_to_agent", { provider: "claude", reason: "smoke test delegation" }, ${JSON.stringify(SCRATCH_ROOT)})
      .then(JSON.stringify)
  `);
  await new Promise((r) => setTimeout(r, 500));
  check("the EXISTING AgentAskModal appears (no new UI built for this)", await page.evalJs(`!!document.querySelector('.modal-root .agent-ask-command')`), true);
  check("...showing 'claude' as the requested provider", await page.evalJs(`document.querySelector('.agent-ask-command')?.textContent?.includes('claude')`), true);
  const allowSpawnCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.modal-actions button.primary'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  if (allowSpawnCoords) {
    await page.click(allowSpawnCoords.x, allowSpawnCoords.y);
    const delegateResult = JSON.parse(await delegatePromise);
    check("delegation reports ok:true with a real card id", delegateResult.ok, true);
    await new Promise((r) => setTimeout(r, 500));
    const boardCountAfter = JSON.parse(
      await page.evalJs(`
        (async () => {
          const boards = await window.store.boards.list();
          const cards = await window.store.list(boards[0].id);
          return JSON.stringify(cards.length);
        })()
      `),
    );
    check("...and a real new card genuinely exists on the board afterward", boardCountAfter > boardCountBefore, true);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
