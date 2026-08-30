// Regression guard for DESIGN-BACKLOG.md item 57 ponto 5 — a real bug:
// two fresh (no resumeId) terminal cards for the same provider+cwd could
// discover and attach to the SAME session id ("todos abrem a mesma
// sessão"). Root cause: `findClaudeSession`/`findCursorSession`/
// `findCodexSession` each just returned the single most-recently-touched
// candidate across the whole shared directory/log, with no notion of
// which watcher a candidate belongs to — a session actively being
// appended to by one card could out-rank a different card's own quieter,
// brand-new session.
//
// Tests the REAL `watchForSession` (src/main/session-watch.ts, imported
// directly — no mock, no reimplementation) against a controlled scratch
// `~/.claude/projects/<fake-cwd>/` directory that reproduces the exact
// timing: card A's own session file exists but keeps getting touched
// (an ongoing conversation) after card B's spawn time, while card B's
// own session file appears later still — realistically staggered
// watcher starts (B's watcher only starts ~1.6s after A's, past A's own
// first poll tick), matching how two "novo terminal" clicks actually
// happen in the UI (never in the exact same JS tick).
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchForSession } from "../../src/main/session-watch.ts";
import { makeChecker } from "./cdp-client.mjs";

const { check, finish } = makeChecker();

const sessionsDir = join(homedir(), ".claude", "projects", "-tmp-stellar-item57-5-fake-project");

function writeSessionFile(id, mtimeMs) {
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, '{"type":"user","message":"hi"}\n');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

rmSync(sessionsDir, { recursive: true, force: true });
mkdirSync(sessionsDir, { recursive: true });

try {
  const t0 = Date.now();

  const spawnedAtA = t0;
  // Card A's own session file appears almost immediately.
  writeSessionFile("session-A", spawnedAtA + 200);

  const spawnedAtB = t0 + 400;
  // A's session keeps getting appended to (a real, ongoing conversation)
  // — its mtime advances past B's own spawn time, the exact collision
  // hypothesis: without the fix, B's watcher would see this as "newest
  // candidate after my own spawn time" and wrongly claim it.
  writeSessionFile("session-A", t0 + 600);
  // B's own real session file appears later still.
  setTimeout(() => writeSessionFile("session-B", t0 + 900), 900);

  const foundA = new Promise((resolve) => {
    watchForSession("claude", "/tmp/stellar-item57-5-fake-project", spawnedAtA, resolve);
  });
  await new Promise((r) => setTimeout(r, 1600));
  const foundB = new Promise((resolve) => {
    watchForSession("claude", "/tmp/stellar-item57-5-fake-project", spawnedAtB, resolve);
  });

  const TIMEOUT_MS = 12000;
  const [resultA, resultB] = await Promise.all([
    Promise.race([foundA, new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))]),
    Promise.race([foundB, new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))]),
  ]);

  check("card A discovered some session id", resultA !== null, true);
  check("card B discovered some session id", resultB !== null, true);
  check("the two discovered session ids are DIFFERENT (no collision)", resultA !== resultB, true);
} finally {
  rmSync(sessionsDir, { recursive: true, force: true });
}

finish();
