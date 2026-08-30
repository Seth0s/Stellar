import { delimiter } from "node:path";
import * as pty from "node-pty";
import { resolveSpawn, type SpawnOpts } from "./providers";
import { watchForSession } from "./session-watch";

const COALESCE_MS = 16;
const COALESCE_MAX = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
// DESIGN-BACKLOG.md item 57, ponto 12 — real bug reported live: seen-url
// chips showed garbage like "claude.ai/cod[54G/a[57Gtifact/..." — raw
// ANSI escapes (cursor repositioning, e.g. terminal line-wrap redraws on
// a long URL) landing INSIDE the matched string, since `URL_PATTERN`'s
// excluded-character class (whitespace/quotes/angle-brackets) never
// excluded control characters. Stripped from a local copy used only for
// URL matching below — never from `data` itself, which still needs its
// real escape codes intact for xterm to render color/cursor movement
// correctly. Same CSI/OSC-stripping pattern as the well-known `ansi-regex`
// npm package (not added as a dependency for one regex) — not
// exhaustive of every obscure escape form, but covers the CSI class
// (cursor movement, colors) actually seen in practice here.
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);

type Entry = {
  proc: pty.IPty;
  cols: number;
  rows: number;
  chunks: string[];
  pending: number;
  flushTimer: NodeJS.Timeout | null;
  stopWatch: (() => void) | null;
  seenUrls: Set<string>;
};

export function createPtyRegistry(registryOpts: {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
  onSessionFound: (id: string, sessionId: string) => void;
  onUrlSeen: (id: string, url: string) => void;
  /** Path to the acbridge Unix socket, and the dir it lives in — injected into every spawned provider's env/PATH. */
  sockPath: string;
  binDir: string;
  /** DESIGN-BACKLOG.md item 21, ponto 9 — the MCP server's own base URL
   * (mcp-server.ts), threaded into `SpawnOpts.mcpUrl` for every spawn so
   * `providers.ts::buildArgs` can register it per-provider. */
  mcpUrl: string;
}) {
  const entries = new Map<string, Entry>();

  function flush(id: string) {
    const e = entries.get(id);
    if (!e || e.chunks.length === 0) return;
    const data = e.chunks.join("");
    e.chunks = [];
    e.pending = 0;
    if (e.flushTimer) {
      clearTimeout(e.flushTimer);
      e.flushTimer = null;
    }
    registryOpts.onData(id, data);
  }

  // `id` is the caller's own card id, not a fresh one generated here — the
  // renderer's card id and the PTY's id used to be two separate id spaces
  // (this registry minted its own randomUUID), which meant nothing that
  // deals in "cards" (the message bus's list/send, a browser card's
  // ownerCardId) could actually address a running PTY. Unifying them makes
  // AGENT_CANVAS_CARD_ID, acbridge's targets, and store.listCards() all
  // speak the same id.
  function spawn(
    id: string,
    providerId: string,
    cwd: string,
    cols: number,
    rows: number,
    spawnOpts: SpawnOpts = {},
  ): { id: string } | { error: "binary_not_found" | "spawn_failed"; providerId: string } {
    const resolved = resolveSpawn(providerId, { ...spawnOpts, mcpUrl: registryOpts.mcpUrl });
    if (!resolved) return { error: "binary_not_found", providerId };

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENT_CANVAS_SOCK: registryOpts.sockPath,
      AGENT_CANVAS_CARD_ID: id,
      // DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — fork-bomb guard.
      // `spawnOpts.spawnDepth` is only ever set for an agent-initiated
      // spawn (main/index.ts's onSpawnAgentRequest handler); every human-
      // triggered spawn (rail, radial menu) leaves it undefined, starting
      // a fresh chain at depth 0. This process reports its OWN depth back
      // out via acbridge/MCP if IT spawns another agent.
      AGENT_CANVAS_SPAWN_DEPTH: String(spawnOpts.spawnDepth ?? 0),
      PATH: `${registryOpts.binDir}${delimiter}${process.env.PATH ?? ""}`,
    };

    let proc: pty.IPty;
    try {
      proc = pty.spawn(resolved.binary, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch {
      return { error: "spawn_failed", providerId };
    }

    const entry: Entry = {
      proc,
      cols,
      rows,
      chunks: [],
      pending: 0,
      flushTimer: null,
      stopWatch: null,
      seenUrls: new Set(),
    };
    entries.set(id, entry);

    // Only watch for a fresh session when the caller didn't already pass a
    // resumeId — a spawn that already targets a known session has nothing
    // to discover.
    if (!spawnOpts.resumeId) {
      entry.stopWatch = watchForSession(providerId, cwd, Date.now(), (sessionId) => {
        entry.stopWatch = null;
        registryOpts.onSessionFound(id, sessionId);
      });
    }

    proc.onData((data) => {
      entry.chunks.push(data);
      entry.pending += data.length;
      if (entry.pending >= COALESCE_MAX) {
        flush(id);
        return;
      }
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => flush(id), COALESCE_MS);
      }
      // Passive URL sighting — the only discoverability path for providers
      // with no system-prompt hook (codex/cursor): never opens anything on
      // its own, just surfaces what the agent already printed as a chip a
      // human can click.
      const cleaned = data.replace(ANSI_PATTERN, "");
      for (const url of cleaned.match(URL_PATTERN) ?? []) {
        if (!entry.seenUrls.has(url)) {
          entry.seenUrls.add(url);
          registryOpts.onUrlSeen(id, url);
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      flush(id);
      entry.stopWatch?.();
      entries.delete(id);
      registryOpts.onExit(id, exitCode);
    });

    return { id };
  }

  function write(id: string, data: string) {
    entries.get(id)?.proc.write(data);
  }

  function resize(id: string, cols: number, rows: number) {
    const e = entries.get(id);
    if (!e || (e.cols === cols && e.rows === rows)) return;
    e.cols = cols;
    e.rows = rows;
    e.proc.resize(cols, rows);
  }

  function interrupt(id: string) {
    entries.get(id)?.proc.write("\x03");
  }

  function kill(id: string) {
    const e = entries.get(id);
    if (!e) return;
    e.stopWatch?.();
    e.proc.kill();
    entries.delete(id);
  }

  function killAll() {
    for (const id of [...entries.keys()]) kill(id);
  }

  /** Whether a PTY is actually running right now — the remote-control
   * mobile mirror (remote-server.ts) uses this instead of duplicating the
   * renderer's own liveStatus tracking (spawnError/exitCode), since "has a
   * live entry here" is the same underlying signal, just simpler: no entry
   * means either never spawned, exited, or a spawn error, and the mobile
   * client doesn't need to tell those apart the way the desktop UI does. */
  function isAlive(id: string): boolean {
    return entries.has(id);
  }

  return { spawn, write, resize, interrupt, kill, killAll, isAlive };
}
