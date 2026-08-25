import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { countLines } from "./fs-tools";

const execFileP = promisify(execFile);

export type GitEntry = { path: string; status: string; insertions: number; deletions: number };
export type GitStatus =
  | { repo: false }
  | { repo: true; branch: string; insertions: number; deletions: number; entries: GitEntry[] };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function parsePorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.split(" -> ")[1];
    map.set(rest.trim(), status);
  }
  return map;
}

function parseNumstat(output: string, into: Map<string, { insertions: number; deletions: number }>) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [ins, del, path] = line.split("\t");
    if (!path) continue;
    const insertions = ins === "-" ? 0 : Number(ins);
    const deletions = del === "-" ? 0 : Number(del);
    const prior = into.get(path) ?? { insertions: 0, deletions: 0 };
    into.set(path, { insertions: prior.insertions + insertions, deletions: prior.deletions + deletions });
  }
}

/**
 * Replicates CentralByte's real git-status sequence: rev-parse --show-toplevel
 * (repo detection) -> rev-parse --abbrev-ref HEAD (branch) -> status --porcelain
 * -uall -> diff --numstat HEAD, falling back to diff --numstat + diff --cached
 * --numstat combined when HEAD doesn't exist yet (fresh repo, no commits).
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { repo: false };
  }

  // rev-parse --abbrev-ref HEAD fails on an unborn branch (fresh repo, no
  // commits yet) — branch --show-current works in that case too.
  let branch: string;
  try {
    branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    branch = (await git(root, ["branch", "--show-current"])).trim();
  }
  const statusMap = parsePorcelain(await git(root, ["status", "--porcelain=v1", "-uall"]));

  const numstat = new Map<string, { insertions: number; deletions: number }>();
  try {
    parseNumstat(await git(root, ["diff", "--numstat", "HEAD"]), numstat);
  } catch {
    parseNumstat(await git(root, ["diff", "--numstat"]), numstat);
    parseNumstat(await git(root, ["diff", "--cached", "--numstat"]), numstat);
  }

  const entries: GitEntry[] = [];
  for (const [path, status] of statusMap) {
    const counts = numstat.get(path);
    if (counts) {
      entries.push({ path, status, insertions: counts.insertions, deletions: counts.deletions });
      continue;
    }
    let insertions = 0;
    if (status === "??") {
      try {
        insertions = await countLines(root, path);
      } catch {
        insertions = 0;
      }
    }
    entries.push({ path, status, insertions, deletions: 0 });
  }

  const insertions = entries.reduce((sum, e) => sum + e.insertions, 0);
  const deletions = entries.reduce((sum, e) => sum + e.deletions, 0);
  return { repo: true, branch, insertions, deletions, entries };
}
