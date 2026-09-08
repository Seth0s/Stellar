import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const POLL_MS = 1500;
const TIMEOUT_MS = 30_000;
// Achado ao vivo (2026-09-07) — Codex nunca restaurava sessão: o Codex TUI
// só grava a entrada em `~/.codex/session_index.jsonl` bem depois do início
// real da sessão (embedded timestamp do rollout vs. mtime do index, medido
// neste mesmo host): 36s num caso, 211s (3.5min) noutro. Ambos passam do
// TIMEOUT_MS de 30s compartilhado por todo provider, então o watcher sempre
// desistia antes do Codex escrever o índice — `resumeId` ficava `null` pra
// sempre e o próximo launch simplesmente abria uma sessão nova vazia
// (indistinguível de "falhou a restaurar"). Claude/Cursor gravam quase
// instantaneamente (~2s) — 30s continua certo pra eles.
const CODEX_TIMEOUT_MS = 6 * 60_000;

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

/**
 * Achado ao vivo (2026-09-07) — 3 cards Claude diferentes exibindo o MESMO
 * `resume:<id>` no rodapé. Causa: um card restaurado do DB (`spawnOpts.
 * resumeId` já preenchido) pula `watchForSession` inteiramente (ver o `if
 * (!spawnOpts.resumeId)` em pty-registry.ts) — logo seu id nunca passava por
 * `claimedSessionIds.add()`. Pra qualquer watcher de um card novo no mesmo
 * cwd, esse arquivo de sessão (que pode estar sendo escrito ativamente pelo
 * card restaurado) parecia livre pra reivindicar. Chame isto assim que um
 * `resumeId` conhecido é usado pra spawnar/restaurar um card, antes de
 * qualquer watcher rodar — fecha o gap sem esperar um "found" que nunca vem.
 */
export function claimSessionId(id: string): void {
  claimedSessionIds.add(id);
}

/**
 * Pedido ao vivo (2026-09-07) — nada nunca refresca `resumeId` depois do
 * spawn: quem roda `/resume` DENTRO de um card já aberto troca de sessão
 * por baixo (o processo passa a escrever num arquivo de sessão diferente,
 * já existente, escolhido no picker), mas o rodapé do card continua
 * mostrando o id antigo pra sempre — só o id descoberto no spawn é
 * reportado (ver `reportedRef` em TerminalCard.tsx). Único trigger
 * confirmado até agora: o slash command `/resume` do próprio Claude Code
 * (documentado). Os outros providers podem ter equivalentes, mas não
 * foram confirmados contra um CLI real rodando — mesmo critério das
 * lacunas documentadas acima (antigravity) — então ficam de fora até
 * serem confirmados, não adivinhados.
 */
export const RESUME_TRIGGER_COMMANDS: Partial<Record<string, string>> = {
  claude: "/resume",
};

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

async function findOpenCodeSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
  // opencode (sst/opencode, see providers.ts) keeps its own sessions in a
  // real sqlite db (`~/.local/share/opencode/opencode.db`, `session` table
  // — schema confirmed live on this machine via `PRAGMA table_info`), not
  // in loose files like the others. Opened readonly: this db belongs to a
  // separate app that may have it open (WAL mode) at the same time.
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare("SELECT id, time_updated FROM session WHERE directory = ? AND time_updated > ? ORDER BY time_updated DESC")
      .all(cwd, spawnedAtMs) as { id: string; time_updated: number }[];
    for (const row of rows) {
      if (!claimedSessionIds.has(row.id)) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Achado ao vivo (2026-09-07) — reverse-engineered `~/.gemini/antigravity-cli/
// conversations/<id>.db` (one sqlite file per conversation, id = filename)
// against 8 real conversations on this machine: byte-for-byte, the file's
// working-directory is stored as a standard protobuf length-delimited string
// field — tag byte 0x0a or 0x12 (field 1/2, wire type 2), a single-byte
// varint length, then that many raw UTF-8 bytes of a `file://<cwd>` URI —
// inside the `trajectory_metadata_blob` row whose id is `main`. Confirmed via
// the byte immediately preceding "file://" always equalling the exact
// encoded byte-length of that URI (proper length-prefix, not a guessed
// delimiter). Always landed within the first ~40KB of the file regardless of
// total size (one file was 21MB) — same sqlite page every time — so reads
// are bounded to ANTIGRAVITY_READ_WINDOW_BYTES instead of the whole db.
const ANTIGRAVITY_READ_WINDOW_BYTES = 128 * 1024;

async function extractAntigravityWorkspaceUri(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(ANTIGRAVITY_READ_WINDOW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ANTIGRAVITY_READ_WINDOW_BYTES, 0);
    const slice = buffer.subarray(0, bytesRead);
    const needle = Buffer.from("file://");
    let idx = slice.indexOf(needle);
    while (idx > 1) {
      const lenByte = slice[idx - 1];
      const tagByte = slice[idx - 2];
      if ((tagByte === 0x0a || tagByte === 0x12) && lenByte > 0 && idx + lenByte <= slice.length) {
        const candidate = slice.toString("utf8", idx, idx + lenByte);
        if (Buffer.byteLength(candidate, "utf8") === lenByte && candidate.startsWith("file://")) {
          return candidate;
        }
      }
      idx = slice.indexOf(needle, idx + 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function findAntigravitySession(cwd: string, spawnedAtMs: number): Promise<string | null> {
  const dir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const cwdUri = `file://${cwd}`;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".db")) continue; // skip sqlite's own -wal/-shm siblings
    const id = name.slice(0, -".db".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || st.mtimeMs <= spawnedAtMs) continue;
    if (best && st.mtimeMs <= best.mtimeMs) continue;
    const workspaceUri = await extractAntigravityWorkspaceUri(full);
    if (workspaceUri !== cwdUri) continue;
    best = { id, mtimeMs: st.mtimeMs };
  }
  return best?.id ?? null;
}

/**
 * Polls the on-disk location each provider (undocumented, reverse-engineered
 * on this machine — see AGENTS.md) writes new sessions to, looking for one
 * created after `spawnedAtMs`. Stops after finding one or after ~30s (longer
 * for codex — see CODEX_TIMEOUT_MS). `bash` has no session concept —
 * callers should never call this for it. `opencode` also has no branch
 * needed beyond `findOpenCodeSession` below: unlike the others it keeps a
 * real sqlite db, not loose files.
 */
export function watchForSession(
  providerId: string,
  cwd: string,
  spawnedAtMs: number,
  onFound: (sessionId: string) => void,
): () => void {
  if (
    providerId !== "claude" &&
    providerId !== "codex" &&
    providerId !== "cursor" &&
    providerId !== "antigravity" &&
    providerId !== "opencode"
  ) {
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
        } else if (providerId === "antigravity") {
          return findAntigravitySession(cwd, spawnedAtMs);
        } else if (providerId === "opencode") {
          return findOpenCodeSession(cwd, spawnedAtMs);
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

  const timeout = setTimeout(
    () => {
      stopped = true;
      clearInterval(timer);
    },
    providerId === "codex" ? CODEX_TIMEOUT_MS : TIMEOUT_MS,
  );

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
  };
}
