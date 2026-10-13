import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Reserve a collision-free download path, including other active downloads. */
export function reserveUniqueDownloadPath(
  directory: string,
  filename: string,
  reserved: Set<string>,
  exists: (path: string) => boolean = existsSync,
): string {
  const safeName = basename(filename) || "download";
  const normalizedName = safeName === "." || safeName === ".." ? "download" : safeName;
  const extension = extname(normalizedName);
  const stem = normalizedName.slice(0, normalizedName.length - extension.length);
  let candidate = join(directory, normalizedName);
  let suffix = 1;
  while (reserved.has(candidate) || exists(candidate)) {
    candidate = join(directory, `${stem} (${suffix})${extension}`);
    suffix++;
  }
  reserved.add(candidate);
  return candidate;
}

/** Attach a session-level listener only once, even when a persistent profile is reopened. */
export function registerSessionListenerOnce<T extends object>(
  session: T,
  registered: WeakSet<T>,
  register: () => void,
): boolean {
  if (registered.has(session)) return false;
  registered.add(session);
  register();
  return true;
}
