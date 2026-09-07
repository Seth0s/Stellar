import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import styles from "./BrowserInspector.module.css";

// Mesma lazy-load de FilesCard.tsx — CodeMirror é pesado, uma sessão que
// nunca abre a aba Sources não deveria pagar por ele no bundle inicial.
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

/** Pendentes #188 — mini-inspector embutido no card, pedido explícito do
 * usuário depois de ver que o DevTools real só abre numa janela
 * separada (Electron não sabe pintar a UI do DevTools dentro de um
 * webContents offscreen — ver browser-registry.ts's `openDevTools` doc
 * comment). Construído inteiramente em cima de `evalJs` (já existia, só
 * exposto pro lado MCP até agora) — sem CDP/`webContents.debugger`.
 *
 * Redesenho pra coluna dockável (2026-09-06) — protótipo HTML aprovado
 * pelo usuário ("Vamos planejar melhor a UI e UX... formato coluna
 * (barra lateral)"). Trocou o drawer fixo na parte de baixo por um
 * painel que se ancora à direita (default, igual o DevTools real),
 * embaixo ou à esquerda, redimensionável por arraste — ver `dock`/
 * `panelSize` abaixo. Aba Application é nova (local/session storage +
 * cookies reais); Network fica por conta do outro agente trabalhando em
 * paralelo nesta mesma feature (ver `browser:get-network`/`getCookies`
 * já wireados por ele em browser-registry.ts/preload). */

type DomNode = { nodeId: number; tag: string; attrs: Record<string, string>; children: DomNode[]; text: string; hasChildren: boolean };
/** Node cru devolvido por `DOM.getDocument`/dentro de um evento
 * `DOM.setChildNodes` — só os campos que este inspector usa (CDP devolve
 * bem mais: shadow DOM, pseudo-elements, etc., fora de escopo aqui,
 * igual o `evalJs`-based antigo nunca via shadow DOM nenhum). */
type CdpRawNode = {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  childNodeCount?: number;
  children?: CdpRawNode[];
  attributes?: string[];
};
type ConsoleLine = { level: string; message: string; at: number };
type Tab = "elements" | "console" | "network" | "application" | "sources" | "performance";
type SourceEntry = { url: string; kind: "document" | "script" | "stylesheet" };
/** Fase 4 (adoção de CDP) — a aba Network do Inspector passa a usar isto
 * em vez do shape `NetworkLine` simples que `window.browser.getNetwork`
 * ainda devolve (a tool MCP `getNetwork`/o resumo da aba Performance
 * continuam nesse shape antigo, sem CDP — ver `refreshProcessStats`
 * abaixo). `startedMonotonic` é o
 * `timestamp` CRU do evento `Network.requestWillBeSent` (relógio
 * monotônico do processo, não wall-clock) — guardado só pra calcular
 * `durationMs` quando `loadingFinished`/`loadingFailed` chegar; `at` (pra
 * exibição) já vem de `wallTime` (esse sim wall-clock) convertido pra ms. */
type NetworkEntry = {
  requestId: string;
  method: string;
  url: string;
  status: number | null;
  statusText?: string;
  mimeType?: string;
  error?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  initiatorType?: string;
  at: number;
  startedMonotonic: number;
  durationMs?: number;
};
type Dock = "right" | "bottom" | "left";
type StorageArea = "local" | "session" | "cookies";
type DetailsSubtab = "styles" | "computed" | "listeners";
type ListenerEntry = { event: string };
type StyleDecl = { prop: string; value: string; important: boolean };
type MatchedRule = { selector: string; source: string; decls: StyleDecl[] };
type BoxModel = {
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  borderTop: number;
  borderRight: number;
  borderBottom: number;
  borderLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  width: number;
  height: number;
};
type ElementStyles = { inline: StyleDecl[]; matched: MatchedRule[]; computed: StyleDecl[]; box: BoxModel };
/** Fase 5 (adoção de CDP) — `Profiler.stop`'s formato cru (`CdpProfileNode`)
 * vs. o que a UI mostra (`ProfileHotspot`, já ordenado/resumido). */
type CdpProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
type ProfileHotspot = { functionName: string; url: string; lineNumber: number; hitCount: number; selfPercent: number };

export type ResponsivePreset = { label: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean };

const RESPONSIVE_PRESETS: ResponsivePreset[] = [
  { label: "Mobile (390×844)", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  { label: "Tablet (768×1024)", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  { label: "Desktop (1280×800)", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
];

// Limite de tamanho de dispositivo emulado — antes só existia como `100`/
// `3000` soltos dentro do clamp do arraste das alças (`onFrameResizePointerMove`),
// sem bater com NENHUM limite nos campos numéricos de tamanho personalizado
// (que não tinham `min`/`max` nenhum, então digitar "5" ou "99999" e clicar
// "Aplicar" não era clampado — só o ARRASTE respeitava um limite). Nomeado e
// centralizado aqui, aplicado nos dois caminhos (`clampFrameDim` abaixo).
const FRAME_DIM_MIN = 100;
const FRAME_DIM_MAX = 3000;
function clampFrameDim(n: number): number {
  return Math.max(FRAME_DIM_MIN, Math.min(FRAME_DIM_MAX, Math.round(n)));
}

// Larguras comuns de breakpoint, mesma "linha horizontal" de presets que
// o usuário apontou no print do device toolbar real do Chrome — atalho
// pra preencher o campo de largura personalizada sem digitar.
const WIDTH_RULER = [320, 375, 390, 414, 768, 1024, 1280, 1440];

// Achado ao vivo (2026-09-06, reconciliando o trabalho concorrente que
// implementou isto) — `300`/`400` pareciam razoáveis à primeira vista,
// mas a barra de abas (5 abas de texto + reload + 3 botões de dock +
// fechar) precisa de bastante largura mínima pro conteúdo não estourar.
// Sem isso o botão "Fechar inspector" (o último da fila) renderiza fora
// do retângulo clicável de verdade — visualmente cortado pelo
// `overflow: hidden` do próprio card, `elementFromPoint` nesse ponto
// acha o `.viewport` do board por baixo em vez do botão. Medido ao vivo
// depois de adicionar a aba Network: a barra de abas já pede uns 567px
// de largura de conteúdo real (5 abas + reload + 3 dock + fechar) — 520
// (o valor anterior, achado antes do Network existir) deixava a barra
// estourar por ~48px o tempo TODO, disparando o scrollbar nativo feio de
// `.inspectorTabs` (`overflow-x:auto`) mesmo no caso comum, não só no
// extremo. Subindo pra 600 dá folga de verdade; o `overflow-x:auto` e o
// scrollbar escondido (ver BrowserInspector.module.css) continuam como
// rede de segurança pro que ainda não couber (zoom do board bem baixo,
// card manualmente encolhido demais). `bottom` não sofre disso (a barra
// ocupa a largura CHEIA do card ali, não um painel estreito lateral).
// Achado ao vivo (2026-09-07, depois de mover o toggle de device toolbar
// pro DENTRO do inspector — ver `onToggleDeviceToolbar` abaixo): o novo
// botão fixo na barra de abas empurrou `.inspectorTabs` pra 667px de
// conteúdo contra só 599px de `clientWidth` (600 aqui) — os 68px que
// sobravam eram exatamente onde os botões de dock/fechar ficavam, então
// mediam a posição certa via `getBoundingClientRect()` mas um clique real
// nessas coordenadas caía FORA da área visível/clicável do painel
// (`.viewport` do board por baixo, confirmado com `elementFromPoint`) —
// clicável só na teoria, igual o bug documentado no comment de
// `.inspectorTabs` no CSS. 600→680 dá folga de novo pro caso comum.
const DOCK_MIN = { right: 680, bottom: 160, left: 680 } as const;
const DOCK_MAX = { right: 900, bottom: 520, left: 900 } as const;
const DOCK_DEFAULT = { right: 680, bottom: 280, left: 680 } as const;

// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 1) — substitui o antigo
// `SNAPSHOT_SCRIPT`/`SNAPSHOT_NODE_BUDGET` (evalJs, teto GLOBAL de 60 nós
// — reclamação explícita do usuário: "elements tem limite de 60 linhas e
// só carrega uma parte"). `DOM.getDocument({depth})` no attach + lazy
// `DOM.requestChildNodes` sob demanda no expand (ver `toggleNode` abaixo)
// nunca faz round-trip do subtree inteiro como um blob JSON — cada nível
// chega de cada vez, direto do protocolo de depuração (sem passar pelo
// `MAX_EVAL_RESULT_CHARS` de `evalJs`), então não existe budget de nó/
// profundidade/filhos nenhum pra impor.

/** Converte um node cru do CDP (`DOM.getDocument`/dentro de um evento
 * `DOM.setChildNodes`) pro formato que a árvore da UI já usava. `attrs`
 * vem de `attributes` (array plano alternando nome/valor, formato
 * próprio do protocolo). `text`/`hasChildren` só ficam corretos quando o
 * node cru já tem `children` populado (dentro da profundidade pedida) —
 * um node na FRONTEIRA da profundidade (children ainda não buscado)
 * aparece sem preview de texto até ser expandido, igual o DevTools real
 * — `hasChildren` nesse caso vem de `childNodeCount` bruto SÓ quando
 * `children` ainda não veio (fronteira de profundidade real — pode
 * incluir nós de texto que só vão se revelar num fetch futuro). Quando
 * `children` já veio (mesmo que só com nós de texto — CDP inclui texto
 * inline mesmo em fetches rasos), o valor real de `elementChildren` já é
 * conhecido e é ISSO que decide `hasChildren` — do contrário um `<button>
 * texto</button>` (childNodeCount=1, o nó de texto) ganha uma seta de
 * expand morta que nunca teria filho ELEMENTO nenhum pra revelar, e pior:
 * ela intercepta o clique (`stopPropagation` no toggle) antes de chegar
 * no `onSelect` da linha — nó nunca fica selecionável. */
function cdpNodeToDomNode(n: CdpRawNode): DomNode {
  const rawChildren = n.children ?? [];
  const elementChildren = rawChildren.filter((c) => c.nodeType === 1);
  const textChildren = rawChildren.filter((c) => c.nodeType === 3);
  const attrs: Record<string, string> = {};
  const flat = n.attributes ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]] = flat[i + 1];
  return {
    nodeId: n.nodeId,
    tag: (n.nodeName || "").toLowerCase(),
    attrs,
    children: elementChildren.map(cdpNodeToDomNode),
    text: elementChildren.length === 0 ? textChildren.map((c) => c.nodeValue ?? "").join("").trim().slice(0, 160) : "",
    hasChildren: n.children !== undefined ? elementChildren.length > 0 : (n.childNodeCount ?? 0) > 0,
  };
}

/** `parentMap` (nodeId → parentId) é a única forma barata de reconstruir
 * a cadeia de ancestrais de um node achado por localização (clique com
 * "Inspecionar elemento") sem mais uma chamada CDP — populada tanto pela
 * árvore inicial (`DOM.getDocument`) quanto por CADA evento
 * `DOM.setChildNodes` que chega depois (expand manual ou o cascade
 * automático que `DOM.pushNodeByBackendIdToFrontend` dispara pros
 * ancestrais do node revelado). */
function recordParentLinks(map: Map<number, number>, parentId: number, nodes: CdpRawNode[]) {
  for (const n of nodes) {
    map.set(n.nodeId, parentId);
    if (n.children) recordParentLinks(map, n.nodeId, n.children);
  }
}

function ancestorChain(parentMap: Map<number, number>, nodeId: number): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = nodeId;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = parentMap.get(cur);
  }
  return chain;
}

/** Mescla os filhos recém-buscados (`DOM.requestChildNodes`'s evento
 * `DOM.setChildNodes`) na árvore local, achando o node certo por
 * `nodeId` — substitui reconstruir a árvore inteira a cada expand.
 * `hasChildren` é recalculado pro valor REAL agora que os filhos
 * chegaram (corrige o caso em que `childNodeCount` bruto incluía só nós
 * de texto — ver doc comment de `cdpNodeToDomNode`). */
function mergeChildrenIntoTree(node: DomNode, parentId: number, newChildren: DomNode[]): DomNode {
  if (node.nodeId === parentId) return { ...node, children: newChildren, hasChildren: newChildren.length > 0 };
  if (node.children.length === 0) return node;
  return { ...node, children: node.children.map((c) => mergeChildrenIntoTree(c, parentId, newChildren)) };
}

function findNodeById(node: DomNode, nodeId: number): DomNode | null {
  if (node.nodeId === nodeId) return node;
  for (const child of node.children) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

/** `Overlay.highlightNode`/`Overlay.hideHighlight` substituem a injeção
 * de `<style id="stellar-highlight-style">` + atributo
 * `data-stellar-highlighted` — o overlay pinta FORA do DOM/CSSOM da
 * página (não é mais uma mutação observável por um `MutationObserver`
 * da própria página, estritamente melhor que antes). */
const HIGHLIGHT_CONFIG = {
  contentColor: { r: 255, g: 90, b: 95, a: 0.25 },
  contentOutlineColor: { r: 255, g: 90, b: 95, a: 0.9 },
};
function highlightNode(cardId: string, nodeId: number | null) {
  if (nodeId === null) {
    void window.browser.sendCdp(cardId, "Overlay.hideHighlight", {});
  } else {
    void window.browser.sendCdp(cardId, "Overlay.highlightNode", { highlightConfig: HIGHLIGHT_CONFIG, nodeId });
    void window.browser.sendCdp(cardId, "DOM.scrollIntoViewIfNeeded", { nodeId });
  }
}

/** DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 2) — troca a aproximação
 * de cascata por `document.styleSheets`+`el.matches()` (nunca foi
 * especificidade real, só uma ordem de varredura que dava certo na
 * maioria dos casos) por `CSS.getMatchedStylesForNode`/
 * `CSS.getComputedStyleForNode` — o motor de match/cascata de VERDADE do
 * Chrome, e todas as ~300 propriedades computadas de uma vez (sem
 * allowlist nenhuma — o teto antigo, `COMPUTED_PROPS`, só existia porque
 * o `evalJs` antigo precisava caber no round-trip JSON de
 * `MAX_EVAL_RESULT_CHARS`; CDP nunca passa por esse caminho). Não
 * depende mais da ponte `data-stellar-el-id` — `nodeId` do CDP já
 * identifica o elemento direto, sem round-trip por atributo HTML. */
type CdpCssProperty = { name: string; value: string; important?: boolean; disabled?: boolean };
type CdpMatchedRule = {
  rule: {
    selectorList: { selectors: { text: string }[] };
    origin: string;
    style: { cssProperties: CdpCssProperty[] };
    styleSheetId?: string;
  };
};

function cssPropsToDecls(props: CdpCssProperty[] | undefined): StyleDecl[] {
  if (!props) return [];
  return props.filter((p) => !p.disabled).map((p) => ({ prop: p.name, value: p.value, important: !!p.important }));
}

/** `styleSheetId` (interno da sessão CDP) → um rótulo legível, populado
 * pelo evento `CSS.styleSheetAdded` (dispara pra cada stylesheet já
 * carregada assim que `CSS.enable` roda no attach, e de novo pra cada
 * `<style>`/`<link>` novo depois). Sem URL (`<style>` inline) vira
 * "estilo interno", igual antes. */
function styleSheetLabel(labels: Map<string, string>, styleSheetId: string | undefined): string {
  if (!styleSheetId) return "estilo interno";
  return labels.get(styleSheetId) ?? "estilo interno";
}

async function fetchElementStyles(cardId: string, nodeId: number, styleSheetLabels: Map<string, string>): Promise<ElementStyles | null> {
  const [matchedRes, computedRes] = await Promise.all([
    window.browser.sendCdp(cardId, "CSS.getMatchedStylesForNode", { nodeId }),
    window.browser.sendCdp(cardId, "CSS.getComputedStyleForNode", { nodeId }),
  ]);
  if (!matchedRes.ok || !computedRes.ok) return null;
  const matchedResult = matchedRes.result as {
    inlineStyle?: { cssProperties: CdpCssProperty[] };
    matchedCSSRules?: CdpMatchedRule[];
  };
  const computedResult = computedRes.result as { computedStyle: { name: string; value: string }[] };

  const inline = cssPropsToDecls(matchedResult.inlineStyle?.cssProperties);
  // CDP devolve `matchedCSSRules` em ordem de aplicação (menos específica
  // primeiro); invertido pra mostrar a regra mais forte no topo — mesmo
  // idioma visual da aproximação antiga (que ordenava por "achada por
  // último" primeiro). Regras `origin:"user-agent"` (folha default do
  // navegador, ex. `display:block` de um `<div>`) ficam de fora, igual
  // antes (a versão evalJs só via `document.styleSheets`, nunca UA).
  const matched: MatchedRule[] = (matchedResult.matchedCSSRules ?? [])
    .filter((m) => m.rule.origin === "regular")
    .map((m) => ({
      selector: m.rule.selectorList.selectors.map((s) => s.text).join(", "),
      source: styleSheetLabel(styleSheetLabels, m.rule.styleSheetId),
      decls: cssPropsToDecls(m.rule.style.cssProperties),
    }))
    .reverse();

  const computed: StyleDecl[] = computedResult.computedStyle.map((c) => ({ prop: c.name, value: c.value, important: false }));
  const computedMap = new Map(computedResult.computedStyle.map((c) => [c.name, c.value] as const));
  function num(name: string): number {
    return Math.round(parseFloat(computedMap.get(name) ?? "0") || 0);
  }
  const box: BoxModel = {
    marginTop: num("margin-top"),
    marginRight: num("margin-right"),
    marginBottom: num("margin-bottom"),
    marginLeft: num("margin-left"),
    borderTop: num("border-top-width"),
    borderRight: num("border-right-width"),
    borderBottom: num("border-bottom-width"),
    borderLeft: num("border-left-width"),
    paddingTop: num("padding-top"),
    paddingRight: num("padding-right"),
    paddingBottom: num("padding-bottom"),
    paddingLeft: num("padding-left"),
    width: num("width"),
    height: num("height"),
  };
  return { inline, matched, computed, box };
}

/** DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 3) — a lacuna ABSOLUTA que
 * as fases anteriores não fechavam: sem CDP não existe jeito de
 * enumerar listeners registrados via `addEventListener` de FORA da
 * página depois do fato (só dava pra ver as propriedades IDL `on<evento>`
 * — cobria `onclick="..."` no atributo HTML e `el.onclick = fn`, mas
 * NUNCA `addEventListener`, a forma mais comum em código moderno,
 * inclusive todo framework como React). `DOMDebugger.getEventListeners`
 * resolve isso de verdade, mas pede um `objectId` (handle de objeto
 * remoto do Runtime), não um `nodeId` — bridge de duas chamadas:
 * `DOM.resolveNode({nodeId})` devolve `{object:{objectId}}`, então
 * `DOMDebugger.getEventListeners({objectId})` devolve os listeners reais
 * (tipo capturado é o `type` de cada entrada — "click", "keydown" etc.,
 * dedup por tipo já que o mesmo evento pode ter N handlers empilhados).
 * `Runtime.releaseObject` libera o handle remoto depois de ler — sem
 * isso cada seleção deixaria um objeto pendurado na página até a sessão
 * CDP inteira desanexar. */
async function fetchElementListeners(cardId: string, nodeId: number): Promise<ListenerEntry[] | null> {
  const resolved = await window.browser.sendCdp(cardId, "DOM.resolveNode", { nodeId });
  if (!resolved.ok) return null;
  const objectId = (resolved.result as { object?: { objectId?: string } }).object?.objectId;
  if (!objectId) return null;
  try {
    const listeners = await window.browser.sendCdp(cardId, "DOMDebugger.getEventListeners", { objectId });
    if (!listeners.ok) return null;
    const raw = (listeners.result as { listeners: { type: string }[] }).listeners;
    const seen = new Set<string>();
    const out: ListenerEntry[] = [];
    for (const l of raw) {
      if (seen.has(l.type)) continue;
      seen.add(l.type);
      out.push({ event: l.type });
    }
    return out;
  } finally {
    void window.browser.sendCdp(cardId, "Runtime.releaseObject", { objectId });
  }
}

// Aba Sources (DESIGN-BACKLOG.md §2.1 item 7) — só a LISTA de URLs vem
// via `evalJs` (payload pequeno, bem longe do teto de truncamento); o
// CONTEÚDO de cada arquivo vem depois via `window.browser.fetchSource`
// (main process, ver browser-registry.ts), não daqui.
const SOURCES_LIST_SCRIPT = `
(() => {
  const out = [{ url: location.href, kind: "document" }];
  const seen = new Set([location.href]);
  for (const s of document.scripts) {
    if (s.src && !seen.has(s.src)) { seen.add(s.src); out.push({ url: s.src, kind: "script" }); }
  }
  for (const sheet of document.styleSheets) {
    const href = sheet.href;
    if (href && !seen.has(href)) { seen.add(href); out.push({ url: href, kind: "stylesheet" }); }
  }
  return out;
})()
`;

async function evalJson<T>(id: string, js: string): Promise<T | null> {
  const res = await window.browser.evalJs(id, js);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.result) as T;
  } catch {
    return null;
  }
}


/** Nome curto pra mostrar na lista da aba Sources — a URL completa fica
 * no `title` (tooltip) do botão. `CodeEditor`'s `loadLanguage` também
 * usa este mesmo nome (via a prop `filename`) pra escolher o highlight
 * de sintaxe pela extensão, então precisa preservá-la. */
function sourceFilename(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split("/").filter(Boolean).pop();
    return last || url;
  } catch {
    return url;
  }
}

function ElementsTree({
  node,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  node: DomNode;
  selectedId: number | null;
  expanded: Set<number>;
  onToggle: (nodeId: number) => void;
  onSelect: (nodeId: number) => void;
}) {
  const isOpen = expanded.has(node.nodeId);
  // `node.hasChildren` (childNodeCount real do CDP), não `node.children.length`
  // — a árvore agora é lazy (`DOM.requestChildNodes` só no expand), então um
  // node ainda não expandido tem `children: []` mesmo tendo filhos de verdade.
  const hasChildren = node.hasChildren;
  const attrPreview = Object.entries(node.attrs)
    .slice(0, 3)
    .map(([k, v]) => ` ${k}="${v.length > 24 ? v.slice(0, 24) + "…" : v}"`)
    .join("");
  return (
    <div className={styles.treeNode}>
      <div
        className={styles.treeLine}
        data-role="inspector-tree-line"
        data-node-id={node.nodeId}
        data-tag={node.tag}
        data-selected={selectedId === node.nodeId || undefined}
        onClick={() => onSelect(node.nodeId)}
      >
        {hasChildren ? (
          <button
            className={styles.treeToggle}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.nodeId);
            }}
          >
            <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
          </button>
        ) : (
          <span className={styles.treeToggleSpacer} />
        )}
        <span className={styles.treeTag}>
          {"<"}
          {node.tag}
          <span className={styles.treeAttrs}>{attrPreview}</span>
          {">"}
        </span>
        {node.text && <span className={styles.treeText}>{node.text}</span>}
      </div>
      {hasChildren && isOpen && (
        <div className={styles.treeChildren}>
          {node.children.map((child) => (
            <ElementsTree
              key={child.nodeId}
              node={child}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeclRow({ d }: { d: StyleDecl }) {
  return (
    <div>
      <span className={styles.prop}>{d.prop}</span>
      <span className={styles.propval}>
        {d.value}
        {d.important ? " !important" : ""}
      </span>
    </div>
  );
}

function StylesPanel({ es }: { es: ElementStyles }) {
  return (
    <>
      <div className={styles.rule}>
        <div className={styles.ruleSelector}>element.style</div>
        {es.inline.length === 0 ? (
          <div className={styles.ruleEmpty}>— nenhum estilo inline —</div>
        ) : (
          <div className={styles.decl}>
            {es.inline.map((d) => (
              <DeclRow key={d.prop} d={d} />
            ))}
          </div>
        )}
      </div>
      {es.matched.map((rule, i) => (
        <div key={i} className={styles.rule} data-role="inspector-style-rule">
          <div className={styles.ruleSelector}>
            {rule.selector} <span className={styles.ruleSource}>{rule.source}</span>
          </div>
          <div className={styles.decl}>
            {rule.decls.map((d) => (
              <DeclRow key={d.prop} d={d} />
            ))}
          </div>
        </div>
      ))}
      {es.matched.length === 0 && <div className={styles.ruleEmpty}>Nenhuma regra de CSS externa corresponde a este elemento.</div>}
    </>
  );
}

function ComputedPanel({ es, filter, onFilterChange }: { es: ElementStyles; filter: string; onFilterChange: (v: string) => void }) {
  const needle = filter.trim().toLowerCase();
  const rows = es.computed.filter((d) => !needle || d.prop.includes(needle));
  return (
    <>
      <div className={styles.boxModel} data-role="inspector-box-model">
        <div className={styles.bmMargin}>
          <span className={styles.bmTag}>margin</span>
          <span className={`${styles.bmNum} ${styles.bmNumT}`}>{es.box.marginTop}</span>
          <span className={`${styles.bmNum} ${styles.bmNumR}`}>{es.box.marginRight}</span>
          <span className={`${styles.bmNum} ${styles.bmNumB}`}>{es.box.marginBottom}</span>
          <span className={`${styles.bmNum} ${styles.bmNumL}`}>{es.box.marginLeft}</span>
          <div className={styles.bmBorder}>
            <span className={styles.bmTag}>border</span>
            <span className={`${styles.bmNum} ${styles.bmNumT}`}>{es.box.borderTop}</span>
            <span className={`${styles.bmNum} ${styles.bmNumR}`}>{es.box.borderRight}</span>
            <span className={`${styles.bmNum} ${styles.bmNumB}`}>{es.box.borderBottom}</span>
            <span className={`${styles.bmNum} ${styles.bmNumL}`}>{es.box.borderLeft}</span>
            <div className={styles.bmPadding}>
              <span className={styles.bmTag}>padding</span>
              <span className={`${styles.bmNum} ${styles.bmNumT}`}>{es.box.paddingTop}</span>
              <span className={`${styles.bmNum} ${styles.bmNumR}`}>{es.box.paddingRight}</span>
              <span className={`${styles.bmNum} ${styles.bmNumB}`}>{es.box.paddingBottom}</span>
              <span className={`${styles.bmNum} ${styles.bmNumL}`}>{es.box.paddingLeft}</span>
              <div className={styles.bmContent} data-role="inspector-box-content">
                {es.box.width} × {es.box.height}
              </div>
            </div>
          </div>
        </div>
      </div>
      <input
        className={styles.computedFilter}
        data-role="inspector-computed-filter"
        placeholder="Filtrar propriedades…"
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
      />
      <div className={styles.decl} data-role="inspector-computed-list">
        {rows.map((d) => (
          <DeclRow key={d.prop} d={d} />
        ))}
        {rows.length === 0 && <div className={styles.ruleEmpty}>Nenhuma propriedade encontrada.</div>}
      </div>
    </>
  );
}

function ListenersPanel({ entries }: { entries: ListenerEntry[] }) {
  return (
    <>
      {entries.length === 0 ? (
        <div className={styles.ruleEmpty}>Nenhum handler desse tipo neste elemento.</div>
      ) : (
        <div className={styles.decl} data-role="inspector-listeners-list">
          {entries.map((e) => (
            <div key={e.event}>
              <span className={styles.prop}>{e.event}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function BrowserInspector({
  id,
  cardSize,
  initialFocusPoint,
  onEmulationChange,
  deviceToolbarOpen,
  onToggleDeviceToolbar,
  onClose,
}: {
  id: string;
  /** Tamanho de MUNDO atual do card (`rect.w`/`rect.h`) — usado só pra
   * restaurar o content size/zoom real (`resize()`) depois de desligar
   * um preset de emulação de dispositivo (ver `disableEmulation` abaixo). */
  cardSize: { w: number; h: number };
  /** Espaço de CONTEÚDO (mesmo de `toCanvasPoint`/`sendMouse`), não tela
   * real — vem direto do menu de contexto ("Inspecionar elemento"). */
  initialFocusPoint?: { x: number; y: number } | null;
  /** BrowserCard.tsx owns o `<canvas>`/coordenadas de clique — este é o
   * único jeito de avisá-lo do que está REALMENTE aplicado no webContents
   * agora (dims do dispositivo + zoom de exibição escolhido, `null` quando
   * desligado), pra ele desenhar o device-frame na proporção certa e
   * manter o mapeamento de clique correto (ver o doc comment de
   * `handleEmulationChange` em BrowserCard.tsx). */
  onEmulationChange?: (dims: { width: number; height: number; zoom: "fit" | "1" | "0.75" | "0.5"; deviceScaleFactor: number } | null) => void;
  /** DESIGN-BACKLOG.md §2.1 item 4 — decisão do usuário (revista ao vivo
   * em 2026-09-07: o botão morava no address bar de BrowserCard.tsx;
   * pedido explícito de mover a ferramenta de device-frame pra DENTRO do
   * inspector, como um ícone na barra de abas). O ESTADO continua morando
   * em BrowserCard.tsx (sobrevive o inspector fechar/reabrir), só o botão
   * que troca ele mudou de lugar — por isso o valor chega como prop
   * (`deviceToolbarOpen`) e a mudança sai por callback
   * (`onToggleDeviceToolbar`), mesmo padrão de `onEmulationChange` acima. */
  deviceToolbarOpen: boolean;
  onToggleDeviceToolbar: () => void;
  onClose: () => void;
}) {
  // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 0) — attach/detach seguem
  // o mount/unmount deste componente (não a criação/destruição do card),
  // restringindo o custo de uma sessão CDP ao caso raro (inspector
  // aberto) em vez do caso comum (qualquer card aberto). `cdpAttachResult`
  // começa `null` (ainda não resolveu) — `!ok` dispara o banner de erro
  // (causa mais provável: DevTools real já aberto pra este card).
  const [cdpAttachResult, setCdpAttachResult] = useState<Awaited<ReturnType<typeof window.browser.attachInspector>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.browser.attachInspector(id).then((res) => {
      if (!cancelled) setCdpAttachResult(res);
    });
    return () => {
      cancelled = true;
      void window.browser.detachInspector(id);
    };
  }, [id]);

  // `parentMap` (nodeId → parentId) reconstrói a cadeia de ancestrais de
  // um node achado por localização sem mais uma chamada CDP — ver doc
  // comment de `recordParentLinks`/`ancestorChain` acima. `requestedChildren`
  // evita re-pedir `DOM.requestChildNodes` pro mesmo node enquanto o
  // evento `DOM.setChildNodes` ainda não voltou.
  const parentMapRef = useRef<Map<number, number>>(new Map());
  const requestedChildrenRef = useRef<Set<number>>(new Set());

  // `styleSheetId` (CSS domain) → rótulo legível pro painel Styles — ver
  // doc comment de `styleSheetLabel` acima. Populado pelo evento
  // `CSS.styleSheetAdded` (Fase 2, adoção de CDP), capturado pelo mesmo
  // dispatcher genérico de `onCdpEvent` abaixo.
  const styleSheetLabelsRef = useRef<Map<string, string>>(new Map());

  // Desconexão inesperada no meio do caminho (ex: outra coisa forçou
  // attach por fora) chega como o evento sintético "__detached__" de
  // browser-cdp.ts, pelo MESMO canal genérico que toda fase futura vai
  // usar (`onCdpEvent`, um só, sem canal por domínio — CDP já se
  // autodescreve pelo `method`). `DOM.setChildNodes` (Fase 1, adoção de
  // CDP) é a resposta assíncrona de `DOM.requestChildNodes` — o comando
  // em si não devolve nada útil, os filhos chegam por ESTE evento.
  useEffect(() => {
    const off = window.browser.onCdpEvent((eventId, method, params) => {
      if (eventId !== id) return;
      if (method === "__detached__") {
        const reason = (params as { reason?: string })?.reason;
        setCdpAttachResult({ ok: false, error: `Sessão de depuração desanexada${reason ? ` (${reason})` : ""}.` });
        return;
      }
      if (method === "DOM.setChildNodes") {
        const { parentId, nodes } = params as { parentId: number; nodes: CdpRawNode[] };
        recordParentLinks(parentMapRef.current, parentId, nodes);
        const converted = nodes.filter((n) => n.nodeType === 1).map(cdpNodeToDomNode);
        setTree((prev) => (prev ? mergeChildrenIntoTree(prev, parentId, converted) : prev));
        return;
      }
      if (method === "CSS.styleSheetAdded") {
        const header = (params as { header: { styleSheetId: string; sourceURL: string } }).header;
        let label = "estilo interno";
        if (header.sourceURL) {
          try {
            label = new URL(header.sourceURL).pathname.split("/").pop() || header.sourceURL;
          } catch {
            label = header.sourceURL;
          }
        }
        styleSheetLabelsRef.current.set(header.styleSheetId, label);
        return;
      }
      // Fase 4 (adoção de CDP) — push ao vivo da aba Network, um evento
      // por etapa do ciclo de vida do request (o mesmo request cruza os 4
      // eventos por `requestId`, nunca chega pronto de uma vez só).
      if (method === "Network.requestWillBeSent") {
        const p = params as {
          requestId: string;
          request: { url: string; method: string; headers: Record<string, string> };
          wallTime: number;
          timestamp: number;
          initiator?: { type?: string };
        };
        setNetworkEntries((prev) => [
          ...prev.slice(-499),
          {
            requestId: p.requestId,
            method: p.request.method,
            url: p.request.url,
            status: null,
            requestHeaders: p.request.headers,
            responseHeaders: {},
            initiatorType: p.initiator?.type,
            at: p.wallTime * 1000,
            startedMonotonic: p.timestamp,
          },
        ]);
        return;
      }
      if (method === "Network.responseReceived") {
        const p = params as { requestId: string; response: { status: number; statusText: string; headers: Record<string, string>; mimeType: string } };
        setNetworkEntries((prev) =>
          prev.map((e) =>
            e.requestId === p.requestId
              ? { ...e, status: p.response.status, statusText: p.response.statusText, responseHeaders: p.response.headers, mimeType: p.response.mimeType }
              : e,
          ),
        );
        return;
      }
      if (method === "Network.loadingFinished") {
        const p = params as { requestId: string; timestamp: number };
        setNetworkEntries((prev) => prev.map((e) => (e.requestId === p.requestId ? { ...e, durationMs: (p.timestamp - e.startedMonotonic) * 1000 } : e)));
        return;
      }
      if (method === "Network.loadingFailed") {
        const p = params as { requestId: string; timestamp: number; errorText: string; canceled?: boolean };
        setNetworkEntries((prev) =>
          prev.map((e) =>
            e.requestId === p.requestId ? { ...e, error: p.canceled ? "cancelado" : p.errorText, durationMs: (p.timestamp - e.startedMonotonic) * 1000 } : e,
          ),
        );
        return;
      }
      // Fase 6 (adoção de CDP) — `Debugger.paused` chega quando um
      // breakpoint real é atingido (o único jeito de pausar era esperar
      // isso acontecer; sem step-into/over/out, `resumed` é o único jeito
      // de continuar, via `resumeDebugger` abaixo).
      if (method === "Debugger.paused") {
        setDebuggerPaused(true);
        return;
      }
      if (method === "Debugger.resumed") {
        setDebuggerPaused(false);
      }
    });
    return () => {
      off();
    };
  }, [id]);

  function retryCdpAttach() {
    void window.browser.attachInspector(id).then(setCdpAttachResult);
  }

  const [tab, setTab] = useState<Tab>("elements");
  const [tree, setTree] = useState<DomNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [detailsSubtab, setDetailsSubtab] = useState<DetailsSubtab>("styles");
  const [elementStyles, setElementStyles] = useState<ElementStyles | null>(null);
  const [loadingStyles, setLoadingStyles] = useState(false);
  const [elementListeners, setElementListeners] = useState<ListenerEntry[] | null>(null);
  const [loadingListeners, setLoadingListeners] = useState(false);
  const [computedFilter, setComputedFilter] = useState("");
  const [consoleEntries, setConsoleEntries] = useState<ConsoleLine[]>([]);
  const [consoleInput, setConsoleInput] = useState("");
  const [activeEmulation, setActiveEmulation] = useState<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean; label: string } | null>(
    null,
  );
  const [customW, setCustomW] = useState(390);
  const [customH, setCustomH] = useState(844);
  // Zoom de EXIBIÇÃO do device-frame (não muda a resolução real do
  // dispositivo emulado, só como ele é mostrado no canvas — "Ajustar" é o
  // padrão, contido no espaço disponível sem cortar; ver o CSS de
  // `.browserCardBodyWrap[data-emulating]` em BrowserCard.module.css).
  const [frameZoom, setFrameZoom] = useState<"fit" | "1" | "0.75" | "0.5">("fit");
  const focusPointRef = useRef(initialFocusPoint);

  // Coluna dockável — `dock` decide o LADO; `panelSize` é width (right/
  // left) ou height (bottom), em px reais, ajustável pela alça de
  // arraste (ver `onResizePointerMove` abaixo). Guardados juntos num
  // objeto por `dock` pra trocar de lado sem perder o tamanho que o
  // usuário já tinha ajustado no outro.
  const [dock, setDock] = useState<Dock>("right");
  const [panelSizes, setPanelSizes] = useState<Record<Dock, number>>({ ...DOCK_DEFAULT });
  const resizingRef = useRef<{ dock: Dock; start: number; startSize: number } | null>(null);

  // Alças de resize DIRETO nas bordas do device-frame (DESIGN-BACKLOG.md
  // §2.1 item 3, sub-item pendente — o usuário relatou ao vivo: "não
  // consegue nem mexer com a altura do content se mexer na altura do
  // card inteiro", confirmando que resize por arraste do FRAME em si
  // (não só do card/dock) faz falta). `.inspector` (o próprio painel do
  // dock) é filho direto de `.browserCardBodyWrap` — o MESMO
  // `position:relative` que já contém o `<canvas>` (ver BrowserCard.tsx)
  // — então basta um ref no root deste componente pra achar o wrap via
  // `.parentElement` e ler a caixa real do canvas dentro dele, sem
  // precisar de nenhuma prop nova vinda de BrowserCard.tsx. `frameBox`
  // (abaixo) lê `getBoundingClientRect()` do PRÓPRIO `<canvas>` — não
  // reimplementa o cálculo de "contido" (`aspect-ratio`+`max-width/
  // height:100%`+`margin:auto`) que o CSS já faz sozinho. Antes disto
  // (achado ao vivo, screenshot do usuário: "as linhas do frame ficam
  // fora do content") esta era uma SEGUNDA implementação independente da
  // mesma matemática de layout — podia divergir (visivelmente um frame
  // atrás durante resize rápido, e ficou de fato errada quando
  // BrowserCard.tsx reservava espaço do dock via `padding`, removido no
  // refactor overlay→reflow). Lendo a caixa REAL do canvas, as alças
  // acompanham qualquer resize (card, dock, o que for) por construção,
  // sem chance de divergir.
  const inspectorRootRef = useRef<HTMLDivElement>(null);
  // Achado ao vivo (2026-09-07, screenshot do usuário: alças "presas",
  // bem longe da borda real do frame depois de zoomar o BOARD, não o
  // device toolbar): `frameBox` guardava `left/top/width/height` em
  // pixels de TELA (`getBoundingClientRect()`, pós-transform), aplicados
  // depois como estilo inline DENTRO do mesmo `.card-frame` que já leva
  // `transform: scale(zoom)` (CardFrame.tsx) — um valor em px de tela
  // capturado num zoom vira ERRADO assim que o zoom muda (a alça
  // acabava escalada DUAS vezes: uma vez already-baked no px capturado,
  // outra pelo próprio `transform` do ancestral) porque nada nesta
  // medição reage a mudança de zoom do board (zoom é só um `transform`
  // do ancestral, não muda o box LOCAL do canvas que o `ResizeObserver`
  // observa — então nunca disparava de novo). Fix: guarda FRAÇÕES
  // (0–1) do próprio `wrap` (`.browserCardBodyWrap`, o mesmo elemento
  // `position:relative` que `.frameResizeOverlay` usa como containing
  // block) em vez de pixels absolutos — a proporção entre canvas e wrap
  // é invariante a qualquer escala UNIFORME de um ancestral comum
  // (cancela exatamente, canvas e wrap escalam pelo MESMO fator), então
  // convertida de volta pra `%` no JSX abaixo ela funciona em QUALQUER
  // zoom de board sem precisar depender dele nas deps do efeito.
  const [frameBox, setFrameBox] = useState<{ leftPct: number; topPct: number; widthPct: number; heightPct: number } | null>(null);
  const frameCanvasElRef = useRef<HTMLElement | null>(null);
  const frameResizeRef = useRef<{ axis: "right" | "bottom" | "corner"; startX: number; startY: number; startW: number; startH: number; scaleX: number; scaleY: number } | null>(null);

  const [storageArea, setStorageArea] = useState<StorageArea>("local");
  const [localItems, setLocalItems] = useState<[string, string][]>([]);
  const [sessionItems, setSessionItems] = useState<[string, string][]>([]);
  const [cookieItems, setCookieItems] = useState<
    { name: string; value: string; domain: string; path: string; expirationDate?: number; httpOnly: boolean; secure: boolean; sameSite: string }[]
  >([]);
  const [loadingStorage, setLoadingStorage] = useState(false);

  // Aba Network (DESIGN-BACKLOG.md §2.1, adoção de CDP, Fase 4) — o
  // domínio `Network` fica de fora de `EAGER_DOMAINS` (browser-cdp.ts) de
  // propósito: só ele tem custo real de buffering (bodies de resposta
  // ficam retidos em memória enquanto o request "vivo" na sessão), então
  // só habilita (`Network.enable`, um comando CDP comum como outro
  // qualquer — `sendCdp` genérico, sem precisar de método dedicado) na
  // PRIMEIRA vez que esta aba abre, não no attach do inspector inteiro.
  // Push ao vivo via `requestWillBeSent`/`responseReceived`/
  // `loadingFinished`/`loadingFailed` (capturados no dispatcher genérico
  // de `onCdpEvent`) substitui o polling antigo de `getNetwork` SÓ pra
  // esta aba — `ensureNetworkTap`/`NETWORK_BUFFER` (browser-registry.ts)
  // continuam intocados, servindo a tool MCP `getNetwork` e o resumo da
  // aba Performance (`refreshProcessStats` abaixo), que não precisam de
  // headers/body/timing reais.
  const [networkEntries, setNetworkEntries] = useState<NetworkEntry[]>([]);
  const [networkOnlyFailed, setNetworkOnlyFailed] = useState(false);
  const [expandedNetworkId, setExpandedNetworkId] = useState<string | null>(null);
  const [networkBodies, setNetworkBodies] = useState<Record<string, { content: string; base64Encoded: boolean } | { error: string }>>({});
  const networkEnabledRef = useRef(false);

  // Aba Sources (DESIGN-BACKLOG.md §2.1 item 7) — árvore read-only de
  // scripts/stylesheets/documento principal + visualizador de código.
  // Nova aba do ZERO (não existia nada disto antes), por isso o estado é
  // mais verboso que os outros: lista (leve, `evalJs`) + conteúdo do
  // arquivo selecionado (pesado, `fetchSource` no main process — ver o
  // doc comment dela em browser-registry.ts).
  const [sourceList, setSourceList] = useState<SourceEntry[]>([]);
  const [loadingSourceList, setLoadingSourceList] = useState(false);
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState<{ content: string; truncated: boolean; totalChars: number } | { error: string } | null>(null);
  const [loadingSourceContent, setLoadingSourceContent] = useState(false);
  // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 6) — breakpoints reais
  // via `Debugger.setBreakpointByUrl`/`removeBreakpoint`. `Debugger.enable`
  // só liga na 1ª tentativa de toggle (não no attach do inspector
  // inteiro), mesmo padrão de `Network.enable` na Fase 4. Só faz sentido
  // em `kind:"script"` (arquivo JS de verdade) — `SOURCES_LIST_SCRIPT`
  // só lista scripts EXTERNOS (`s.src`), então todo item `script` tem uma
  // URL real que `setBreakpointByUrl` consegue casar.
  const [breakpointsByUrl, setBreakpointsByUrl] = useState<Record<string, { breakpointId: string; lineNumber: number }[]>>({});
  const [debuggerPaused, setDebuggerPaused] = useState(false);
  const debuggerEnabledRef = useRef(false);

  // Aba Performance (DESIGN-BACKLOG.md §2.1 item 8) — FPS ao vivo é
  // medido inteiro no renderer (`window.browser.onFrame`, o MESMO evento
  // que BrowserCard.tsx já escuta pra desenhar — múltiplos listeners no
  // mesmo `ipcRenderer.on` convivem sem conflito nenhum), não precisa de
  // instrumentação nova no main process. `frameTimestampsRef` acumula
  // chegadas SEM disparar re-render a cada frame (até 60/s) — um
  // `setInterval` de 1s lê o acumulado, calcula o fps daquele segundo e
  // alimenta a "timeline" (janela deslizante, pro pequeno gráfico de
  // barras). CPU/memória do processo (`getProcessStats`) já não dá pra
  // medir aqui — exige `app.getAppMetrics()` no main process de verdade.
  const frameTimestampsRef = useRef<number[]>([]);
  const [liveFps, setLiveFps] = useState<number | null>(null);
  const [fpsTimeline, setFpsTimeline] = useState<number[]>([]);
  const [totalFrames, setTotalFrames] = useState(0);
  const [processStats, setProcessStats] = useState<{ cpuPercent: number; memoryMB: number } | { error: string } | null>(null);
  const [loadingProcessStats, setLoadingProcessStats] = useState(false);
  // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 5) — profiling de CPU
  // REAL via `Profiler.start`/`stop` (domínio `Profiler`, fora de
  // `EAGER_DOMAINS`, habilitado sob demanda no 1º "Iniciar profiling").
  // Escopo explícito e reduzido, mesmo espírito de corte de escopo já
  // usado nas alças de resize: só sampling de CPU, sem o domínio
  // `Tracing` completo (timeline isolada de script/layout/paint exigiria
  // buffering de trace-events + parsing do formato Chrome trace,
  // desproporcional pro que uma view de hotspots de CPU precisa). O
  // resultado (`Profiler.stop`'s `profile.nodes`, cada um com
  // `hitCount` = quantas amostras do sampler caíram nessa função) vira
  // uma lista dos hotspots reais por contagem de amostra — não um flame
  // graph completo, mas dado 100% real do V8, não decorativo.
  const [profiling, setProfiling] = useState(false);
  const [profileResult, setProfileResult] = useState<{ hotspots: ProfileHotspot[]; totalHitCount: number; durationMs: number } | { error: string } | null>(
    null,
  );
  const profilerEnabledRef = useRef(false);
  const profilingRef = useRef(false);
  // Contagem pro grid de estatísticas — busca própria, independente de
  // `networkRows`/`consoleEntries` das outras abas (Performance pode ser
  // a PRIMEIRA aba aberta, sem ninguém ter visitado Network ainda).
  const [perfNetworkSummary, setPerfNetworkSummary] = useState<{ total: number; failed: number } | null>(null);

  // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 1) — `depth: 2` alcança
  // document → html → head/body (um nível a mais que o mínimo, só pra
  // abrir já mostrando `<html>` com filhos imediatos expansíveis em vez
  // de nascer com uma única linha fechada). Qualquer coisa além disso é
  // sempre lazy via `DOM.requestChildNodes` no expand (`toggleNode`).
  async function refreshTree() {
    setLoadingTree(true);
    parentMapRef.current = new Map();
    requestedChildrenRef.current = new Set();
    const doc = await window.browser.sendCdp(id, "DOM.getDocument", { depth: 2, pierce: false });
    if (!doc.ok) {
      setTree(null);
      setLoadingTree(false);
      return;
    }
    const docRoot = (doc.result as { root: CdpRawNode }).root;
    const htmlRaw = docRoot.children?.find((c) => c.nodeType === 1) ?? null;
    if (!htmlRaw) {
      setTree(null);
      setLoadingTree(false);
      return;
    }
    recordParentLinks(parentMapRef.current, docRoot.nodeId, [htmlRaw]);
    const root = cdpNodeToDomNode(htmlRaw);
    setTree(root);
    setLoadingTree(false);

    // "Inspecionar elemento" (clique com botão direito, antes do
    // inspector abrir) — `DOM.getNodeForLocation` acha o elemento sob o
    // ponto, `DOM.pushNodeByBackendIdToFrontend` garante que ele (e toda
    // a cadeia de ancestrais, via o cascade de eventos `DOM.setChildNodes`
    // que o próprio Chrome dispara pra revelar um node "empurrado")
    // ganhe um `nodeId` usável nesta sessão.
    const point = focusPointRef.current;
    focusPointRef.current = null;
    if (point) {
      const loc = await window.browser.sendCdp(id, "DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y) });
      const backendNodeId = loc.ok ? (loc.result as { backendNodeId?: number }).backendNodeId : undefined;
      if (backendNodeId !== undefined) {
        const pushed = await window.browser.sendCdp(id, "DOM.pushNodeByBackendIdToFrontend", { backendNodeId });
        const targetNodeId = pushed.ok ? (pushed.result as { nodeId?: number }).nodeId : undefined;
        if (targetNodeId !== undefined) {
          setExpanded((prev) => new Set([...prev, ...ancestorChain(parentMapRef.current, targetNodeId)]));
          selectNode(targetNodeId);
          return;
        }
      }
    }
    // Sem alvo específico — abre pelo menos a raiz, senão a árvore
    // inteira nasce fechada e parece vazia.
    setExpanded((prev) => (prev.size > 0 ? prev : new Set([root.nodeId])));
  }

  useEffect(() => {
    // Só busca a árvore depois que a sessão CDP anexar de verdade — sem
    // isso `sendCdp` falharia limpo (ok:false) numa corrida com o efeito
    // de attach acima (os dois disparam no mesmo mount, mas attach é
    // assíncrono). Reexecuta a cada novo attach bem-sucedido (inclusive
    // um retry manual do banner de erro).
    if (!cdpAttachResult?.ok) return;
    void refreshTree();
    return () => {
      highlightNode(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cdpAttachResult]);

  useEffect(() => {
    void window.browser.getConsole(id).then((res) => {
      if (res.ok) setConsoleEntries(res.messages);
    });
    const off = window.browser.onConsoleMessage((msgId, level, message) => {
      if (msgId !== id) return;
      setConsoleEntries((prev) => [...prev.slice(-299), { level, message, at: Date.now() }]);
    });
    return () => {
      off();
    };
  }, [id]);

  async function refreshStorage() {
    setLoadingStorage(true);
    const [storageRes, cookiesRes] = await Promise.all([window.browser.getLocalSessionStorage(id), window.browser.getCookies(id)]);
    if (storageRes.ok) {
      setLocalItems(storageRes.local);
      setSessionItems(storageRes.session);
    }
    if (cookiesRes.ok) setCookieItems(cookiesRes.cookies);
    setLoadingStorage(false);
  }

  useEffect(() => {
    if (tab === "application") void refreshStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  useEffect(() => {
    if (tab !== "network" || networkEnabledRef.current) return;
    networkEnabledRef.current = true;
    void window.browser.sendCdp(id, "Network.enable", {});
  }, [tab, id]);

  async function fetchNetworkBody(requestId: string) {
    const res = await window.browser.sendCdp(id, "Network.getResponseBody", { requestId });
    if (!res.ok) {
      setNetworkBodies((prev) => ({ ...prev, [requestId]: { error: res.error } }));
      return;
    }
    const { body, base64Encoded } = res.result as { body: string; base64Encoded: boolean };
    setNetworkBodies((prev) => ({ ...prev, [requestId]: { content: body, base64Encoded } }));
  }

  function toggleNetworkRow(requestId: string) {
    setExpandedNetworkId((prev) => {
      const next = prev === requestId ? null : requestId;
      if (next && !(next in networkBodies)) void fetchNetworkBody(next);
      return next;
    });
  }

  async function refreshSources() {
    setLoadingSourceList(true);
    const list = await evalJson<SourceEntry[]>(id, SOURCES_LIST_SCRIPT);
    setSourceList(list ?? []);
    setLoadingSourceList(false);
  }

  useEffect(() => {
    if (tab === "sources") void refreshSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  // Busca o conteúdo do arquivo selecionado — `fetchSource` roda no main
  // process (session.fetch, sem CORS, sem o teto de 20k chars do
  // `evalJs`), ver o doc comment dela em browser-registry.ts.
  useEffect(() => {
    if (!selectedSourceUrl) {
      setSourceContent(null);
      return;
    }
    let cancelled = false;
    setLoadingSourceContent(true);
    void window.browser.fetchSource(id, selectedSourceUrl).then((res) => {
      if (cancelled) return;
      setSourceContent(res.ok ? { content: res.content, truncated: res.truncated, totalChars: res.totalChars } : { error: res.error });
      setLoadingSourceContent(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id, selectedSourceUrl]);

  async function toggleBreakpoint(url: string, lineNumber: number) {
    if (!debuggerEnabledRef.current) {
      const enableRes = await window.browser.sendCdp(id, "Debugger.enable", {});
      if (!enableRes.ok) return;
      debuggerEnabledRef.current = true;
    }
    const existing = (breakpointsByUrl[url] ?? []).find((b) => b.lineNumber === lineNumber);
    if (existing) {
      await window.browser.sendCdp(id, "Debugger.removeBreakpoint", { breakpointId: existing.breakpointId });
      setBreakpointsByUrl((prev) => ({ ...prev, [url]: (prev[url] ?? []).filter((b) => b.lineNumber !== lineNumber) }));
      return;
    }
    // CDP é 0-indexed; a UI (CodeEditor's gutter, `jumpToLine` etc.) é
    // 1-indexed em todo lugar — converte só na fronteira com o protocolo.
    const res = await window.browser.sendCdp(id, "Debugger.setBreakpointByUrl", { lineNumber: lineNumber - 1, url });
    if (!res.ok) return;
    const { breakpointId } = res.result as { breakpointId: string };
    setBreakpointsByUrl((prev) => ({ ...prev, [url]: [...(prev[url] ?? []), { breakpointId, lineNumber }] }));
  }

  function resumeDebugger() {
    void window.browser.sendCdp(id, "Debugger.resume", {});
  }

  async function refreshProcessStats() {
    setLoadingProcessStats(true);
    const [statsRes, networkRes] = await Promise.all([window.browser.getProcessStats(id), window.browser.getNetwork(id)]);
    setProcessStats(statsRes.ok ? { cpuPercent: statsRes.cpuPercent, memoryMB: statsRes.memoryMB } : { error: statsRes.error });
    if (networkRes.ok) {
      setPerfNetworkSummary({
        total: networkRes.requests.length,
        failed: networkRes.requests.filter((r) => r.error !== undefined || r.status === null || r.status >= 400).length,
      });
    }
    setLoadingProcessStats(false);
  }

  useEffect(() => {
    if (tab === "performance") void refreshProcessStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  async function startProfiling() {
    if (!profilerEnabledRef.current) {
      const enableRes = await window.browser.sendCdp(id, "Profiler.enable", {});
      if (!enableRes.ok) {
        setProfileResult({ error: enableRes.error });
        return;
      }
      profilerEnabledRef.current = true;
    }
    setProfileResult(null);
    const res = await window.browser.sendCdp(id, "Profiler.start", {});
    if (!res.ok) {
      setProfileResult({ error: res.error });
      return;
    }
    profilingRef.current = true;
    setProfiling(true);
  }

  async function stopProfiling() {
    const res = await window.browser.sendCdp(id, "Profiler.stop", {});
    profilingRef.current = false;
    setProfiling(false);
    if (!res.ok) {
      setProfileResult({ error: res.error });
      return;
    }
    const profile = (res.result as { profile: { nodes: CdpProfileNode[]; startTime: number; endTime: number } }).profile;
    const totalHitCount = profile.nodes.reduce((sum, n) => sum + (n.hitCount ?? 0), 0);
    const hotspots: ProfileHotspot[] = profile.nodes
      .filter((n) => (n.hitCount ?? 0) > 0)
      .map((n) => ({
        functionName: n.callFrame.functionName || "(anônima)",
        url: n.callFrame.url,
        lineNumber: n.callFrame.lineNumber,
        hitCount: n.hitCount ?? 0,
        selfPercent: totalHitCount > 0 ? ((n.hitCount ?? 0) / totalHitCount) * 100 : 0,
      }))
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 15);
    setProfileResult({ hotspots, totalHitCount, durationMs: (profile.endTime - profile.startTime) / 1000 });
  }

  useEffect(() => {
    // Sessão CDP desanexando (fecha o inspector, ou conflito com DevTools
    // real) com profiling ativo não deveria deixar o `Profiler` do V8
    // rodando pra sempre na página — mesmo cuidado de `Runtime.releaseObject`
    // na Fase 3. `Profiler.stop` sem sessão anexada falha limpo (`sendCdp`
    // já guarda isso), então chamar sem checar de novo é seguro.
    return () => {
      if (profilingRef.current) void window.browser.sendCdp(id, "Profiler.stop", {});
    };
  }, [id]);

  useEffect(() => {
    if (tab !== "performance") return;
    frameTimestampsRef.current = [];
    let totalCount = 0;
    setLiveFps(null);
    setFpsTimeline([]);
    setTotalFrames(0);
    const offFrame = window.browser.onFrame((frameId) => {
      if (frameId !== id) return;
      frameTimestampsRef.current.push(Date.now());
      totalCount++;
    });
    // A cada 1s: quantos frames chegaram no ÚLTIMO segundo (fps daquele
    // segundo) — `filter` (não um contador zerado a cada tick) porque um
    // frame pode chegar bem no limiar entre dois ticks; contar só o que
    // está DENTRO da janela de 1000ms é mais estável que um contador que
    // reseta exatamente no tick. `totalCount` é um contador monotônico
    // separado, incrementado uma vez por frame de verdade — nunca deriva
    // do array filtrado (que reconta o mesmo frame em ticks vizinhos).
    const interval = window.setInterval(() => {
      const now = Date.now();
      frameTimestampsRef.current = frameTimestampsRef.current.filter((t) => now - t <= 1000);
      setLiveFps(frameTimestampsRef.current.length);
      setTotalFrames(totalCount);
      setFpsTimeline((prev) => [...prev.slice(-29), frameTimestampsRef.current.length]);
    }, 1000);
    return () => {
      offFrame();
      window.clearInterval(interval);
    };
  }, [tab, id]);

  // Painel de detalhes (Styles/Computed) — refaz a busca sempre que a
  // seleção mudar. `nodeId` é o próprio identificador CDP da seleção
  // (Fase 1) — `CSS.getMatchedStylesForNode`/`getComputedStyleForNode`
  // falham limpo (`ok:false`) se o node não existir mais na sessão atual
  // (ex: depois de um `refreshTree()`, que reatribui `nodeId`s), e a UI
  // mostra um estado vazio em vez de dado velho/quebrado.
  useEffect(() => {
    if (tab !== "elements" || !selectedId) {
      setElementStyles(null);
      return;
    }
    let cancelled = false;
    setLoadingStyles(true);
    void fetchElementStyles(id, selectedId, styleSheetLabelsRef.current).then((res) => {
      if (cancelled) return;
      setElementStyles(res);
      setLoadingStyles(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, id, selectedId]);

  // Mesma ideia do efeito de Styles/Computed acima, mas pra Event
  // Listeners — busca separada (`fetchElementListeners`, bridge
  // `DOM.resolveNode`+`DOMDebugger.getEventListeners`) porque é um
  // domínio CDP independente do `CSS` usado por Styles/Computed.
  useEffect(() => {
    if (tab !== "elements" || !selectedId) {
      setElementListeners(null);
      return;
    }
    let cancelled = false;
    setLoadingListeners(true);
    void fetchElementListeners(id, selectedId).then((res) => {
      if (cancelled) return;
      setElementListeners(res);
      setLoadingListeners(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, id, selectedId]);

  async function deleteStorageRow(key: string) {
    if (storageArea === "cookies") return; // cookies são só-leitura por ora (ver doc comment da tabela abaixo)
    await window.browser.deleteLocalSessionItem(id, storageArea, key);
    void refreshStorage();
  }

  function selectNode(nodeId: number) {
    setSelectedId(nodeId);
    highlightNode(id, nodeId);
  }

  function toggleNode(nodeId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
        return next;
      }
      next.add(nodeId);
      // Lazy-load: só pede filhos se ainda não vieram (evita re-pedir
      // toda vez que o usuário fecha/reabre o mesmo node já carregado).
      if (tree && !requestedChildrenRef.current.has(nodeId)) {
        const node = findNodeById(tree, nodeId);
        if (node && node.hasChildren && node.children.length === 0) {
          requestedChildrenRef.current.add(nodeId);
          void window.browser.sendCdp(id, "DOM.requestChildNodes", { nodeId, depth: 1 });
        }
      }
      return next;
    });
  }

  async function runConsoleInput() {
    const js = consoleInput.trim();
    if (!js) return;
    setConsoleInput("");
    setConsoleEntries((prev) => [...prev.slice(-299), { level: "input", message: js, at: Date.now() }]);
    const res = await window.browser.evalJs(id, js);
    setConsoleEntries((prev) => [
      ...prev.slice(-299),
      res.ok
        ? { level: "result", message: res.result, at: Date.now() }
        : { level: "error", message: res.error, at: Date.now() },
    ]);
  }

  // browser-registry.ts's `setDeviceEmulation(id, null)` deliberadamente
  // NÃO restaura o content size/zoom do supersample sozinho (não sabe o
  // tamanho atual do card) — chamar `resize()` de novo com o tamanho real
  // (`cardSize`, prop vinda de BrowserCard.tsx) recalcula os dois juntos,
  // exatamente como um resize manual real já faz.
  function disableEmulation() {
    void window.browser.setDeviceEmulation(id, null);
    void window.browser.resize(id, cardSize.w, cardSize.h);
  }

  // Único funil por onde QUALQUER caminho de mudança de tamanho passa
  // (presets, tamanho personalizado, ruler, girar, DPR) — clampar aqui,
  // não em cada chamador, garante o mesmo limite [FRAME_DIM_MIN,
  // FRAME_DIM_MAX] em todos eles de uma vez só. Antes, só o ARRASTE das
  // alças respeitava esse limite (`onFrameResizePointerMove`); os campos
  // numéricos de tamanho personalizado não tinham `min`/`max` nenhum —
  // digitar "5" ou "99999" e clicar "Aplicar" não era clampado.
  function applyEmulation(width: number, height: number, deviceScaleFactor: number, mobile: boolean, label: string) {
    const clampedWidth = clampFrameDim(width);
    const clampedHeight = clampFrameDim(height);
    setActiveEmulation({ width: clampedWidth, height: clampedHeight, deviceScaleFactor, mobile, label });
    setCustomW(clampedWidth);
    setCustomH(clampedHeight);
    void window.browser.setDeviceEmulation(id, { width: clampedWidth, height: clampedHeight, deviceScaleFactor, mobile });
  }

  function applyCustomSize() {
    applyEmulation(customW, customH, activeEmulation?.deviceScaleFactor ?? 2, customW < 768, `${customW}×${customH} (personalizado)`);
  }

  function pickRulerWidth(w: number) {
    setCustomW(w);
    applyEmulation(w, activeEmulation?.height ?? customH, activeEmulation?.deviceScaleFactor ?? 2, w < 768, `${w}×${activeEmulation?.height ?? customH} (personalizado)`);
  }

  // Pedido direto do usuário (com screenshot do device toolbar real do
  // Chrome): a barra de dispositivo/responsividade não deveria ser uma
  // ABA que precisa de clique pra aparecer — no DevTools real ela fica
  // sempre visível, acima das outras abas, direto no card. `deviceSelectValue`
  // deriva do `activeEmulation` atual em vez de guardar estado próprio —
  // uma única fonte de verdade evita o dropdown dessincronizar do que
  // está realmente ativo (ex: depois de girar ou usar o ruler).
  const deviceSelectValue = !activeEmulation ? "none" : RESPONSIVE_PRESETS.some((p) => p.label === activeEmulation.label) ? activeEmulation.label : "custom";

  function onDeviceSelectChange(value: string) {
    if (value === "none") {
      setActiveEmulation(null);
      disableEmulation();
      return;
    }
    if (value === "custom") {
      applyCustomSize();
      return;
    }
    const preset = RESPONSIVE_PRESETS.find((p) => p.label === value);
    if (preset) applyEmulation(preset.width, preset.height, preset.deviceScaleFactor, preset.mobile, preset.label);
  }

  function applyDpr(deviceScaleFactor: number) {
    const width = activeEmulation?.width ?? customW;
    const height = activeEmulation?.height ?? customH;
    const mobile = activeEmulation?.mobile ?? customW < 768;
    const label = activeEmulation?.label ?? `${width}×${height} (personalizado)`;
    applyEmulation(width, height, deviceScaleFactor, mobile, label);
  }

  function rotateSize() {
    const width = activeEmulation?.width ?? customW;
    const height = activeEmulation?.height ?? customH;
    const deviceScaleFactor = activeEmulation?.deviceScaleFactor ?? 2;
    applyEmulation(height, width, deviceScaleFactor, height < 768, `${height}×${width} (personalizado)`);
  }

  // `activePresetRef`/`cardSizeRef` abaixo — o efeito de desmontagem só
  // roda uma vez (deps `[id]`), então sua closure capturaria pra sempre o
  // `activeEmulation`/`cardSize` de quando o componente MONTOU, não o
  // valor real no momento em que o inspector realmente fecha (uma
  // emulação ligada DEPOIS da montagem nunca seria desligada ao fechar).
  // Refs espelhados a cada render leem o valor atual de verdade dentro
  // da cleanup.
  const activeEmulationRef = useRef(activeEmulation);
  activeEmulationRef.current = activeEmulation;
  const cardSizeRef = useRef(cardSize);
  cardSizeRef.current = cardSize;
  // `onEmulationChange` é uma closure NOVA a cada render de BrowserCard.tsx
  // (arrow function inline) — não pode entrar nas deps de nenhum efeito
  // aqui embaixo (causaria o efeito refazer/disparar de novo TODA hora sem
  // relação nenhuma com emulação de verdade mudando). Mesmo padrão de ref
  // espelhado já usado acima pra `activeEmulation`/`cardSize`.
  const onEmulationChangeRef = useRef(onEmulationChange);
  onEmulationChangeRef.current = onEmulationChange;

  // Avisa BrowserCard.tsx (dono do <canvas>) do que está realmente
  // aplicado agora — dispara de novo a cada mudança real de emulação OU
  // de zoom de exibição, nunca por causa da identidade da própria função
  // (ver comentário do ref acima).
  useEffect(() => {
    onEmulationChangeRef.current?.(
      activeEmulation
        ? { width: activeEmulation.width, height: activeEmulation.height, zoom: frameZoom, deviceScaleFactor: activeEmulation.deviceScaleFactor }
        : null,
    );
  }, [activeEmulation, frameZoom]);

  // Desliga a emulação de dispositivo se o card fechar o inspector (ou
  // desmontar) com uma ainda ativa — não deve sobreviver ao inspector
  // fechado, senão a página fica "presa" num viewport mobile sem nenhum
  // controle visível pra desligar.
  useEffect(
    () => () => {
      if (activeEmulationRef.current) {
        void window.browser.setDeviceEmulation(id, null);
        void window.browser.resize(id, cardSizeRef.current.w, cardSizeRef.current.h);
        onEmulationChangeRef.current?.(null);
      }
    },
    [id],
  );

  // Pedido ao vivo do usuário (screenshot real): abrir a barra de
  // dispositivo só REVELAVA os controles, com o dropdown em "Nenhum" —
  // exigia escolher um preset manualmente antes de ver qualquer device-
  // frame de verdade. Um DevTools real ativa um device (o último usado,
  // ou um default) no mesmo clique que abre a barra. Aplica o primeiro
  // preset (Mobile) na transição false→true, só quando não há emulação
  // ativa ainda — não pisa em cima de uma emulação que o usuário já tinha
  // ligado antes de esconder a barra (ver smoke-browser-inspector-device-
  // toolbar-toggle.mjs, "esconder controles ≠ 'Parar emulação'": reabrir a
  // barra com uma emulação já ativa não deve trocar o preset escolhido).
  useEffect(() => {
    if (!deviceToolbarOpen || activeEmulationRef.current) return;
    const preset = RESPONSIVE_PRESETS[0];
    applyEmulation(preset.width, preset.height, preset.deviceScaleFactor, preset.mobile, preset.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceToolbarOpen]);

  // Alça de resize — um único listener de ponteiro no CONTAINER externo
  // (`onPointerMove`/`onPointerUp` no próprio `.inspector`, ver JSX)
  // trata os três docks: `resizingRef` guarda de qual lado veio o drag e
  // o valor inicial, pra converter o delta do ponteiro (que tem sinal
  // diferente conforme o lado — arrastar a alça da direita pra ESQUERDA
  // aumenta a largura, a da esquerda pra DIREITA também aumenta, a de
  // embaixo pra CIMA aumenta a altura) numa única fórmula por dock.
  function beginResize(d: Dock, clientPos: number) {
    resizingRef.current = { dock: d, start: clientPos, startSize: panelSizes[d] };
  }
  // Throttle via rAF (mesmo espírito do `rafThrottleRect`, CardFrame.tsx,
  // incluindo o "flush" final no fim do arraste) — revisto ao vivo no
  // refactor overlay→reflow: arrastar esta alça agora reflow de VERDADE
  // o canvas a cada mudança de `panelSizes` (o dock virou flex sibling,
  // não mais overlay absoluto), o que por sua vez dispara o
  // `ResizeObserver` novo de BrowserCard.tsx a cada tick — sem o
  // throttle, cada pointermove cru viraria uma chamada IPC de resize.
  // `pendingResizeRef` guarda sempre o ÚLTIMO valor calculado (mesmo
  // enquanto um rAF já está agendado) pra `endResize` poder aplicar o
  // valor final de verdade na hora de soltar, em vez de simplesmente
  // cancelar e perder o último tick.
  const panelResizeRafRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<{ dock: Dock; next: number } | null>(null);
  function onResizePointerMove(e: React.PointerEvent) {
    const r = resizingRef.current;
    if (!r) return;
    const pos = r.dock === "bottom" ? e.clientY : e.clientX;
    const delta = pos - r.start;
    const signed = r.dock === "right" ? -delta : r.dock === "left" ? delta : -delta;
    const next = Math.max(DOCK_MIN[r.dock], Math.min(DOCK_MAX[r.dock], r.startSize + signed));
    pendingResizeRef.current = { dock: r.dock, next };
    if (panelResizeRafRef.current !== null) return;
    panelResizeRafRef.current = requestAnimationFrame(() => {
      panelResizeRafRef.current = null;
      const p = pendingResizeRef.current;
      if (p) setPanelSizes((prev) => ({ ...prev, [p.dock]: p.next }));
    });
  }
  function endResize() {
    resizingRef.current = null;
    if (panelResizeRafRef.current !== null) {
      cancelAnimationFrame(panelResizeRafRef.current);
      panelResizeRafRef.current = null;
      const p = pendingResizeRef.current;
      if (p) setPanelSizes((prev) => ({ ...prev, [p.dock]: p.next }));
    }
    pendingResizeRef.current = null;
  }

  // Só existe (e só faz sentido medir) em zoom "Ajustar" com emulação
  // ativa — sem isso `frameBox` fica em `null` o resto do tempo, sem
  // custo. Nos zooms fixos (100%/75%/50%) o frame pode ficar MAIOR que a
  // área visível e rolar (ver o CSS de `.browserCardBodyWrap[data-
  // emulating]`) — as alças precisariam então compensar `scrollLeft`/
  // `scrollTop` do wrap, uma complicação a mais que fica de fora desta
  // rodada (decisão de escopo, não esquecida).
  //
  // Lê a caixa REAL do `<canvas>` (`getBoundingClientRect()`, relativa
  // ao wrap) em vez de re-derivar a matemática de "contido" — o
  // `ResizeObserver` no canvas acompanha qualquer resize (card, dock, o
  // que for) automaticamente, sem chance de divergir do que o CSS
  // realmente pintou.
  useEffect(() => {
    if (!activeEmulation || frameZoom !== "fit") {
      setFrameBox(null);
      return;
    }
    const wrap = inspectorRootRef.current?.parentElement;
    const canvas = wrap?.querySelector<HTMLElement>('[data-role="browser-body"]');
    if (!wrap || !canvas) return;
    frameCanvasElRef.current = canvas;
    function measure() {
      const wrapRect = wrap!.getBoundingClientRect();
      const canvasRect = canvas!.getBoundingClientRect();
      if (wrapRect.width <= 0 || wrapRect.height <= 0) return;
      setFrameBox({
        leftPct: (canvasRect.left - wrapRect.left) / wrapRect.width,
        topPct: (canvasRect.top - wrapRect.top) / wrapRect.height,
        widthPct: canvasRect.width / wrapRect.width,
        heightPct: canvasRect.height / wrapRect.height,
      });
    }
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    ro.observe(wrap);
    measure();
    return () => {
      ro.disconnect();
      frameCanvasElRef.current = null;
    };
  }, [activeEmulation, frameZoom]);

  function beginFrameResize(axis: "right" | "bottom" | "corner", clientX: number, clientY: number) {
    // Lê a caixa do canvas FRESCA (não de `frameBox`, que agora guarda
    // frações — precisamos do tamanho de TELA real deste instante pra
    // converter delta de ponteiro, que também chega em px de tela) —
    // mesmo espírito de "nunca uma segunda fonte de verdade", só que
    // aqui precisa ser em pixels mesmo, então lê direto do DOM.
    const canvasEl = frameCanvasElRef.current;
    if (!activeEmulation || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    frameResizeRef.current = {
      axis,
      startX: clientX,
      startY: clientY,
      startW: activeEmulation.width,
      startH: activeEmulation.height,
      // Conversão screen-px→device-px fixada no INÍCIO do arraste (não
      // recalculada a cada tick) — o frame muda de tamanho/proporção
      // durante o próprio arraste (é um redimensionamento de verdade,
      // não um zoom), então travar a escala do começo do gesto é o que
      // dá um arraste previsível em vez de acelerar/desacelerar sozinho
      // conforme a caixa "contida" reencaixa.
      scaleX: activeEmulation.width / rect.width,
      scaleY: activeEmulation.height / rect.height,
    };
  }
  function onFrameResizePointerMove(e: React.PointerEvent) {
    const r = frameResizeRef.current;
    if (!r || !activeEmulation) return;
    const dx = (e.clientX - r.startX) * r.scaleX;
    const dy = (e.clientY - r.startY) * r.scaleY;
    const width = r.axis === "bottom" ? r.startW : clampFrameDim(r.startW + dx);
    const height = r.axis === "right" ? r.startH : clampFrameDim(r.startH + dy);
    applyEmulation(width, height, activeEmulation.deviceScaleFactor, width < 768, `${width}×${height} (personalizado)`);
  }
  function endFrameResize() {
    frameResizeRef.current = null;
  }

  const panelSizeStyle = dock === "bottom" ? { height: panelSizes.bottom } : { width: panelSizes[dock] };
  // Fase 6 (adoção de CDP) — breakpoints só fazem sentido em `kind:"script"`.
  const selectedSourceKind = sourceList.find((s) => s.url === selectedSourceUrl)?.kind;
  const breakpointLineSet = new Set((selectedSourceUrl ? breakpointsByUrl[selectedSourceUrl] : undefined)?.map((b) => b.lineNumber) ?? []);

  return (
    <>
    <div
      ref={inspectorRootRef}
      className={styles.inspector}
      data-role="browser-inspector"
      data-dock={dock}
      style={panelSizeStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={onResizePointerMove}
      onPointerUp={endResize}
      onPointerLeave={endResize}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className={styles.resizeHandle}
        data-role="inspector-resize-handle"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          beginResize(dock, dock === "bottom" ? e.clientY : e.clientX);
        }}
      />
      {deviceToolbarOpen && (
      <div className={styles.deviceToolbar} data-role="inspector-device-toolbar">
        <span className={styles.deviceLabel}>Dispositivo</span>
        <select
          data-role="inspector-device-select"
          value={deviceSelectValue}
          onChange={(e) => onDeviceSelectChange(e.target.value)}
        >
          <option value="none">Sem emulação</option>
          {RESPONSIVE_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.label}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Personalizado</option>
        </select>
        <input
          type="number"
          data-role="inspector-custom-width"
          className={styles.deviceDim}
          min={FRAME_DIM_MIN}
          max={FRAME_DIM_MAX}
          value={customW}
          onChange={(e) => setCustomW(Number(e.target.value) || 0)}
        />
        <span className={styles.deviceX}>×</span>
        <input
          type="number"
          data-role="inspector-custom-height"
          className={styles.deviceDim}
          min={FRAME_DIM_MIN}
          max={FRAME_DIM_MAX}
          value={customH}
          onChange={(e) => setCustomH(Number(e.target.value) || 0)}
        />
        <button data-role="inspector-apply-custom-size" onClick={applyCustomSize}>
          Aplicar
        </button>
        <button title="Girar (trocar largura/altura)" data-role="inspector-rotate" onClick={rotateSize}>
          <Icon name="rotate" size={13} />
        </button>
        <span className={styles.deviceLabel}>DPR</span>
        <select data-role="inspector-dpr-select" value={activeEmulation?.deviceScaleFactor ?? 2} onChange={(e) => applyDpr(Number(e.target.value))}>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
        </select>
        {activeEmulation && (
          <>
            <span className={styles.deviceLabel}>Zoom</span>
            <select
              data-role="inspector-zoom-select"
              value={frameZoom}
              onChange={(e) => setFrameZoom(e.target.value as typeof frameZoom)}
            >
              <option value="fit">Ajustar</option>
              <option value="1">100%</option>
              <option value="0.75">75%</option>
              <option value="0.5">50%</option>
            </select>
          </>
        )}
        <div className={styles.deviceToolbarSpacer} />
        {activeEmulation && (
          <button
            className={styles.stopEmulation}
            data-role="inspector-stop-emulation"
            onClick={() => {
              setActiveEmulation(null);
              disableEmulation();
            }}
          >
            Parar emulação
          </button>
        )}
      </div>
      )}
      {deviceToolbarOpen && (
      <div className={styles.widthRulerBar} data-role="inspector-width-ruler">
        {WIDTH_RULER.map((w) => (
          <button key={w} data-role="inspector-width-preset" data-width={w} data-active={customW === w || undefined} onClick={() => pickRulerWidth(w)}>
            {w}
          </button>
        ))}
      </div>
      )}
      <div className={styles.inspectorTabs}>
        <button data-role="inspector-tab" data-tab="elements" data-active={tab === "elements" || undefined} onClick={() => setTab("elements")}>
          Elements
        </button>
        <button data-role="inspector-tab" data-tab="console" data-active={tab === "console" || undefined} onClick={() => setTab("console")}>
          Console
        </button>
        <button data-role="inspector-tab" data-tab="network" data-active={tab === "network" || undefined} onClick={() => setTab("network")}>
          Network
        </button>
        <button data-role="inspector-tab" data-tab="application" data-active={tab === "application" || undefined} onClick={() => setTab("application")}>
          Application
        </button>
        <button data-role="inspector-tab" data-tab="sources" data-active={tab === "sources" || undefined} onClick={() => setTab("sources")}>
          Sources
        </button>
        <button data-role="inspector-tab" data-tab="performance" data-active={tab === "performance" || undefined} onClick={() => setTab("performance")}>
          Performance
        </button>
        <div className={styles.inspectorTabsSpacer} />
        {tab === "elements" && (
          <button title="Atualizar árvore" onClick={() => void refreshTree()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        {tab === "network" && (
          <button
            title="Limpar requisições"
            onClick={() => {
              setNetworkEntries([]);
              setNetworkBodies({});
              setExpandedNetworkId(null);
            }}
          >
            <Icon name="close" size={13} />
          </button>
        )}
        {tab === "sources" && (
          <button title="Atualizar lista de arquivos" onClick={() => void refreshSources()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        {tab === "performance" && (
          <button title="Atualizar CPU/memória" onClick={() => void refreshProcessStats()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        {tab === "application" && (
          <button title="Atualizar" onClick={() => void refreshStorage()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        <button
          title={deviceToolbarOpen ? "Ocultar barra de dispositivo" : "Mostrar barra de dispositivo (modo responsivo)"}
          data-role="inspector-device-toolbar-toggle"
          data-active={deviceToolbarOpen || undefined}
          onClick={onToggleDeviceToolbar}
        >
          <Icon name="viewportMobile" size={13} />
        </button>
        <div className={styles.dockButtons} data-role="inspector-dock-buttons">
          <button title="Ancorar à direita" data-active={dock === "right" || undefined} onClick={() => setDock("right")}>
            <Icon name="dockRight" size={13} />
          </button>
          <button title="Ancorar embaixo" data-active={dock === "bottom" || undefined} onClick={() => setDock("bottom")}>
            <Icon name="dockBottom" size={13} />
          </button>
          <button title="Ancorar à esquerda" data-active={dock === "left" || undefined} onClick={() => setDock("left")}>
            <Icon name="dockLeft" size={13} />
          </button>
        </div>
        <button title="Fechar inspector" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      {cdpAttachResult && !cdpAttachResult.ok && (
        <div className={styles.cdpErrorBanner} data-role="inspector-cdp-error">
          <span>{cdpAttachResult.error}</span>
          <button onClick={retryCdpAttach}>Tentar novamente</button>
        </div>
      )}
      <div className={styles.inspectorBody}>
        {tab === "elements" && (
          <div className={styles.elementsSplit}>
            <div className={styles.tree} data-role="inspector-tree">
              {loadingTree ? (
                <div className={styles.inspectorEmpty}>Carregando árvore…</div>
              ) : tree ? (
                <ElementsTree node={tree} selectedId={selectedId} expanded={expanded} onToggle={toggleNode} onSelect={selectNode} />
              ) : (
                <div className={styles.inspectorEmpty}>Não foi possível ler a página.</div>
              )}
            </div>
            <div className={styles.detailsPane} data-role="inspector-details-pane">
              <div className={styles.subtabs}>
                <button
                  className={styles.subtab}
                  data-role="inspector-subtab"
                  data-sub="styles"
                  data-active={detailsSubtab === "styles" || undefined}
                  onClick={() => setDetailsSubtab("styles")}
                >
                  Styles
                </button>
                <button
                  className={styles.subtab}
                  data-role="inspector-subtab"
                  data-sub="computed"
                  data-active={detailsSubtab === "computed" || undefined}
                  onClick={() => setDetailsSubtab("computed")}
                >
                  Computed
                </button>
                <button
                  className={styles.subtab}
                  data-role="inspector-subtab"
                  data-sub="listeners"
                  data-active={detailsSubtab === "listeners" || undefined}
                  onClick={() => setDetailsSubtab("listeners")}
                >
                  Event Listeners
                </button>
              </div>
              <div className={styles.subpanel} data-role="inspector-subpanel">
                {!selectedId ? (
                  <div className={styles.inspectorEmpty}>Selecione um elemento na árvore.</div>
                ) : detailsSubtab === "listeners" ? (
                  loadingListeners ? (
                    <div className={styles.inspectorEmpty}>Carregando listeners…</div>
                  ) : !elementListeners ? (
                    <div className={styles.inspectorEmpty}>Elemento não encontrado (a árvore pode ter sido atualizada).</div>
                  ) : (
                    <ListenersPanel entries={elementListeners} />
                  )
                ) : loadingStyles ? (
                  <div className={styles.inspectorEmpty}>Carregando estilos…</div>
                ) : !elementStyles ? (
                  <div className={styles.inspectorEmpty}>Elemento não encontrado (a árvore pode ter sido atualizada).</div>
                ) : detailsSubtab === "styles" ? (
                  <StylesPanel es={elementStyles} />
                ) : (
                  <ComputedPanel es={elementStyles} filter={computedFilter} onFilterChange={setComputedFilter} />
                )}
              </div>
            </div>
          </div>
        )}
        {tab === "console" && (
          <div className={styles.console}>
            <div className={styles.consoleLog} data-role="inspector-console-log">
              {consoleEntries.length === 0 && <div className={styles.inspectorEmpty}>Sem mensagens ainda.</div>}
              {consoleEntries.map((entry, i) => (
                <div key={i} className={styles.consoleLine} data-role="inspector-console-line" data-level={entry.level}>
                  {entry.level === "input" ? "› " : entry.level === "result" ? "‹ " : ""}
                  {entry.message}
                </div>
              ))}
            </div>
            <div className={styles.consoleInputRow}>
              <input
                data-role="inspector-console-input"
                value={consoleInput}
                onChange={(e) => setConsoleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runConsoleInput();
                }}
                placeholder="Avaliar JS na página…"
              />
              <button data-role="inspector-console-submit" onClick={() => void runConsoleInput()}>
                <Icon name="forward" size={13} />
              </button>
            </div>
          </div>
        )}
        {tab === "network" && (
          <div className={styles.network} data-role="inspector-network">
            <div className={styles.networkToolbar}>
              <button data-role="inspector-network-filter" data-active={!networkOnlyFailed || undefined} onClick={() => setNetworkOnlyFailed(false)}>
                Tudo
              </button>
              <button data-role="inspector-network-filter" data-active={networkOnlyFailed || undefined} onClick={() => setNetworkOnlyFailed(true)}>
                Falhas
              </button>
            </div>
            <div className={styles.storageTableWrap}>
              {networkEntries.length === 0 ? (
                <div className={styles.inspectorEmpty}>Nenhuma requisição registrada ainda.</div>
              ) : (
                <table className={styles.storageTable} data-role="inspector-network-table">
                  <thead>
                    <tr>
                      <th>Método</th>
                      <th>URL</th>
                      <th>Status</th>
                      <th>Tipo</th>
                      <th>Tempo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkEntries
                      .filter((r) => !networkOnlyFailed || r.error !== undefined || (r.status !== null && r.status >= 400))
                      .map((r) => {
                        const body = networkBodies[r.requestId];
                        const isOpen = expandedNetworkId === r.requestId;
                        return (
                          <Fragment key={r.requestId}>
                            <tr data-role="inspector-network-row" data-expanded={isOpen || undefined} onClick={() => toggleNetworkRow(r.requestId)}>
                              <td>{r.method}</td>
                              <td className={styles.networkUrl} title={r.url}>
                                {r.url}
                              </td>
                              <td data-severity={r.status !== null && r.status < 400 && !r.error ? "ok" : "error"}>{r.error ? "erro" : (r.status ?? "—")}</td>
                              <td>{r.mimeType ?? "—"}</td>
                              <td>{r.durationMs !== undefined ? `${Math.round(r.durationMs)} ms` : "…"}</td>
                            </tr>
                            {isOpen && (
                              <tr data-role="inspector-network-detail">
                                <td colSpan={5}>
                                  <div className={styles.networkDetail}>
                                    <div className={styles.networkDetailSection}>
                                      <div className={styles.ruleSelector}>Initiator</div>
                                      <div>{r.initiatorType ?? "—"}</div>
                                    </div>
                                    <div className={styles.networkDetailSection}>
                                      <div className={styles.ruleSelector}>Request Headers</div>
                                      <div className={styles.decl}>
                                        {Object.entries(r.requestHeaders).map(([k, v]) => (
                                          <div key={k}>
                                            <span className={styles.prop}>{k}</span>
                                            <span className={styles.propval}>{v}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    <div className={styles.networkDetailSection}>
                                      <div className={styles.ruleSelector}>Response Headers</div>
                                      {Object.keys(r.responseHeaders).length === 0 ? (
                                        <div className={styles.ruleEmpty}>— sem resposta ainda —</div>
                                      ) : (
                                        <div className={styles.decl}>
                                          {Object.entries(r.responseHeaders).map(([k, v]) => (
                                            <div key={k}>
                                              <span className={styles.prop}>{k}</span>
                                              <span className={styles.propval}>{v}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <div className={styles.networkDetailSection} data-role="inspector-network-body">
                                      <div className={styles.ruleSelector}>Body</div>
                                      {!body ? (
                                        <div className={styles.ruleEmpty}>Carregando…</div>
                                      ) : "error" in body ? (
                                        <div className={styles.ruleEmpty}>{body.error}</div>
                                      ) : (
                                        <pre className={styles.networkBody} data-role="inspector-network-body-content">
                                          {body.base64Encoded ? "(binário, base64)" : body.content}
                                        </pre>
                                      )}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        {tab === "application" && (
          <div className={styles.application} data-role="inspector-application">
            <div className={styles.storageNav}>
              <div className={styles.storageGroupTitle}>Local Storage</div>
              <button
                className={styles.storageItem}
                data-role="inspector-storage-item"
                data-area="local"
                data-active={storageArea === "local" || undefined}
                onClick={() => setStorageArea("local")}
              >
                {localItems.length} {localItems.length === 1 ? "item" : "itens"}
              </button>
              <div className={styles.storageGroupTitle}>Session Storage</div>
              <button
                className={styles.storageItem}
                data-role="inspector-storage-item"
                data-area="session"
                data-active={storageArea === "session" || undefined}
                onClick={() => setStorageArea("session")}
              >
                {sessionItems.length} {sessionItems.length === 1 ? "item" : "itens"}
              </button>
              <div className={styles.storageGroupTitle}>Cookies</div>
              <button
                className={styles.storageItem}
                data-role="inspector-storage-item"
                data-area="cookies"
                data-active={storageArea === "cookies" || undefined}
                onClick={() => setStorageArea("cookies")}
              >
                {cookieItems.length} {cookieItems.length === 1 ? "cookie" : "cookies"}
              </button>
            </div>
            <div className={styles.storageTableWrap}>
              {loadingStorage ? (
                <div className={styles.inspectorEmpty}>Carregando…</div>
              ) : storageArea === "cookies" ? (
                <table className={styles.storageTable} data-role="inspector-storage-table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Valor</th>
                      <th>Domínio</th>
                      <th>Caminho</th>
                      <th>HttpOnly</th>
                      <th>Secure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cookieItems.map((c) => (
                      <tr key={c.name + c.domain + c.path}>
                        <td className={styles.storageKey}>{c.name}</td>
                        <td>{c.value}</td>
                        <td>{c.domain}</td>
                        <td>{c.path}</td>
                        <td>{c.httpOnly ? "✓" : "—"}</td>
                        <td>{c.secure ? "✓" : "—"}</td>
                      </tr>
                    ))}
                    {cookieItems.length === 0 && (
                      <tr>
                        <td colSpan={6} className={styles.inspectorEmpty}>
                          Sem cookies pra esta página.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className={styles.storageTable} data-role="inspector-storage-table">
                  <thead>
                    <tr>
                      <th>Chave</th>
                      <th>Valor</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(storageArea === "local" ? localItems : sessionItems).map(([k, v]) => (
                      <tr key={k}>
                        <td className={styles.storageKey}>{k}</td>
                        <td>{v}</td>
                        <td>
                          <button title="Remover" onClick={() => void deleteStorageRow(k)}>
                            <Icon name="trash" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {(storageArea === "local" ? localItems : sessionItems).length === 0 && (
                      <tr>
                        <td colSpan={3} className={styles.inspectorEmpty}>
                          Vazio.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
        {tab === "sources" && (
          <div className={styles.sources} data-role="inspector-sources">
            <div className={styles.sourcesList} data-role="inspector-sources-list">
              {loadingSourceList ? (
                <div className={styles.inspectorEmpty}>Carregando…</div>
              ) : sourceList.length === 0 ? (
                <div className={styles.inspectorEmpty}>Nenhum arquivo encontrado.</div>
              ) : (
                sourceList.map((s) => (
                  <button
                    key={s.url}
                    className={styles.sourceItem}
                    data-role="inspector-source-item"
                    data-kind={s.kind}
                    data-active={selectedSourceUrl === s.url || undefined}
                    title={s.url}
                    onClick={() => setSelectedSourceUrl(s.url)}
                  >
                    <Icon name="fileCode" size={12} />
                    {sourceFilename(s.url)}
                  </button>
                ))
              )}
            </div>
            <div className={styles.sourceViewer} data-role="inspector-source-viewer">
              {!selectedSourceUrl ? (
                <div className={styles.inspectorEmpty}>Selecione um arquivo na lista.</div>
              ) : loadingSourceContent ? (
                <div className={styles.inspectorEmpty}>Carregando arquivo…</div>
              ) : !sourceContent ? (
                <div className={styles.inspectorEmpty}>—</div>
              ) : "error" in sourceContent ? (
                <div className={styles.inspectorEmpty}>Não foi possível buscar o arquivo: {sourceContent.error}</div>
              ) : (
                <>
                  {/* DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 6) — o
                      gutter de breakpoint do protótipo virou real:
                      `Debugger.setBreakpointByUrl`/`removeBreakpoint` no
                      clique, `Debugger.paused`/`resumed` refletidos no
                      banner abaixo. Escopo explícito e reduzido: sem watch
                      expressions, sem navegação de call-stack-frame, sem
                      step-into/over/out — um botão único de Continuar. Só
                      existe em `kind:"script"` (arquivo JS real com URL
                      externa de verdade); documento/CSS continuam
                      somente-leitura sem gutter, não faz sentido pausar JS
                      neles. */}
                  {debuggerPaused && (
                    <div className={styles.sourceBreakpointNotice} data-role="inspector-debugger-paused" data-severity="paused">
                      Execução pausada num breakpoint.
                      <button onClick={resumeDebugger}>Continuar</button>
                    </div>
                  )}
                  {selectedSourceKind !== "script" && (
                    <div className={styles.sourceBreakpointNotice} data-role="inspector-breakpoint-notice">
                      Breakpoints só em arquivos JS — {selectedSourceKind === "document" ? "isto é o documento principal" : "isto é uma folha de estilo"},
                      somente leitura.
                    </div>
                  )}
                  {sourceContent.truncated && (
                    <div className={styles.sourceTruncatedNotice} data-role="inspector-source-truncated">
                      Arquivo grande demais pra mostrar por completo — exibindo os primeiros {sourceContent.content.length.toLocaleString("pt-BR")} de{" "}
                      {sourceContent.totalChars.toLocaleString("pt-BR")} caracteres.
                    </div>
                  )}
                  <Suspense fallback={<div className={styles.inspectorEmpty}>Carregando editor…</div>}>
                    <CodeEditor
                      key={selectedSourceUrl}
                      value={sourceContent.content}
                      onChange={() => {}}
                      filename={selectedSourceUrl}
                      readOnly
                      breakpointLines={selectedSourceKind === "script" ? breakpointLineSet : undefined}
                      onToggleBreakpoint={selectedSourceKind === "script" ? (line) => void toggleBreakpoint(selectedSourceUrl, line) : undefined}
                    />
                  </Suspense>
                </>
              )}
            </div>
          </div>
        )}
        {tab === "performance" && (
          <div className={styles.performance} data-role="inspector-performance">
            {/* DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 5) — profiling
                de CPU real via `Profiler.start`/`stop` existe agora
                (abaixo), mas com escopo reduzido de propósito: só
                hotspots por contagem de amostra, sem flame graph nem o
                domínio `Tracing` completo (timeline isolada de script/
                layout/paint) — ver doc comment de `profileResult` acima.
                FPS/CPU/memória continuam medidos de fora, sem CDP. */}
            <div className={styles.perfNotice} data-role="inspector-performance-notice">
              Profiling de CPU real (amostragem V8) disponível abaixo — sem flame graph nem timeline de script/layout/paint isolados (fora de escopo). FPS
              ao vivo e CPU/memória do processo continuam medidos de fora, sem CDP.
            </div>
            <div className={styles.perfGrid} data-role="inspector-perf-grid">
              <div className={styles.perfStat} data-role="inspector-perf-fps">
                <div className={styles.perfStatLabel}>FPS ao vivo</div>
                <div className={styles.perfStatValue}>{liveFps ?? "—"}</div>
              </div>
              <div className={styles.perfStat}>
                <div className={styles.perfStatLabel}>Frames capturados</div>
                <div className={styles.perfStatValue}>{totalFrames}</div>
              </div>
              <div className={styles.perfStat} data-role="inspector-perf-cpu">
                <div className={styles.perfStatLabel}>CPU do processo</div>
                <div className={styles.perfStatValue}>
                  {loadingProcessStats ? "…" : !processStats ? "—" : "error" in processStats ? "—" : `${processStats.cpuPercent}%`}
                </div>
              </div>
              <div className={styles.perfStat} data-role="inspector-perf-memory">
                <div className={styles.perfStatLabel}>Memória do processo</div>
                <div className={styles.perfStatValue}>
                  {loadingProcessStats ? "…" : !processStats ? "—" : "error" in processStats ? "—" : `${processStats.memoryMB} MB`}
                </div>
              </div>
              <div className={styles.perfStat}>
                <div className={styles.perfStatLabel}>Console</div>
                <div className={styles.perfStatValue}>
                  {consoleEntries.filter((e) => e.level === "error").length} erro(s), {consoleEntries.filter((e) => e.level === "warning").length} aviso(s)
                </div>
              </div>
              <div className={styles.perfStat}>
                <div className={styles.perfStatLabel}>Network</div>
                <div className={styles.perfStatValue}>
                  {perfNetworkSummary ? `${perfNetworkSummary.total} requisição(ões), ${perfNetworkSummary.failed} falha(s)` : "—"}
                </div>
              </div>
            </div>
            <div className={styles.perfTimeline} data-role="inspector-perf-timeline">
              <div className={styles.perfTimelineLabel}>FPS nos últimos {fpsTimeline.length}s</div>
              <div className={styles.perfTimelineBars}>
                {fpsTimeline.length === 0 ? (
                  <div className={styles.inspectorEmpty}>Aguardando frames…</div>
                ) : (
                  fpsTimeline.map((v, i) => (
                    <div key={i} className={styles.perfBar} data-role="inspector-perf-bar" data-fps={v} style={{ height: `${Math.min(100, (v / 60) * 100)}%` }} />
                  ))
                )}
              </div>
            </div>
            <div className={styles.perfProfiler} data-role="inspector-perf-profiler">
              <div className={styles.perfTimelineLabel}>Profiling de CPU</div>
              <button
                data-role="inspector-perf-profile-toggle"
                data-active={profiling || undefined}
                onClick={() => void (profiling ? stopProfiling() : startProfiling())}
              >
                {profiling ? "Parar profiling" : "Iniciar profiling"}
              </button>
              {profiling && <div className={styles.inspectorEmpty}>Coletando amostras…</div>}
              {!profiling && profileResult && "error" in profileResult && <div className={styles.ruleEmpty}>{profileResult.error}</div>}
              {!profiling && profileResult && !("error" in profileResult) && (
                <div data-role="inspector-perf-profile-result">
                  <div className={styles.perfProfileSummary}>
                    {profileResult.hotspots.length === 0
                      ? `Nenhuma amostra coletada em ${Math.round(profileResult.durationMs)}ms (função inativa nesse intervalo).`
                      : `${profileResult.totalHitCount} amostra(s) em ${Math.round(profileResult.durationMs)}ms — top ${profileResult.hotspots.length} função(ões) por tempo próprio:`}
                  </div>
                  {profileResult.hotspots.length > 0 && (
                    <table className={styles.storageTable} data-role="inspector-perf-profile-table">
                      <thead>
                        <tr>
                          <th>Função</th>
                          <th>Local</th>
                          <th>Amostras</th>
                          <th>%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profileResult.hotspots.map((h, i) => (
                          <tr key={i}>
                            <td>{h.functionName}</td>
                            <td className={styles.networkUrl} title={h.url}>
                              {h.url ? `${h.url.split("/").pop()}:${h.lineNumber + 1}` : "(nativo)"}
                            </td>
                            <td>{h.hitCount}</td>
                            <td>{h.selfPercent.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    {/* Alças de resize do device-frame — DESIGN-BACKLOG.md §2.1 item 3,
        sub-item pendente. Renderizadas como IRMÃS do painel do dock
        (não filhas), ambas sob o MESMO `.browserCardBodyWrap` (o
        `<canvas>` mora lá também, ver BrowserCard.tsx) — é o que dá o
        contexto de posicionamento certo pra alinhar exatamente com a
        borda visível do frame, sem precisar de nenhuma prop nova vinda
        do pai. */}
    {frameBox && (
      <div
        className={styles.frameResizeOverlay}
        data-role="inspector-frame-resize-overlay"
        onPointerMove={onFrameResizePointerMove}
        onPointerUp={endFrameResize}
        onPointerLeave={endFrameResize}
      >
        <div
          className={styles.frameResizeRight}
          data-role="inspector-frame-resize-right"
          style={{ left: `calc(${(frameBox.leftPct + frameBox.widthPct) * 100}% - 3px)`, top: `${frameBox.topPct * 100}%`, height: `${frameBox.heightPct * 100}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            beginFrameResize("right", e.clientX, e.clientY);
          }}
        />
        <div
          className={styles.frameResizeBottom}
          data-role="inspector-frame-resize-bottom"
          style={{ left: `${frameBox.leftPct * 100}%`, top: `calc(${(frameBox.topPct + frameBox.heightPct) * 100}% - 3px)`, width: `${frameBox.widthPct * 100}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            beginFrameResize("bottom", e.clientX, e.clientY);
          }}
        />
        <div
          className={styles.frameResizeCorner}
          data-role="inspector-frame-resize-corner"
          style={{
            left: `calc(${(frameBox.leftPct + frameBox.widthPct) * 100}% - 10px)`,
            top: `calc(${(frameBox.topPct + frameBox.heightPct) * 100}% - 10px)`,
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            beginFrameResize("corner", e.clientX, e.clientY);
          }}
        />
      </div>
    )}
    </>
  );
}
