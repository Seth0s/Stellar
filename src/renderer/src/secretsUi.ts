import { t } from "../../shared/i18n";
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

export function providerKeyPlaceholder(provider: ChatProvider): string {
  if (provider === "anthropic") return t("secrets.ph.anthropic");
  if (provider === "openai") return t("secrets.ph.openai");
  if (provider === "gemini") return t("secrets.ph.gemini");
  return t("secrets.ph.generic");
}

/**
 * DESIGN-BACKLOG.md item 31 — curated primary model list per provider.
 */
export const PROVIDER_MODELS: Record<Exclude<ChatProvider, "generic">, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  openai: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
  gemini: ["gemini-3.7-flash"],
};

/**
 * Non-blocking hint only — never used to refuse a save.
 */
export function keyFormatWarning(provider: ChatProvider, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (provider === "anthropic" && !v.startsWith("sk-ant-")) {
    return t("secrets.warn.anthropic");
  }
  if (provider === "openai" && !v.startsWith("sk-")) {
    return t("secrets.warn.openai");
  }
  return null;
}
