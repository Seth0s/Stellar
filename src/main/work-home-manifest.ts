/**
 * CASA DE TRABALHO — o MANIFESTO e o pacote (A3a, BACKEND_V1.md §5.2).
 *
 * A unidade que viaja é um pacote de arquivos: um MANIFESTO (o que existe, com
 * caminho lógico, sha256, tamanho e modo) mais um mapa `sha256 → conteúdo`. O
 * conteúdo é endereçado por hash — um arquivo idêntico em duas revisões ou
 * dois perfis é guardado uma vez (§5.2).
 *
 * CAMINHO LÓGICO. Nada que viaja carrega um caminho absoluto da máquina de
 * origem. O caminho lógico usa marcadores resolvidos na chegada (§5.2):
 *   - `{<tool>}/…`   — relativo à raiz da ferramenta (`{claude}`, `{codex}`…).
 *     A raiz de cada ferramenta é PARÂMETRO (A3c aponta para pastas por
 *     perfil), então o marcador nomeia a ferramenta, não o `~/.claude`.
 *   - `{home}/…`     — caminho sob a home que não está sob nenhuma raiz.
 *   - `{project:<id>}/…` — pasta de projeto (memória por projeto do Claude).
 *
 * LIMITES v1 (§5.2): 1 MB por arquivo, 20 MB por revisão. Arquivo grande demais
 * fica de fora e o coletor AVISA — nunca entra truncado (um arquivo truncado
 * tem sha diferente e viajaria mentindo sobre o conteúdo).
 *
 * Este módulo é PURO: sem fs, sem relógio. O I/O do coletor é
 * `work-home-collect.ts`; o do aplicador é `work-home-apply.ts`.
 */

import { createHash } from "node:crypto";

/** Versão do FORMATO do manifesto (não da casa). */
export const WORK_HOME_MANIFEST_VERSION = 1;

/** Ferramentas com allowlist declarada. `tools` é a tabela em `work-home-tools.ts`. */
export const WORK_HOME_TOOLS = ["claude", "codex", "cursor", "gemini", "stellar"] as const;
export type WorkHomeTool = (typeof WORK_HOME_TOOLS)[number];

export function isWorkHomeTool(value: unknown): value is WorkHomeTool {
  return typeof value === "string" && (WORK_HOME_TOOLS as readonly string[]).includes(value);
}

/** Marcador de caminho sob a home. */
export const HOME_MARKER = "{home}";
/** Abertura do marcador de projeto: `{project:<id>}`. O id nunca contém `}`. */
export const PROJECT_MARKER_PREFIX = "{project:";

/** Marcador da raiz de uma ferramenta: `{claude}`, `{codex}`… */
export function toolMarker(tool: WorkHomeTool): string {
  return `{${tool}}`;
}

/** Extrai o marcador de raiz de um caminho lógico, `null` se não houver. */
export function markerTool(logicalPath: string): WorkHomeTool | null {
  for (const tool of WORK_HOME_TOOLS) {
    if (logicalPath === toolMarker(tool) || logicalPath.startsWith(`${toolMarker(tool)}/`)) return tool;
  }
  return null;
}

/** Extrai o id de `{project:<id>}/…`, `null` se não for um caminho de projeto. */
export function projectIdOf(logicalPath: string): string | null {
  if (!logicalPath.startsWith(PROJECT_MARKER_PREFIX)) return null;
  const end = logicalPath.indexOf("}", PROJECT_MARKER_PREFIX.length);
  if (end < 0) return null;
  return logicalPath.slice(PROJECT_MARKER_PREFIX.length, end);
}

/** O restante do caminho lógico depois do marcador (`""` quando é só o
 *  marcador). O `/` procurado é o que vem DEPOIS do `}` — o id de projeto
 *  contém barras e não pode ser confundido com o início do resto. */
export function relPathOf(logicalPath: string): string {
  const close = logicalPath.startsWith("{") ? logicalPath.indexOf("}") : -1;
  const slash = logicalPath.indexOf("/", close >= 0 ? close + 1 : 0);
  if (slash < 0) return "";
  return logicalPath.slice(slash + 1);
}

/** 1 MB por arquivo (§5.2). */
export const MAX_FILE_SIZE = 1 * 1024 * 1024;
/** 20 MB por revisão (§5.2). */
export const MAX_REVISION_SIZE = 20 * 1024 * 1024;

export type WorkHomeManifestEntry = {
  tool: WorkHomeTool;
  /** Caminho lógico com marcadores — nunca um absoluto da origem. */
  path: string;
  sha256: string;
  size: number;
  /** Bits POSIX (0o777). Informativo; a chegada decide se aplica. */
  mode: number;
};

export type WorkHomeManifest = {
  version: number;
  /** Ordenado por `(tool, path)`; sem duplicatas de `path`. */
  entries: WorkHomeManifestEntry[];
  /**
   * Remoções EXPLÍCITAS (§5.3): um caminho lógico que deve ser apagado da
   * chegada. Fora desta lista, o aplicador NUNCA apaga nada — a ausência de um
   * arquivo no pacote não é ordem de remoção.
   */
  removals: string[];
};

export type WorkHomePackage = {
  manifest: WorkHomeManifest;
  /** sha256 → bytes. Um conteúdo compartilhado por N caminhos entra uma vez. */
  blobs: Map<string, Uint8Array>;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Ordena e remove duplicatas por `path`. A ordem é `(tool, path)` — estável
 *  para o manifesto ser comparável entre execuções. */
export function buildManifest(
  entries: readonly WorkHomeManifestEntry[],
  removals: readonly string[] = [],
): WorkHomeManifest {
  const byPath = new Map<string, WorkHomeManifestEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);
  const sorted = [...byPath.values()].sort((a, b) =>
    a.tool === b.tool ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.tool < b.tool ? -1 : 1,
  );
  return {
    version: WORK_HOME_MANIFEST_VERSION,
    entries: sorted,
    removals: [...new Set(removals)].sort(),
  };
}

function parseEntry(value: unknown): WorkHomeManifestEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isWorkHomeTool(rec.tool)) return null;
  if (typeof rec.path !== "string" || rec.path === "") return null;
  if (typeof rec.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.sha256)) return null;
  if (typeof rec.size !== "number" || !Number.isFinite(rec.size) || rec.size < 0) return null;
  if (typeof rec.mode !== "number" || !Number.isInteger(rec.mode) || rec.mode < 0) return null;
  return { tool: rec.tool, path: rec.path, sha256: rec.sha256, size: rec.size, mode: rec.mode };
}

/**
 * Valida um manifesto na versão ATUAL. Entradas inválidas são DESCARTADAS
 * (nunca consertadas com um palpite); manifesto que não é objeto, com versão
 * diferente da atual ou sem `entries` é recusado por inteiro. Ausência de
 * remoções é normal (`[]`).
 */
export function parseManifest(raw: unknown): WorkHomeManifest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== WORK_HOME_MANIFEST_VERSION) return null;
  if (!Array.isArray(rec.entries)) return null;
  const entries: WorkHomeManifestEntry[] = [];
  for (const entry of rec.entries) {
    const parsed = parseEntry(entry);
    if (parsed) entries.push(parsed);
  }
  const removals = Array.isArray(rec.removals)
    ? rec.removals.filter((p): p is string => typeof p === "string" && p !== "")
    : [];
  return buildManifest(entries, removals);
}

/** Serializa para JSON canônico (2 espaços), pronto para arquivo/transporte. */
export function serializeManifest(manifest: WorkHomeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Soma dos tamanhos ÚNICOS (um blob compartilhado conta uma vez). */
export function packageByteSize(pkg: WorkHomePackage): number {
  let total = 0;
  for (const bytes of pkg.blobs.values()) total += bytes.byteLength;
  return total;
}

/** Índice `path lógico → entrada` para diff/conflito por arquivo (§5.4). */
export function manifestByPath(manifest: WorkHomeManifest | null | undefined): Map<string, WorkHomeManifestEntry> {
  const map = new Map<string, WorkHomeManifestEntry>();
  if (!manifest) return map;
  for (const entry of manifest.entries) map.set(entry.path, entry);
  return map;
}

/**
 * Entrada do manifesto na FORMA DO BACKEND B6 (`{tool, path, sha256, size,
 * mode, deleted?}`). `mode` é a STRING de modo do git ("100644"/"100755"), não
 * os bits POSIX do manifesto local.
 */
export type RemoteManifestEntry = {
  tool: WorkHomeTool;
  path: string;
  sha256: string;
  size: number;
  mode: string;
  deleted?: boolean;
};

/** Bits POSIX → modo git (`100644` normal, `100755` executável). */
export function gitModeString(modeBits: number): string {
  return modeBits & 0o111 ? "100755" : "100644";
}

/** Modo git → bits POSIX. Desconhecido cai em `0o644` (o backend não valida). */
export function parseGitModeString(mode: string): number {
  const parsed = Number.parseInt(mode, 8);
  return Number.isFinite(parsed) ? parsed & 0o777 : 0o644;
}

/**
 * Manifesto local → entradas do backend. As REMOÇÕES entram como
 * `deleted:true`, com os valores da entrada de BASE correspondente (o backend
 * exige sha256 válido mesmo para remoção). Remoção sem base é DESCARTADA — não
 * inventamos sha256 para apagar algo que não conhecemos.
 */
export function toRemoteEntries(
  manifest: WorkHomeManifest,
  base: WorkHomeManifest | null,
): { entries: RemoteManifestEntry[]; droppedRemovals: string[] } {
  const entries: RemoteManifestEntry[] = manifest.entries.map((entry) => ({
    tool: entry.tool,
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
    mode: gitModeString(entry.mode),
  }));
  const baseMap = manifestByPath(base);
  const droppedRemovals: string[] = [];
  for (const path of manifest.removals) {
    const previous = baseMap.get(path);
    if (!previous) {
      droppedRemovals.push(path);
      continue;
    }
    entries.push({
      tool: previous.tool,
      path,
      sha256: previous.sha256,
      size: previous.size,
      mode: gitModeString(previous.mode),
      deleted: true,
    });
  }
  return { entries, droppedRemovals };
}

/** Entradas do backend → manifesto local (`deleted` vira `removals`). */
export function fromRemoteEntries(entries: readonly RemoteManifestEntry[]): WorkHomeManifest {
  const files: WorkHomeManifestEntry[] = [];
  const removals: string[] = [];
  for (const entry of entries) {
    if (entry.deleted) {
      removals.push(entry.path);
      continue;
    }
    files.push({
      tool: entry.tool,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
      mode: parseGitModeString(entry.mode),
    });
  }
  return buildManifest(files, removals);
}

/** Valida uma entrada vinda do backend (stub de frontend do contrato B6). */
export function parseRemoteManifestEntry(value: unknown): RemoteManifestEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isWorkHomeTool(rec.tool)) return null;
  if (typeof rec.path !== "string" || rec.path === "") return null;
  if (typeof rec.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.sha256)) return null;
  if (typeof rec.size !== "number" || !Number.isFinite(rec.size) || rec.size < 0) return null;
  const mode = typeof rec.mode === "string" && rec.mode !== "" ? rec.mode : "100644";
  return { tool: rec.tool, path: rec.path, sha256: rec.sha256, size: rec.size, mode, deleted: rec.deleted === true };
}

/** Array cru do backend → manifesto. Entradas inválidas são DESCARTADAS. */
export function parseRemoteManifest(raw: unknown): WorkHomeManifest | null {
  if (!Array.isArray(raw)) return null;
  const entries: RemoteManifestEntry[] = [];
  for (const value of raw) {
    const parsed = parseRemoteManifestEntry(value);
    if (parsed) entries.push(parsed);
  }
  return fromRemoteEntries(entries);
}
