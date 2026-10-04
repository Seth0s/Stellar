/**
 * PASTAS DE FERRAMENTA POR PERFIL (A3c — BACKEND_V1.md §3 e §5.5; decisão P5 do
 * dono, 2026-10-04): cada perfil tem as PRÓPRIAS pastas das CLIs, inclusive o
 * login. O perfil pessoal pode continuar nas pastas padrão do sistema.
 *
 * MÓDULO PURO (sem I/O): dado o MODO de casa do perfil e a DECLARAÇÃO do
 * provider (`configHome`), decide se injeta uma variável/flag apontando para a
 * pasta do perfil, se deixa o sistema, ou se o provider NÃO separa (aviso).
 *
 * Nada de `if (provider === "claude")`: o mecanismo é DADO da declaração do
 * provider (`providers.builtin.json` / `ProviderDef.configHome`).
 *
 * Tabela MEDIDA (2026-10-04, binários instalados, HOME/XDG falsos):
 *   claude      env CLAUDE_CONFIG_DIR   (80 refs no binário v2.1.289)
 *   codex       env CODEX_HOME          (documentado; binário é wrapper node)
 *   opencode    env OPENCODE_CONFIG_DIR (12 refs no binário)
 *   cline       flag --config           (`--config <path>`, default ~/.cline)
 *   cursor      NÃO suporta             (--help e binário: sem env de config dir)
 *   antigravity NÃO suporta             (agy: só ANTIGRAVITY_* internos)
 *   commandcode NÃO suporta             (--help e binário: sem env de config dir)
 */

import { join } from "node:path";

export type ProviderHomeMode = "system" | "isolated";
export const PROVIDER_HOME_MODES: readonly ProviderHomeMode[] = ["system", "isolated"];

export function isProviderHomeMode(value: unknown): value is ProviderHomeMode {
  return value === "system" || value === "isolated";
}

/** O MECANISMO declarado por um provider para mudar a pasta de config. */
export type ConfigHomeDecl = { env: string } | { flag: string };

/** Parse TOLERANTE da declaração (usado pelo parser do spec JSON). Ausente =
 *  `null` (sem suporte declarado), nunca inventado. */
export function parseConfigHomeDecl(value: unknown): { ok: true; decl: ConfigHomeDecl | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, decl: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'configHome must be an object like { "env": "CLAUDE_CONFIG_DIR" } or { "flag": "--config" }' };
  }
  const rec = value as Record<string, unknown>;
  const hasEnv = typeof rec.env === "string" && rec.env.trim() !== "";
  const hasFlag = typeof rec.flag === "string" && rec.flag.trim() !== "";
  if (hasEnv && hasFlag) return { ok: false, reason: "configHome accepts EITHER `env` OR `flag`, not both" };
  if (hasEnv) {
    const env = (rec.env as string).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) return { ok: false, reason: `configHome.env is not an env var name: ${JSON.stringify(env)}` };
    return { ok: true, decl: { env } };
  }
  if (hasFlag) return { ok: true, decl: { flag: (rec.flag as string).trim() } };
  return { ok: false, reason: 'configHome must declare `env` or `flag`' };
}

/** Pasta da ferramenta DENTRO do perfil: `profiles/<id>/homes/<providerId>/`. */
export function providerHomeDir(profileDir: string, providerId: string): string {
  return join(profileDir, "homes", providerId);
}

/**
 * A ferramenta da A3a (allowlist de cópia) correspondente ao provider. Só o
 * que tem tabela em `work-home-tools.ts` pode ser copiado do sistema; o resto
 * devolve `null` (nada a oferecer).
 */
export function workHomeToolForProvider(providerId: string): string | null {
  switch (providerId) {
    case "claude":
    case "codex":
    case "cursor":
      return providerId;
    case "antigravity":
      return "gemini";
    default:
      return null;
  }
}

export type ConfigHomePlan =
  /** Perfil `system`: nada é injetado — o provider usa as pastas do sistema. */
  | { kind: "system" }
  /** Perfil `isolated` com suporte: injeta env e/ou flag apontando o home. */
  | { kind: "isolated"; homeDir: string; env: Record<string, string>; argv: string[] }
  /** Perfil `isolated` sem suporte: usa o sistema e AVISA no card. */
  | { kind: "unsupported"; providerId: string };

/**
 * Decide o plano de casa de UM provider. Pura: `declaration` vem do spec
 * (`providerById(id).configHome`), nunca de uma tabela paralela.
 */
export function planConfigHome(input: {
  providerId: string;
  homeMode: ProviderHomeMode;
  profileDir: string;
  declaration: ConfigHomeDecl | null;
}): ConfigHomePlan {
  if (input.homeMode === "system") return { kind: "system" };
  if (input.declaration === null) return { kind: "unsupported", providerId: input.providerId };
  const homeDir = providerHomeDir(input.profileDir, input.providerId);
  if ("env" in input.declaration) {
    return { kind: "isolated", homeDir, env: { [input.declaration.env]: homeDir }, argv: [] };
  }
  return { kind: "isolated", homeDir, env: {}, argv: [input.declaration.flag, homeDir] };
}
