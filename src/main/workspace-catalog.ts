/**
 * Load `ai/workspace.yaml` the same way `ai/scripts/workspace_lib.py` does:
 * JSON subset of YAML 1.2, `#` comments stripped, `schema_version === 1`.
 *
 * The catalog names the trees that exist. It is not a join table and not
 * a denylist — every listed path that is present on disk is walked.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type CatalogProject = {
  id: string;
  name: string;
  path: string;
  absPath: string;
  canonicalSources: string[];
};

export type WorkspaceCatalog = {
  catalogPath: string;
  workspaceRoot: string;
  projects: CatalogProject[];
  missing: Array<{ id: string; path: string }>;
};

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function stripHashComments(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function pathEscapes(root: string, candidate: string): boolean {
  const rootPosix = toPosix(root).replace(/\/+$/, "");
  const candPosix = toPosix(candidate);
  return candPosix !== rootPosix && !candPosix.startsWith(`${rootPosix}/`);
}

export function parseCatalogJson(raw: string, catalogPath: string): Omit<WorkspaceCatalog, "missing"> & { rawProjects: Array<{ id: string; path: string; name: string; canonicalSources: string[] }> } {
  let data: unknown;
  try {
    data = JSON.parse(stripHashComments(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid catalog at ${catalogPath}: use the JSON subset of YAML (${msg}).`);
  }
  if (!isRecord(data) || data.schema_version !== 1) {
    throw new Error("Catalog must be an object with schema_version equal to 1.");
  }
  if (!Array.isArray(data.projects)) {
    throw new Error("Catalog must contain a projects list.");
  }
  const workspaceRoot = resolve(dirname(dirname(catalogPath)));
  const rawProjects: Array<{ id: string; path: string; name: string; canonicalSources: string[] }> = [];
  for (const entry of data.projects) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const rel = asString(entry.path);
    if (!id || !rel) continue;
    rawProjects.push({
      id,
      path: rel,
      name: asString(entry.name) || id,
      canonicalSources: asStringList(entry.canonical_sources),
    });
  }
  return { catalogPath, workspaceRoot, projects: [], rawProjects };
}

export async function loadCatalog(catalogPath: string): Promise<WorkspaceCatalog> {
  const absCatalog = resolve(catalogPath);
  const raw = await readFile(absCatalog, "utf8");
  const parsed = parseCatalogJson(raw, absCatalog);
  const projects: CatalogProject[] = [];
  const missing: Array<{ id: string; path: string }> = [];
  for (const p of parsed.rawProjects) {
    const absPath = resolve(parsed.workspaceRoot, p.path);
    if (pathEscapes(parsed.workspaceRoot, absPath)) {
      missing.push({ id: p.id, path: p.path });
      continue;
    }
    try {
      const st = await stat(absPath);
      if (!st.isDirectory()) {
        missing.push({ id: p.id, path: p.path });
        continue;
      }
    } catch {
      missing.push({ id: p.id, path: p.path });
      continue;
    }
    projects.push({
      id: p.id,
      name: p.name,
      path: p.path,
      absPath,
      canonicalSources: p.canonicalSources,
    });
  }
  return {
    catalogPath: absCatalog,
    workspaceRoot: parsed.workspaceRoot,
    projects,
    missing,
  };
}

/** Walk parents of `start` looking for `ai/workspace.yaml`. */
export async function findCatalogPath(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "ai", "workspace.yaml");
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadCatalogFromCwd(
  cwd: string,
  catalogPath?: string,
): Promise<WorkspaceCatalog | { error: string }> {
  try {
    const found = catalogPath?.trim() ? resolve(catalogPath.trim()) : await findCatalogPath(cwd);
    if (!found) {
      return {
        error:
          "No ai/workspace.yaml found walking up from cwd. The catalog is what names the other repositories; without it this scan has no trees to join against.",
      };
    }
    return await loadCatalog(found);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
