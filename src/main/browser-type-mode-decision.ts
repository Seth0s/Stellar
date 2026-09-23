/**
 * `browser_type` com `replace: true` — o que pode ser substituído, e o que
 * NÃO PODE.
 *
 * Relato do dono (task 770abd6e), valores reais: `#company-name-input` ficou
 * "Idy PlatformIdy Platform". O agente não apagou o que estava lá; escreveu
 * por cima SOMANDO — o humano já tinha digitado aquilo à mão. A saída de
 * emergência que existia (limpar por `browser_eval` com o setter nativo)
 * passa no React e é frágil no Angular: a forma clássica de conserto que
 * parece bom.
 *
 * COMO LIMPAR, e por que assim (medido no smoke que acompanha este módulo,
 * contra React 18, Vue 3 e AngularJS — `ng-model`, que é o mesmo contrato do
 * DefaultValueAccessor do Angular: escutar `input`):
 *
 *   - o setter nativo + `dispatchEvent(new Event('input'))` escreve o DOM e
 *     AVISA o framework; funciona, e é justamente o caminho que o dono já
 *     tinha descoberto ser frágil fora do React — além de trocar o mecanismo
 *     de entrada por JS, o que tira a digitação do caminho IME-safe;
 *   - `Input.insertText` com string vazia NÃO limpa nada: inserir nada é
 *     inserir nada (não existe "apagar" nessa chamada);
 *   - teclas sintéticas (Ctrl+A / Delete por `dispatchKeyEvent`) limpam, mas
 *     reintroduzem digitação por evento de tecla — exatamente o que
 *     `insertText` existe para evitar em línguas com composição.
 *
 * A escolha: `webContents.selectAll()` (o comando de edição REAL do Chromium,
 * o mesmo do Ctrl+A humano) seguido do `insertText` que já existia. Selecionar
 * e inserir por cima substitui, em UM `insertText`, sem evento de tecla
 * nenhum — o smoke audita isso: exatamente UM `beforeinput` com
 * `inputType: "insertText"` e ZERO `keydown`.
 *
 * A LINHA DURA — onde este módulo RECUSA em vez de limpar pela metade: se o
 * alvo não é um campo editável, `selectAll()` num alvo não editável seleciona
 * o DOCUMENTO inteiro e o `insertText` seguinte substituiria a página.
 * Recusar nomeando é mais honesto que "limpar" o que não era um campo.
 *
 * Puro — sem Electron, sem I/O. `typeTargetFactsSource()` é o extrator que
 * roda DENTRO da página; a decisão (`decideTypeMode`) recebe só os fatos.
 */

/** O que a página responde sobre o alvo do `browser_type`. */
export type TypeTargetFacts = {
  /** `tagName` minúsculo. */
  tag: string;
  /** Recebe digitação: `input` de texto (não checkbox/botão/…), `textarea` ou
   * `contenteditable`. */
  editable: boolean;
  readOnly: boolean;
  disabled: boolean;
  /** O alvo está FOCADO agora — pré-condição medida do `selectAll()`: o
   * comando de edição age em quem está focado, e o Chromium processa o clique
   * de forma assíncrona (medido: selecionar antes do foco pousar limpava nada
   * e o `insertText` seguinte virava APPEND — o defeito original, de novo e só
   * às vezes). */
  focused: boolean;
};

export type TypeModeDecision =
  | { action: "type"; replace: boolean }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. Nomeia o fato medido e o que fazer. */
export function describeNotEditable(describe: string, facts: TypeTargetFacts | null): string {
  if (!facts) {
    return (
      `browser_type refused: could not read the target ${describe} to check whether it is editable, and ` +
      `\`replace: true\` never clears blindfolded (selecting everything in a page that has no focused field ` +
      `selects the whole document). Give a \`selector\`/\`ref\` that points at the field, or drop \`replace\` ` +
      `(append) — nothing was typed.`
    );
  }
  const why = !facts.editable
    ? `it is a <${facts.tag}> and not an editable field`
    : facts.readOnly
      ? `it is a readonly <${facts.tag}>`
      : `it is a disabled <${facts.tag}>`;
  return (
    `browser_type refused with \`replace: true\`: ${describe} — ${why}. Clearing it would either do nothing ` +
    `or select the whole document (the editing command acts on whatever is focused), so nothing was typed. ` +
    `Target the field itself, or type without \`replace\` (append).`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeNotFocused(describe: string): string {
  return (
    `browser_type refused with \`replace: true\`: ${describe} never took focus, and the clear acts on whatever ` +
    `IS focused — inserting after it would land the text in the wrong field (or append, which is the bug this ` +
    `parameter exists to fix). Nothing was typed: target the field again (or click it first) and retry.`
  );
}

/**
 * Decide se esta chamada pode ser um "substituir". O append (default) segue
 * exatamente como era: quem depende dele não muda de comportamento — o número
 * medido está no relatório da task, e a decisão de manter o default foi
 * explícita.
 */
export function decideTypeMode(input: {
  replace: boolean;
  /** Como o chamador nomeou o alvo (seletor/ref), para a mensagem. */
  describe: string;
  facts: TypeTargetFacts | null;
}): TypeModeDecision {
  if (!input.replace) return { action: "type", replace: false };
  if (!input.facts) return { action: "refuse", error: describeNotEditable(input.describe, null) };
  if (!input.facts.editable || input.facts.readOnly || input.facts.disabled) {
    return { action: "refuse", error: describeNotEditable(input.describe, input.facts) };
  }
  if (!input.facts.focused) {
    return { action: "refuse", error: describeNotFocused(input.describe) };
  }
  return { action: "type", replace: true };
}

/** Tipos de `<input>` que NÃO recebem texto. */
export const NON_TEXT_INPUT_TYPES = [
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "image",
  "range",
  "color",
  "hidden",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
] as const;

/**
 * Corpo que roda DENTRO da página: descreve o alvo (o elemento do seletor, ou
 * o que está focado quando não há seletor) para a decisão acima.
 */
export function typeTargetFactsSource(selector: string | null): string {
  const sel = selector === null ? "null" : JSON.stringify(selector);
  return `(() => {
    const sel = ${sel};
    const el = sel === null ? document.activeElement : document.querySelector(sel);
    if (!el) return { __noMatch: true };
    const tag = String(el.tagName || "").toLowerCase();
    const type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
    const NON_TEXT = ${JSON.stringify(NON_TEXT_INPUT_TYPES)};
    const editable =
      el.isContentEditable === true ||
      tag === "textarea" ||
      (tag === "input" && type !== null && NON_TEXT.indexOf(type) === -1);
    return {
      __value: {
        tag: tag,
        editable: editable,
        readOnly: Boolean(el.readOnly),
        disabled: Boolean(el.disabled),
        focused: document.activeElement === el,
      },
    };
  })()`;
}

/**
 * Corpo que roda DENTRO da página: FOCO + SELEÇÃO do conteúdo do alvo, para o
 * `insertText` seguinte substituir em vez de somar.
 *
 * Por que por aqui, e não por `webContents.selectAll()`: aquele comando de
 * edição age em QUEM ESTÁ FOCADO, e o foco de um clique chega de forma
 * assíncrona — medido no smoke, `selectAll()` disparado logo depois do clique
 * selecionava NADA e o `insertText` voltava a CONCATENAR (o defeito original,
 * agora intermitente: o pior dos mundos para diagnosticar). Aqui o foco é
 * pedido e a seleção é montada na MESMA avaliação, sem corrida.
 *
 * A digitação continua sendo `insertText` (um `beforeinput` de `insertText`,
 * zero tecla) — o que muda é só a seleção que ele substitui. Para
 * `input`/`textarea` usa `setSelectionRange`; para `contenteditable`, um
 * `Range` sobre o conteúdo.
 */
export function typeSelectContentSource(selector: string | null): string {
  const sel = selector === null ? "null" : JSON.stringify(selector);
  return `(() => {
    const sel = ${sel};
    const el = sel === null ? document.activeElement : document.querySelector(sel);
    if (!el) return { __noMatch: true };
    if (typeof el.focus === "function") el.focus();
    const tag = String(el.tagName || "").toLowerCase();
    try {
      if (tag === "input" || tag === "textarea") {
        const len = String(el.value || "").length;
        el.setSelectionRange(0, len);
        return { __value: { selected: len } };
      }
      if (el.isContentEditable === true) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return { __value: { selected: String(selection.toString() || "").length } };
      }
    } catch (err) {
      return { __value: { selected: 0, error: String(err) } };
    }
    return { __value: { selected: 0 } };
  })()`;
}
