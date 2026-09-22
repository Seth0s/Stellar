/**
 * `browser_snapshot`: o controle de formulário que ESCOLHE o input escondido.
 *
 * Relato do dono: na tela de perguntas do Infnet o snapshot listou 2 elementos
 * numa página com ~40 rádios; no Gupy, a lista de rádios de "Dados adicionais"
 * não apareceu. O padrão que causa é o mais comum da web: `<input type=radio>`
 * invisível com um `<label>` estilizado por cima. O snapshot perguntava
 * visibilidade ao PRÓPRIO input — que está escondido de propósito — e
 * descartava todos.
 *
 * Por que isto é P0: o snapshot é o caminho que a própria ferramenta recomenda
 * ("cheaper and more reliable than a screenshot plus guessing coordinates").
 * Quando ele mente POR OMISSÃO, o agente não tem como saber que faltou algo e
 * cai no clique por coordenada — o outro P0. Os dois defeitos compõem: um
 * empurra para o outro.
 *
 * MEDIDO (probe real contra o build, ver o smoke que acompanha este módulo),
 * com as formas reais de esconder e um grupo de cada:
 *
 *   forma                              | o snapshot de HOJE dizia
 *   ---------------------------------- | ----------------------------------
 *   `opacity: 0` + `<label for>`       | OMITIDO (é o caso do relato)
 *   `display: none` + label visível    | OMITIDO (clicar o label FUNCIONA)
 *   `visibility: hidden` + label       | OMITIDO
 *   `position:absolute; left:-9999px`  | LISTADO, e o clique não acontece
 *   `width:0; height:0`                | LISTADO, e o clique não acerta o input
 *   `sr-only`/`clip` + label ANCESTRAL | LISTADO (este funcionava)
 *   passo fechado (`display:none` no ancestral) | omitido — e DEVE ser
 *   `<template>`                       | nem entra no `querySelectorAll` — deve
 *
 * Ou seja: a regra antiga errava nos DOIS sentidos. Omitia o que dá para
 * clicar (o label está lá, visível, e é o que um humano clica) e listava o que
 * não dá (input de 0×0 ou fora da tela, cujo `ref` não leva a clique nenhum).
 *
 * A LINHA, e por quê: um controle é listado quando o agente CONSEGUE agir
 * sobre ele, e o `ref` vai no elemento que o clique de fato atinge —
 * 1. no próprio controle, quando ele tem caixa visível E o ponto central cai
 *    dentro da viewport E o `elementFromPoint` dali devolve o próprio controle
 *    (ou um filho/pai dele: o mesmo critério que `browser_click` usa antes de
 *    disparar, então o snapshot nunca lista algo que o clique recusaria);
 * 2. senão, no `<label>` ASSOCIADO visível (label ancestral, ou `label[for=id]`
 *    — medidos como as duas formas reais de associação), com `via: "label"`
 *    dito na resposta, porque aí o `ref` aponta para o label e é o label que o
 *    clique acerta;
 * 3. senão, FORA. Um input sem caixa visível e sem label associado visível é o
 *    passo de formulário que ainda não abriu — listá-lo seria a mentira
 *    oposta, tão ruim quanto a omissão: um snapshot que lista o que não dá
 *    para clicar é indistinguível de um que omite.
 *
 * `aria-labelledby` NÃO entra como proxy de clique: ele nomeia o controle
 * (e continua sendo usado para o NOME), mas não é o alvo que o clique acerta.
 *
 * `checked` de rádio é POR GRUPO: "checked: false" em 40 rádios não informa
 * nada se não se sabe de que grupo cada um é, então o item carrega `group`
 * (o atributo `name`) e `checked` SEMPRE (true e false) em rádio/checkbox.
 *
 * Puro — sem Electron, sem I/O. `snapshotTargetProbeSource()` é o extrator que
 * roda DENTRO da página; a decisão (`decideSnapshotTarget`) recebe só os fatos
 * e é testável fora do navegador, mesmo padrão de
 * `browser-native-dialog-decision.ts`.
 */

/** Fatos medidos na página sobre UM candidato do `querySelectorAll`. */
export type SnapshotControlFacts = {
  /** `tagName` minúsculo. */
  tag: string;
  /** O elemento tem caixa visível PRÓPRIA (rect + display/visibility/opacity). */
  selfVisible: boolean;
  /** O ponto que um clique usaria (centro do rect) está dentro da viewport. */
  pointInViewport: boolean;
  /** `elementFromPoint` nesse ponto devolve o próprio elemento, um filho ou um
   * pai dele — o mesmo critério de aceitação de `browser_click`. */
  pointHitsSelf: boolean;
  /** Label ASSOCIADO (ancestral, ou `label[for=id]`), e se ele está visível. */
  label: { kind: "wrapping" | "for"; visible: boolean } | null;
};

export type SnapshotTargetDecision =
  | { list: true; refOn: "self" }
  | { list: true; refOn: "label"; via: "label" }
  | { list: false; reason: string };

/** Onde o clique deste controle realmente cai — e portanto onde o `ref` deve
 * ser carimbado. */
export function decideSnapshotTarget(facts: SnapshotControlFacts): SnapshotTargetDecision {
  if (facts.selfVisible && facts.pointInViewport && facts.pointHitsSelf) {
    return { list: true, refOn: "self" };
  }
  if (facts.label?.visible) {
    return { list: true, refOn: "label", via: "label" };
  }
  return { list: false, reason: describeSnapshotSkip(facts) };
}

/** Por que este controle ficou de fora — diagnóstico, não vai para a resposta
 * do snapshot (não listar não é uma afirmação sobre o alvo). */
export function describeSnapshotSkip(facts: SnapshotControlFacts): string {
  const parts: string[] = [];
  if (!facts.selfVisible) parts.push("no visible box of its own");
  if (facts.selfVisible && !facts.pointInViewport) parts.push("its point is outside the viewport");
  if (facts.selfVisible && facts.pointInViewport && !facts.pointHitsSelf) {
    parts.push("something else is on top of its point");
  }
  if (!facts.label) parts.push("no <label> associated");
  else if (!facts.label.visible) parts.push("its associated <label> is not visible");
  return parts.join(" and ");
}

/** Tipos de input em que `checked`/`group` fazem sentido (e onde "checked:
 * false" sozinho não informa nada sem o grupo). */
export function isCheckableInput(inputType: string | null): boolean {
  return inputType === "radio" || inputType === "checkbox";
}


/**
 * Corpo que roda DENTRO da página: define a visibilidade (UMA definição, usada
 * tanto para o candidato quanto para o label dele), acha o label associado e
 * coleta os fatos. Fica como fonte de texto porque é isso que
 * `executeJavaScript` recebe.
 */
export function snapshotTargetProbeSource(): string {
  return `
    function __stellarStyleVisible(el) {
      if (!el || el.getClientRects().length === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
    }
    function __stellarAssociatedLabel(el) {
      const wrapping = el.closest ? el.closest("label") : null;
      if (wrapping) return { label: wrapping, kind: "wrapping" };
      if (el.id) {
        const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (forLabel) return { label: forLabel, kind: "for" };
      }
      return null;
    }
    function __stellarSnapshotFacts(el) {
      const r = el.getBoundingClientRect();
      const px = r.x + r.width / 2;
      const py = r.y + r.height / 2;
      const inViewport =
        r.width > 0 &&
        r.height > 0 &&
        px >= 0 &&
        py >= 0 &&
        px <= window.innerWidth &&
        py <= window.innerHeight;
      const hit = inViewport ? document.elementFromPoint(px, py) : null;
      const associated = __stellarAssociatedLabel(el);
      return {
        tag: String(el.tagName || "").toLowerCase(),
        selfVisible: __stellarStyleVisible(el),
        pointInViewport: inViewport,
        pointHitsSelf: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
        label: associated
          ? { kind: associated.kind, visible: __stellarStyleVisible(associated.label) }
          : null,
        labelElement: associated ? associated.label : null,
      };
    }
  `;
}
