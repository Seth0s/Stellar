// DESIGN-BACKLOG.md item 13 — FilesCard's "explorador de verdade": per-
// type icons, rename/delete/new-file/new-folder quick actions. Runs
// against a disposable scratch directory (own temp dir under
// .verify-tmp, created by this script) — NEVER against the real repo
// tree, which is what a naive "spawn via the rail" test would do (the
// rail's files button always roots at App.tsx's DEFAULT_CWD, the live
// Stellar checkout itself). A files card is spawned rooted at the
// scratch dir by upserting its DB row directly, then reopening the
// session (Home → back in) so `loadBoard` picks the row up — same
// mechanism the app's own board-switch already uses, no shortcut around
// product code.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-files-card-${CDP_PORT}`, import.meta.url).pathname;
const SCRATCH_DIR = new URL(`../../.verify-tmp/smoke-files-card-scratch-${CDP_PORT}`, import.meta.url).pathname;

rmSync(SCRATCH_DIR, { recursive: true, force: true });
mkdirSync(`${SCRATCH_DIR}/sub`, { recursive: true });
writeFileSync(`${SCRATCH_DIR}/notes.md`, "# hello\n");
writeFileSync(`${SCRATCH_DIR}/config.json`, "{}\n");
writeFileSync(`${SCRATCH_DIR}/sub/script.ts`, "export {};\n");

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Files Test", { spawnTerminal: false });

  async function clickByText(selector, text) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}));
          if (!el) return JSON.stringify(null);
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!coords) throw new Error(`element matching ${selector} / "${text}" not found`);
    await page.click(coords.x, coords.y);
  }

  async function clickSelector(sel) {
    let pt = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector(${JSON.stringify(sel)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!pt && sel.includes(".rail-btn[title=")) {
      const titleMatch = sel.match(/title=["\x27]([^"\x27]+)["\x27]/);
      if (titleMatch) {
        const title = titleMatch[1];
        const addBtn = JSON.parse(
          await page.evalJs(`
            (() => {
              const b = document.querySelector(\x27.rail-btn[title="Adicionar card"]\x27);
              if (!b) return null;
              const r = b.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
        if (addBtn) {
          await page.click(addBtn.x, addBtn.y);
          await new Promise((r) => setTimeout(r, 250));
          pt = JSON.parse(
            await page.evalJs(`
              (() => {
                const el = document.querySelector(\\\`.popover-row[title="\${title}"]\\\`);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
              })()
            `),
          );
        }
      }
    }
    if (!pt) throw new Error(`element not found: ${sel}`);
    await page.click(pt.x, pt.y);
  }

  // Insert a files card rooted at the scratch dir directly into the DB,
  // then reopen the session so loadBoard picks it up for real.
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Files Test');
      await window.store.upsert({
        id: 'filestest1',
        board_id: board.id,
        kind: 'files',
        provider: '',
        cwd: ${JSON.stringify(SCRATCH_DIR)},
        x: 40, y: 40, w: 700, h: 560,
        resume_id: null, model: null, system_prompt: null,
        group_id: null, label: null,
        updated_at: Date.now(),
      });
    })()
  `);
  await clickSelector(".topbar-home");
  await new Promise((r) => setTimeout(r, 300));
  await clickByText(".home-session-name", "Files Test");
  await new Promise((r) => setTimeout(r, 800));

  check("scratch-rooted files card loaded", await page.evalJs(`!!document.querySelector('.files-card')`), true);
  check(
    "tree lists the scratch dir's real entries",
    await page.evalJs(`document.querySelectorAll('.files-tree .files-node').length`),
    3,
  );

  // 1. Per-type icons — markdown/config/folder should render DIFFERENT
  // icon glyphs (checked via the inner <svg>'s class list lucide sets,
  // not just "some icon exists").
  const iconClasses = JSON.parse(
    await page.evalJs(`
      (() => {
        const rows = [...document.querySelectorAll('.files-tree > .files-node')];
        const byName = {};
        for (const r of rows) {
          const name = r.querySelector('.files-node-name')?.textContent;
          const svg = r.querySelector('svg');
          if (name) byName[name] = svg?.getAttribute('class') || null;
        }
        return JSON.stringify(byName);
      })()
    `),
  );
  check("markdown file gets a distinct icon from config/folder", iconClasses["notes.md"] && iconClasses["notes.md"] !== iconClasses["config.json"], true);
  check("folder gets a distinct icon from files", iconClasses["sub"] !== iconClasses["notes.md"], true);

  // DESIGN-BACKLOG.md item 6 — marked/dompurify moved to a lazy
  // MarkdownPreview sub-component (dynamic import(), only fires once
  // "preview" is actually clicked) to keep them out of the initial
  // bundle. Open notes.md and toggle to preview — this is the one path
  // that exercises the dynamic import live, not just a type-check.
  await page.evalJs(`
    [...document.querySelectorAll('.files-tree > .files-node .files-node-name')]
      .find((el) => el.textContent === 'notes.md')?.click()
  `);
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`
    [...document.querySelectorAll('.files-editor-head-actions button')].find((b) => b.textContent === 'preview')?.click()
  `);
  await new Promise((r) => setTimeout(r, 800));
  check(
    "markdown preview lazy-loads and renders real HTML from the .md content",
    await page.evalJs(`document.querySelector('.files-editor-preview')?.innerHTML.includes('hello')`),
    true,
  );

  // DESIGN-BACKLOG.md item 21, ponto 11 — "código" view used to be a bare
  // <textarea>: no line numbers, no syntax highlight, no indentation
  // guides. CodeEditor.tsx (CodeMirror 6, lazy-loaded — see
  // FilesCard.tsx's `React.lazy`) replaced it. Open sub/script.ts (real
  // seeded TypeScript content), confirm the real editor mounted (not the
  // old textarea), type more real code, confirm actual per-token
  // highlighting spans exist (not flat unstyled text), save, and confirm
  // the exact typed content landed on disk — the same round-trip the old
  // textarea test would have covered, now through CodeMirror's own
  // update-listener → onChange path (CodeEditor.tsx) instead of a plain
  // DOM `input` event.
  // "sub" is collapsed by default — script.ts's own node doesn't exist in
  // the DOM at all until the folder is expanded first.
  await clickByText(".files-tree > .files-node .files-node-name", "sub");
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`
    [...document.querySelectorAll('.files-tree .files-node-name')]
      .find((el) => el.textContent === 'script.ts')?.click()
  `);
  // Longer wait than the markdown-preview one above — CodeEditor.tsx's
  // lazy chunk bundles CodeMirror's core (~680KB, measured via
  // VISUALIZE=1 npm run build), a real fetch+parse+mount that takes
  // meaningfully longer than marked/dompurify's smaller lazy chunk.
  await new Promise((r) => setTimeout(r, 2000));
  check("old <textarea> editor is gone", await page.evalJs(`!document.querySelector('.files-editor-textarea')`), true);
  check("CodeMirror editor mounted for a .ts file", await page.evalJs(`!!document.querySelector('.code-editor .cm-editor')`), true);
  check("line-number gutter present", await page.evalJs(`!!document.querySelector('.cm-gutters .cm-lineNumbers')`), true);
  check("fold gutter present", await page.evalJs(`!!document.querySelector('.cm-foldGutter')`), true);
  check(
    "seeded file content actually loaded into the editor",
    await page.evalJs(`[...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')`),
    "export {};\n",
  );

  const cmContentCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.cm-content');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + 10, y: r.y + 10 });
      })()
    `),
  );
  await page.click(cmContentCoords.x, cmContentCoords.y);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  const addition = '\nconst n = 1; // note';
  for (const ch of addition) {
    if (ch === "\n") {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    } else {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, text: ch });
    }
  }
  await new Promise((r) => setTimeout(r, 300));

  const tokenSpanCount = await page.evalJs(`document.querySelectorAll('.cm-line span[class^="ͼ"]').length`);
  check("real per-token syntax-highlight spans exist after typing (not flat text)", tokenSpanCount > 0, true);

  await page.evalJs(`
    [...document.querySelectorAll('.files-editor-head-actions button')].find((b) => b.textContent.trim() === 'salvar')?.click()
  `);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "typed content actually saved to disk through CodeMirror's onChange",
    readFileSync(`${SCRATCH_DIR}/sub/script.ts`, "utf8"),
    "export {};\nconst n = 1; // note\n",
  );

  // Re-collapse "sub" — every check below counts *visible* tree rows and
  // was written assuming it starts collapsed (its state from before this
  // block ran).
  await clickByText(".files-tree > .files-node .files-node-name", "sub");
  await new Promise((r) => setTimeout(r, 200));

  // 2. Hover actions exist (rename/delete, +new-file/+new-folder on dirs)
  // even before any real hover — CSS opacity gates visibility, not DOM
  // presence, so a plain query already proves they're there.
  const subRowActionCount = JSON.parse(
    await page.evalJs(`
      (() => {
        const row = [...document.querySelectorAll('.files-tree > .files-node')].find((r) => r.querySelector('.files-node-name')?.textContent === 'sub');
        return JSON.stringify(row?.querySelectorAll('.files-node-actions button').length ?? 0);
      })()
    `),
  );
  check("a folder row has 4 quick actions (new file, new folder, rename, delete)", subRowActionCount, 4);

  // 3. Create a file via the root toolbar.
  await clickSelector(".files-tree-toolbar button[title*='Novo arquivo']");
  await new Promise((r) => setTimeout(r, 200));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.files-create-row input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'created.txt');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 500));
  check("created.txt appears in the tree", await page.evalJs(`document.querySelectorAll('.files-tree .files-node').length`), 4);
  check("created.txt actually exists on disk", existsSync(`${SCRATCH_DIR}/created.txt`), true);

  // 4. Rename it.
  const createdRowPencil = JSON.parse(
    await page.evalJs(`
      (() => {
        const row = [...document.querySelectorAll('.files-tree > .files-node')].find((r) => r.querySelector('.files-node-name')?.textContent === 'created.txt');
        const btn = row.querySelector('button[title="Renomear"]');
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(createdRowPencil.x, createdRowPencil.y);
  await new Promise((r) => setTimeout(r, 200));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.files-node-rename-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'renamed.txt');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 500));
  check("renamed.txt exists on disk", existsSync(`${SCRATCH_DIR}/renamed.txt`), true);
  check("created.txt no longer exists (renamed, not copied)", existsSync(`${SCRATCH_DIR}/created.txt`), false);

  // 5. Delete it — first click arms, second confirms.
  const renamedRowTrash = JSON.parse(
    await page.evalJs(`
      (() => {
        const row = [...document.querySelectorAll('.files-tree > .files-node')].find((r) => r.querySelector('.files-node-name')?.textContent === 'renamed.txt');
        const btn = row.querySelector('button[title="Excluir"]');
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(renamedRowTrash.x, renamedRowTrash.y);
  await new Promise((r) => setTimeout(r, 200));
  check("first click only arms delete (file still there)", existsSync(`${SCRATCH_DIR}/renamed.txt`), true);
  await page.click(renamedRowTrash.x, renamedRowTrash.y);
  await new Promise((r) => setTimeout(r, 500));
  check("second click actually deletes", existsSync(`${SCRATCH_DIR}/renamed.txt`), false);
  check("tree is back to 3 entries", await page.evalJs(`document.querySelectorAll('.files-tree .files-node').length`), 3);

  page.close();
} finally {
  await stopApp(app);
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}
finish();
