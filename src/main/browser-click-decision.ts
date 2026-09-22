/**
 * `browser_click`: em QUE a ferramenta clicou, e isso é o que ela afirma?
 *
 * Achado ao vivo (relato do dono, incidente P0 num formulário de vestibular):
 * três chamadas com seletores DIFERENTES devolveram as MESMAS coordenadas
 * (x:1322.99 y:852) e a resposta era só `{ok, x, y}` — nenhuma delas dizia
 * em que elemento o clique tinha caído. O resultado foram respostas marcadas
 * em perguntas que ele nunca mirou, num formulário que avisa "as respostas
 * não poderão ser editadas depois".
 *
 * MEDIDO (scripts/verify, build real, ver o smoke que acompanha este
 * módulo), e é daí que sai cada regra abaixo:
 *
 * 1. A coordenada devolvida não é a identidade do alvo. `scrollIntoView
 *    ({block:"center"})` põe o alvo no MEIO da viewport e o rect lido depois
 *    disso é o centro da viewport — dois alvos distintos, largura de linha
 *    parecida, devolvem o MESMO par x/y. Um agente que guarde esse par (o
 *    que a própria doc da tool sugere) e o reuse clica no que estiver ali
 *    naquele instante.
 * 2. Página com `scroll-behavior: smooth`: o `scrollIntoView` ANIMA, o rect
 *    é lido ANTES do scroll andar, e o clique cai na posição antiga — num
 *    alvo 3000px abaixo da dobra, o clique acertou `html` e a ferramenta
 *    devolveu `ok: true`.
 * 3. Alvo coberto por overlay/modal: `elementFromPoint` devolve o de cima;
 *    o clique acerta o overlay e a resposta continua `ok: true`.
 * 4. `selector: "button"` casando N elementos: clica o primeiro e nunca diz
 *    qual foi.
 *
 * A espinha é sempre a mesma: afirmação de sucesso que o sistema não pode
 * sustentar. Este módulo decide a ÚNICA frase que a tool pode dizer com o
 * que foi medido — no que clicou, ou por que não clicou.
 *
 * Puro — sem Electron, sem I/O. `describeClickTargetSource()`/
 * `sampleClickTargetSource()` são o extrator que roda DENTRO da página; a
 * decisão (`decideClickVerdict`) recebe só o que o extrator mediu e é
 * testável fora do navegador, mesmo padrão de
 * `browser-native-dialog-decision.ts`.
 */

import {
  COLLECT_CLICK_TARGET_FACTS_JS,
  type ClickTargetFacts,
} from "./browser-native-dialog-decision";

export type ClickRect = { x: number; y: number; width: number; height: number };
export type ClickPoint = { x: number; y: number };

/** O que a resposta pode dizer do alvo: o que um humano leria na tela. */
export type ClickTargetDescriptor = {
  /** `tagName` minúsculo. */
  tag: string;
  /** `id` do próprio elemento, `null` quando não tem. */
  id: string | null;
  /** `role` EXPLÍCITO (atributo), minúsculo; `null` quando ausente. */
  role: string | null;
  /** Nome legível: `aria-label` quando existe, senão o texto do elemento. */
  text: string;
};

/**
 * Relação entre o elemento que `elementFromPoint` devolveu no ponto e o
 * elemento que o seletor resolveu:
 * - `self` — o próprio alvo está no ponto;
 * - `descendant` — um filho do alvo (normal: botão com `<span>` dentro,
 *   `<label>` com o `<input>` dentro);
 * - `ancestor` — o ponto cai num PAI do alvo (`pointer-events:none` faz
 *   isso; aceito, porque um clique humano cairia igual);
 * - `other` — outra coisa qualquer: overlay, modal, sticky header, o
 *   `<html>` de uma página vazia;
 * - `none` — nada ali (`elementFromPoint` devolveu `null`).
 */
export type ClickRelation = "self" | "descendant" | "ancestor" | "other" | "none";

/** O que se está tentando clicar: um alvo resolvido por seletor/ref (`ref`
 * vira um `[data-stellar-ref=...]` antes de chegar aqui) ou um ponto cru. */
export type ClickIntent =
  | {
      kind: "element";
      /** Como o agente nomeou o alvo (seletor/ref) — entra nas mensagens. */
      describe: string;
      /** Descritor do elemento RESOLVIDO. */
      target: ClickTargetDescriptor;
      /** Quantos elementos o seletor casou. */
      matched: number;
    }
  | { kind: "point" };

/**
 * Uma amostra do estado da página no ponto de clique. Tudo em px lógicos
 * (CSS) da própria página — o mesmo espaço que `getBoundingClientRect` e
 * `elementFromPoint` usam, e que `sendInputEvent` recebe (medido: um clique
 * em (680,50) chega na página como `clientX=680, clientY=50`).
 */
export type ClickSite = {
  intent: ClickIntent;
  /** Onde o clique cairia. */
  point: ClickPoint;
  /** O que está no ponto, agora. `null` = nada (fora da viewport). */
  hit: ClickTargetDescriptor | null;
  relation: ClickRelation;
  viewport: { width: number; height: number };
  /** Quanto o rect do alvo andou entre a resolução e a checagem imediatamente
   * anterior ao disparo. `null` para clique por ponto (não há rect de alvo). */
  drift: { dx: number; dy: number } | null;
};

export type ClickVerdict =
  | { ok: true; target: ClickTargetDescriptor; matched: number; warning: string | null }
  | { ok: false; error: string };

/** O que o extrator devolveu da página (uma amostra crua). */
export type ClickSample = {
  point: ClickPoint;
  rect: ClickRect | null;
  target: ClickTargetDescriptor | null;
  targetFacts: ClickTargetFacts | null;
  hit: ClickTargetDescriptor | null;
  hitFacts: ClickTargetFacts | null;
  relation: ClickRelation;
  matched: number;
  viewport: { width: number; height: number };
};

/** Tolerância de drift: um clique é um evento no espaço de pixels; sub-pixel
 * não move o alvo para baixo do cursor. Medido: páginas estáveis devolvem
 * `dx = dy = 0`. */
export const CLICK_DRIFT_TOLERANCE_PX = 1;

function describeTarget(target: ClickTargetDescriptor | null): string {
  if (!target) return "nothing";
  const name = target.text ? ` "${target.text}"` : "";
  const id = target.id ? `#${target.id}` : "";
  return `<${target.tag}${id}>${name}`;
}

/**
 * Corpo do extrator que roda DENTRO da página (mesmo primitivo
 * `executeJavaScript` de `browser-registry.ts`): define `__stellarDescribe`
 * (o descritor legível), `__stellarRelation` e `__stellarSample`. Fica como
 * FONTE DE TEXTO porque é isso que a página recebe — e é a mesma string que
 * as três amostragens (resolver / re-verificar / ponto) usam, para não
 * existir uma versão que descreve o alvo e outra que descreve o que foi
 * clicado.
 */
export function clickExtractorSource(): string {
  return `
    function __stellarDescribe(el) {
      if (!el) return null;
      var raw = (el.getAttribute && el.getAttribute("aria-label")) || el.innerText || el.textContent || "";
      return {
        tag: String(el.tagName || "").toLowerCase(),
        id: el.id || null,
        role: (el.getAttribute && el.getAttribute("role")) || null,
        text: String(raw).replace(/\\s+/g, " ").trim().slice(0, ${CLICK_DESCRIBE_MAX_CHARS}),
      };
    }
    function __stellarRelation(target, hit) {
      if (!hit) return "none";
      if (!target) return "other";
      if (hit === target) return "self";
      if (target.contains(hit)) return "descendant";
      if (hit.contains(target)) return "ancestor";
      return "other";
    }
    function __stellarSample(target, px, py, matched) {
      var hit = document.elementFromPoint(px, py);
      return {
        point: { x: px, y: py },
        rect: target
          ? (function (r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; })(target.getBoundingClientRect())
          : null,
        target: __stellarDescribe(target),
        targetFacts: target ? (${COLLECT_CLICK_TARGET_FACTS_JS})(target) : null,
        hit: __stellarDescribe(hit),
        hitFacts: hit ? (${COLLECT_CLICK_TARGET_FACTS_JS})(hit) : null,
        relation: __stellarRelation(target, hit),
        matched: matched,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
  `;
}

/** Quantas amostras (uma por frame) se espera o layout parar de andar antes
 * de desistir. ~30 frames ≈ 500ms — mais que uma animação de
 * `scroll-behavior: smooth` do Chromium, e um teto pra página que anima para
 * sempre. */
export const CLICK_SETTLE_MAX_SAMPLES = 30;
/** Movimento abaixo disto entre duas amostras consecutivas é ruído de
 * sub-pixel, não layout andando. */
export const CLICK_SETTLE_TOLERANCE_PX = 0.5;
/** Quantos frames SEGUIDOS de rect E scroll parados contam como "o layout
 * parou". Dois já pareciam bastar, mas medido ao vivo: uma animação de scroll
 * em desaceleração produz dois frames com delta < 0.5px NO MEIO do caminho —
 * o clique saía ~10px acima do alvo (caiu em `spacer`, não no `#deep`). */
export const CLICK_SETTLE_STABLE_FRAMES = 3;
/** Teto do texto devolvido em `text` (mesmo espírito dos outros truncamentos
 * deste registry: o suficiente para um humano reconhecer o alvo). */
export const CLICK_DESCRIBE_MAX_CHARS = 80;

/**
 * Resolve o seletor, rola o alvo para o centro da viewport e espera o layout
 * PARAR antes de devolver a amostra.
 *
 * O scroll é forçado a ser INSTANTÂNEO neutralando `scroll-behavior` no inline
 * style dos containers roláveis acima do alvo (só durante esta chamada, e
 * restaurado no `finally`): com `scroll-behavior: smooth` no CSS da página, o
 * `getBoundingClientRect` logo depois do `scrollIntoView` devolvia a posição
 * ANTIGA — medido, o clique caía em `html`, 3000px acima do alvo, com a tool
 * respondendo `ok: true`. O laço de estabilidade (rect E scroll parados por
 * `CLICK_SETTLE_STABLE_FRAMES` frames seguidos) é a rede para quem continuar
 * animando por conta própria.
 */
export function clickResolveSource(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(async () => {
    ${clickExtractorSource()}
    let el = null;
    try {
      el = document.querySelector(${sel});
    } catch (err) {
      return { __selectorError: String((err && err.message) || err) };
    }
    if (!el) return { __noMatch: true };
    const matched = document.querySelectorAll(${sel}).length;
    // scroll-behavior: smooth (na própria página ou em qualquer container
    // rolável acima do alvo) faz o rect ser lido ANTES de o scroll andar —
    // medido: o clique caiu em html, 3000px acima do alvo, com a tool
    // respondendo ok. Neutralizado no inline style só durante este scroll e
    // restaurado logo depois, sem deixar rastro nenhum na página.
    const scrollers = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node === document.documentElement || node === document.body) {
        scrollers.push(node);
        continue;
      }
      const style = getComputedStyle(node);
      if (/^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)) scrollers.push(node);
    }
    const savedBehavior = scrollers.map((node) => node.style.scrollBehavior);
    scrollers.forEach((node) => {
      node.style.scrollBehavior = "auto";
    });
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (err) {
      try {
        el.scrollIntoView();
      } catch (err2) {
        /* sem scroll nenhum: a verificação abaixo decide */
      }
    } finally {
      scrollers.forEach((node, i) => {
        node.style.scrollBehavior = savedBehavior[i];
      });
    }
    let previousRect = null;
    let stableFrames = 0;
    let last = null;
    for (let i = 0; i < ${CLICK_SETTLE_MAX_SAMPLES}; i++) {
      const scrollBefore = { x: window.scrollX, y: window.scrollY };
      const rect = el.getBoundingClientRect();
      last = __stellarSample(el, rect.x + rect.width / 2, rect.y + rect.height / 2, matched);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const movedByRect =
        previousRect &&
        (Math.abs(rect.x - previousRect.x) > ${CLICK_SETTLE_TOLERANCE_PX} ||
          Math.abs(rect.y - previousRect.y) > ${CLICK_SETTLE_TOLERANCE_PX});
      const movedByScroll = scrollBefore.x !== window.scrollX || scrollBefore.y !== window.scrollY;
      stableFrames = movedByRect || movedByScroll ? 0 : stableFrames + 1;
      previousRect = rect;
      if (stableFrames >= ${CLICK_SETTLE_STABLE_FRAMES}) return { __value: last };
    }
    return { __value: last };
  })()`;
}

/**
 * Re-resolve o MESMO seletor e re-amostra o ponto, sem rolar nada — é a
 * leitura que fica entre a resolução acima e o `sendInputEvent`. É da
 * comparação entre as duas que sai o `drift`.
 */
export function clickVerifySource(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(() => {
    ${clickExtractorSource()}
    let el = null;
    try {
      el = document.querySelector(${sel});
    } catch (err) {
      return { __selectorError: String((err && err.message) || err) };
    }
    if (!el) return { __noMatch: true };
    const rect = el.getBoundingClientRect();
    return {
      __value: __stellarSample(el, rect.x + rect.width / 2, rect.y + rect.height / 2, document.querySelectorAll(${sel}).length),
    };
  })()`;
}

/** Amostra de um PONTO cru (sem seletor): o alvo é o que estiver ali. */
export function clickPointSource(x: number, y: number): string {
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  return `(() => {
    ${clickExtractorSource()}
    return { __value: __stellarSample(null, ${JSON.stringify(px)}, ${JSON.stringify(py)}, 0) };
  })()`;
}

/** O alvo está fora da viewport? (`elementFromPoint` devolve `null` fora
 * dela, mas nomear "fora da viewport" é a mensagem certa: o motivo mais
 * comum é a página ter rolado depois de as coordenadas serem lidas.) */
export function targetOutsideViewport(
  point: ClickPoint,
  viewport: { width: number; height: number },
): boolean {
  return point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height;
}

/** AGENT-FACING — DO NOT TRANSLATE. English, like every other refusal this
 * registry returns, and it TEACHES: names the measured fact and the way out. */
export function describePointOutsideViewport(
  point: ClickPoint,
  viewport: { width: number; height: number },
): string {
  return (
    `browser_click refused before clicking: the point (${point.x}, ${point.y}) is outside the page's viewport ` +
    `(${viewport.width}×${viewport.height} logical px), so the click would have landed on nothing. ` +
    `The page's layout most likely moved (or scrolled) since those coordinates were read — re-read them ` +
    `(browser_query on the element) or click by selector/ref instead of by coordinate. Nothing was clicked.`
  );
}

export function describeNoElementAtPoint(point: ClickPoint): string {
  return (
    `browser_click refused before clicking: nothing is at the point (${point.x}, ${point.y}) — ` +
    `document.elementFromPoint returned null, so the click would have hit nothing at all. Nothing was clicked.`
  );
}

export function describeTargetCovered(
  intent: Extract<ClickIntent, { kind: "element" }>,
  point: ClickPoint,
  hit: ClickTargetDescriptor | null,
): string {
  return (
    `browser_click refused before clicking ${intent.describe}: the point (${point.x}, ${point.y}) is covered by ` +
    `${describeTarget(hit)} — that click would have hit the covering element, not ${describeTarget(intent.target)}. ` +
    `Something is on top of the target (overlay, modal, sticky header, cookie banner, or an empty page's <html>). ` +
    `Dismiss it, click the covering element on purpose (browser_click on THAT selector), or use browser_eval ` +
    `to inspect why the target is not the topmost element. Nothing was clicked.`
  );
}

export function describeLayoutMoved(
  intent: Extract<ClickIntent, { kind: "element" }>,
  drift: { dx: number; dy: number },
  point: ClickPoint,
): string {
  return (
    `browser_click refused before clicking ${intent.describe}: the page was still moving — the target's rect moved ` +
    `by (${drift.dx}, ${drift.dy}) logical px between resolving it and the check immediately before the click, ` +
    `so the click would have landed at the OLD coordinates (${point.x}, ${point.y}). ` +
    `Re-run the call (the layout has settled by now), or wait for the page to finish loading/reflowing. ` +
    `Nothing was clicked.`
  );
}

export function describeMultiMatch(
  matched: number,
  target: ClickTargetDescriptor | null,
  describe: string,
): string {
  return (
    `${describe} matched ${matched} elements; the click went to the FIRST one in document order, ` +
    `${describeTarget(target)}. If that is not the one you meant, use a stricter selector, a ref from ` +
    `browser_snapshot (which names what a human reads on screen), or browser_query first.`
  );
}

/**
 * A frase que a tool pode dizer com o que foi medido. Ordem das checagens,
 * e por quê:
 * 1. ponto fora da viewport — nada pode ser clicado ali, e é o caso que mais
 *    se parece com sucesso na resposta antiga;
 * 2. nada no ponto (`elementFromPoint` = null) — idem;
 * 3. MOVIMENTO do alvo entre a resolução e a checagem pré-disparo — o
 *    mecanismo do incidente relatado; recusar é o único jeito de não clicar
 *    no lugar errado;
 * 4. coisa DIFERENTE no ponto (`relation: "other"`) — coberto por overlay;
 * 5. senão, `ok` — e o alvo vai NOMEADO na resposta, com aviso quando o
 *    seletor casou mais de um elemento.
 *
 * Clique por PONTO não tem intenção a comparar (o chamador pediu "o que
 * estiver ali"): não existe o caso 3 (não há rect de alvo) nem o 4 (clicar
 * no overlay É o que se pediu) — mas 1 e 2 continuam valendo, e a resposta
 * nomeia o que foi atingido em vez de devolver só x/y.
 */
export function decideClickVerdict(site: ClickSite): ClickVerdict {
  const { intent, point, hit, relation, viewport, drift } = site;
  if (targetOutsideViewport(point, viewport)) {
    return { ok: false, error: describePointOutsideViewport(point, viewport) };
  }
  if (!hit || relation === "none") {
    return { ok: false, error: describeNoElementAtPoint(point) };
  }
  if (intent.kind === "element") {
    if (
      drift &&
      (Math.abs(drift.dx) > CLICK_DRIFT_TOLERANCE_PX ||
        Math.abs(drift.dy) > CLICK_DRIFT_TOLERANCE_PX)
    ) {
      return { ok: false, error: describeLayoutMoved(intent, drift, point) };
    }
    if (relation === "other") {
      return { ok: false, error: describeTargetCovered(intent, point, hit) };
    }
    return {
      ok: true,
      target: intent.target,
      matched: intent.matched,
      warning:
        intent.matched > 1
          ? describeMultiMatch(intent.matched, intent.target, intent.describe)
          : null,
    };
  }
  return { ok: true, target: hit, matched: 0, warning: null };
}

/**
 * Compara o rect resolvido com o re-lido imediatamente antes do disparo.
 * `null` para clique por ponto. Tolerância:
 * `CLICK_DRIFT_TOLERANCE_PX` — sub-pixel não move o alvo para baixo do
 * cursor.
 */
export function clickDrift(
  resolved: ClickRect | null,
  current: ClickRect | null,
): { dx: number; dy: number } | null {
  if (!resolved || !current) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { dx: round(current.x - resolved.x), dy: round(current.y - resolved.y) };
}
