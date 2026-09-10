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
export type RadialProviderItem = { id: string; installed: boolean };

export function deriveRadialProviderItems(
  providers: readonly string[],
  missing: readonly { id: string }[],
): RadialProviderItem[] {
  const missingIds = new Set(missing.map((m) => m.id));
  return providers.map((id) => ({ id, installed: !missingIds.has(id) }));
}
