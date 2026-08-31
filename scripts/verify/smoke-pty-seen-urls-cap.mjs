// Pre-release audit B7 — `seenUrls` (pty-registry.ts, one `Set<string>`
// per terminal entry) grew without any limit: a long-running agent
// printing thousands of distinct URLs over its lifetime accumulated all
// of them, never released until the card's own PTY exited. Fixed with
// oldest-first eviction (`Set` iterates in insertion order) once the set
// passes `MAX_SEEN_URLS` (500).
//
// Verifies live against a real bash terminal printing 800 genuinely
// distinct URLs (`https://example.com/url-N`) in one real loop: (1) the
// internal `seenUrls` size (via a new test-only `debug:seen-urls-count`
// IPC, same guard as B4/B6's debug hooks) never exceeds the cap even
// after well over it, and (2) eviction from the DEDUPE set never
// suppresses reporting a URL a human hasn't seen before — all 800
// distinct URLs still arrive individually over the real `pty:url-seen`
// IPC, none silently dropped just because an older entry aged out.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9448;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-pty-seen-urls-cap", import.meta.url).pathname;
const URL_COUNT = 800;
const MAX_SEEN_URLS = 500; // sandbox.ts's own cap, mirrored here for the assertion

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "PTY Seen URLs Cap Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("real bash terminal card id resolved", typeof bashCardId === "string" && bashCardId.length > 0, true);

  const before = JSON.parse(await page.evalJs(`window.debugBridge.seenUrlsCount(${JSON.stringify(bashCardId)}).then(JSON.stringify)`));
  check("no URLs seen yet on a fresh terminal", before, 0);

  await page.evalJs(`
    (() => {
      window.__seenUrls = [];
      window.pty.onUrlSeen((id, url) => window.__seenUrls.push(url));
      return true;
    })()
  `);

  await page.evalJs(`
    window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(
      `for i in $(seq 1 ${URL_COUNT}); do echo https://example.com/url-$i; done\r`,
    )})
  `);
  await new Promise((r) => setTimeout(r, 4000));

  const seen = JSON.parse(await page.evalJs(`JSON.stringify(window.__seenUrls)`));
  const distinctSeen = new Set(seen);
  // >= not === : the terminal also echoes the typed command line itself
  // (containing the literal, unexpanded "url-$i"), one extra genuine
  // sighting that isn't one of the loop's own N URLs — expected noise,
  // not a missed one.
  const allNPresent = Array.from({ length: URL_COUNT }, (_, i) => `https://example.com/url-${i + 1}`).every((u) => distinctSeen.has(u));
  check(`all ${URL_COUNT} genuinely distinct URLs were individually reported (none dropped by eviction)`, allNPresent, true);

  const after = JSON.parse(await page.evalJs(`window.debugBridge.seenUrlsCount(${JSON.stringify(bashCardId)}).then(JSON.stringify)`));
  check(`the internal seenUrls set stayed at the cap (${MAX_SEEN_URLS}), not ${URL_COUNT}`, after, MAX_SEEN_URLS);

  page.close();
} finally {
  await stopApp(app);
}
finish();
