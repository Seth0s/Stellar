import { lazy, Suspense, useEffect, useRef, useState } from "react";
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

type DomNode = { id: string; tag: string; attrs: Record<string, string>; children: DomNode[]; text: string };
type SnapshotResult = { root: DomNode; truncated: boolean; nodeCount: number };
type ConsoleLine = { level: string; message: string; at: number };
type Tab = "elements" | "console" | "network" | "application" | "sources" | "performance";
type SourceEntry = { url: string; kind: "document" | "script" | "stylesheet" };
type NetworkLine = { method: string; url: string; status: number | null; error?: string; at: number };
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

// Event Listeners (DESIGN-BACKLOG.md §2.1 item 6) — sem `webContents.
// debugger`/CDP (decisão explícita deste projeto, ver os doc comments
// acima de `openDevTools`/`setDeviceEmulation` em browser-registry.ts),
// não existe jeito de enumerar listeners registrados via
// `addEventListener` de FORA da página depois do fato — isso é
// exatamente o que a DevTools real usa o protocolo do V8 Inspector pra
// fazer, e é a razão de este projeto ter escolhido não depender de CDP
// em primeiro lugar. O que ESTE script consegue ver honestamente, só com
// `evalJs` (mesmo mecanismo de todo o resto do inspector): as
// propriedades IDL `on<evento>` do elemento — cobre handlers via atributo
// HTML (`onclick="..."`, o navegador compila isso na mesma propriedade)
// E via atribuição direta (`el.onclick = fn`), mas NUNCA
// `addEventListener` puro (a forma mais comum em código moderno,
// inclusive frameworks como React). A UI (`ListenersPanel` abaixo) deixa
// esse limite explícito — mostrar uma lista vazia sem essa ressalva
// enganaria o usuário a achar que o elemento não tem NENHUM listener.
const LISTENER_EVENTS = [
  "click", "dblclick", "mousedown", "mouseup", "mouseenter", "mouseleave", "mouseover", "mouseout", "mousemove", "contextmenu",
  "keydown", "keyup", "keypress",
  "input", "change", "submit", "reset", "focus", "blur", "focusin", "focusout",
  "dragstart", "dragend", "dragover", "dragenter", "dragleave", "drop",
  "touchstart", "touchend", "touchmove", "touchcancel",
  "pointerdown", "pointerup", "pointermove", "pointerenter", "pointerleave",
  "wheel", "scroll", "load", "error", "animationend", "transitionend", "toggle",
];

function elementListenersScript(elId: string): string {
  return `
(() => {
  const el = document.querySelector('[data-stellar-el-id="${elId}"]');
  if (!el) return null;
  const found = [];
  for (const event of ${JSON.stringify(LISTENER_EVENTS)}) {
    if (typeof el["on" + event] === "function") found.push({ event });
  }
  return found;
})()
`;
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

function ListenersPanel({ entries }: { entries: ListenerEntry[] }) {
  return (
    <>
      <div className={styles.listenersNotice} data-role="inspector-listeners-notice">
        Só mostra handlers via atributo HTML (<code>onclick=&quot;…&quot;</code>) ou atribuição direta (<code>el.onclick = fn</code>) — listeners
        registrados via <code>addEventListener</code> exigiriam o protocolo do DevTools (CDP), que este inspector não usa.
      </div>
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
  const [tab, setTab] = useState<Tab>("elements");
  const [tree, setTree] = useState<DomNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  // Aba Network — `getNetwork` já existia no registry pro lado MCP
  // (tap de `session.webRequest`, sem CDP); só faltava a UI alcançá-lo.
  // Snapshot pull (igual `getConsole`), não push ao vivo — um botão
  // "Atualizar" cobre requisições novas sem precisar reabrir a aba.
  const [networkRows, setNetworkRows] = useState<NetworkLine[]>([]);
  const [loadingNetwork, setLoadingNetwork] = useState(false);
  const [networkOnlyFailed, setNetworkOnlyFailed] = useState(false);

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
  // Contagem pro grid de estatísticas — busca própria, independente de
  // `networkRows`/`consoleEntries` das outras abas (Performance pode ser
  // a PRIMEIRA aba aberta, sem ninguém ter visitado Network ainda).
  const [perfNetworkSummary, setPerfNetworkSummary] = useState<{ total: number; failed: number } | null>(null);

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

  // Mesma ideia do efeito de Styles/Computed acima, mas pra Event
  // Listeners — busca separada (não a mesma chamada de `evalJs`) porque
  // `elementListenersScript` é um instrumento independente, não uma
  // ampliação de `elementStylesScript`.
  useEffect(() => {
    if (tab !== "elements" || !selectedId) {
      setElementListeners(null);
      return;
    }
    let cancelled = false;
    setLoadingListeners(true);
    void evalJson<ListenerEntry[]>(id, elementListenersScript(selectedId)).then((res) => {
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
    const width = r.axis === "bottom" ? r.startW : Math.round(Math.max(100, Math.min(3000, r.startW + dx)));
    const height = r.axis === "right" ? r.startH : Math.round(Math.max(100, Math.min(3000, r.startH + dy)));
    applyEmulation(width, height, activeEmulation.deviceScaleFactor, width < 768, `${width}×${height} (personalizado)`);
  }
  function endFrameResize() {
    frameResizeRef.current = null;
  }

  const panelSizeStyle = dock === "bottom" ? { height: panelSizes.bottom } : { width: panelSizes[dock] };

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
          <button title="Atualizar requisições" onClick={() => void refreshNetwork()}>
            <Icon name="reload" size={13} />
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
                  {/* DESIGN-BACKLOG.md §2.1 item 7 — o gutter de breakpoint
                      do protótipo fica DESABILITADO de propósito, não
                      esquecido: abrir um breakpoint de verdade (pausar a
                      execução de verdade) exige o protocolo do V8
                      Inspector (`webContents.debugger`/CDP), que este
                      projeto decidiu não usar (mesma decisão por trás do
                      limite de Event Listeners acima). Fingir um gutter
                      clicável sem nenhum breakpoint real por trás seria
                      exatamente o tipo de controle decorativo que este
                      projeto evita (mesmo raciocínio do "SEM THROTTLING"
                      não construído no device toolbar). */}
                  <div className={styles.sourceBreakpointNotice} data-role="inspector-breakpoint-notice">
                    Breakpoints desabilitados — pausar a execução de verdade exige o protocolo do DevTools (CDP), que este inspector não usa. Somente
                    leitura.
                  </div>
                  {sourceContent.truncated && (
                    <div className={styles.sourceTruncatedNotice} data-role="inspector-source-truncated">
                      Arquivo grande demais pra mostrar por completo — exibindo os primeiros {sourceContent.content.length.toLocaleString("pt-BR")} de{" "}
                      {sourceContent.totalChars.toLocaleString("pt-BR")} caracteres.
                    </div>
                  )}
                  <Suspense fallback={<div className={styles.inspectorEmpty}>Carregando editor…</div>}>
                    <CodeEditor key={selectedSourceUrl} value={sourceContent.content} onChange={() => {}} filename={selectedSourceUrl} readOnly />
                  </Suspense>
                </>
              )}
            </div>
          </div>
        )}
        {tab === "performance" && (
          <div className={styles.performance} data-role="inspector-performance">
            {/* DESIGN-BACKLOG.md §2.1 item 8 — nota honesta permanente,
                mesmo espírito do aviso de Event Listeners/Sources: sem
                CDP, não tem profiling de verdade (call stacks, flame
                graph, sample de JS/layout/paint isolados) — só o que dá
                pra medir de fora: taxa de frame real (o mesmo sinal que
                já pinta o canvas) e CPU/memória do processo offscreen
                (`app.getAppMetrics()`, a mesma API do Task Manager). */}
            <div className={styles.perfNotice} data-role="inspector-performance-notice">
              Sem profiling de verdade (exigiria o protocolo do DevTools/CDP) — só métricas reais que dão pra medir de fora: taxa de frame ao vivo e
              CPU/memória do processo.
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
