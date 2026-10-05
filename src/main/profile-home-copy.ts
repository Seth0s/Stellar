/**
 * "COPIAR DO SISTEMA" para um perfil isolado (A3b, adendo 2 — sobra da A3c).
 *
 * Um perfil `isolated` tem as PRÓPRIAS pastas das CLIs
 * (`profiles/<id>/homes/<provider>/`). Ao criá-lo, a pessoa começa vazio; este
 * módulo copia para lá o que ela já tem nas pastas do SISTEMA (`~/.claude`,
 * `~/.codex`, `~/.cursor`, `~/.gemini`), usando o MESMO coletor e aplicador da
 * A3a — allowlist fechada, deny de credencial, backup, escrita atômica.
 *
 * REGRAS DE OURO (adendo): NUNCA copia credenciais (o `deny` do coletor barra)
 * NEM memórias de projeto (o filtro mantém só os caminhos `{<tool>}/…` — a
 * memória vive sob `{project:<id>}` e fica de fora). O `homeDir` é PARÂMETRO;
 * os testes usam um HOME falso, nunca o real.
 *
 * A raiz do sistema é derivada de `homeDir` (parâmetro), e o mapa
 * provider → tool é o mesmo da A3c (`workHomeToolForProvider`), não uma tabela
 * paralela.
 */

import { join } from "node:path";
import { buildManifest, type WorkHomePackage, type WorkHomeTool } from "./work-home-manifest";
import { collectWorkHome } from "./work-home-collect";
import { applyWorkHomePlan, sha256FileSync, type WorkHomeApplyResult } from "./work-home-apply";
import { planWorkHomeApply, type WorkHomeApplyPlan } from "./work-home-apply-decision";
import { providerHomeDir, workHomeToolForProvider } from "./config-home-decision";

/** Raiz no SISTEMA de cada ferramenta, dado o `homeDir`. Só as que a A3a
 *  coleta; `stellar` não tem pasta de sistema (é config do app). */
export function systemHomeRoots(homeDir: string): Partial<Record<WorkHomeTool, string>> {
  return {
    claude: join(homeDir, ".claude"),
    codex: join(homeDir, ".codex"),
    cursor: join(homeDir, ".cursor"),
    gemini: join(homeDir, ".gemini"),
  };
}

export type CopyFromSystemUnsupported = { ok: false; reason: "unsupported-provider" };

export type CopyFromSystemPreview = {
  ok: true;
  tool: WorkHomeTool;
  providerId: string;
  source: string;
  destination: string;
  incoming: WorkHomePackage;
  plan: WorkHomeApplyPlan;
  /** O que o coletor deixou de fora (tamanho, incluídos fora da raiz, memória
   *  sem clone — que aqui é a regra: memória NÃO é copiada). */
  warnings: string[];
};

/** Mantém só os caminhos da RAIZ da ferramenta; descarta `{home}`/`{project:}`
 *  (memória de projeto e arquivos soltos da home NÃO são copiados). */
function toolRootsOnly(pkg: WorkHomePackage, tool: WorkHomeTool): WorkHomePackage {
  const prefix = `{${tool}}`;
  const entries = pkg.manifest.entries.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`));
  const blobs = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const bytes = pkg.blobs.get(entry.sha256);
    if (bytes) blobs.set(entry.sha256, bytes);
  }
  return { manifest: buildManifest(entries), blobs };
}

/**
 * Prévia da cópia: coleta a raiz do SISTEMA da ferramenta do provider e monta o
 * plano de aplicação contra a pasta do perfil. NÃO escreve nada.
 */
export function previewCopyFromSystem(input: {
  providerId: string;
  /** Diretório do perfil (`profiles/<id>`). */
  profileDir: string;
  /** HOME do sistema (parâmetro; testes passam um falso). */
  homeDir: string;
}): CopyFromSystemPreview | CopyFromSystemUnsupported {
  const toolName = workHomeToolForProvider(input.providerId);
  if (!toolName) return { ok: false, reason: "unsupported-provider" };
  const tool = toolName as WorkHomeTool;
  const source = systemHomeRoots(input.homeDir)[tool];
  if (!source) return { ok: false, reason: "unsupported-provider" };

  const collected = collectWorkHome({ tool, rootDir: source, homeDir: input.homeDir, projectClones: [] });
  const incoming = toolRootsOnly(collected.package, tool);
  const destination = providerHomeDir(input.profileDir, input.providerId);

  const plan = planWorkHomeApply({
    incoming,
    base: null,
    toolRoots: { [tool]: destination },
    homeDir: input.homeDir,
    projectClones: [],
    shaOf: sha256FileSync,
  });
  return { ok: true, tool, providerId: input.providerId, source, destination, incoming, plan, warnings: collected.warnings };
}

/** Aplica a prévia (com backup datado). Mesmo aplicador da A3a. */
export function applyCopyFromSystem(input: {
  preview: CopyFromSystemPreview;
  backupRoot: string;
  now: number;
}): WorkHomeApplyResult {
  return applyWorkHomePlan({
    plan: input.preview.plan,
    blobs: input.preview.incoming.blobs,
    backupRoot: input.backupRoot,
    now: input.now,
  });
}
