import { promises as fs, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

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

/** Line count of a file, bounded by the same size guard as readFile — used to approximate insertions for untracked files in git status. */
export async function countLines(root: string, path: string): Promise<number> {
  const target = confine(root, path);
  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) return 0;
  const content = await fs.readFile(target, "utf8");
  return content.length === 0 ? 0 : content.split("\n").length;
}
