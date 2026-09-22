/**
 * Pure derivation of the radial menu's terminal-provider submenu (item 2)
 * from the same two sources the rest of the app already uses — no
 * separate/invented provider list:
 *
 * - the provider ids themselves: App.tsx's `PROVIDER_OPTIONS`, the exact
 *   list `Rail.tsx`'s terminal-config popover already passes to
 *   `ProviderPicker` (`providers` prop, plumbed through unchanged here);
 * - installed/missing: `useAgentAvailability()`
 *   (`src/renderer/src/useAgentAvailability.ts`), the same hook
 *   `Topbar.tsx` uses for its "CLI de agente não encontrada" warning.
 *   `bash` is never in its `missing` list (main/providers.ts's
 *   `checkAgentAvailability` excludes it — it's always the OS shell, not
 *   an installable CLI), so it always comes out `installed: true` here
 *   with no special-casing needed.
 */
export type RadialProviderItem = {
  id: string;
  installed: boolean;
  /**
   * PRONTO? (task 1777060e) — a mesma resposta de quatro estados que o main
   * manda em `AgentAvailability.readiness`. `"not-ready"` NÃO desabilita o item
   * (o humano ainda pode querer abrir o card e autenticar por dentro): o que ele
   * faz é dizer POR QUE ele não vai funcionar, com o comando declarado pelo
   * provider quando existe um.
   *
   * `"unknown"` é o que a UI vê quando o provider não declara probe — instalado
   * e NÃO verificado, que é a verdade.
   */
  readiness: "missing" | "ready" | "not-ready" | "unknown";
  /** O comando que o humano roda para sair do estado, declarado pelo provider. */
  readinessHint: string | null;
};

export function deriveRadialProviderItems(
  providers: readonly string[],
  missing: readonly { id: string }[],
  availability: readonly { id: string; readiness: RadialProviderItem["readiness"]; readinessHint: string | null }[] = [],
): RadialProviderItem[] {
  const missingIds = new Set(missing.map((m) => m.id));
  const byId = new Map(availability.map((row) => [row.id, row]));
  return providers.map((id) => {
    const installed = !missingIds.has(id);
    // `bash` não está em nenhuma das duas listas (não é CLI instalável): sem
    // linha de disponibilidade ele é `unknown` — instalado e não verificado,
    // nunca "pronto" por omissão.
    const row = byId.get(id);
    return {
      id,
      installed,
      readiness: installed ? (row?.readiness ?? "unknown") : "missing",
      readinessHint: row?.readinessHint ?? null,
    };
  });
}

/**
 * O TEXTO do item do radial, ou `null` quando não há nada de especial a dizer —
 * e `null` significa EXATAMENTE o que a tela já fazia antes desta task: o
 * tooltip é o próprio id (`RadialMenu` cai nele).
 *
 * POR QUE ISTO É UMA FUNÇÃO PURA, e não dois `if` dentro do JSX: a pergunta do
 * dono do repo (2026-09-22) foi "o que ele VÊ para um provider nativo em
 * `unknown`?" — e a resposta que ele exigiu é uma PROPRIEDADE testável: `unknown`
 * não pode virar texto, senão o radial inteiro vira ruído (todo nativo está em
 * `unknown`, porque nenhum declara probe). Só `not-ready` ganha frase, e a frase
 * carrega o comando DECLARADO pelo provider — nunca um texto inventado aqui.
 */
export function radialProviderTitle(
  item: RadialProviderItem,
  t: (key: "radial.notInstalled" | "radial.notReady" | "radial.notReadyNoHint", vars: { id: string; hint: string }) => string,
): string | null {
  if (!item.installed) return t("radial.notInstalled", { id: item.id, hint: "" });
  if (item.readiness !== "not-ready") return null;
  return item.readinessHint !== null
    ? t("radial.notReady", { id: item.id, hint: item.readinessHint })
    : t("radial.notReadyNoHint", { id: item.id, hint: "" });
}
