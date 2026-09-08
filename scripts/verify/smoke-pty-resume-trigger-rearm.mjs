// Regression guard for the 2026-09-07 addition of a `/resume` watcher.
// Before this, `resumeId` was only ever discovered once, right after spawn
// (see `reportedRef` in TerminalCard.tsx, now `lastReportedRef`) — a user
// running Claude's `/resume` INSIDE an already-open card silently switches
// that card's real session underneath, but the footer kept showing the old
// id forever, because nothing ever re-armed `watchForSession`.
//
// Tests the REAL `createPtyRegistry` (src/main/pty-registry.ts) against a
// REAL spawned `claude` process — no mock of the trigger-detection or
// rearm logic. Two real-world wrinkles this had to work around, neither a
// bug in the fix itself:
//   1. A brand-new cwd makes Claude Code show its one-time "do you trust
//      this folder?" dialog; an Enter sent before dismissing it selects
//      the DEFAULT option, "No, exit" — so this dismisses that first
//      (Down+Enter picks "Yes, I trust this folder").
//   2. The real `/resume` slash command opens an interactive picker with
//      no deterministic keystroke-only completion to script here, so this
//      swaps `RESUME_TRIGGER_COMMANDS.claude` for the safe, real, local-only
//      `/clear` command for the duration of the test — same detection code
//      path (a line typed into the card matching the configured trigger),
//      without depending on the resume picker's own UI.
//
// The "resumed-into" session file is a pre-existing (old mtime) fake file
// whose mtime gets bumped only once the trigger fires — exactly what a real
// `/resume` does to an EXISTING, older session file — rather than depending
// on catching the split-second a real, live claude process happens to flush
// its own transcript, which isn't something a test should race against.
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./cdp-client.mjs";

const { check, finish } = makeChecker();

// `pty-registry.ts` imports `./providers` and `./session-watch` without
// extensions — plain `node` (no bundler) can't resolve those, unlike the
// other smoke tests here that import a single dependency-free .ts file
// directly. Bundled with esbuild (the same bundler electron-vite already
// uses to build this app) instead of reimplementing any of its logic here —
// native deps stay external, resolved from node_modules like always.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifyTmp = fileURLToPath(new URL("../../.verify-tmp", import.meta.url));
const entryPath = join(verifyTmp, "pty-resume-trigger-rearm.entry.ts");
const bundlePath = join(verifyTmp, "pty-resume-trigger-rearm.bundle.mjs");
mkdirSync(verifyTmp, { recursive: true });
writeFileSync(
  entryPath,
  `export { createPtyRegistry } from "../src/main/pty-registry";\nexport { RESUME_TRIGGER_COMMANDS } from "../src/main/session-watch";\n`,
);
execFileSync(
  "./node_modules/.bin/esbuild",
  [entryPath, "--bundle", "--platform=node", "--format=esm", "--external:node-pty", "--external:better-sqlite3", "--external:node:*", `--outfile=${bundlePath}`],
  { cwd: repoRoot, stdio: "inherit" },
);
const { createPtyRegistry, RESUME_TRIGGER_COMMANDS } = await import(bundlePath);

const cwd = mkdtempSync(join(tmpdir(), "stellar-resume-trigger-"));
const sessionsDir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
mkdirSync(sessionsDir, { recursive: true });

const RESUMED_INTO_ID = "resumed-into-session";
const resumedIntoPath = join(sessionsDir, `${RESUMED_INTO_ID}.jsonl`);
// Pre-existing, deliberately OLD — a real `/resume` switches into an
// EXISTING (usually older) session, it doesn't create a fresh file.
writeFileSync(resumedIntoPath, '{"type":"user","message":"hi"}\n');
utimesSync(resumedIntoPath, 1, 1);

const found = [];
const registry = createPtyRegistry({
  onData: () => {},
  onExit: () => {},
  onSessionFound: (_id, sessionId) => found.push(sessionId),
  onUrlSeen: () => {},
  sockPath: "/tmp/stellar-resume-trigger-fake.sock",
  binDir: "/tmp",
  mcpUrl: "http://127.0.0.1:0/fake-mcp-never-used",
});

const cardId = "resume-trigger-smoke-card";
const originalClaudeTrigger = RESUME_TRIGGER_COMMANDS.claude;

try {
  const result = registry.spawn(cardId, "claude", cwd, 80, 24, {});
  check("card spawned ok (real `claude` binary found on PATH)", "id" in result, true);
  if (!("id" in result)) throw new Error(`spawn failed: ${JSON.stringify(result)}`);

  // Dismiss the one-time trust dialog for this brand-new cwd (Down selects
  // "Yes, I trust this folder" — see the file's doc comment above).
  await new Promise((r) => setTimeout(r, 1000));
  registry.write(cardId, "\x1b[B\r");
  await new Promise((r) => setTimeout(r, 1500));

  check("the pre-existing (old mtime) file isn't discovered yet", found.includes(RESUMED_INTO_ID), false);

  // Swap in a safe, real, local-only trigger command for this test (see
  // doc comment) — restored in `finally`.
  RESUME_TRIGGER_COMMANDS.claude = "/clear";
  registry.write(cardId, "/clear\r");
  await new Promise((r) => setTimeout(r, 300));

  // The moment a real `/resume` would have switched into this file.
  utimesSync(resumedIntoPath, Date.now() / 1000, Date.now() / 1000);

  await new Promise((r) => setTimeout(r, 3500));
  check("the rearmed watcher discovered the post-trigger session id", found.includes(RESUMED_INTO_ID), true);
} finally {
  RESUME_TRIGGER_COMMANDS.claude = originalClaudeTrigger;
  registry.kill(cardId, { immediate: true });
  await new Promise((r) => setTimeout(r, 500));
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

finish();
