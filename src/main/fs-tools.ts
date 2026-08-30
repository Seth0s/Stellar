import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const IGNORE = new Set(["node_modules", ".git", "dist", "target"]);
export const MAX_FILE_BYTES = 512 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export type DirEntry = { name: string; path: string; isDir: boolean };
export type ReadFileResult = { content: string } | { tooLarge: true };
export type ReadImageResult = { dataUrl: string } | { tooLarge: true } | { notImage: true };

export class PathEscapeError extends Error {}

/**
 * Resolves `path` (relative to `root`) and rejects anything that escapes
 * `root` (e.g. via `..`) — mirrors CentralByte's canonicalize + starts_with
 * confinement so a card can never be tricked into reading/writing outside
 * the root it was opened with.
 */
export function confine(root: string, path: string): string {
  const rootReal = realpathSync(resolve(root));
  const target = resolve(rootReal, path.replace(/^[/\\]+/, ""));
  if (target !== rootReal && !target.startsWith(rootReal + sep)) {
    throw new PathEscapeError(`path escapes root: ${path}`);
  }
  return target;
}

/** One directory level only — the UI fetches children lazily as directories expand. */
export async function listDir(root: string, path: string): Promise<DirEntry[]> {
  const dir = confine(root, path);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items = entries
    .filter((e) => !IGNORE.has(e.name))
    .map((e) => ({
      name: e.name,
      path: relative(root, join(dir, e.name)),
      isDir: e.isDirectory(),
    }));
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return items;
}

export async function readFile(root: string, path: string): Promise<ReadFileResult> {
  const target = confine(root, path);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) return { tooLarge: true };
  return { content: await fs.readFile(target, "utf8") };
}

/**
 * Reads an image as a data: URI over IPC — not `<img src="file://...">`,
 * which would mix a file:// resource into a page served from
 * http://localhost (dev) or a packaged file:// origin with its own quirks;
 * a data URI sidesteps any protocol/CORS question entirely, the same way
 * readFile already returns file content as a plain string rather than a path.
 */
export async function readImageDataUrl(root: string, path: string): Promise<ReadImageResult> {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return { notImage: true };
  const target = confine(root, path);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) return { tooLarge: true };
  const buf = await fs.readFile(target);
  return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
}

export async function writeFile(root: string, path: string, content: string): Promise<void> {
  const target = confine(root, path);
  await fs.writeFile(target, content, "utf8");
}

/**
 * DESIGN-BACKLOG.md item 13 — FilesCard's "quick actions" (rename/delete/
 * new file/new folder). All three reuse `confine()` on every path they
 * touch, both source and destination — same escape guard `listDir`/
 * `readFile`/`writeFile` already rely on, nothing new to trust here.
 */
export async function renamePath(root: string, path: string, newName: string): Promise<void> {
  // Pre-release audit B8 — the separator check alone let "." and ".."
  // through: `join(<parent>, "..")` collapses to the parent's OWN parent
  // (and "." to the parent itself), so `fs.rename` was handed a
  // destination that is a directory the entry already lives under. It
  // fails with a raw errno today rather than doing damage, but "a rename
  // whose destination isn't the name the user typed" is exactly the class
  // of input this guard exists to reject, not something to leave to the
  // kernel's mood. Neither is a legal filename on any filesystem here, so
  // rejecting them costs nothing.
  if (!newName || newName === "." || newName === ".." || newName.includes("/") || newName.includes("\\")) {
    throw new Error("nome inválido");
  }
  const from = confine(root, path);
  const to = confine(root, join(relative(root, dirname(from)), newName));
  await fs.rename(from, to);
}

export async function deletePath(root: string, path: string): Promise<void> {
  const target = confine(root, path);
  await fs.rm(target, { recursive: true, force: true });
}

export async function createEntry(
  root: string,
  parentPath: string,
  name: string,
  kind: "file" | "folder",
): Promise<void> {
  // Same hole as renamePath's guard just above (audit B8) — identical
  // check, identical reason; "." / ".." resolve the new entry onto a
  // directory that already exists instead of creating anything.
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("nome inválido");
  }
  const parent = confine(root, parentPath);
  const target = confine(root, join(parentPath, name));
  await fs.mkdir(parent, { recursive: true });
  if (kind === "folder") await fs.mkdir(target);
  else await fs.writeFile(target, "", { flag: "wx" });
}

/**
 * DESIGN-BACKLOG.md items 49/51 — real bug found verifying item 51 live
 * (not assumed): a raw recursive walk of `root` with only `IGNORE`
 * (`node_modules`/`.git`/`dist`/`target`) excluded can burn its entire
 * scan budget inside some OTHER huge, non-ignored directory before ever
 * reaching real source files — confirmed on this repo itself, whose own
 * `.gitignore` also excludes `out/` and `.verify-tmp/` (1.5GB of this
 * project's own throwaway Electron test profiles) neither of which
 * `IGNORE` knew about; a content search for a string that genuinely
 * exists came back with zero matches. Whack-a-mole-ing `IGNORE` bigger
 * doesn't generalize (every repo's own build/output dirs differ) — the
 * actual fix is deferring to the same file set the user already
 * curated: `git ls-files` (tracked + untracked-but-not-`.gitignore`-d),
 * which is also what VSCode's own search does by default. Falls back to
 * the old manual walk for a root that isn't a git repo at all (or has no
 * `git` binary available) — every root this app can open, not just
 * repos, still gets a working search.
 */
async function gitTrackedFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * DESIGN-BACKLOG.md item 49 — "busca por nome de arquivo na árvore".
 * `listDir` only ever fetches one directory level (the UI expands lazily),
 * so a filename search across the whole tree needs its own enumeration.
 * `gitTrackedFiles` above is tried first (fast, correct-by-construction);
 * the manual walk below is the fallback for a non-git root, with the
 * same `IGNORE` set applied at EVERY depth and a hard cap on both files
 * scanned and matches returned so a huge repo (or a symlink cycle) can't
 * turn "type a few letters" into a multi-second stall. Case-insensitive
 * substring match against the relative path (not just the basename) —
 * matches VSCode's own Ctrl+P behavior of letting a partial directory
 * name narrow results too. Git-backed results are files only (`git
 * ls-files` doesn't enumerate directories) — a minor, acceptable scope
 * narrowing for a search that's about finding a FILE, not browsing.
 */
const SEARCH_MAX_SCANNED = 20_000;
const SEARCH_MAX_RESULTS = 200;

export async function searchFileNames(root: string, query: string): Promise<DirEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tracked = await gitTrackedFiles(root);
  if (tracked) {
    const results: DirEntry[] = [];
    for (const path of tracked) {
      if (results.length >= SEARCH_MAX_RESULTS) break;
      if (path.toLowerCase().includes(q)) {
        results.push({ name: path.split("/").pop() ?? path, path, isDir: false });
      }
    }
    return results;
  }

  const rootDir = confine(root, "");
  const results: DirEntry[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (results.length >= SEARCH_MAX_RESULTS || scanned >= SEARCH_MAX_SCANNED) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    // (empty on a permission error, a race with a delete, etc. — skip that
    // directory, don't fail the whole search)
    for (const e of entries) {
      if (results.length >= SEARCH_MAX_RESULTS || scanned >= SEARCH_MAX_SCANNED) return;
      if (IGNORE.has(e.name)) continue;
      scanned++;
      const path = relative(root, join(dir, e.name));
      if (path.toLowerCase().includes(q)) {
        results.push({ name: e.name, path, isDir: e.isDirectory() });
      }
      if (e.isDirectory()) await walk(join(dir, e.name));
    }
  }

  await walk(rootDir);
  return results;
}

/**
 * DESIGN-BACKLOG.md item 51 — "busca full-text no conteúdo dos
 * arquivos". Same git-first, walk-fallback split as `searchFileNames`
 * just above (see its doc comment for why) — heavier per file here (a
 * real read + substring scan instead of a path compare), so the caps
 * are smaller than the filename search's. Skips anything over
 * `MAX_FILE_BYTES` (the same size guard `readFile` already enforces —
 * no point grep-ing a file this app can't even open) and any extension
 * VSCode's own "binary" heuristic would also skip (images — a genuinely
 * exhaustive binary-sniff is out of scope; this covers the actual
 * regression risk, a huge image file bloating scan time for zero useful
 * matches). Case-insensitive substring per line, not a regex engine —
 * same "simple and predictable" scope as item 49's filename search, not
 * a real grep replacement.
 */
export type ContentMatch = { path: string; line: number; text: string };
const CONTENT_SEARCH_MAX_SCANNED = 5_000;
const CONTENT_SEARCH_MAX_RESULTS = 100;
const CONTENT_SEARCH_MAX_LINE_LEN = 200;
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".woff", ".woff2", ".ttf", ".otf"]);

async function grepFile(root: string, path: string, q: string, results: ContentMatch[]): Promise<void> {
  const full = confine(root, path);
  const stat = await fs.stat(full).catch(() => null);
  if (!stat || stat.size > MAX_FILE_BYTES) return;
  const text = await fs.readFile(full, "utf8").catch(() => null);
  if (text === null) return; // couldn't decode as utf8 — treat as binary, skip
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= CONTENT_SEARCH_MAX_RESULTS) return;
    if (lines[i].toLowerCase().includes(q)) {
      results.push({ path, line: i + 1, text: lines[i].trim().slice(0, CONTENT_SEARCH_MAX_LINE_LEN) });
    }
  }
}

export async function searchFileContents(root: string, query: string): Promise<ContentMatch[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tracked = await gitTrackedFiles(root);
  if (tracked) {
    const results: ContentMatch[] = [];
    let scanned = 0;
    for (const path of tracked) {
      if (results.length >= CONTENT_SEARCH_MAX_RESULTS || scanned >= CONTENT_SEARCH_MAX_SCANNED) break;
      if (BINARY_EXTS.has(extname(path).toLowerCase())) continue;
      scanned++;
      await grepFile(root, path, q, results);
    }
    return results;
  }

  const rootDir = confine(root, "");
  const results: ContentMatch[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (results.length >= CONTENT_SEARCH_MAX_RESULTS || scanned >= CONTENT_SEARCH_MAX_SCANNED) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (results.length >= CONTENT_SEARCH_MAX_RESULTS || scanned >= CONTENT_SEARCH_MAX_SCANNED) return;
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
      scanned++;
      await grepFile(root, relative(root, full), q, results);
    }
  }

  await walk(rootDir);
  return results;
}

/** Line count of a file, bounded by the same size guard as readFile — used to approximate insertions for untracked files in git status. */
export async function countLines(root: string, path: string): Promise<number> {
  const target = confine(root, path);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) return 0;
  const content = await fs.readFile(target, "utf8");
  return content.length === 0 ? 0 : content.split("\n").length;
}
