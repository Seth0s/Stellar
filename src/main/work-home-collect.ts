/**
 * CASA DE TRABALHO — o COLETOR (A3a, BACKEND_V1.md §5.1/§5.2).
 *
 * Lê SÓ o que a allowlist declara (`work-home-tools.ts`) sob a raiz dada como
 * PARÂMETRO e produz um `WorkHomePackage` (manifesto + mapa sha→conteúdo).
 * Nada aqui conhece `~/.claude` real: o teste passa um diretório temporário.
 *
 * GARANTIAS:
 *   - Universo fechado: só as raízes da tabela são lidas, e os `deny` da
 *     ferramenta barram credencial/sessão/histórico mesmo dentro delas.
 *   - Sem symlink: um link não é seguido (não vaza para fora da árvore).
 *   - Settings filtrado: chave fora da lista declarada NÃO sai; um settings
 *     que não é JSON-objeto é DESCARTADO (nunca vira "inclui tudo").
 *   - Arquivo acima de 1 MB fica de fora e AVISA; a revisão para em 20 MB.
 *   - Ausência é ausência: arquivo/árvore que não existe simplesmente não
 *     entra; o manifest não ganha entrada inventada.
 */

import { lstatSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  MAX_FILE_SIZE,
  MAX_REVISION_SIZE,
  buildManifest,
  sha256Hex,
  type WorkHomeManifestEntry,
  type WorkHomePackage,
  type WorkHomeTool,
} from "./work-home-manifest";
import {
  WORK_HOME_TOOL_SPECS,
  filterJsonSettings,
  filterTomlSettings,
  isDenied,
  type SettingsFilter,
  type WorkHomeRule,
} from "./work-home-tools";
import {
  projectLogicalPath,
  remapPathToLogical,
  matchClaudeProjectDir,
  toPosix,
  type ProjectClone,
} from "./work-home-remap";
import { buildPortableBundle } from "./provider-config-sync";

export type CollectWorkHomeInput = {
  tool: WorkHomeTool;
  /** Raiz da ferramenta — PARÂMETRO (A3c pode apontar para pastas por perfil). */
  rootDir: string;
  /** Home local, só para decidir `{home}` em includes. */
  homeDir: string;
  /** Clones conhecidos (descobertos das pastas de trabalho) para resolver
   *  projeto da memória do Claude. Vazio = memórias ficam de fora, com aviso. */
  projectClones?: readonly ProjectClone[];
  /** Só para `tool: "stellar"`: a config de providers e os NOMES de credencial. */
  stellar?: { config: Record<string, unknown>; credentialNames: readonly string[] };
  /** Máximo de arquivos por arquivo (default 1 MB). Tester-friendly. */
  maxFileSize?: number;
};

export type CollectWorkHomeResult = {
  package: WorkHomePackage;
  /** O que ficou de fora e por quê — nunca silencioso. */
  warnings: string[];
};

const MAX_INCLUDE_DEPTH = 4;

/** Extrai alvos de `@caminho` de um CLAUDE.md (linha ou inline). */
export function extractClaudeIncludes(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s@<>()[\]{}"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].replace(/[.,;:]+$/, "");
    if (target !== "" && !out.includes(target)) out.push(target);
  }
  return out;
}

function resolveIncludePath(target: string, baseDir: string, homeDir: string): string {
  if (target === "~") return homeDir;
  if (target.startsWith("~/") || target.startsWith("~" + sep)) return join(homeDir, target.slice(2));
  if (isAbsolute(target)) return toPosix(target);
  return join(baseDir, target);
}

export function collectWorkHome(input: CollectWorkHomeInput): CollectWorkHomeResult {
  const spec = WORK_HOME_TOOL_SPECS[input.tool];
  const maxFileSize = input.maxFileSize ?? MAX_FILE_SIZE;
  const entries: WorkHomeManifestEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  let totalBytes = 0;
  const toolRoots = { [input.tool]: input.rootDir };

  function addBytes(logicalPath: string, bytes: Uint8Array, mode: number): void {
    if (bytes.byteLength > maxFileSize) {
      warnings.push(`${logicalPath}: ${bytes.byteLength} bytes > limite de ${maxFileSize} — fora`);
      return;
    }
    const sha = sha256Hex(bytes);
    if (!blobs.has(sha)) {
      if (totalBytes + bytes.byteLength > MAX_REVISION_SIZE) {
        warnings.push(`${logicalPath}: revisão passaria de ${MAX_REVISION_SIZE} bytes — fora`);
        return;
      }
      blobs.set(sha, bytes);
      totalBytes += bytes.byteLength;
    }
    entries.push({ tool: input.tool, path: logicalPath, sha256: sha, size: bytes.byteLength, mode });
  }

  /** Lê um arquivo regular (nunca symlink), aplica filtro opcional e adiciona. */
  function addFile(absPath: string, relForDeny: string, filter: SettingsFilter | undefined): boolean {
    let st;
    try {
      st = lstatSync(absPath);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      warnings.push(`${relForDeny}: symlink ignorado (não é seguido)`);
      return false;
    }
    if (!st.isFile()) return false;
    if (st.size > maxFileSize) {
      warnings.push(`${relForDeny}: ${st.size} bytes > limite de ${maxFileSize} — fora`);
      return false;
    }
    if (isDenied(spec, relForDeny)) return false;

    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath);
    } catch {
      warnings.push(`${relForDeny}: não foi possível ler`);
      return false;
    }

    const remap = remapPathToLogical(toPosix(absPath), { homeDir: input.homeDir, toolRoots });
    if (remap.kind === "absolute") {
      warnings.push(`${relForDeny}: caminho fora da home/raiz — não é portável, fora`);
      return false;
    }

    if (filter && filter.kind !== "none") {
      const text = bytes.toString("utf-8");
      const filtered =
        filter.kind === "json"
          ? filterJsonSettings(text, filter.allowKeys)
          : filterTomlSettings(text, filter.allowTopLevel);
      if (filtered === null) {
        warnings.push(`${relForDeny}: nenhuma chave de comportamento declarada — não sai`);
        return false;
      }
      addBytes(remap.logical, Buffer.from(filtered, "utf-8"), st.mode & 0o777);
    } else {
      addBytes(remap.logical, bytes, st.mode & 0o777);
    }
    return true;
  }

  /** Percorre uma árvore adicionando arquivos; não segue symlink nem desce em
   *  `deny` (que também é checado por arquivo). */
  function addTree(absDir: string, relBase: string): void {
    let names: string[];
    try {
      names = readdirSync(absDir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const childAbs = join(absDir, name);
      const childRel = relBase === "" ? name : `${relBase}/${name}`;
      const childRelPosix = toPosix(relative(input.rootDir, childAbs));
      if (isDenied(spec, childRelPosix)) continue;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) addTree(childAbs, childRel);
      else if (st.isFile()) addFile(childAbs, childRelPosix, undefined);
    }
  }

  /** CLAUDE.md e os arquivos que ele inclui com `@` (recursivo, com teto). */
  function addClaudeIncludes(absFile: string, depth: number, visited: Set<string>): void {
    if (depth > MAX_INCLUDE_DEPTH) return;
    let text: string;
    try {
      text = readFileSync(absFile, "utf-8");
    } catch {
      return;
    }
    const baseDir = toPosix(absFile).replace(/\/[^/]*$/, "");
    for (const target of extractClaudeIncludes(text)) {
      const resolved = toPosix(resolveIncludePath(target, baseDir, input.homeDir));
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      const remap = remapPathToLogical(resolved, { homeDir: input.homeDir, toolRoots });
      if (remap.kind === "absolute") {
        warnings.push(`@${target}: fora da home/raiz — não é portável, fora`);
        continue;
      }
      const relForDeny = remap.kind === "tool" ? remap.relPath : toPosix(relative(input.rootDir, resolved));
      if (!addFile(resolved, relForDeny, undefined)) continue;
      addClaudeIncludes(resolved, depth + 1, visited);
    }
  }

  function applyRule(rule: WorkHomeRule): void {
    if (rule.kind === "stellar-bundle") {
      if (!input.stellar) {
        warnings.push("stellar: bundle de provider não informado — nada a coletar");
        return;
      }
      const bundle = buildPortableBundle({
        config: input.stellar.config,
        credentialNames: input.stellar.credentialNames,
        homeDir: input.homeDir,
      });
      addBytes(`{stellar}/provider-bundle.json`, Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf-8"), 0o644);
      return;
    }

    if (rule.kind === "claude-project-memory") {
      const projectsDir = join(input.rootDir, rule.relDir);
      if (!existsSync(projectsDir)) return;
      const clones = input.projectClones ?? [];
      let names: string[];
      try {
        names = readdirSync(projectsDir).sort();
      } catch {
        return;
      }
      for (const enc of names) {
        const memoryDir = join(projectsDir, enc, rule.subtree);
        if (!existsSync(memoryDir)) continue;
        let memoryStat;
        try {
          memoryStat = statSync(memoryDir);
        } catch {
          continue;
        }
        if (!memoryStat.isDirectory()) continue;
        const relForDeny = `${rule.relDir}/${enc}/${rule.subtree}`;
        if (isDenied(spec, relForDeny)) continue;
        const matched = matchClaudeProjectDir(enc, clones);
        if (!matched) {
          warnings.push(`${relForDeny}: nenhum clone com esse remote — memória de projeto não identificada`);
          continue;
        }
        addProjectTree(memoryDir, matched.projectId, rule.subtree);
      }
      return;
    }

    if (rule.kind === "file") {
      const abs = join(input.rootDir, rule.relPath);
      const relForDeny = toPosix(rule.relPath);
      if (!addFile(abs, relForDeny, rule.filter)) return;
      if (rule.includes === "claude-at") {
        addClaudeIncludes(abs, 1, new Set([toPosix(abs)]));
      }
      return;
    }

    // tree
    const abs = join(input.rootDir, rule.relPath);
    if (!existsSync(abs)) return;
    let absStat;
    try {
      absStat = statSync(abs);
    } catch {
      return;
    }
    if (absStat.isDirectory()) addTree(abs, rule.relPath);
  }

  /** Árvore de memória de um projeto: caminho lógico `{project:<id>}/sub/rel`. */
  function addProjectTree(absDir: string, projectId: string, sub: string): void {
    const walk = (dir: string, rel: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const childAbs = join(dir, name);
        const childRel = rel === "" ? name : `${rel}/${name}`;
        let st;
        try {
          st = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          walk(childAbs, childRel);
          continue;
        }
        if (!st.isFile()) continue;
        const logical = projectLogicalPath(projectId, childRel);
        const relForDeny = toPosix(relative(input.rootDir, childAbs));
        if (isDenied(spec, relForDeny)) continue;
        if (st.size > maxFileSize) {
          warnings.push(`${relForDeny}: ${st.size} bytes > limite de ${maxFileSize} — fora`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(childAbs);
        } catch {
          warnings.push(`${relForDeny}: não foi possível ler`);
          continue;
        }
        addBytes(logical, bytes, st.mode & 0o777);
      }
    };
    walk(absDir, sub);
  }

  for (const rule of spec.rules) applyRule(rule);

  return { package: { manifest: buildManifest(entries), blobs }, warnings };
}

/** Junta pacotes de várias ferramentas num só (blobs de mesmo sha entram uma vez). */
export function mergeWorkHomePackages(packages: readonly WorkHomePackage[]): WorkHomePackage {
  const entries: WorkHomeManifestEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  const removals: string[] = [];
  let totalBytes = 0;
  for (const pkg of packages) {
    for (const entry of pkg.manifest.entries) entries.push(entry);
    for (const path of pkg.manifest.removals) removals.push(path);
    for (const [sha, bytes] of pkg.blobs) {
      if (!blobs.has(sha)) {
        if (totalBytes + bytes.byteLength > MAX_REVISION_SIZE) continue;
        blobs.set(sha, bytes);
        totalBytes += bytes.byteLength;
      }
    }
  }
  return { manifest: buildManifest(entries, removals), blobs };
}
