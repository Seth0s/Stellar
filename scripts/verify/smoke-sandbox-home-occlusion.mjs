// Pre-release audit S5 — the chat `bash` tool's sandbox (`src/main/
// sandbox.ts`) used `--ro-bind / /`, which makes the WHOLE host
// filesystem readable inside the sandbox — `$HOME` included: `~/.ssh`,
// this app's own `secrets.json`, any other dotfile. `--bind root root`
// only ever intended to grant WRITE access to the project root, never
// READ access to the rest of `$HOME` — that was collateral, not a
// decision. Fix: `--tmpfs $HOME` occludes the real `$HOME` with empty
// scratch space BEFORE the root bind re-mounts the real project
// directory back (writable), so anything under `$HOME` outside the
// project root reads as empty/missing from inside the sandbox.
//
// Verifies this against a REAL navigated chat card's own
// `testSimulateTool("bash", ...)` path (not a mock) and this machine's
// own real `~/.ssh` (confirmed present first — a missing directory
// would make the "occluded" result below pass for the wrong reason).
//
// Started as its own single-scenario script because chaining this
// consent flow right after smoke-chat-sandbox.mjs's prior bash/consent
// interactions made the new consent button's real on-screen position
// land outside the viewport (confirmed live via `elementFromPoint` at
// the computed click coordinates returning nothing) — that turned out
// to be a REAL bug, not a test-harness quirk: `.chat-msg` (cards.css)
// was `display: flex` with no `flex-direction`, so a `.chat-bash-block`
// rendered after an already-resolved bash with a long command got
// squeezed to ~2px wide by that sibling's `white-space: nowrap` label
// monopolizing the (accidental) flex row. Now fixed (`flex-direction:
// column`), with its own regression check re-added to
// smoke-chat-sandbox.mjs (a third chained bash call, no other UI
// interaction in between). This script stays as the focused, minimal-
// dependency verification of the sandbox fix itself.
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-sandbox-home-occlusion-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_ROOT = fileURLToPath(new URL(`../../.verify-tmp/smoke-sandbox-home-occlusion-scratch-${CDP_PORT}/`, import.meta.url));
rmSync(SCRATCH_ROOT, { recursive: true, force: true });
mkdirSync(SCRATCH_ROOT, { recursive: true });

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
  await bootIntoFreshSession(page, "Sandbox Home Occlusion Teste", { spawnTerminal: false });
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

  await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-smoke-test-key")`);
  await page.evalJs(`
    (() => {
      const b = document.querySelector('.chat-card .card-head-actions button[title="API key"]');
      b?.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  const realSshDir = `${homedir()}/.ssh`;
  const realSshExists = existsSync(realSshDir);
  check("this machine has a real ~/.ssh to test against (or the occlusion check below proves nothing)", realSshExists, true);

  if (realSshExists) {
    // `grep -rl` on a non-existent (occluded) directory prints its own
    // error to stderr, suppressed by `2>/dev/null` so it never pollutes
    // the match count; a real, unoccluded `~/.ssh` on this machine is
    // known (checked above) to contain at least one private key, so
    // `wc -l` staying "0" only happens if the sandbox never saw it.
    const sshPromise = page.evalJs(`
      window.chat.testSimulateTool(${JSON.stringify(realCardId)}, "bash", {
        command: "grep -rl 'PRIVATE KEY' ~/.ssh 2>/dev/null | wc -l"
      }, ${JSON.stringify(SCRATCH_ROOT)}).then(JSON.stringify)
    `);
    await new Promise((r) => setTimeout(r, 500));
    check(
      "a bash consent block appears, showing the real command text",
      await page.evalJs(`document.querySelector('.chat-bash-command')?.textContent`),
      "grep -rl 'PRIVATE KEY' ~/.ssh 2>/dev/null | wc -l",
    );
    const sshAllowCoords = JSON.parse(
      await page.evalJs(`(() => { const b = document.querySelector('.chat-diff-allow'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
    );
    await page.click(sshAllowCoords.x, sshAllowCoords.y);
    const sshResult = JSON.parse(await sshPromise);
    check("bash reports ok:true (bwrap ran, no crash)", sshResult.ok, true);
    check(
      "...but ~/.ssh is occluded inside the sandbox — zero private keys found, real key material never reaches the command",
      sshResult.text.split("\n")[0]?.trim(),
      "0",
    );
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
