// Pre-release audit B5 — URL sighting (pty-registry.ts) used to run
// `URL_PATTERN.match()` against each RAW `onData` chunk straight from
// node-pty, not against the coalesced buffer this same registry already
// assembles for the renderer. `node-pty`'s chunk boundaries land on
// arbitrary byte offsets (pipe-buffer-sized reads), with no regard for
// where a URL happens to sit in the stream — a URL longer than one such
// chunk was silently split, either missed entirely or emitted truncated/
// duplicated across two "seen" events.
//
// Fixed by matching on the same joined buffer `flush()` already builds
// (fixes chunk splits), plus a bounded `urlCarry` tail across flush
// boundaries (fixes the rarer split at a flush boundary itself).
//
// Verifies live against a REAL bash terminal (auto-seeded by
// bootIntoFreshSession) printing a genuinely long URL — 8000 characters,
// several times any typical PTY read chunk size — via `window.pty.write`,
// exactly as a real agent's own long output would arrive. Confirms the
// exact, complete, non-corrupted URL surfaces both on the `pty:url-seen`
// IPC event itself and in the real DOM chip's `title` (the one place the
// untruncated URL is kept for copying), not a shortened/garbled version.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-pty-url-chunk-split-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "PTY URL Chunk Split Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("real bash terminal card id resolved", typeof bashCardId === "string" && bashCardId.length > 0, true);

  await page.evalJs(`
    (() => {
      window.__seenUrls = [];
      window.pty.onUrlSeen((id, url) => window.__seenUrls.push({ id, url }));
      return true;
    })()
  `);

  // Well over any realistic PTY read chunk size (typically 4-8KB).
  const LONG_PATH = "a".repeat(8000);
  const LONG_URL = `https://example.com/${LONG_PATH}`;
  await page.evalJs(`window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(`echo ${LONG_URL}\r`)})`);
  await new Promise((r) => setTimeout(r, 1500));

  const seen = JSON.parse(await page.evalJs(`JSON.stringify(window.__seenUrls)`));
  const match = seen.find((s) => s.id === bashCardId && s.url === LONG_URL);
  check("the long URL is reported via pty:url-seen, byte-for-byte complete (not split/truncated/garbled)", !!match, true);
  check("exactly one sighting for it (not duplicated by a chunk/carry double-count)", seen.filter((s) => s.url === LONG_URL).length, 1);

  // And the real UI surface: open the badge, confirm the DOM chip's
  // title (where the full URL lives for copying) matches exactly.
  const badgeCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('[data-role="terminal-url-badge"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  check("a URL badge is showing on the terminal card", badgeCoords !== null, true);
  if (badgeCoords) {
    await page.click(badgeCoords.x, badgeCoords.y);
    await new Promise((r) => setTimeout(r, 200));
    const chipTitles = JSON.parse(
      await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="terminal-url-chip"]')].map((b) => b.title))`),
    );
    check("the real DOM chip shows the exact, complete URL", chipTitles.includes(LONG_URL), true);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
