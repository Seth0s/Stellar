import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { extractAntigravityWorkspaceUri } from "./session-watch";

const execFile = promisify(execFileCb);

/**
 * Manual "identify this card's session" — the honest fallback when
 * discovery cannot uniquely claim. Each path is what the 2026-09-13
 * measurement said can be inspected with certainty. If two unowned
 * ids match the cwd, this returns `ambiguous` instead of guessing mtime.
 */

export type IdentifyStatus = "found" | "ambiguous" | "none" | "error";

export type IdentifyResult = {
  status: IdentifyStatus;
  ids: string[];
  source: string;
  message?: string;
};

export type IdentifyDeps = {
  homedir?: () => string;
  readUtf8?: (path: string) => Promise<string>;
  listDir?: (path: string) => Promise<string[]>;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  extractAntigravityWorkspaceUri?: (path: string) => Promise<string | null>;
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
  return {
    homedir: deps.homedir ?? osHomedir,
    readUtf8: deps.readUtf8 ?? ((path) => readFile(path, "utf8")),
    listDir: deps.listDir ?? readdir,
    execFile: deps.execFile ?? ((file, args) => execFile(file, args, { timeout: 8_000 }).then((r) => ({ stdout: r.stdout }))),
    extractAntigravityWorkspaceUri: deps.extractAntigravityWorkspaceUri ?? extractAntigravityWorkspaceUri,
  };
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
        return await identifyCursor(cwd, io);
      case "antigravity":
        return await identifyAntigravity(cwd, io);
      case "opencode":
        return await identifyOpenCode(cwd, io);
      case "codex":
        return await identifyCodex(cwd, io);
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
    if (fromAgents.status !== "none") return fromAgents;
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

async function identifyCursor(cwd: string, io: Required<IdentifyDeps>): Promise<IdentifyResult> {
  const hashDir = join(io.homedir(), ".cursor", "chats", cursorChatsHash(cwd));
  let sessionDirs: string[];
  try {
    sessionDirs = await io.listDir(hashDir);
  } catch {
    return { status: "none", ids: [], source: "~/.cursor/chats/<md5(cwd)>" };
  }
  const ids: string[] = [];
  for (const sessionId of sessionDirs) {
    try {
      const meta = JSON.parse(await io.readUtf8(join(hashDir, sessionId, "meta.json"))) as { cwd?: string };
      if (meta.cwd === cwd) ids.push(sessionId);
    } catch {
      // directory without meta — skip
    }
  }
  return decideIdentifyFromIds(ids, "~/.cursor/chats/<md5(cwd)>/*/meta.json");
}

async function identifyAntigravity(cwd: string, io: Required<IdentifyDeps>): Promise<IdentifyResult> {
  const dir = join(io.homedir(), ".gemini", "antigravity-cli", "conversations");
  let entries: string[];
  try {
    entries = await io.listDir(dir);
  } catch {
    return { status: "none", ids: [], source: "~/.gemini/antigravity-cli/conversations" };
  }
  const cwdUri = `file://${cwd}`;
  const ids: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".db")) continue;
    const uri = await io.extractAntigravityWorkspaceUri(join(dir, name));
    if (uri === cwdUri) ids.push(name.slice(0, -".db".length));
  }
  return decideIdentifyFromIds(ids, "~/.gemini/antigravity-cli/conversations/*.db");
}

async function identifyOpenCode(cwd: string, io: Required<IdentifyDeps>): Promise<IdentifyResult> {
  try {
    const { stdout } = await io.execFile("opencode", ["session", "list", "--format", "json"]);
    const rows = parseOpenCodeSessionListJson(stdout).filter((row) => row.directory === cwd);
    return decideIdentifyFromIds(
      rows.map((row) => row.id),
      "opencode session list --format json",
    );
  } catch (error) {
    return {
      status: "error",
      ids: [],
      source: "opencode session list --format json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function identifyCodex(cwd: string, io: Required<IdentifyDeps>): Promise<IdentifyResult> {
  const root = join(io.homedir(), ".codex", "sessions");
  const ids: string[] = [];
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
          try {
            const raw = await io.readUtf8(join(root, year, month, day, name));
            const first = raw.split("\n").find((line) => line.trim());
            if (!first) continue;
            const parsed = JSON.parse(first) as {
              type?: string;
              payload?: { session_id?: string; cwd?: string };
            };
            if (parsed.type !== "session_meta") continue;
            if (parsed.payload?.cwd !== cwd) continue;
            if (typeof parsed.payload.session_id === "string") ids.push(parsed.payload.session_id);
          } catch {
            // partial / unrelated jsonl
          }
        }
      }
    }
  }
  return decideIdentifyFromIds(ids, "~/.codex/sessions/**/rollout-*.jsonl session_meta");
}
