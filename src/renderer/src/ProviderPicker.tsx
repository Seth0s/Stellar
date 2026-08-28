import { Icon, type IconName } from "./icons";

const PROVIDER_ICON: Record<string, IconName> = {
  bash: "providerBash",
  claude: "providerClaude",
  codex: "providerCodex",
  cursor: "providerCursor",
  gemini: "providerGemini",
};

/**
 * DESIGN-BACKLOG.md item 12, achado 5 — the terminal-creation popover's
 * native `<select>` (bash/claude/codex/cursor as a plain text list)
 * becomes icon buttons, one per provider, generic enough to reuse
 * anywhere else in the app that needs to pick from this same provider
 * set (today just Rail.tsx's terminal popover, but the point of pulling
 * it out is not having to rebuild this again). Falls back to a bare
 * terminal glyph for any provider not in `PROVIDER_ICON` — `providers`
 * is a plain `string[]` (App.tsx's `PROVIDER_OPTIONS`), not a fixed
 * union, so a new provider added there still renders something instead
 * of crashing.
 */
export function ProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: string[];
  value: string;
  onChange: (provider: string) => void;
}) {
  return (
    <div className="provider-picker">
      {providers.map((p) => (
        <button
          key={p}
          type="button"
          className={`provider-picker-btn${p === value ? " active" : ""}`}
          title={p}
          onClick={() => onChange(p)}
        >
          <Icon name={PROVIDER_ICON[p] ?? "providerBash"} size={18} />
          <span>{p}</span>
        </button>
      ))}
    </div>
  );
}
