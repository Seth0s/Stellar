import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Task d14086f8 (item 9, PERNA 3 — o bundle fino) — PERFIL DE SPAWN POR PAPEL.
 *
 * O que isto É: um arquivo do USUÁRIO, editável à mão como o `providers.json`,
 * que diz, por NOME de perfil e por papel, qual provider/model/effort um card
 * daquele papel costuma usar. O AGENTE pode LER e PROPOR — a linha do brief é
 * uma SUGESTÃO —, NUNCA impor.
 *
 * O que isto NÃO É (e é o ponto do refinamento do dono, 2026-10-03):
 *  - NÃO é um default do app. NÃO existe fallback, NÃO existe "se não houver,
 *    use X". Ausência de perfil, de papel ou de provider declarado => `null` =>
 *    NENHUMA sugestão. Nada é preenchido, nada é escolhido no lugar dele.
 *  - NÃO é o orquestrador escolhendo por trás: a superfície é DECLARADA e
 *    legível, no arquivo do dono.
 *  - NÃO é autorização. Quando a sugestão existe, ela ainda passa por
 *    `decideSpawnProfile` (spawn-profile-decision.ts) como qualquer outro
 *    pedido: um par que a `ProviderCapacity` não honra é RECUSADO nomeando o
 *    campo. O perfil não abre porta nenhuma.
 *  - NÃO duplica território nem armadilhas: aqueles já moram em `territory` e
 *    em `board-context.ts` e já entram no brief. Aqui só há perfil de spawn.
 *
 * Módulo quase puro: só a leitura do arquivo faz I/O; parse/resolução/rendação
 * são funções puras, testáveis sem disco.
 */

export type SpawnRole = "implementer" | "reviewer";
export const SPAWN_ROLES: readonly SpawnRole[] = ["implementer", "reviewer"];

export type SpawnDefault = {
  provider: string;
  model?: string;
  /** Ausente = nada declarado para effort (nunca um effort inventado). */
  effort?: string;
};

export type SpawnProfile = {
  name: string;
  spawnDefaults?: Partial<Record<SpawnRole, SpawnDefault>>;
};

export type SpawnProfilesFile = { profiles: SpawnProfile[] };

/** O arquivo do usuário. Ausente é ausência DECLARADA, não erro. */
export function spawnProfilesPath(userDataDir: string): string {
  return join(userDataDir, "spawn-profiles.json");
}

const MAX_PROFILES = 100;

/**
 * Parse DEFENSIVO, no idioma de `providers-dynamic`: entrada malformada vira
 * arquivo VAZIO (e diz por quê) em vez de derrubar o app ou inventar um perfil.
 * Campos fora do esquema são ignorados; `name`/`provider` não-string ou vazios
 * são descartados — nunca "consertados" com um valor plausível.
 */
export function parseSpawnProfilesFile(raw: unknown): { ok: true; file: SpawnProfilesFile } | { ok: false; error: string; file: SpawnProfilesFile } {
  const empty: SpawnProfilesFile = { profiles: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "spawn-profiles: the file must be a JSON object", file: empty };
  }
  const list = (raw as { profiles?: unknown }).profiles;
  if (list === undefined) return { ok: true, file: empty };
  if (!Array.isArray(list)) {
    return { ok: false, error: "spawn-profiles: field `profiles` must be an array", file: empty };
  }
  const profiles: SpawnProfile[] = [];
  for (const entry of list.slice(0, MAX_PROFILES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name.trim() : "";
    if (!name) continue;
    const defaultsRaw = (entry as { spawnDefaults?: unknown }).spawnDefaults;
    const spawnDefaults: Partial<Record<SpawnRole, SpawnDefault>> = {};
    if (typeof defaultsRaw === "object" && defaultsRaw !== null && !Array.isArray(defaultsRaw)) {
      for (const role of SPAWN_ROLES) {
        const d = (defaultsRaw as Record<string, unknown>)[role];
        if (typeof d !== "object" || d === null) continue;
        const provider = typeof (d as { provider?: unknown }).provider === "string" ? (d as { provider: string }).provider.trim() : "";
        // SEM PROVIDER NÃO HÁ PERFIL DESTE PAPEL — e nada é inventado no lugar.
        if (!provider) continue;
        const model = typeof (d as { model?: unknown }).model === "string" ? (d as { model: string }).model.trim() : "";
        const effort = typeof (d as { effort?: unknown }).effort === "string" ? (d as { effort: string }).effort.trim() : "";
        spawnDefaults[role] = {
          provider,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        };
      }
    }
    profiles.push({ name, ...(Object.keys(spawnDefaults).length > 0 ? { spawnDefaults } : {}) });
  }
  return { ok: true, file: { profiles } };
}

/** Lê o arquivo do usuário. Ausente/ilegível/malformado => VAZIO (nunca um default). */
export function readSpawnProfiles(userDataDir: string): SpawnProfilesFile {
  const path = spawnProfilesPath(userDataDir);
  if (!existsSync(path)) return { profiles: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseSpawnProfilesFile(raw).file;
  } catch {
    return { profiles: [] };
  }
}

/**
 * A SUGESTÃO para um papel — ou `null`. Aqui mora o "SEM DEFAULT": se o perfil
 * não existe, se o papel não foi declarado, ou se o default não traz provider,
 * a resposta é `null` e NADA é sugerido. Não há `?? algo`.
 */
export function resolveSpawnSuggestion(file: SpawnProfilesFile, name: string | null | undefined, role: SpawnRole): SpawnDefault | null {
  if (!name) return null;
  const profile = file.profiles.find((p) => p.name === name);
  const d = profile?.spawnDefaults?.[role];
  return d ? d : null;
}

/**
 * A LINHA que o brief carrega quando (e SÓ quando) há sugestão. Sem sugestão a
 * resposta é "" — e o brief NÃO menciona perfil nenhum, nem para dizer que não
 * há (o dono foi explícito). A linha se declara SUGESTÃO e nomeia o perfil de
 * onde veio; ela nunca é uma ordem e nunca substitui a validação do spawn.
 */
export function renderSpawnSuggestionLine(profileName: string, role: SpawnRole, suggestion: SpawnDefault | null): string {
  if (!suggestion) return "";
  const parts = [`provider ${suggestion.provider}`];
  if (suggestion.model) parts.push(`model ${suggestion.model}`);
  if (suggestion.effort) parts.push(`effort ${suggestion.effort}`);
  return `[de: stellar] spawn profile "${profileName}" suggests for the ${role} role: ${parts.join(", ")} — a SUGGESTION only: request it explicitly and it still goes through the same spawn validation as any other value. Nothing is applied for you.`;
}
