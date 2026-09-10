/**
 * Item 2 (atalhos, fase A) — a versão original só considerava "digitando"
 * INPUT/TEXTAREA/CANVAS/contentEditable. Bug ao vivo: com foco num
 * `<button>` (por exemplo a própria Rail, depois de clicar num botão que
 * não navega/blura), teclar `v`/`p`/`c`/`s` trocava a ferramenta e `?`
 * abria a overlay no meio de uma interação de teclado com aquele
 * componente — o guard nunca via um BUTTON como "ocupado".
 *
 * Revisão pós-review (2026-09-09, achado 1) — a primeira generalização
 * checava `tabIndex >= 0`, o que ainda vazava: um modal ou widget custom
 * que usa `tabindex="-1"` de propósito (pra poder chamar `.focus()` nele
 * via script e fazer focus-trapping, SEM entrar na ordem normal de Tab)
 * reporta `tabIndex === -1` — indistinguível, por esse critério, de um
 * `<div>` comum nunca focado. `v`/`p`/`c`/`s` continuavam sequestrando
 * teclado de um componente assim.
 *
 * A checagem certa não é sobre o VALOR do tabIndex, é sobre uma
 * invariante do DOM: `document.activeElement` só é `<body>`/`<html>`
 * quando nada de verdade está focado; qualquer outro elemento que
 * `document.activeElement` aponte só chegou lá porque tem ALGUM tabIndex
 * (nativo — button/a[href]/select/input/textarea — ou explícito,
 * INCLUINDO `tabindex="-1"`) — um `<div>` sem tabindex nenhum não pode se
 * tornar `activeElement` nem por clique nem por `.focus()` (no-op sem
 * tabIndex). Então "é `activeElement` e não é body/html" já IMPLICA
 * "focável de verdade", sem precisar ler `tabIndex` — e cobre o caso do
 * achado 1 de graça. O fundo do canvas (um `<div>` comum) nunca vira
 * `activeElement`, então continua fora do guard — as teclas de ferramenta
 * seguem funcionando com foco lá.
 *
 * IMPORTANTE pro chamador: passe `document.activeElement`, não
 * `event.target` — normalmente coincidem, mas só `activeElement` é
 * garantido atual se algo mais cedo na mesma fase de bubble do evento já
 * tiver mudado o foco.
 *
 * Pura e sem DOM de propósito — `vitest` aqui roda em `environment: "node"`
 * (ver vitest.config.ts), então o alvo chega como os poucos campos que a
 * decisão realmente usa, nunca um `HTMLElement` real (ver
 * tests/unit/keyboard-shortcut-guard.test.ts).
 */
export interface ShortcutTargetInfo {
  /** `element.tagName`, já em maiúsculas (é assim que o DOM devolve). */
  tagName: string;
  isContentEditable: boolean;
}

/**
 * `true` quando um atalho global de teclado (ferramenta v/p/c/s, `?` da
 * overlay, F11) NÃO deve disparar porque o elemento REALMENTE focado
 * (`document.activeElement`) já é dono legítimo daquela tecla — um campo
 * de texto, o canvas embutido de um card de navegador (que encaminha toda
 * tecla pra dentro da página), um modal/widget com `tabindex="-1"`, ou
 * qualquer outro elemento genuinamente focado (Rail, links, selects).
 */
export function isGlobalShortcutBlocked(target: ShortcutTargetInfo | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName !== "BODY" && target.tagName !== "HTML";
}
