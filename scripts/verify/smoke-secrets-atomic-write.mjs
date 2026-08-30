// Pre-release audit S9 — `secrets.ts`'s `writeAll` used to call
// `writeFileSync(path, data, { mode: 0o600 })` directly against the real
// path: a crash mid-write left a truncated file (`readAll` treats invalid
// JSON as empty — a configured key would silently vanish), and `{ mode }`
// only ever applies to a file THE CALL ITSELF CREATES — once secrets.json
// already existed (the common case, every write after the first), its
// mode was left untouched regardless of what it actually was. Fixed: write
// to a sibling `.tmp` path, `chmodSync` it explicitly (regardless of
// whether it's fresh or a leftover from a prior crash), then `renameSync`
// over the real path — atomic on the same filesystem, which `userDataDir`
// guarantees.
//
// Verifies the real, disk-observable guarantees against the actual IPC
// path (`window.secrets.setKey`, no mock) rather than trying to race a
// literal SIGKILL against a syscall that completes in microseconds:
// (1) a normal write leaves the real file at mode 0600 with no stray
// `.tmp` behind; (2) a pre-existing file that somehow has the WRONG mode
// (simulating a file inherited from before this fix, or altered
// externally) gets its mode corrected by the very next write, not just
// left alone; (3) a stray `.tmp` already sitting there (simulating a
// crash mid-write from a previous run) doesn't break the next write —
// it's overwritten and renamed over cleanly, no corruption, no leftover.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9454;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-secrets-atomic-write", import.meta.url).pathname;
const SECRETS_PATH = `${USER_DATA_DIR}/secrets.json`;
const TMP_PATH = `${SECRETS_PATH}.tmp`;

function mode(path) {
  return statSync(path).mode & 0o777;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Secrets Atomic Write Teste");
  await new Promise((r) => setTimeout(r, 500));

  // ---- 1. A normal write: real file, mode 0600, no stray .tmp ----
  const firstSet = JSON.parse(await page.evalJs(`window.secrets.setKey("anthropic", "sk-ant-fake-atomic-1").then(JSON.stringify)`));
  check("first setKey resolves ok:true", firstSet.ok, true);
  check("secrets.json genuinely exists on disk", existsSync(SECRETS_PATH), true);
  check("...at mode 0600", mode(SECRETS_PATH), 0o600);
  check("...with no stray .tmp left behind", existsSync(TMP_PATH), false);
  const hasKeyAfterFirst = JSON.parse(await page.evalJs(`window.secrets.hasKey("anthropic").then(JSON.stringify)`));
  check("hasKey reflects the real write", hasKeyAfterFirst, true);

  // ---- 2. A pre-existing file with the WRONG mode gets corrected, not
  // left alone, by the next write (the actual bug: mode used to only
  // apply on file CREATION). ----
  // `writeFileSync`'s own `mode` option only applies on file CREATION —
  // the exact bug under test — so an explicit `chmodSync` is needed here
  // to actually force the existing file's mode, simulating a legacy file
  // (or one altered externally) that predates this fix.
  chmodSync(SECRETS_PATH, 0o644);
  check("(setup) secrets.json mode forced to 0644 to simulate a pre-fix legacy file", mode(SECRETS_PATH), 0o644);
  const secondSet = JSON.parse(await page.evalJs(`window.secrets.setKey("openai", "sk-fake-atomic-2").then(JSON.stringify)`));
  check("second setKey (different provider) resolves ok:true", secondSet.ok, true);
  check("...and corrects the file's mode back to 0600, not leaving 0644 alone", mode(SECRETS_PATH), 0o600);
  const bothKeysStillPresent = JSON.parse(
    await page.evalJs(`Promise.all([window.secrets.hasKey("anthropic"), window.secrets.hasKey("openai")]).then(JSON.stringify)`),
  );
  check(
    "...and both providers' keys survived (the earlier write wasn't clobbered)",
    bothKeysStillPresent,
    (v) => Array.isArray(v) && v.every((x) => x === true),
  );

  // ---- 3. A stray .tmp left over from a simulated crash doesn't break
  // the next write. ----
  writeFileSync(TMP_PATH, "not valid json — leftover from a simulated crash", { mode: 0o644 });
  check("(setup) a stray, garbage .tmp file exists before the next write", existsSync(TMP_PATH), true);
  const thirdSet = JSON.parse(await page.evalJs(`window.secrets.setKey("gemini", "sk-fake-atomic-3").then(JSON.stringify)`));
  check("a write with a stray leftover .tmp present still resolves ok:true", thirdSet.ok, true);
  check("...the stray .tmp is gone afterward (overwritten and renamed over, not left behind)", existsSync(TMP_PATH), false);
  check("...secrets.json is still valid JSON, not corrupted by the leftover", (() => {
    try { JSON.parse(readFileSync(SECRETS_PATH, "utf-8")); return true; } catch { return false; }
  })(), true);
  check("...mode is still 0600 after this write too", mode(SECRETS_PATH), 0o600);
  const allThreeKeysPresent = JSON.parse(
    await page.evalJs(
      `Promise.all([window.secrets.hasKey("anthropic"), window.secrets.hasKey("openai"), window.secrets.hasKey("gemini")]).then(JSON.stringify)`,
    ),
  );
  check(
    "...and all three providers' keys are present after the full sequence",
    allThreeKeysPresent,
    (v) => Array.isArray(v) && v.every((x) => x === true),
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
