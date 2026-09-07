import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import styles from "./BrowserInspector.module.css";

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

type DomNode = { id: string; tag: string; attrs: Record<string, string>; children: DomNode[]; text: string };
type SnapshotResult = { root: DomNode; truncated: boolean; nodeCount: number };
type ConsoleLine = { level: string; message: string; at: number };
type Tab = "elements" | "console" | "network" | "application";
type NetworkLine = { method: string; url: string; status: number | null; error?: string; at: number };
type Dock = "right" | "bottom" | "left";
type StorageArea = "local" | "session" | "cookies";
type DetailsSubtab = "styles" | "computed";
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

export type ResponsivePreset = { label: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean };

const RESPONSIVE_PRESETS: ResponsivePreset[] = [
  { label: "Mobile (390×844)", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  { label: "Tablet (768×1024)", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  { label: "Desktop (1280×800)", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
];

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
const DOCK_MIN = { right: 600, bottom: 160, left: 600 } as const;
const DOCK_MAX = { right: 820, bottom: 520, left: 820 } as const;
const DOCK_DEFAULT = { right: 600, bottom: 280, left: 600 } as const;

// Cada elemento ganha um `data-stellar-el-id` estável (só até o próximo
// snapshot) — é assim que "clicar num nó da árvore" consegue destacar o
// elemento de VERDADE na página renderizada, sem precisar reconstruir um
// seletor CSS frágil. Retorna o objeto puro (não uma string) — `evalJs`
// (browser-registry.ts) já faz o `JSON.stringify` sozinho.
//
// Achado ao vivo (relatado pelo usuário com screenshot: "Não foi possível
// ler a página" em google.com — funcionava só nas fixtures pequenas dos
// smoke tests) — `depth<=14`/`children<=80` por nó não bastam: um site
// real com MUITOS ramos rasos (não um único ramo fundo/largo) ainda
// produz um JSON grande o bastante pra estourar `MAX_EVAL_RESULT_CHARS`
// (20_000, `evalJs` em browser-registry.ts) — o resultado vem truncado
// no meio, `JSON.parse` (em `evalJson` abaixo) falha em silêncio, e a UI
// mostra "não foi possível ler". Confirmado com instrumentação real (não
// só suspeita): 60 nós reais de `google.com` ocupam 14_595 chars, 60 de
// um artigo aleatório da Wikipédia ocupam 10_613 — ambos com margem
// confortável abaixo do teto; 80 nós já ficava em 18_578 (margem
// apertada demais pra variação real de atributos). `BUDGET` abaixo é um
// contador GLOBAL (compartilha `n`, já usado pros ids) que para de
// descer a árvore inteira (não só um ramo) assim que atingido — retorna
// `{ root, truncated, nodeCount }` em vez do nó cru, pra UI poder avisar
// honestamente em vez de falhar calada quando uma página é grande demais
// pra mostrar por completo de uma vez.
const SNAPSHOT_NODE_BUDGET = 60;
const SNAPSHOT_SCRIPT = `
(() => {
  let n = 0;
  function walk(el, depth) {
    if (!el || depth > 14 || n >= ${SNAPSHOT_NODE_BUDGET}) return null;
    const id = "stellar-el-" + (n++);
    el.setAttribute("data-stellar-el-id", id);
    const attrs = {};
    for (const a of el.attributes) if (a.name !== "data-stellar-el-id") attrs[a.name] = a.value;
    const children = [];
    for (const child of el.children) {
      if (children.length >= 80) break;
      const s = walk(child, depth + 1);
      if (s) children.push(s);
    }
    const text = children.length === 0 ? (el.textContent || "").trim().slice(0, 160) : "";
    return { id, tag: el.tagName.toLowerCase(), attrs, children, text };
  }
  const root = walk(document.documentElement, 0);
  return { root, truncated: n >= ${SNAPSHOT_NODE_BUDGET}, nodeCount: n };
})()
`;

function highlightScript(elId: string | null): string {
  // Achado ao vivo (via smoke test do painel Styles): a versão anterior
  // escrevia o destaque DIRETO em `el.style` — inofensivo pro destaque em
  // si, mas poluía o painel "Styles" (aba nova): o `element.style` do
  // elemento selecionado sempre mostrava o outline vermelho de destaque
  // como se fosse um estilo inline de verdade da página, escondendo o
  // inline real. Fix: uma única regra CSS injetada uma vez (`<style
  // id="stellar-highlight-style">`), o destaque vira só um atributo
  // (`data-stellar-highlighted`) que não toca `el.style` — `elementStylesScript`
  // (painel Styles) fica livre pra ler o `element.style` real do autor.
  return `
    (() => {
      if (!document.getElementById("stellar-highlight-style")) {
        const style = document.createElement("style");
        style.id = "stellar-highlight-style";
        style.textContent = '[data-stellar-highlighted] { outline: 2px solid #ff5a5f !important; outline-offset: -1px !important; }';
        document.head.appendChild(style);
      }
      document.querySelectorAll("[data-stellar-highlighted]").forEach((el) => {
        el.removeAttribute("data-stellar-highlighted");
      });
      ${
        elId
          ? `const el = document.querySelector('[data-stellar-el-id="${elId}"]');
      if (el) {
        el.setAttribute("data-stellar-highlighted", "1");
        el.scrollIntoView({ block: "center", behavior: "instant" });
      }`
          : ""
      }
      return true;
    })()
  `;
}

function elementAtPointScript(x: number, y: number): string {
  return `document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})?.getAttribute("data-stellar-el-id") ?? null`;
}

// Achado ao vivo escrevendo o smoke test deste painel: devolver TODAS as
// ~300 propriedades de `getComputedStyle` (ideia original) estoura o
// `MAX_EVAL_RESULT_CHARS` (20_000, browser-registry.ts's `evalJs`) —
// o JSON vem cortado no meio, `JSON.parse` falha em silêncio (capturado
// pelo try/catch de `evalJson`) e a UI mostrava "elemento não encontrado"
// pra QUALQUER seleção. Fix: escopar `computed` pra um allowlist real das
// propriedades que mais importam (mesmas categorias que o DevTools
// destaca) em vez de despejar a lista inteira crua — ainda é dado 100%
// real (`getComputedStyle` de verdade), só não every-single-property.
const COMPUTED_PROPS = [
  "display", "position", "top", "right", "bottom", "left", "float", "clear", "z-index", "box-sizing",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-color", "border-radius",
  "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "gap", "flex-grow", "flex-shrink", "flex-basis",
  "grid-template-columns", "grid-template-rows",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-align", "text-decoration-line", "text-transform", "white-space", "color",
  "background-color", "background-image", "opacity", "box-shadow", "overflow", "overflow-x", "overflow-y", "visibility", "cursor",
  "transform", "transition", "animation-name",
];

// Painel de detalhes (Styles/Computed) do Elements — sem CDP, então sem
// `CSS.getMatchedCSSRules` (removida do DOM padrão, só existia mesmo no
// WebKit antigo). Aproximação real de qualquer jeito: varre
// `document.styleSheets` (pulando folhas cross-origin, que lançam ao ler
// `.cssRules`) e testa `el.matches(rule.selectorText)` regra por regra —
// ordena pelo índice de varredura DECRESCENTE (a regra encontrada por
// último tende a vencer a cascata na prática, já que folhas/posições
// mais tardias no documento normalmente têm prioridade) como
// aproximação de especificidade real, que exigiria reimplementar o
// algoritmo de cascata inteiro. Devolve o objeto CRU — `evalJs` já
// stringifica.
function elementStylesScript(elId: string): string {
  return `
(() => {
  const el = document.querySelector('[data-stellar-el-id="${elId}"]');
  if (!el) return null;
  function declsOf(decl) {
    const out = [];
    for (let i = 0; i < decl.length; i++) {
      const prop = decl[i];
      out.push({ prop, value: decl.getPropertyValue(prop), important: decl.getPropertyPriority(prop) === "important" });
    }
    return out;
  }
  const inline = declsOf(el.style);
  const matched = [];
  let order = 0;
  function walkRules(rules, sourceLabel) {
    for (const rule of rules) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        let matches = false;
        try { matches = window.matchMedia(rule.conditionText || "").matches; } catch {}
        if (matches) walkRules(rule.cssRules, sourceLabel);
        continue;
      }
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      let isMatch = false;
      try { isMatch = el.matches(rule.selectorText); } catch {}
      if (!isMatch) continue;
      matched.push({ selector: rule.selectorText, source: sourceLabel, decls: declsOf(rule.style), order: order++ });
    }
  }
  for (const sheet of document.styleSheets) {
    // Pula a folha de destaque injetada por highlightScript (nosso próprio
    // instrumento, não estilo do autor da página) — senão o elemento
    // selecionado sempre mostraria sua própria regra de destaque
    // ([data-stellar-highlighted]) como se fosse CSS real da página.
    if (sheet.ownerNode && sheet.ownerNode.id === "stellar-highlight-style") continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    let label = "estilo inline";
    if (sheet.href) {
      try { label = new URL(sheet.href).pathname.split("/").pop() || sheet.href; } catch { label = sheet.href; }
    }
    walkRules(rules, label);
  }
  matched.sort((a, b) => b.order - a.order);
  for (const m of matched) delete m.order;
  const cs = getComputedStyle(el);
  const computed = [];
  for (const prop of ${JSON.stringify(COMPUTED_PROPS)}) {
    const value = cs.getPropertyValue(prop);
    if (value) computed.push({ prop, value, important: false });
  }
  function num(v) { return Math.round(parseFloat(v) || 0); }
  const box = {
    marginTop: num(cs.marginTop), marginRight: num(cs.marginRight), marginBottom: num(cs.marginBottom), marginLeft: num(cs.marginLeft),
    borderTop: num(cs.borderTopWidth), borderRight: num(cs.borderRightWidth), borderBottom: num(cs.borderBottomWidth), borderLeft: num(cs.borderLeftWidth),
    paddingTop: num(cs.paddingTop), paddingRight: num(cs.paddingRight), paddingBottom: num(cs.paddingBottom), paddingLeft: num(cs.paddingLeft),
    width: num(cs.width), height: num(cs.height),
  };
  return { inline, matched, computed, box };
})()
`;
}

async function evalJson<T>(id: string, js: string): Promise<T | null> {
  const res = await window.browser.evalJs(id, js);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.result) as T;
  } catch {
    return null;
  }
}

/** Caminho de ids do nó raiz até `targetId` (inclusive) — usado só pra
 * auto-expandir os ancestrais de um elemento selecionado via botão
 * direito "Inspecionar elemento", sem exigir que o usuário abra a árvore
 * manualmente até achar onde clicou. */
function findPath(node: DomNode, targetId: string, path: string[] = []): string[] | null {
  const next = [...path, node.id];
  if (node.id === targetId) return next;
  for (const child of node.children) {
    const found = findPath(child, targetId, next);
    if (found) return found;
  }
  return null;
}

function ElementsTree({
  node,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  node: DomNode;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const attrPreview = Object.entries(node.attrs)
    .slice(0, 3)
    .map(([k, v]) => ` ${k}="${v.length > 24 ? v.slice(0, 24) + "…" : v}"`)
    .join("");
  return (
    <div className={styles.treeNode}>
      <div
        className={styles.treeLine}
        data-role="inspector-tree-line"
        data-node-id={node.id}
        data-tag={node.tag}
        data-selected={selectedId === node.id || undefined}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <button
            className={styles.treeToggle}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
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
              key={child.id}
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

export function BrowserInspector({
  id,
  cardSize,
  initialFocusPoint,
  onEmulationChange,
  onDockChange,
  deviceToolbarOpen,
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
  onEmulationChange?: (dims: { width: number; height: number; zoom: "fit" | "1" | "0.75" | "0.5" } | null) => void;
  /** O dock é um overlay ABSOLUTO por cima do canvas, de propósito (não
   * reflow — ver o doc comment no topo de BrowserCard.module.css), então
   * BrowserCard.tsx não tem como saber sozinho quanto espaço o painel
   * está cobrindo agora. Sem isto, o device-frame centralizado (device-
   * frame model, item 3) centraliza contra a largura CHEIA do corpo do
   * card e cai atrás do próprio painel que o abriu — achado ao vivo
   * comparando `getBoundingClientRect()` do canvas com um screenshot real
   * (o frame existia, com a proporção certa, mas invisível, escondido
   * embaixo do dock). */
  onDockChange?: (dock: Dock, size: number) => void;
  /** DESIGN-BACKLOG.md §2.1 item 4 — decisão do usuário: a barra de
   * dispositivo deixa de ser sempre visível, vira um toggle no address
   * bar de BrowserCard.tsx (ícone de celular), escondida por padrão. O
   * estado mora lá (sobrevive ao inspector fechar/reabrir) porque o
   * BOTÃO que liga isto vive lá, não aqui. */
  deviceToolbarOpen: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("elements");
  const [tree, setTree] = useState<DomNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detailsSubtab, setDetailsSubtab] = useState<DetailsSubtab>("styles");
  const [elementStyles, setElementStyles] = useState<ElementStyles | null>(null);
  const [loadingStyles, setLoadingStyles] = useState(false);
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

  const [storageArea, setStorageArea] = useState<StorageArea>("local");
  const [localItems, setLocalItems] = useState<[string, string][]>([]);
  const [sessionItems, setSessionItems] = useState<[string, string][]>([]);
  const [cookieItems, setCookieItems] = useState<
    { name: string; value: string; domain: string; path: string; expirationDate?: number; httpOnly: boolean; secure: boolean; sameSite: string }[]
  >([]);
  const [loadingStorage, setLoadingStorage] = useState(false);

  // Aba Network — `getNetwork` já existia no registry pro lado MCP
  // (tap de `session.webRequest`, sem CDP); só faltava a UI alcançá-lo.
  // Snapshot pull (igual `getConsole`), não push ao vivo — um botão
  // "Atualizar" cobre requisições novas sem precisar reabrir a aba.
  const [networkRows, setNetworkRows] = useState<NetworkLine[]>([]);
  const [loadingNetwork, setLoadingNetwork] = useState(false);
  const [networkOnlyFailed, setNetworkOnlyFailed] = useState(false);

  async function refreshTree() {
    setLoadingTree(true);
    const snapshot = await evalJson<SnapshotResult>(id, SNAPSHOT_SCRIPT);
    setTree(snapshot?.root ?? null);
    setTreeTruncated(snapshot?.truncated ?? false);
    setLoadingTree(false);
    if (!snapshot) return;
    const point = focusPointRef.current;
    focusPointRef.current = null;
    if (point) {
      const targetId = await evalJson<string | null>(id, elementAtPointScript(point.x, point.y));
      if (targetId) {
        const path = findPath(snapshot.root, targetId);
        if (path) {
          setExpanded((prev) => new Set([...prev, ...path]));
          setSelectedId(targetId);
          void window.browser.evalJs(id, highlightScript(targetId));
          return;
        }
      }
    }
    // Sem alvo específico — abre pelo menos a raiz, senão a árvore
    // inteira nasce fechada e parece vazia.
    setExpanded((prev) => (prev.size > 0 ? prev : new Set([snapshot.root.id])));
  }

  useEffect(() => {
    void refreshTree();
    return () => {
      void window.browser.evalJs(id, highlightScript(null));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  async function refreshNetwork() {
    setLoadingNetwork(true);
    const res = await window.browser.getNetwork(id);
    setNetworkRows(res.ok ? res.requests : []);
    setLoadingNetwork(false);
  }

  useEffect(() => {
    if (tab === "network") void refreshNetwork();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  // Painel de detalhes (Styles/Computed) — refaz a busca sempre que a
  // seleção mudar. `selectedId` pode apontar pra um `data-stellar-el-id`
  // que não existe mais depois de um `refreshTree()` (a numeração
  // reinicia a cada snapshot novo, ver comentário do `SNAPSHOT_SCRIPT`) —
  // `elementStylesScript` já devolve `null` nesse caso e a UI mostra um
  // estado vazio em vez de dado velho/quebrado.
  useEffect(() => {
    if (tab !== "elements" || !selectedId) {
      setElementStyles(null);
      return;
    }
    let cancelled = false;
    setLoadingStyles(true);
    void evalJson<ElementStyles>(id, elementStylesScript(selectedId)).then((res) => {
      if (cancelled) return;
      setElementStyles(res);
      setLoadingStyles(false);
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

  function selectNode(nodeId: string) {
    setSelectedId(nodeId);
    void window.browser.evalJs(id, highlightScript(nodeId));
  }

  function toggleNode(nodeId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
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

  function applyEmulation(width: number, height: number, deviceScaleFactor: number, mobile: boolean, label: string) {
    setActiveEmulation({ width, height, deviceScaleFactor, mobile, label });
    setCustomW(width);
    setCustomH(height);
    void window.browser.setDeviceEmulation(id, { width, height, deviceScaleFactor, mobile });
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
  const onDockChangeRef = useRef(onDockChange);
  onDockChangeRef.current = onDockChange;

  // Avisa BrowserCard.tsx (dono do <canvas>) do que está realmente
  // aplicado agora — dispara de novo a cada mudança real de emulação OU
  // de zoom de exibição, nunca por causa da identidade da própria função
  // (ver comentário do ref acima).
  useEffect(() => {
    onEmulationChangeRef.current?.(activeEmulation ? { width: activeEmulation.width, height: activeEmulation.height, zoom: frameZoom } : null);
  }, [activeEmulation, frameZoom]);

  // Idem, pro lado/tamanho do dock — só importa enquanto o painel existe
  // (`inspectorOpen` do lado de BrowserCard.tsx já cobre "painel fechado").
  useEffect(() => {
    onDockChangeRef.current?.(dock, panelSizes[dock]);
  }, [dock, panelSizes]);

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
  function onResizePointerMove(e: React.PointerEvent) {
    const r = resizingRef.current;
    if (!r) return;
    const pos = r.dock === "bottom" ? e.clientY : e.clientX;
    const delta = pos - r.start;
    const signed = r.dock === "right" ? -delta : r.dock === "left" ? delta : -delta;
    const next = Math.max(DOCK_MIN[r.dock], Math.min(DOCK_MAX[r.dock], r.startSize + signed));
    setPanelSizes((prev) => ({ ...prev, [r.dock]: next }));
  }
  function endResize() {
    resizingRef.current = null;
  }

  const panelSizeStyle = dock === "bottom" ? { height: panelSizes.bottom } : { width: panelSizes[dock] };

  return (
    <div
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
          value={customW}
          onChange={(e) => setCustomW(Number(e.target.value) || 0)}
        />
        <span className={styles.deviceX}>×</span>
        <input
          type="number"
          data-role="inspector-custom-height"
          className={styles.deviceDim}
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
        <div className={styles.inspectorTabsSpacer} />
        {tab === "elements" && (
          <button title="Atualizar árvore" onClick={() => void refreshTree()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        {tab === "network" && (
          <button title="Atualizar requisições" onClick={() => void refreshNetwork()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        {tab === "application" && (
          <button title="Atualizar" onClick={() => void refreshStorage()}>
            <Icon name="reload" size={13} />
          </button>
        )}
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
      <div className={styles.inspectorBody}>
        {tab === "elements" && (
          <div className={styles.elementsSplit}>
            <div className={styles.tree} data-role="inspector-tree">
              {loadingTree ? (
                <div className={styles.inspectorEmpty}>Carregando árvore…</div>
              ) : tree ? (
                <>
                  {treeTruncated && (
                    <div className={styles.treeTruncatedNotice} data-role="inspector-tree-truncated">
                      Página grande demais pra mostrar por completo — exibindo os primeiros {SNAPSHOT_NODE_BUDGET} elementos.
                    </div>
                  )}
                  <ElementsTree node={tree} selectedId={selectedId} expanded={expanded} onToggle={toggleNode} onSelect={selectNode} />
                </>
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
              </div>
              <div className={styles.subpanel} data-role="inspector-subpanel">
                {!selectedId ? (
                  <div className={styles.inspectorEmpty}>Selecione um elemento na árvore.</div>
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
              {loadingNetwork ? (
                <div className={styles.inspectorEmpty}>Carregando requisições…</div>
              ) : networkRows.length === 0 ? (
                <div className={styles.inspectorEmpty}>Nenhuma requisição registrada ainda.</div>
              ) : (
                <table className={styles.storageTable} data-role="inspector-network-table">
                  <thead>
                    <tr>
                      <th>Método</th>
                      <th>URL</th>
                      <th>Status</th>
                      <th>Quando</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkRows
                      .filter((r) => !networkOnlyFailed || r.error !== undefined || r.status === null || r.status >= 400)
                      .map((r, i) => (
                        <tr key={i} data-role="inspector-network-row">
                          <td>{r.method}</td>
                          <td className={styles.networkUrl} title={r.url}>
                            {r.url}
                          </td>
                          <td data-severity={r.status !== null && r.status < 400 && !r.error ? "ok" : "error"}>{r.error ? "erro" : (r.status ?? "—")}</td>
                          <td>{new Date(r.at).toLocaleTimeString()}</td>
                        </tr>
                      ))}
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
      </div>
    </div>
  );
}
