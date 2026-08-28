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
