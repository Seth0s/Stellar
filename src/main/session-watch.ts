import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_MS = 1500;
const TIMEOUT_MS = 30_000;

/**
 * DESIGN-BACKLOG.md item 57, ponto 5 — real bug, confirmed live: two
 * fresh (no resumeId) terminal cards for the same provider+cwd each run
 * their own `watchForSession` poller, but every `find*Session` below used
 * to just return the single most-recently-modified session file across
 * the WHOLE shared directory/log — with no notion of which watcher a
 * candidate "belongs" to. A session file that's still being actively
 * appended to (a real, ongoing conversation in ANOTHER card) could
 * out-rank a different card's own, quieter, brand-new session, so two
 * cards converged on the exact same discovered session id. Module-level
 * (not per-watcher) because the whole point is cross-watcher visibility:
 * once a session id is attributed to one card, no other still-polling
 * watcher may claim it, no matter whose poll tick sees it next. Lives for
 * the app's lifetime, deliberately never cleared — a claimed id should
 * never be handed to a second card later either.
 *
 * Still a narrow residual race if two watchers' own filesystem reads
 * interleave (both compute the same "best" candidate before either has
 * claimed it) — accepted as much rarer than the original bug (which
 * reproduced on effectively every overlapping spawn), not eliminated by
 * construction. A real per-candidate lock would close that gap but isn't
 * proportionate here.
 */
const claimedSessionIds = new Set<string>();

function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function findClaudeSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
  const dir = join(homedir(), ".claude", "projects", encodeCwdForClaude(cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || st.mtimeMs <= spawnedAtMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { id, mtimeMs: st.mtimeMs };
    }
  }
  return best?.id ?? null;
}

// Codex's session_index.jsonl is append-only — track byte offset at spawn
// time and only parse what's new, per watcher (module-level, keyed by cwd
// isn't needed: each watcher tracks its own offset independently).
async function findCodexSession(sinceOffset: number): Promise<{ id: string | null; newOffset: number }> {
  const file = join(homedir(), ".codex", "session_index.jsonl");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return { id: null, newOffset: sinceOffset };
  }
  if (content.length <= sinceOffset) return { id: null, newOffset: content.length };
  const added = content.slice(sinceOffset);
  const lines = added.split("\n").filter((l) => l.trim());
  let id: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.id === "string" && !claimedSessionIds.has(parsed.id)) id = parsed.id;
    } catch {
      // partial line (file mid-write) — ignore, next poll will re-read it whole.
    }
  }
  return { id, newOffset: content.length };
}

async function findCursorSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
  const chatsDir = join(homedir(), ".cursor", "chats");
  let hashDirs: string[];
  try {
    hashDirs = await readdir(chatsDir);
  } catch {
    return null;
  }
  let best: { id: string; createdAtMs: number } | null = null;
  for (const hash of hashDirs) {
    const hashPath = join(chatsDir, hash);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(hashPath);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      if (claimedSessionIds.has(sessionId)) continue;
      const metaPath = join(hashPath, sessionId, "meta.json");
      let meta: { cwd?: string; createdAtMs?: number };
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch {
        continue;
      }
      if (meta.cwd !== cwd || typeof meta.createdAtMs !== "number" || meta.createdAtMs <= spawnedAtMs) continue;
      if (!best || meta.createdAtMs > best.createdAtMs) {
        best = { id: sessionId, createdAtMs: meta.createdAtMs };
      }
    }
  }
  return best?.id ?? null;
}

/**
 * Polls the on-disk location each provider (undocumented, reverse-engineered
 * on this machine — see AGENTS.md) writes new sessions to, looking for one
 * created after `spawnedAtMs`. Stops after finding one or after ~30s.
 * `bash` has no session concept — callers should never call this for it.
 *
 * DESIGN-BACKLOG.md item 28 — `antigravity` (formerly `gemini`, swapped
 * 2026-08-31 after Google retired the Gemini CLI) deliberately does NOT
 * get a branch here yet: the other three were reverse-engineered against
 * a real, locally-installed CLI (see AGENTS.md), and antigravity's own
 * on-disk session-file layout hasn't been inspected the same way.
 * Guessing it from docs alone risks silently pointing at the wrong path
 * forever — worse than the honest gap this falls through to (no
 * auto-resume discovery for antigravity cards; `--conversation <id>`
 * itself still works fine if the human passes a session id manually).
 * Revisit once antigravity's real session storage can be inspected.
 */
export function watchForSession(
  providerId: string,
  cwd: string,
  spawnedAtMs: number,
  onFound: (sessionId: string) => void,
): () => void {
  if (providerId !== "claude" && providerId !== "codex" && providerId !== "cursor") {
    return () => {};
  }

  let stopped = false;
  let codexOffset = 0;
  let codexOffsetReady = false;
  // Establish the starting offset before the first poll so we only ever
  // look at bytes appended after this watcher started — set once, then
  // `findCodexSession` advances it every subsequent tick.
  const initCodexOffset =
    providerId === "codex"
      ? readFile(join(homedir(), ".codex", "session_index.jsonl"), "utf8")
          .then((c) => c.length)
          .catch(() => 0)
      : Promise.resolve(0);

  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      let found: string | null = null;
      if (providerId === "claude") {
        found = await findClaudeSession(cwd, spawnedAtMs);
      } else if (providerId === "codex") {
        if (!codexOffsetReady) {
          codexOffset = await initCodexOffset;
          codexOffsetReady = true;
        }
        const result = await findCodexSession(codexOffset);
        codexOffset = result.newOffset;
        found = result.id;
      } else if (providerId === "cursor") {
        found = await findCursorSession(cwd, spawnedAtMs);
      }
      if (found) {
        // Claim synchronously, before anything else runs — the narrow
        // remaining race is two watchers' own filesystem reads
        // interleaving (see claimedSessionIds' doc comment); this at
        // least closes the much wider window of "already claimed, but a
        // later watcher hasn't polled again yet to see that."
        claimedSessionIds.add(found);
        stopped = true;
        clearInterval(timer);
        clearTimeout(timeout);
        onFound(found);
      }
    } catch {
      // Best-effort — a transient read error just means try again next poll.
    }
  }, POLL_MS);

  const timeout = setTimeout(() => {
    stopped = true;
    clearInterval(timer);
  }, TIMEOUT_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
  };
}
