import { promises as fs, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

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
  if (!newName || newName.includes("/") || newName.includes("\\")) {
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
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error("nome inválido");
  }
  const parent = confine(root, parentPath);
  const target = confine(root, join(parentPath, name));
  await fs.mkdir(parent, { recursive: true });
  if (kind === "folder") await fs.mkdir(target);
  else await fs.writeFile(target, "", { flag: "wx" });
}

/**
 * DESIGN-BACKLOG.md item 49 — "busca por nome de arquivo na árvore".
 * `listDir` only ever fetches one directory level (the UI expands lazily),
 * so a filename search across the whole tree needs its own real recursive
 * walk — same `IGNORE` set applied at EVERY depth (not just the root
 * level), and a hard cap on both files scanned and matches returned so a
 * huge repo (or a symlink cycle) can't turn "type a few letters" into a
 * multi-second stall. Case-insensitive substring match against the
 * relative path (not just the basename) — matches VSCode's own Ctrl+P
 * behavior of letting a partial directory name narrow results too.
 */
const SEARCH_MAX_SCANNED = 20_000;
const SEARCH_MAX_RESULTS = 200;

export async function searchFileNames(root: string, query: string): Promise<DirEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
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

/** Line count of a file, bounded by the same size guard as readFile — used to approximate insertions for untracked files in git status. */
export async function countLines(root: string, path: string): Promise<number> {
  const target = confine(root, path);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) return 0;
  const content = await fs.readFile(target, "utf8");
  return content.length === 0 ? 0 : content.split("\n").length;
}
