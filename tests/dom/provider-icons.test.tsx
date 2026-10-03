import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderIcon } from "@renderer/provider-icons";
import { PROVIDER_ICON_KEYS, providerAccentVar, providerIconKey } from "@renderer/provider-icon-map";

/**
 * O MAPA provider → ícone, incluindo o FALLBACK (task b3560898).
 *
 * O defeito medido: os ícones de provider eram todos iguais de relance — os do
 * picker eram metáforas Lucide SEM cor (herdavam o texto) e o header do card
 * nem cobria `opencode`. O conserto é dado + desenho: cada provider conhecido
 * tem o SEU SVG, na cor do token `--accent-<id>`; um id SEM desenho conhecido
 * (o declarado pelo usuário, ou um provider novo do app) cai no `generic` em
 * `--muted` — nunca um quadrado vazio, e nunca a cor de outro provider.
 *
 * O contrato estável é `data-role="provider-icon"` + `data-provider-icon` (a
 * chave) + `data-provider-accent` (o token): o teste não depende do desenho.
 */

describe("provider → ícone: o mapa e o fallback", () => {
  it("todo provider conhecido resolve para a PRÓPRIA chave; o desconhecido cai em `generic`", () => {
    for (const id of PROVIDER_ICON_KEYS) expect(providerIconKey(id)).toBe(id);
    expect(providerIconKey("mycli")).toBe("generic");
    expect(providerIconKey("qualquer-coisa")).toBe("generic");
    expect(providerIconKey("")).toBe("generic");
  });

  it("a cor sai do token do provider, e o sem-marca cai em `--muted`", () => {
    expect(providerAccentVar("claude")).toBe("var(--accent-claude)");
    expect(providerAccentVar("opencode")).toBe("var(--accent-opencode)");
    expect(providerAccentVar("cline")).toBe("var(--accent-cline)");
    expect(providerAccentVar("commandcode")).toBe("var(--accent-commandcode)");
    // O fallback: NADA de marca → o neutro, não a cor de outro provider.
    expect(providerAccentVar("mycli")).toBe("var(--muted)");
  });

  it("renderiza um SVG POR provider — desenhos DIFERENTES, e o fallback não é vazio", () => {
    const ids = [...PROVIDER_ICON_KEYS, "mycli"];
    const { container } = render(
      <div>
        {ids.map((id) => (
          <ProviderIcon key={id} id={id} size={16} />
        ))}
      </div>,
    );

    const icons = [...container.querySelectorAll('[data-role="provider-icon"]')];
    expect(icons).toHaveLength(ids.length);
    expect(icons.map((el) => el.getAttribute("data-provider-icon"))).toEqual([
      ...PROVIDER_ICON_KEYS,
      "generic",
    ]);

    // Todo ícone tem SVG de verdade (nada de quadrado vazio)…
    for (const el of icons) expect(el.querySelector("svg")).toBeTruthy();
    // …e um desenho DISTINTO — era exatamente o defeito ("todos parecidos").
    const drawings = icons.map((el) => el.querySelector("svg")!.innerHTML);
    expect(new Set(drawings).size).toBe(drawings.length);

    // A cor do fallback é o neutro; a de um conhecido é o acento dele.
    const fallback = icons[icons.length - 1];
    expect(fallback.getAttribute("data-provider-accent")).toBe("--muted");
    expect(icons[0].getAttribute("data-provider-accent")).toBe("--accent-bash");
  });
});
