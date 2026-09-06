// Pre-release audit P4 — `has`/`get`/`getBaseURL` (secrets.ts) each
// re-read and re-parsed `secrets.json` from disk on every single call
// (`chat:send` alone triggers 2-3 per message). Fixed with an in-memory
// cache, populated on first read and kept in sync by `set`/`clear`
// writing the just-written state directly into it (never invalidate-
// and-reread) — this process is the only writer of this file, so the
// cache can never go stale from something else touching it.
//
// Verifies the cache is REALLY being used, not just that behavior looks
// unchanged: sets a real key via the real `window.secrets.setKey` IPC,
// then deletes the real `secrets.json` file on disk directly (from
// outside the app, not through any API) — if `hasKey` still reads from
// disk like before, deleting the file would make it forget the key.
// Confirms it does NOT forget, proving the answer came from the cache,
// not a fresh disk read. Also proves a provider that was genuinely never
// set still correctly reports false after the same disk-level deletion
// (the cache isn't just stuck reporting the last thing it saw), and that
// the file heals correctly on the next real write afterward.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-secrets-cache-${CDP_PORT}`, import.meta.url).pathname;
const SECRETS_PATH = `${USER_DATA_DIR}/secrets.json`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Secrets Cache Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 300));

  const setResult = JSON.parse(await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-cache-test").then(JSON.stringify)`));
  check("real key set succeeds", setResult.ok, true);
  check("the real file genuinely exists on disk after set", existsSync(SECRETS_PATH), true);

  const hasBeforeDelete = JSON.parse(await page.evalJs(`window.secrets.hasKey("anthropic").then(JSON.stringify)`));
  check("hasKey reports true right after set", hasBeforeDelete, true);

  // Delete the real file directly, from OUTSIDE the app/IPC entirely.
  rmSync(SECRETS_PATH, { force: true });
  check("sanity: the file is genuinely gone now", existsSync(SECRETS_PATH), false);

  const hasAfterDelete = JSON.parse(await page.evalJs(`window.secrets.hasKey("anthropic").then(JSON.stringify)`));
  check("hasKey STILL reports true after the file is deleted — served from cache, not a fresh disk read", hasAfterDelete, true);

  const neverSetAfterDelete = JSON.parse(await page.evalJs(`window.secrets.hasKey("openai").then(JSON.stringify)`));
  check("a provider genuinely never set still correctly reports false (cache isn't just stuck true)", neverSetAfterDelete, false);

  // A real write afterward should heal the file, same atomic path S9
  // already covers — not a regression from caching.
  const secondSet = JSON.parse(await page.evalJs(`window.secrets.setKey("openai", "sk-fake-cache-test-2").then(JSON.stringify)`));
  check("a write after the on-disk file vanished still succeeds", secondSet.ok, true);
  check("...and the file exists again on disk", existsSync(SECRETS_PATH), true);
  const healedParsed = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
  check(
    "...containing BOTH keys set during this run (cache wasn't corrupted by the deletion)",
    JSON.stringify(Object.keys(healedParsed).sort()),
    JSON.stringify(["anthropic", "openai"]),
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
