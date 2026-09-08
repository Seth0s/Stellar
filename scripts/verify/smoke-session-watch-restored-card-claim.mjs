// Regression guard for the 2026-09-07 live bug: 3 different Claude cards
// all showing the SAME "resume:<id>" in their footer. Root cause: a card
// restored from the DB already has a `resumeId` (from card.resume_id), so
// `pty-registry.spawn()` skips `watchForSession` for it entirely — nothing
// ever called `claimedSessionIds.add()` for that id. A brand-new card's
// watcher in the same cwd then saw the restored card's own (still actively
// written) session file as "the newest candidate nobody has claimed" and
// attached to it too.
//
// Tests the REAL `claimSessionId`/`watchForSession` (src/main/session-watch.ts,
// imported directly) — no mock. Simulates: card A is "restored" with a known
// resumeId (so its id gets claimed up front, the fix), its session file
// keeps getting touched (an ongoing conversation), then card B spawns fresh
// in the same cwd and must NOT discover card A's file.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchForSession, claimSessionId } from "../../src/main/session-watch.ts";
import { makeChecker } from "./cdp-client.mjs";

const { check, finish } = makeChecker();

const sessionsDir = join(homedir(), ".claude", "projects", "-tmp-stellar-restored-claim-fake-project");

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

  // Card A "restored" from the DB with a known resume id — its session file
  // already exists from a previous run, before B ever spawns.
  writeSessionFile("session-A", t0 - 5000);
  // The fix under test: claiming it up front, exactly like pty-registry's
  // `else { claimSessionId(spawnOpts.resumeId); }` branch does on restore.
  claimSessionId("session-A");

  const spawnedAtB = t0;
  // Card A's conversation is still ongoing — its file keeps getting
  // touched, well after B's own spawn time, which is exactly what used to
  // make it look like "the newest candidate" to B's watcher.
  writeSessionFile("session-A", t0 + 300);
  // Card B's own real session file appears later still.
  setTimeout(() => writeSessionFile("session-B", t0 + 900), 900);

  const foundB = await new Promise((resolve) => {
    const stop = watchForSession("claude", "/tmp/stellar-restored-claim-fake-project", spawnedAtB, resolve);
    setTimeout(() => {
      stop();
      resolve(null);
    }, 3000);
  });

  check("card B did not steal card A's already-claimed session id", foundB !== "session-A", true);
  check("card B discovered its own session id instead", foundB === "session-B", true);
} finally {
  rmSync(sessionsDir, { recursive: true, force: true });
}

finish();
