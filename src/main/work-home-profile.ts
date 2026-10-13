/**
 * CASA DE TRABALHO por PERFIL — preferências do sync e as raízes das
 * ferramentas do perfil ATIVO (A3b, apoiado na A3c).
 *
 * As raízes vêm do MODO de casa do perfil (A3c): `system` usa `~/.claude` etc.
 * do sistema; `isolated` usa `profiles/<id>/homes/<provider>` dos providers que
 * declaram `configHome`. O mapa provider → tool é o MESMO da A3c
 * (`workHomeToolForProvider`); não há tabela paralela.
 *
 * As preferências (ferramentas ligadas, pastas de trabalho, última revisão)
 * vivem num arquivo por perfil. Escrita atômica (tmp + rename).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORK_HOME_TOOLS, isWorkHomeTool, type WorkHomeTool } from "./work-home-manifest";
import { providerHomeDir, workHomeToolForProvider, type ProviderHomeMode } from "./config-home-decision";

export const WORK_HOME_PREFS_FILENAME = "work-home-prefs.json";

export type WorkHomePrefs = {
  /** Automatic work-home sync is opt-in and independent of tool selection. */
  autoSync: boolean;
  enabledTools: WorkHomeTool[];
  /** Pastas onde procurar clones de projeto (memória do Claude por remote). */
  workFolders: string[];
  /** Última revisão sincronizada (para exibir e como ponteiro da UI). */
  lastRevision: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
};

/** The legacy default is retained for non-UI team publishing; the Work home IPC explicitly passes []. */
export function defaultWorkHomePrefs(defaultEnabledTools: readonly WorkHomeTool[] = WORK_HOME_TOOLS): WorkHomePrefs {
  return { autoSync: false, enabledTools: [...defaultEnabledTools], workFolders: [], lastRevision: null, lastSyncAt: null, lastError: null };
}

export function workHomePrefsPath(dataDir: string): string {
  return join(dataDir, WORK_HOME_PREFS_FILENAME);
}

/** Lê as preferências; ausência/corrupção cai no default (nada é inventado além
 *  do padrão declarado). Ferramenta desconhecida é descartada. */
export function readWorkHomePrefs(dataDir: string, options: { defaultEnabledTools?: readonly WorkHomeTool[] } = {}): WorkHomePrefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workHomePrefsPath(dataDir), "utf-8"));
  } catch {
    return defaultWorkHomePrefs(options.defaultEnabledTools);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaultWorkHomePrefs(options.defaultEnabledTools);
  const rec = parsed as Record<string, unknown>;
  const autoSync = rec.autoSync === true;
  const enabledTools = Array.isArray(rec.enabledTools)
    ? rec.enabledTools.filter(isWorkHomeTool)
    : [...(options.defaultEnabledTools ?? WORK_HOME_TOOLS)];
  const workFolders = Array.isArray(rec.workFolders)
    ? rec.workFolders.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim())
    : [];
  const lastRevision = typeof rec.lastRevision === "number" ? rec.lastRevision : null;
  const lastSyncAt = typeof rec.lastSyncAt === "number" ? rec.lastSyncAt : null;
  const lastError = typeof rec.lastError === "string" ? rec.lastError : null;
  return { autoSync, enabledTools, workFolders, lastRevision, lastSyncAt, lastError };
}

export function writeWorkHomePrefs(dataDir: string, prefs: WorkHomePrefs): void {
  const path = workHomePrefsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Raízes das ferramentas para o perfil ativo. `providers` são os providers de
 * agente (id + se declaram `configHome`). Um perfil `isolated` aponta cada
 * ferramenta suportada para a pasta do perfil; o resto (e o perfil `system`)
 * usa a pasta do sistema sob `homeDir`.
 */
export function resolveWorkHomeToolRoots(input: {
  homeDir: string;
  profileDir: string;
  homeMode: ProviderHomeMode;
  providers: readonly { id: string; supportsConfigHome: boolean }[];
}): Partial<Record<WorkHomeTool, string>> {
  const roots: Partial<Record<WorkHomeTool, string>> = {
    claude: join(input.homeDir, ".claude"),
    codex: join(input.homeDir, ".codex"),
    cursor: join(input.homeDir, ".cursor"),
    gemini: join(input.homeDir, ".gemini"),
  };
  if (input.homeMode === "isolated") {
    for (const provider of input.providers) {
      const toolName = workHomeToolForProvider(provider.id);
      if (!toolName || !provider.supportsConfigHome) continue;
      roots[toolName as WorkHomeTool] = providerHomeDir(input.profileDir, provider.id);
    }
  }
  return roots;
}
