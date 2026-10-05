/**
 * CASA DE TRABALHO — reescrita de VALORES de caminho (A3b, adendo do
 * orquestrador sobre a A3a).
 *
 * A A3a remapeia o caminho LÓGICO do ARQUIVO; aqui remapeamos caminhos
 * ABSOLUTOS que estão DENTRO do conteúdo — o caso medido é o
 * `[projects."/home/lucas/..."]` do `config.toml` do Codex, mas vale para
 * qualquer settings filtrado (JSON ou TOML).
 *
 *   coleta:  /home/u/.claude/...  ->  {home}/.claude/...
 *            /home/u/mono/packs/app  ->  {project:github.com/o/mono/packs/app}
 *   chegada: o inverso; projeto sem clone => PENDENTE (não dá para materializar
 *            um caminho que não existe nesta máquina).
 *
 * Convenção do id de projeto (a mesma da memória do Claude, `work-home-remap`):
 * `remote normalizado + subpasta relativa à raiz do clone`. Assim um caminho que
 * é a raiz do clone vira `{project:<remote>}` e um caminho dentro dele vira
 * `{project:<remote>/<sub>}` — e a expansão volta pelo `resolveProjectLocalDir`.
 *
 * Módulo PURO. A aplicação textual (JSON/TOML) casa apenas strings entre
 * aspas — nunca reescreve prosa de skill.
 */

import { isAbsolute } from "node:path";
import { HOME_MARKER, PROJECT_MARKER_PREFIX } from "./work-home-manifest";
import { formatProjectId, relWithin, resolveProjectLocalDir, toPosix, type ProjectClone } from "./work-home-remap";

export type PathValueContext = {
  homeDir: string;
  projectClones: readonly ProjectClone[];
};

/** Clones ordenados da raiz mais LONGA para a mais curta (o mais específico vence). */
function clonesBySpecificity(clones: readonly ProjectClone[]): ProjectClone[] {
  return [...clones]
    .filter((c) => c.normalizedRemote !== null)
    .sort((a, b) => toPosix(b.root).length - toPosix(a.root).length);
}

/** Um caminho absoluto isolado → marcador lógico. Não-caminho volta igual. */
export function templatePathValue(value: string, ctx: PathValueContext): string {
  const p = toPosix(value);
  if (!isAbsolute(p)) return value;
  for (const clone of clonesBySpecificity(ctx.projectClones)) {
    const rel = relWithin(toPosix(clone.root), p);
    if (rel === null) continue;
    const id = formatProjectId(clone.normalizedRemote!, rel);
    return `${PROJECT_MARKER_PREFIX}${id}}`;
  }
  const relHome = relWithin(toPosix(ctx.homeDir), p);
  if (relHome !== null) return relHome === "" ? HOME_MARKER : `${HOME_MARKER}/${relHome}`;
  return value;
}

/** `{project:<id>}` / `{home}[/rel]` → caminho local. `null` quando um projeto
 *  referenciado não tem clone (pendente). */
export function expandPathValue(value: string, ctx: PathValueContext): { ok: true; value: string } | { ok: false; projectId: string } {
  if (value.startsWith(PROJECT_MARKER_PREFIX)) {
    const end = value.indexOf("}", PROJECT_MARKER_PREFIX.length);
    if (end >= 0) {
      const id = value.slice(PROJECT_MARKER_PREFIX.length, end);
      const rel = value.slice(end + 1).replace(/^\/+/, "");
      const localRoot = resolveProjectLocalDir(id, ctx.projectClones);
      if (localRoot === null) return { ok: false, projectId: id };
      return { ok: true, value: rel === "" ? localRoot : `${toPosix(localRoot)}/${rel}` };
    }
  }
  if (value === HOME_MARKER || value.startsWith(`${HOME_MARKER}/`)) {
    const rel = value.slice(HOME_MARKER.length).replace(/^\/+/, "");
    return { ok: true, value: rel === "" ? toPosix(ctx.homeDir) : `${toPosix(ctx.homeDir)}/${rel}` };
  }
  return { ok: true, value };
}

/** Ids de projeto referenciados por um valor (para achar os pendentes). */
const PROJECT_REF_RE = /\{project:([^}]+)\}/g;
export function projectRefsInText(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = PROJECT_REF_RE.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

/** Reescreve strings entre aspas do texto (JSON ou TOML). Prosa não muda. */
export function templatePathValuesInText(text: string, ctx: PathValueContext): string {
  return text.replace(/"([^"\n]*)"|'([^'\n]*)'/g, (whole, dq: string | undefined, sq: string | undefined) => {
    const inner = dq !== undefined ? dq : sq;
    if (inner === undefined || inner === "") return whole;
    const next = templatePathValue(inner, ctx);
    if (next === inner) return whole;
    return dq !== undefined ? `"${next}"` : `'${next}'`;
  });
}

/**
 * Expande os marcadores do texto. `unresolved` lista os projetos sem clone; o
 * texto devolvido mantém o marcador daqueles (não inventa caminho). O chamador
 * decide pendência com `unresolved`.
 */
export function expandPathValuesInText(
  text: string,
  ctx: PathValueContext,
): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const out = text.replace(/"([^"\n]*)"|'([^'\n]*)'/g, (whole, dq: string | undefined, sq: string | undefined) => {
    const inner = dq !== undefined ? dq : sq;
    if (inner === undefined || inner === "") return whole;
    const res = expandPathValue(inner, ctx);
    if (!res.ok) {
      unresolved.add(res.projectId);
      return whole;
    }
    if (res.value === inner) return whole;
    return dq !== undefined ? `"${res.value}"` : `'${res.value}'`;
  });
  return { text: out, unresolved: [...unresolved] };
}
