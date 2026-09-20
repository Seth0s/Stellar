import { t, type MessageKey } from "../../shared/i18n";
import { Icon, type IconName } from "./icons";
import { useProviderClassification } from "./useProviderClassification";
import type { ProviderGroups, ProviderOption } from "./provider-groups";

const PROVIDER_ICON: Record<string, IconName> = {
  bash: "providerBash",
  claude: "providerClaude",
  codex: "providerCodex",
  cursor: "providerCursor",
  antigravity: "providerAntigravity",
  opencode: "providerOpencode",
};

/**
 * DESIGN-BACKLOG.md item 12, achado 5 — the terminal-creation popover's
 * native `<select>` (bash/claude/codex/cursor as a plain text list)
 * becomes icon buttons, one per provider, generic enough to reuse
 * anywhere else in the app that needs to pick from this same provider
 * set. Falls back to a bare terminal glyph for any provider not in
 * `PROVIDER_ICON` — a provider id is a plain `string`, not a fixed
 * union, so a new provider still renders something instead of crashing.
 *
 * NATIVO × GENÉRICO (2026-09-20, relato do dono): a lista era UMA só, com os
 * CLIs embutidos e os que o usuário declarou indistinguíveis. Os grupos vêm
 * prontos de `buildProviderGroups` (ver `provider-groups.ts` — a
 * classificação é a do main, não uma segunda aqui); este componente só os
 * desenha. `labelled` é a honestidade do intervalo: antes da primeira
 * resposta do main a lista sai SEM título de grupo, porque ainda não se sabe
 * quem é genérico — ver `useProviderClassification`.
 *
 * O rótulo de cada botão é o `label` DECLARADO no registro do main (ex.:
 * "Cline"), com o id como fallback — nunca uma string de UI paralela.
 *
 * O `title` do botão carrega a identidade de spawn (task c857539c): flags
 * fixas declaradas e o efeito MEDIDO declarado nelas ("sobe sem pedir
 * permissão") — é aqui que o usuário escolhe criar um card, então é aqui
 * que "todo card commandcode nasce sem prompt" tem que estar visível. O
 * dado vem do mesmo store da classificação (`useProviderClassification`),
 * que já recebe a visão inteira do main; nativo não tem flags fixas
 * (medido nos seis buildArgs) e não entra no title. Estilo normal, sem
 * alarme: o dono da máquina escolheu a flag de propósito.
 */
export function ProviderPicker({
  groups,
  labelled,
  value,
  onChange,
}: {
  groups: ProviderGroups;
  /** Títulos de grupo só quando a classificação do main já chegou. */
  labelled: boolean;
  value: string;
  onChange: (provider: string) => void;
}) {
  const sections: { key: string; titleKey: MessageKey | null; options: ProviderOption[] }[] =
    labelled
      ? [
          { key: "native", titleKey: "rail.providerGroup.native", options: groups.native },
          { key: "generic", titleKey: "rail.providerGroup.generic", options: groups.generic },
        ]
      : [{ key: "all", titleKey: null, options: [...groups.native, ...groups.generic] }];

  const { flagsById } = useProviderClassification();

  return (
    <div className="provider-picker">
      {sections
        .filter((section) => section.options.length > 0)
        .map((section) => (
          <div
            className="provider-picker-group"
            key={section.key}
            data-provider-group={section.key}
          >
            {section.titleKey && (
              <div className="provider-picker-group-title">{t(section.titleKey)}</div>
            )}
            <div className="provider-picker-group-items">
              {section.options.map((option) => {
                const flags = flagsById[option.id];
                const title = [
                  option.label,
                  flags && flags.baseArgs.length > 0
                    ? `${t("settings.providers.flagsLabel")}: ${flags.baseArgs.join(" ")}`
                    : null,
                  flags?.bypassesPermissionPrompts ? t("settings.providers.bypassBadge") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`provider-picker-btn${option.id === value ? " active" : ""}`}
                    title={title}
                    onClick={() => onChange(option.id)}
                  >
                    <Icon name={PROVIDER_ICON[option.id] ?? "providerBash"} size={18} />
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
    </div>
  );
}
