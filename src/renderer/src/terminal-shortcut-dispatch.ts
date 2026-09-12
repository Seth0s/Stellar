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
  /** Default do registro ainda casa, mas o efetivo não (rebindou pra
   * longe) E nenhum outro atalho no registro reivindicou a tecla —
   * engole pra o encoding antigo do xterm não disparar. Rodada 3: stale
   * vai NO FIM; se viesse antes de paste/eof, reutilizar Ctrl+C liberado
   * virava buraco negro (engolia paste válido). Rodada 4: "ninguém
   * reivindicou" consulta o REGISTRO inteiro (`findShortcutClaimingKey`),
   * não só os quatro atalhos de terminal — senão um central (ex.:
   * `card.duplicate` no Ctrl+C livre) era engolido e nunca bubblava. */
  | { consume: true; action: "swallow" }
  /**
   * Rodada 5–6: stale + QUALQUER dono no registro (central OU native
   * fora dos quatro de terminal já checados). `consume: false` de
   * propósito — NÃO chamar `stopImmediatePropagation` (senão o bubble
   * morre e o atalho do dono nunca dispara). O xterm é barrado à parte
   * via `attachCustomKeyEventHandler` → `false` (medido: `preventDefault`
   * sozinho NÃO impede `onData("\x03")`). Rodada 6: filtrar só
   * `GLOBAL_SHORTCUTS_BY_ID` vazava `\x03` quando o dono era native
   * (ex.: browser.* no Ctrl+C livre) — mesma classe do buraco da rodada 5.
   */
  | { consume: false; action: "defer-central" }
  | { consume: false; action: "none" };

/**
 * Ordem final da sequência (rodadas 3–6 do review):
 * 1. copy efetivo (antes de sigint — Ctrl+Shift+C vs Ctrl+C)
 * 2. sigint efetivo
 * 3. paste efetivo
 * 4. eof efetivo
 * 5. stale sigint / stale eof:
 *    - ninguém reivindica → swallow
 *    - alguém reivindica (qualquer dispatch/escopo) → defer-central
 *      (bubbla; xterm barrado no handler)
 * 6. none
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
  // Stale por último: engole encoding antigo só quando a tecla ficou órfã
  // de verdade — `findShortcutClaimingKey` pergunta ao registro (qualquer
  // dispatch/escopo), sem lista paralela de ids. Qualquer dono →
  // defer-central (não none: senão o xterm emite `\x03`).
  if (
    isStaleDefaultShortcut(e, "terminal.sigint", overrides) ||
    isStaleDefaultShortcut(e, "terminal.eof", overrides)
  ) {
    if (findShortcutClaimingKey(e, overrides) === null) {
      return { consume: true, action: "swallow" };
    }
    return { consume: false, action: "defer-central" };
  }
  return { consume: false, action: "none" };
}
