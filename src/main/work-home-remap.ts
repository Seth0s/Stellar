/**
 * CASA DE TRABALHO — REMAPEAMENTO de caminhos e identificação de projeto
 * (A3a, BACKEND_V1.md §5.2).
 *
 * Três trabalhos, todos em torno da mesma ideia: um caminho absoluto da
 * máquina de origem não viaja; ele vira um caminho LÓGICO resolvido na
 * chegada.
 *
 *   1. HOME → `{home}/…`. Um arquivo sob a home da origem vira `{home}/rel`.
 *   2. FERRAMENTA → `{<tool>}/…`. Como a raiz de cada ferramenta é PARÂMETRO
 *      (A3c), o marcador nomeia a ferramenta, não `~/.claude`. A raiz da
 *      chegada pode estar em qualquer lugar (ex.: por perfil).
 *   3. PROJETO → `{project:<id>}/…`. A memória do Claude por projeto fica em
 *      `projects/<cwd-codificado>/memory`. O id do projeto é o REMOTE GIT
 *      NORMALIZADO (+ subpasta) lido do `.git/config` do clone (§5.2). Na
 *      chegada o projeto é reencontrado procurando um clone pelo remote em
 *      pastas de trabalho dadas como parâmetro; sem clone, o projeto fica
 *      PENDENTE (guardado, não aplicado).
 *
 * A codificação do Claude troca cada separador do cwd por `-` (`/home/u/x` →
 * `-home-u-x`). Decodificar a subpasta de um monorepo é melhor-esforço (hífens
 * dentro de um nome de pasta se perdem) — declarado, não escondido: o caso
 * comum é o clone ser a raiz do projeto, com subpasta vazia.
 *
 * Este módulo tem I/O apenas em `discoverProjectClones` (ler `.git/config`);
 * o resto é puro. Testes usam diretórios temporários — NUNCA a home real.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  HOME_MARKER,
  PROJECT_MARKER_PREFIX,
  type WorkHomeTool,
  toolMarker,
} from "./work-home-manifest";

/** Caminho POSIX normalizado (sem barra final, separador `/`). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Caminho de dentro de `parent` relativo (posix), `null` se estiver fora.
 * `""` quando os dois são o mesmo diretório. Não toca o disco.
 */
export function relWithin(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Codifica um cwd no nome de pasta que o Claude usa em `projects/`
 * (`/home/u/x` → `-home-u-x`). Barra final não conta.
 */
export function encodeClaudeProjectDir(absPath: string): string {
  return toPosix(absPath).replace(/\//g, "-");
}

/**
 * Normaliza um remote git para `host/owner/repo` (minúsculas, sem `.git`, sem
 * usuário, sem porta, sem esquema). Aceita https, ssh (`ssh://`), git:// e a
 * forma scp (`git@host:owner/repo.git`). Remote que é caminho local (sem host)
 * devolve `null`: não é portável, não vira id de projeto.
 */
export function normalizeRemote(url: string): string | null {
  const s = url.trim();
  if (s === "") return null;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let parsed: URL;
    try {
      parsed = new URL(s);
    } catch {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    const scp = s.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (host === "" || path === "") return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/** `host/owner/repo` + subpasta → id de projeto. */
export function formatProjectId(remote: string, subpath: string): string {
  const sub = toPosix(subpath).replace(/^\/+/, "");
  return sub === "" ? remote : `${remote}/${sub}`;
}

/**
 * Inverso de `formatProjectId`. O remote é `host/owner/repo` (3 segmentos; o
 * host tem ponto). O que sobra é subpasta. GitLab com subgrupos fica fora do
 * escopo v1 (o 3º segmento seria o subgrupo) — declarado.
 */
export function parseProjectId(id: string): { remote: string; subpath: string } | null {
  const parts = toPosix(id).split("/").filter((p) => p !== "");
  if (parts.length < 3) return null;
  return { remote: parts.slice(0, 3).join("/"), subpath: parts.slice(3).join("/") };
}

/**
 * Lê o remote de um `.git/config` textual (INI). Prefere `origin`; sem ele, o
 * primeiro remote declarado. Puro — quem lê o arquivo é o chamador.
 */
export function parseGitConfigRemote(content: string): string | null {
  const byName = new Map<string, string>();
  const order: string[] = [];
  let current: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*(?:[#;].*)?$/);
    if (section) {
      current = section[1];
      if (!order.includes(current)) order.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const kv = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (kv && current !== null && !byName.has(current)) byName.set(current, kv[1]);
  }
  const origin = byName.get("origin");
  if (origin !== undefined) return origin;
  for (const name of order) {
    const url = byName.get(name);
    if (url !== undefined) return url;
  }
  return null;
}

export type ProjectClone = {
  /** Raiz do clone (diretório que contém `.git`). */
  root: string;
  /** Remote cru lido do `.git/config`. */
  remote: string;
  /** `host/owner/repo` normalizado, ou `null` se o remote não for portável. */
  normalizedRemote: string | null;
};

/** Um clone encontrado: lê o remote e guarda o normalizado. */
function readClone(root: string): ProjectClone | null {
  const gitPath = join(root, ".git");
  if (!existsSync(gitPath)) return null;
  let gitDir: string;
  try {
    gitDir = statSync(gitPath).isDirectory() ? gitPath : "";
  } catch {
    return null;
  }
  // Worktree (`.git` é arquivo) não é resolvido aqui: o config dele não é o do
  // clone. Declarado — não adivinha.
  if (gitDir === "") return null;
  const configPath = join(gitDir, "config");
  if (!existsSync(configPath)) return null;
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  const remote = parseGitConfigRemote(content);
  if (remote === null) return null;
  return { root, remote, normalizedRemote: normalizeRemote(remote) };
}

const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "dist", "out"]);

/**
 * Procura clones nas pastas de trabalho dadas (§5.2: "dentro das pastas de
 * trabalho que o usuário apontar"). Varredura LIMITADA em profundidade e sem
 * seguir symlink; não desce em diretórios de build. Só diretórios com
 * `.git/config` legível entram.
 */
export function discoverProjectClones(workFolders: readonly string[], maxDepth = 4): ProjectClone[] {
  const found: ProjectClone[] = [];
  const seen = new Set<string>();
  function walk(dir: string, depth: number): void {
    const clone = readClone(dir);
    if (clone && clone.normalizedRemote !== null) {
      found.push(clone);
      // Achou um clone: não desce mais (os subdiretórios pertencem a ele).
      return;
    }
    if (depth >= maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const child = join(dir, name);
      let childStat;
      try {
        childStat = statSync(child);
      } catch {
        continue;
      }
      if (!childStat.isDirectory()) continue;
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child, depth + 1);
    }
  }
  for (const folder of workFolders) {
    if (existsSync(folder)) walk(folder, 0);
  }
  return found;
}

export type MatchedProject = {
  projectId: string;
  cloneRoot: string;
  /** Subpasta dentro do clone (melhor-esforço; `""` no caso comum). */
  subpath: string;
};

/**
 * Casa um nome de pasta de projeto do Claude (`projects/<encoded>`) com um
 * clone conhecido. Vence o clone cujo caminho codificado for o MAIS LONGO —
 * o mais específico. Sem casamento (ou sem remote portável), `null`: o
 * chamador registra o motivo, nunca inventa um id.
 */
export function matchClaudeProjectDir(
  encodedDirName: string,
  clones: readonly ProjectClone[],
): MatchedProject | null {
  const target = encodedDirName.replace(/^\/+|\/+$/g, "");
  let best: { enc: string; clone: ProjectClone; subpath: string } | null = null;
  for (const clone of clones) {
    if (clone.normalizedRemote === null) continue;
    const enc = encodeClaudeProjectDir(clone.root);
    let subpath: string;
    if (target === enc) subpath = "";
    else if (target.startsWith(`${enc}-`)) subpath = target.slice(enc.length + 1).split("-").join("/");
    else continue;
    if (!best || enc.length > best.enc.length) best = { enc, clone, subpath };
  }
  if (!best) return null;
  return {
    projectId: formatProjectId(best.clone.normalizedRemote!, best.subpath),
    cloneRoot: best.clone.root,
    subpath: best.subpath,
  };
}

/** Acha o clone que atende um id de projeto (`remote[/subpath]`). `null` =
 *  projeto PENDENTE nesta máquina (nenhum clone com aquele remote). */
export function resolveProjectLocalDir(projectId: string, clones: readonly ProjectClone[]): string | null {
  const parsed = parseProjectId(projectId);
  if (!parsed) return null;
  for (const clone of clones) {
    if (clone.normalizedRemote !== parsed.remote) continue;
    return parsed.subpath === "" ? clone.root : join(clone.root, parsed.subpath.split("/").join(sep));
  }
  return null;
}

export type LogicalRemap =
  | { kind: "tool"; tool: WorkHomeTool; relPath: string; logical: string }
  | { kind: "home"; relPath: string; logical: string }
  | { kind: "absolute"; logical: string };

export type RemapContext = {
  homeDir: string;
  toolRoots: Partial<Record<WorkHomeTool, string>>;
};

/**
 * Remapeia um caminho absoluto: raiz de ferramenta → `{<tool>}/rel`; sob a
 * home → `{home}/rel`; qualquer outro → absoluto como está (a chegada
 * DENUNCIA, nunca trata como portável). A raiz mais longa vence (uma pasta de
 * perfil dentro da home ainda é da ferramenta que a declarou).
 */
export function remapPathToLogical(absPath: string, ctx: RemapContext): LogicalRemap {
  const roots = Object.entries(ctx.toolRoots)
    .filter((entry): entry is [WorkHomeTool, string] => typeof entry[1] === "string" && entry[1] !== "")
    .sort((a, b) => toPosix(b[1]).length - toPosix(a[1]).length);
  for (const [tool, root] of roots) {
    const rel = relWithin(toPosix(root), toPosix(absPath));
    if (rel === null) continue;
    return {
      kind: "tool",
      tool,
      relPath: rel,
      logical: rel === "" ? toolMarker(tool) : `${toolMarker(tool)}/${rel}`,
    };
  }
  const relHome = relWithin(toPosix(ctx.homeDir), toPosix(absPath));
  if (relHome !== null) {
    return { kind: "home", relPath: relHome, logical: relHome === "" ? HOME_MARKER : `${HOME_MARKER}/${relHome}` };
  }
  return { kind: "absolute", logical: toPosix(absPath) };
}

/** Monta `{project:<id>}/rel`. `rel` vazio devolve só o marcador. */
export function projectLogicalPath(projectId: string, rel: string): string {
  const clean = toPosix(rel).replace(/^\/+/, "");
  return clean === "" ? `${PROJECT_MARKER_PREFIX}${projectId}}` : `${PROJECT_MARKER_PREFIX}${projectId}}/${clean}`;
}
