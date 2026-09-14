import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { extractAntigravityWorkspaceUri } from "./session-watch";
import { decideIdentifyByProcessEvidence } from "./session-claim-decision";

const execFile = promisify(execFileCb);

/**
 * Manual "identify this card's session" — the honest fallback when
 * discovery cannot uniquely claim. Disk candidates for a cwd are often
 * many (measured: 96 cursor sessions for one Stellar cwd). Ambiguity is
 * refused without a process — that is still correct. With a LIVE card
 * pid, Linux `/proc/<pid>/fd` names the session file the process holds
 * open (measured 2026-09-14: every live cursor-agent keeps
 * `~/.cursor/chats/<hash>/<id>/store.db` open). That is ownership, not
 * an mtime guess.
 *
 * macOS: `/proc` is absent. `listProcessOpenPaths` returns [] and
 * cmdline/start-time helpers no-op unless a Darwin path is injected.
 * Identify then keeps the refusal (or unique/cmdline) and surfaces
 * actionable candidates for the human to pick — never invents fd evidence.
 */

export type IdentifyStatus = "found" | "ambiguous" | "none" | "error";

export type IdentifyCandidateInfo = {
  id: string;
  /** Human-recognizable label (cursor meta.title, etc.). */
  title?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type IdentifyResult = {
  status: IdentifyStatus;
  ids: string[];
  source: string;
  message?: string;
  /** Present on ambiguous so the footer can offer a human pick. */
  candidates?: IdentifyCandidateInfo[];
  /** How process evidence resolved a multi-candidate set, when it did. */
  via?: "open-fd" | "cmdline" | "process-birth-window" | "unique";
};

export type IdentifyDeps = {
  homedir?: () => string;
  platform?: () => NodeJS.Platform;
  readUtf8?: (path: string) => Promise<string>;
  listDir?: (path: string) => Promise<string[]>;
  readlinkPath?: (path: string) => Promise<string>;
  statMtimeMs?: (path: string) => Promise<number | null>;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  extractAntigravityWorkspaceUri?: (path: string) => Promise<string | null>;
  /** Override process evidence (tests). When omitted, Linux /proc is read. */
  readProcessEvidence?: (pid: number) => Promise<{
    openPaths: string[];
    cmdline: string;
    startedAtMs?: number;
  }>;
};

export function cursorChatsHash(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

export function decideIdentifyFromIds(ids: string[], source: string): IdentifyResult {
  const unique = [...new Set(ids)];
  if (unique.length === 1) return { status: "found", ids: unique, source };
  if (unique.length > 1) return { status: "ambiguous", ids: unique, source };
  return { status: "none", ids: [], source };
}

function depsWithDefaults(deps: IdentifyDeps = {}): Required<IdentifyDeps> {
  const platform = deps.platform ?? (() => process.platform);
  const readUtf8 = deps.readUtf8 ?? ((path: string) => readFile(path, "utf8"));
  const listDir = deps.listDir ?? readdir;
  const readlinkPath = deps.readlinkPath ?? ((path: string) => readlink(path));
  const base = {
    homedir: deps.homedir ?? osHomedir,
    platform,
    readUtf8,
    listDir,
    readlinkPath,
    statMtimeMs: deps.statMtimeMs ?? (async (path: string) => {
      try {
        return (await stat(path)).mtimeMs;
      } catch {
        return null;
      }
    }),
    execFile: deps.execFile ?? ((file: string, args: string[]) =>
      execFile(file, args, { timeout: 8_000 }).then((r) => ({ stdout: r.stdout }))),
    extractAntigravityWorkspaceUri: deps.extractAntigravityWorkspaceUri ?? extractAntigravityWorkspaceUri,
  };
  return {
    ...base,
    readProcessEvidence:
      deps.readProcessEvidence ??
      ((pid: number) => readLinuxProcessEvidence(pid, { platform, listDir, readlinkPath, readUtf8 })),
  };
}

export async function readLinuxProcessEvidence(
  pid: number,
  io: Pick<Required<IdentifyDeps>, "platform" | "listDir" | "readlinkPath" | "readUtf8">,
): Promise<{ openPaths: string[]; cmdline: string; startedAtMs?: number }> {
  if (io.platform() !== "linux") {
    // macOS / others: /proc does not exist. Callers keep refusal + human pick.
    return { openPaths: [], cmdline: "" };
  }
  const openPaths: string[] = [];
  try {
    const fds = await io.listDir(`/proc/${pid}/fd`);
    for (const fd of fds) {
      try {
        openPaths.push(await io.readlinkPath(`/proc/${pid}/fd/${fd}`));
      } catch {
        // revoked / permission — skip
      }
    }
  } catch {
    // process gone or no /proc
  }
  let cmdline = "";
  try {
    cmdline = await io.readUtf8(`/proc/${pid}/cmdline`);
  } catch {
    // ignore
  }
  const startedAtMs = await readLinuxProcessStartMs(pid, io);
  return { openPaths, cmdline, startedAtMs };
}

/**
 * `/proc/<pid>/stat` field 22 (starttime) is ticks after boot. Convert
 * with `/proc/uptime` and a 100 Hz assumption (Linux USER_HZ default).
 * Returns undefined when unreadable — birth-window path simply does not run.
 */
export async function readLinuxProcessStartMs(
  pid: number,
  io: Pick<Required<IdentifyDeps>, "platform" | "readUtf8">,
): Promise<number | undefined> {
  if (io.platform() !== "linux") return undefined;
  try {
    const [statRaw, uptimeRaw] = await Promise.all([
      io.readUtf8(`/proc/${pid}/stat`),
      io.readUtf8("/proc/uptime"),
    ]);
    const closeParen = statRaw.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const after = statRaw.slice(closeParen + 2).split(" ");
    // fields after (comm): state=0 … starttime=19 (1-based field 22 of full stat)
    const startTicks = Number(after[19]);
    const uptimeSec = Number(uptimeRaw.split(" ")[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) return undefined;
    const USER_HZ = 100;
    const ageSec = uptimeSec - startTicks / USER_HZ;
    if (!Number.isFinite(ageSec) || ageSec < 0) return undefined;
    return Date.now() - ageSec * 1000;
  } catch {
    return undefined;
  }
}

const SESSION_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Measured: cursor keeps `~/.cursor/chats/<md5>/<uuid>/store.db` (+ wal/shm) open. */
export function extractCursorSessionIdsFromPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const m = path.match(/\.cursor\/chats\/[0-9a-f]+\/([0-9a-f-]{36})\//i);
    if (!m) continue;
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Parse `--resume` / `--session-id` (with `=` or next argv) from a cmdline blob. */
export function extractSessionIdsFromCmdline(cmdline: string): string[] {
  const args = cmdline.includes("\0") ? cmdline.split("\0").filter(Boolean) : cmdline.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let value: string | undefined;
    if (a === "--resume" || a === "--session-id") value = args[i + 1];
    else if (a.startsWith("--resume=")) value = a.slice("--resume=".length);
    else if (a.startsWith("--session-id=")) value = a.slice("--session-id=".length);
    if (value && SESSION_UUID_RE.test(value)) out.push(value.match(SESSION_UUID_RE)![0]!);
  }
  return [...new Set(out)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function parseClaudeAgentsJson(raw: string): Array<{ sessionId: string; cwd?: string; pid?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
    ? (parsed as { sessions: unknown[] }).sessions
    : [];
  const out: Array<{ sessionId: string; cwd?: string; pid?: number }> = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const sessionId = stringField(record, "sessionId", "session_id", "id");
    if (!sessionId) continue;
    const cwd = stringField(record, "cwd", "directory", "workspace");
    const pidRaw = record.pid ?? record.PID;
    const pid = typeof pidRaw === "number" ? pidRaw : typeof pidRaw === "string" ? Number(pidRaw) : undefined;
    out.push({ sessionId, cwd, pid: Number.isFinite(pid) ? pid : undefined });
  }
  return out;
}

export function parseOpenCodeSessionListJson(raw: string): Array<{ id: string; directory?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];
  const out: Array<{ id: string; directory?: string }> = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const id = stringField(record, "id", "sessionId", "session_id");
    if (!id) continue;
    out.push({ id, directory: stringField(record, "directory", "cwd", "dir") });
  }
  return out;
}

function applyProcessDecision(
  infos: IdentifyCandidateInfo[],
  decision: ReturnType<typeof decideIdentifyByProcessEvidence>,
  source: string,
): IdentifyResult {
  if (decision.action === "none") return { status: "none", ids: [], source };
  if (decision.action === "claim") {
    return { status: "found", ids: [decision.id], source, via: decision.via };
  }
  const idSet = new Set(decision.ids);
  const candidates = infos.filter((c) => idSet.has(c.id));
  return {
    status: "ambiguous",
    ids: decision.ids,
    source,
    candidates: candidates.length > 0 ? candidates : decision.ids.map((id) => ({ id })),
  };
}

async function resolveWithProcessEvidence(
  infos: IdentifyCandidateInfo[],
  source: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  if (infos.length === 0) return { status: "none", ids: [], source };
  if (infos.length === 1) {
    return { status: "found", ids: [infos[0]!.id], source, via: "unique" };
  }
  if (pid === undefined) {
    return {
      status: "ambiguous",
      ids: infos.map((c) => c.id),
      source,
      candidates: infos,
    };
  }
  const proc = await io.readProcessEvidence(pid);
  const decision = decideIdentifyByProcessEvidence({
    candidates: infos.map((c) => ({ id: c.id, createdAtMs: c.createdAtMs })),
    evidence: {
      openSessionIds: extractCursorSessionIdsFromPaths(proc.openPaths),
      cmdlineSessionIds: extractSessionIdsFromCmdline(proc.cmdline),
      processStartedAtMs: proc.startedAtMs,
    },
  });
  const viaSource =
    decision.action === "claim" && decision.via === "open-fd"
      ? `${source} + /proc/${pid}/fd`
      : decision.action === "claim" && decision.via === "cmdline"
        ? `${source} + /proc/${pid}/cmdline`
        : decision.action === "claim" && decision.via === "process-birth-window"
          ? `${source} + process-birth-window`
          : source;
  return applyProcessDecision(infos, decision, viaSource);
}

export async function identifyCurrentSession(
  providerId: string,
  cwd: string,
  options: { pid?: number } = {},
  deps: IdentifyDeps = {},
): Promise<IdentifyResult> {
  const io = depsWithDefaults(deps);
  try {
    switch (providerId) {
      case "claude":
        return await identifyClaude(cwd, options.pid, io);
      case "cursor":
        return await identifyCursor(cwd, options.pid, io);
      case "antigravity":
        return await identifyAntigravity(cwd, options.pid, io);
      case "opencode":
        return await identifyOpenCode(cwd, options.pid, io);
      case "codex":
        return await identifyCodex(cwd, options.pid, io);
      default:
        return { status: "none", ids: [], source: providerId };
    }
  } catch (error) {
    return {
      status: "error",
      ids: [],
      source: providerId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function identifyClaude(
  cwd: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  try {
    const { stdout } = await io.execFile("claude", ["agents", "--json"]);
    const agents = parseClaudeAgentsJson(stdout);
    const matching = agents.filter((a) => {
      if (a.cwd && a.cwd !== cwd) return false;
      if (pid !== undefined && a.pid !== undefined && a.pid !== pid) return false;
      return true;
    });
    const fromAgents = decideIdentifyFromIds(
      matching.map((a) => a.sessionId),
      "claude agents --json",
    );
    if (fromAgents.status === "found") return fromAgents;
    if (fromAgents.status === "ambiguous") {
      // agents --json already knows pids; if still ambiguous, surface pick.
      return {
        ...fromAgents,
        candidates: fromAgents.ids.map((id) => {
          const row = matching.find((a) => a.sessionId === id);
          return { id, title: row?.pid !== undefined ? `pid ${row.pid}` : undefined };
        }),
      };
    }
  } catch {
    // Process may already be gone — fall through to lastSessionId.
  }
  try {
    const raw = await io.readUtf8(join(io.homedir(), ".claude.json"));
    const parsed = JSON.parse(raw) as { projects?: Record<string, { lastSessionId?: unknown }> };
    const last = parsed.projects?.[cwd]?.lastSessionId;
    if (typeof last === "string" && last.length > 0) {
      return { status: "found", ids: [last], source: "~/.claude.json[projects][cwd].lastSessionId" };
    }
  } catch {
    // ignore
  }
  return { status: "none", ids: [], source: "claude" };
}

async function identifyCursor(
  cwd: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  const hashDir = join(io.homedir(), ".cursor", "chats", cursorChatsHash(cwd));
  let sessionDirs: string[];
  try {
    sessionDirs = await io.listDir(hashDir);
  } catch {
    return { status: "none", ids: [], source: "~/.cursor/chats/<md5(cwd)>" };
  }
  const infos: IdentifyCandidateInfo[] = [];
  for (const sessionId of sessionDirs) {
    try {
      const meta = JSON.parse(await io.readUtf8(join(hashDir, sessionId, "meta.json"))) as {
        cwd?: string;
        title?: string;
        createdAtMs?: number;
        updatedAtMs?: number;
      };
      if (meta.cwd !== cwd) continue;
      infos.push({
        id: sessionId,
        title: typeof meta.title === "string" && meta.title.length > 0 ? meta.title : undefined,
        createdAtMs: typeof meta.createdAtMs === "number" ? meta.createdAtMs : undefined,
        updatedAtMs: typeof meta.updatedAtMs === "number" ? meta.updatedAtMs : undefined,
      });
    } catch {
      // directory without meta — skip
    }
  }
  return resolveWithProcessEvidence(infos, "~/.cursor/chats/<md5(cwd)>/*/meta.json", pid, io);
}

async function identifyAntigravity(
  cwd: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  const dir = join(io.homedir(), ".gemini", "antigravity-cli", "conversations");
  let entries: string[];
  try {
    entries = await io.listDir(dir);
  } catch {
    return { status: "none", ids: [], source: "~/.gemini/antigravity-cli/conversations" };
  }
  const cwdUri = `file://${cwd}`;
  const infos: IdentifyCandidateInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(".db")) continue;
    const path = join(dir, name);
    const uri = await io.extractAntigravityWorkspaceUri(path);
    if (uri !== cwdUri) continue;
    const id = name.slice(0, -".db".length);
    const mtime = await io.statMtimeMs(path);
    infos.push({
      id,
      createdAtMs: mtime ?? undefined,
      updatedAtMs: mtime ?? undefined,
    });
  }
  // Antigravity fd layout not measured on this host; birth-window / human pick only.
  return resolveWithProcessEvidence(infos, "~/.gemini/antigravity-cli/conversations/*.db", pid, io);
}

async function identifyOpenCode(
  cwd: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  try {
    const { stdout } = await io.execFile("opencode", ["session", "list", "--format", "json"]);
    const rows = parseOpenCodeSessionListJson(stdout).filter((row) => row.directory === cwd);
    const infos = rows.map((row) => ({ id: row.id }));
    return resolveWithProcessEvidence(infos, "opencode session list --format json", pid, io);
  } catch (error) {
    return {
      status: "error",
      ids: [],
      source: "opencode session list --format json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function identifyCodex(
  cwd: string,
  pid: number | undefined,
  io: Required<IdentifyDeps>,
): Promise<IdentifyResult> {
  const root = join(io.homedir(), ".codex", "sessions");
  const infos: IdentifyCandidateInfo[] = [];
  let years: string[];
  try {
    years = await io.listDir(root);
  } catch {
    return { status: "none", ids: [], source: "~/.codex/sessions/**/rollout-*.jsonl" };
  }
  for (const year of years) {
    let months: string[];
    try {
      months = await io.listDir(join(root, year));
    } catch {
      continue;
    }
    for (const month of months) {
      let days: string[];
      try {
        days = await io.listDir(join(root, year, month));
      } catch {
        continue;
      }
      for (const day of days) {
        let files: string[];
        try {
          files = await io.listDir(join(root, year, month, day));
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const path = join(root, year, month, day, name);
          try {
            const raw = await io.readUtf8(path);
            const first = raw.split("\n").find((line) => line.trim());
            if (!first) continue;
            const parsed = JSON.parse(first) as {
              type?: string;
              payload?: { session_id?: string; cwd?: string };
            };
            if (parsed.type !== "session_meta") continue;
            if (parsed.payload?.cwd !== cwd) continue;
            if (typeof parsed.payload.session_id !== "string") continue;
            const mtime = await io.statMtimeMs(path);
            infos.push({
              id: parsed.payload.session_id,
              createdAtMs: mtime ?? undefined,
              updatedAtMs: mtime ?? undefined,
            });
          } catch {
            // partial / unrelated jsonl
          }
        }
      }
    }
  }
  return resolveWithProcessEvidence(infos, "~/.codex/sessions/**/rollout-*.jsonl session_meta", pid, io);
}
