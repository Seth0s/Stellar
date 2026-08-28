import type { ChatProvider } from "./card-types";

/**
 * DESIGN-BACKLOG.md item 29 — shared between ChatCard.tsx's inline key
 * form and the new SecretsSettingsModal.tsx, so provider labels/
 * placeholders/format hints only need to change in one place.
 */
export const PROVIDER_LABELS: Record<ChatProvider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  generic: "custom",
};

export const PROVIDER_KEY_PLACEHOLDER: Record<ChatProvider, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  gemini: "sua API key do Gemini",
  generic: "qualquer valor — mesmo fake, se seu endpoint não exige auth",
};

/**
 * DESIGN-BACKLOG.md item 31 — lista curada dos modelos PRINCIPAIS de cada
 * provider (não o catálogo inteiro da API), pra virar dropdown em vez de
 * campo livre — evita digitar/errar o id à mão. `generic` fica de fora de
 * propósito: é um endpoint arbitrário do usuário, nenhuma lista fixa faz
 * sentido ali (só campo livre, como já era). Uma lista assim inevitavelmente
 * fica desatualizada com o tempo — aceito pelo próprio item (curada, não
 * buscada ao vivo da API); revisitar quando um provider lançar algo novo
 * que valha a pena adicionar. Índice 0 de cada lista dobra como default
 * (`DEFAULT_*_MODEL` em ChatCard.tsx deriva daqui).
 */
export const PROVIDER_MODELS: Record<Exclude<ChatProvider, "generic">, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o3-mini"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
};

/**
 * Non-blocking hint only — never used to refuse a save. Prefixes drift
 * over time and this app has no way to verify a key is real without
 * spending a real API call, so a wrong guess here must never stop
 * someone from saving a key that's actually correct.
 */
export function keyFormatWarning(provider: ChatProvider, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (provider === "anthropic" && !v.startsWith("sk-ant-")) {
    return 'chaves da Anthropic costumam começar com "sk-ant-" — confira se colou a key certa';
  }
  if (provider === "openai" && !v.startsWith("sk-")) {
    return 'chaves da OpenAI costumam começar com "sk-" — confira se colou a key certa';
  }
  return null;
}
