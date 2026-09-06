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
 * Achado ao vivo (2026-09-06) — a "narrow residual race" documentada
 * abaixo aconteceu de verdade em produção: dois cards com o MESMO cwd
 * (`/home/lucas/Workplace/Projects`) persistiram o mesmo `resume_id` no
 * banco (`SELECT resume_id, count(*) ... GROUP BY resume_id HAVING
 * count(*) > 1` no `agent-canvas.db` ao vivo confirmou o par). Cada
 * watcher faz `readdir`+`stat` (I/O assíncrono, `findClaudeSession`) antes
 * de decidir seu "best" candidato — se os dois pollers (setInterval
 * independentes, um por watcher) disparam perto o bastante um do outro,
 * o segundo pode terminar seu próprio `readdir`/`stat` e computar o MESMO
 * "best" ANTES do primeiro ter chamado `claimedSessionIds.add()`, já que
 * nada serializa essa seção crítica entre watchers diferentes — só
 * dentro do mesmo watcher (um `setInterval` nunca sobrepõe consigo
 * mesmo). Fix: `runExclusive` abaixo — uma fila de promises COMPARTILHADA
 * entre TODOS os watchers (não só claude/codex/cursor entre si, o mesmo
 * global) — garante que o "achar candidato + reivindicar" de qualquer
 * watcher nunca roda concorrente com o de outro, não importa como os
 * timers reais caiam. `session-watch-collision-stress.mjs` reproduz a
 * colisão de verdade (watchers simultâneos, mesmo spawnedAtMs, um único
 * arquivo candidato) — falha ~sempre sem isto, nunca falhou com isto.
 */
const claimedSessionIds = new Set<string>();

let claimQueue: Promise<unknown> = Promise.resolve();
/** Serializa a seção crítica (achar candidato + `claimedSessionIds.add`)
 * entre TODOS os watchers, não só os de um mesmo provider — a fila é
 * módulo-level de propósito, mesmo raciocínio de `claimedSessionIds`
 * acima: o ponto é visibilidade entre watchers, não por-watcher. */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = claimQueue.then(fn, fn);
  claimQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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
      // `runExclusive` — todo o "achar candidato + reivindicar" roda como
      // seção crítica única entre TODOS os watchers vivos (ver o comentário
      // de `runExclusive` acima); sem isto, dois watchers cujo `readdir`/
      // `stat` interleavam podiam computar o mesmo "best" antes de
      // qualquer um dos dois chamar `claimedSessionIds.add`.
      const found = await runExclusive(async () => {
        if (providerId === "claude") {
          return findClaudeSession(cwd, spawnedAtMs);
        } else if (providerId === "codex") {
          if (!codexOffsetReady) {
            codexOffset = await initCodexOffset;
            codexOffsetReady = true;
          }
          const result = await findCodexSession(codexOffset);
          codexOffset = result.newOffset;
          return result.id;
        } else if (providerId === "cursor") {
          return findCursorSession(cwd, spawnedAtMs);
        }
        return null;
      });
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
