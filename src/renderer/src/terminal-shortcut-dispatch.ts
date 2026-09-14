/**
 * Follow-up fase C (review adversarial) — decisão pura do keydown do
 * terminal. Separada de `useTerminal.ts` de propósito: o listener DOM
 * precisa consumir o evento ANTES de qualquer ação async/UI, e o achado
 * crítico (Ctrl+C com copy rebound + seleção vazia vazando `\x03` pro
 * PTY) só é testável de forma honesta se a regra "matched ⇒ consume"
 * vive fora do hook cheio de xterm.
 *
 * `vitest` unit (`environment: "node"`) exercita isto direto; `tests/dom/`
 * monta um listener mínimo que aplica o mesmo contrato consume→stop, e
 * mede o gancho do xterm pra `defer-central`.
 */
import {
  isStaleDefaultShortcut,
  matchesShortcut,
} from "./shortcut-config";
import {
  findShortcutClaimingKey,
  type ShortcutKeyEvent,
  type ShortcutOverrides,
} from "./shortcut-registry";

export type TerminalShortcutDispatch =
  | { consume: true; action: "copy"; text: string }
  /** Combo de copy casou, mas não há seleção — ainda assim CONSOME o
   * evento. Sem isto, rebindar copy pra Ctrl+C deixa o keydown vazar pro
   * xterm e matar o processo (`\x03`), mentindo o rebind de sigint. */
  | { consume: true; action: "copy-noop" }
  | { consume: true; action: "sigint" }
  | { consume: true; action: "paste" }
  | { consume: true; action: "eof" }
  /** Viewport only — `term.scrollToBottom()`, never `pty.write`. */
  | { consume: true; action: "scroll-to-end" }
  /** Default do registro ainda casa, mas o efetivo não (rebindou pra
   * longe) E ninguém que RODARIA no escopo terminal reivindicou a tecla
   * — engole pra o encoding antigo do xterm não disparar E pra o
   * Chromium não executar o atalho nativo (Ctrl+D = favorito). Rodada 3:
   * stale no FIM. Rodada 7: dono de outro escopo (ex. `card.duplicate`
   * canvas) NÃO conta — `resolveGlobalShortcut` o rejeitaria no bubble e
   * o nativo vazava. */
  | { consume: true; action: "swallow" }
  /**
   * Stale + dono que `resolveGlobalShortcut` DESPACHARIA com foco no
   * terminal (`scopes` inclui `"terminal"`). `consume: false` de
   * propósito — sem `stopImmediatePropagation` (o bubble precisa chegar
   * em App.tsx). O xterm é barrado à parte via
   * `attachCustomKeyEventHandler` → `false`. Dono fora de escopo cai em
   * `swallow`, não aqui (rodada 7).
   */
  | { consume: false; action: "defer-central" }
  | { consume: false; action: "none" };

/**
 * Ordem final da sequência (rodadas 3–7 do review):
 * 1. copy efetivo (antes de sigint — Ctrl+Shift+C vs Ctrl+C)
 * 2. sigint efetivo
 * 3. paste efetivo
 * 4. eof efetivo
 * 5. scroll-to-end efetivo (viewport; depois dos bytes pro PTY)
 * 6. stale sigint / stale eof:
 *    - ninguém que rodaria no escopo terminal → swallow
 *    - dono que `resolveGlobalShortcut` despacharia aqui → defer-central
 *      (bubbla; xterm barrado no handler)
 * 7. none
 *
 * Qualquer ramo matched devolve `consume: true` — inclusive copy sem
 * seleção. Stale no fim = tecla liberada pode ser reatribuída de verdade.
 */
export function resolveTerminalShortcutKeydown(
  e: ShortcutKeyEvent,
  overrides: ShortcutOverrides,
  selection: string,
): TerminalShortcutDispatch {
  if (matchesShortcut(e, "terminal.copySelection", overrides)) {
    if (selection) return { consume: true, action: "copy", text: selection };
    return { consume: true, action: "copy-noop" };
  }
  if (matchesShortcut(e, "terminal.sigint", overrides)) {
    return { consume: true, action: "sigint" };
  }
  if (matchesShortcut(e, "terminal.paste", overrides)) {
    return { consume: true, action: "paste" };
  }
  if (matchesShortcut(e, "terminal.eof", overrides)) {
    return { consume: true, action: "eof" };
  }
  if (matchesShortcut(e, "terminal.scroll.toEnd", overrides)) {
    return { consume: true, action: "scroll-to-end" };
  }
  // Stale por último: engole encoding antigo / nativo do Chromium quando
  // a tecla ficou órfã NO ESCOPO TERMINAL — `findShortcutClaimingKey` com
  // `"terminal"` é a mesma caminhada de `resolveGlobalShortcut` (fonte
  // única). Dono de outro escopo → swallow (não defer-central: o bubble
  // seria rejeitado e o Ctrl+D nativo abriria "adicionar favorito").
  if (
    isStaleDefaultShortcut(e, "terminal.sigint", overrides) ||
    isStaleDefaultShortcut(e, "terminal.eof", overrides)
  ) {
    if (findShortcutClaimingKey(e, overrides, "terminal") === null) {
      return { consume: true, action: "swallow" };
    }
    return { consume: false, action: "defer-central" };
  }
  return { consume: false, action: "none" };
}
