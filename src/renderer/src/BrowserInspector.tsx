import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import styles from "./BrowserInspector.module.css";

/** Pendentes #188 — mini-inspector embutido no card, pedido explícito do
 * usuário depois de ver que o DevTools real só abre numa janela
 * separada (Electron não sabe pintar a UI do DevTools dentro de um
 * webContents offscreen — ver browser-registry.ts's `openDevTools` doc
 * comment). Em vez disso: um Elements/Console/Responsive PRÓPRIO,
 * construído inteiramente em cima de `evalJs` (já existia, só exposto
 * pro lado MCP até agora) — sem CDP/`webContents.debugger`, sem
 * mecanismo novo no main process além do `setDeviceEmulation` da aba
 * Responsive. Vive dentro do próprio card (drawer sobreposto na parte
 * de baixo do canvas), nunca uma janela nova. */

type DomNode = { id: string; tag: string; attrs: Record<string, string>; children: DomNode[]; text: string };
type ConsoleLine = { level: string; message: string; at: number };
type Tab = "elements" | "console" | "responsive";

export type ResponsivePreset = { label: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean };

const RESPONSIVE_PRESETS: ResponsivePreset[] = [
  { label: "Mobile (390×844)", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  { label: "Tablet (768×1024)", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  { label: "Desktop (1280×800)", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
];

// Cada elemento ganha um `data-stellar-el-id` estável (só até o próximo
// snapshot) — é assim que "clicar num nó da árvore" consegue destacar o
// elemento de VERDADE na página renderizada, sem precisar reconstruir um
// seletor CSS frágil. Retorna o objeto puro (não uma string) — `evalJs`
// (browser-registry.ts) já faz o `JSON.stringify` sozinho.
const SNAPSHOT_SCRIPT = `
(() => {
  let n = 0;
  function walk(el, depth) {
    if (!el || depth > 14) return null;
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
  return walk(document.documentElement, 0);
})()
`;

function highlightScript(elId: string | null): string {
  return `
    (() => {
      document.querySelectorAll("[data-stellar-highlighted]").forEach((el) => {
        el.style.outline = "";
        el.removeAttribute("data-stellar-highlighted");
      });
      ${
        elId
          ? `const el = document.querySelector('[data-stellar-el-id="${elId}"]');
      if (el) {
        el.setAttribute("data-stellar-highlighted", "1");
        el.style.outline = "2px solid #ff5a5f";
        el.style.outlineOffset = "-1px";
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

export function BrowserInspector({
  id,
  cardSize,
  initialFocusPoint,
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
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("elements");
  const [tree, setTree] = useState<DomNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [consoleEntries, setConsoleEntries] = useState<ConsoleLine[]>([]);
  const [consoleInput, setConsoleInput] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const focusPointRef = useRef(initialFocusPoint);

  async function refreshTree() {
    setLoadingTree(true);
    const snapshot = await evalJson<DomNode>(id, SNAPSHOT_SCRIPT);
    setTree(snapshot);
    setLoadingTree(false);
    if (!snapshot) return;
    const point = focusPointRef.current;
    focusPointRef.current = null;
    if (point) {
      const targetId = await evalJson<string | null>(id, elementAtPointScript(point.x, point.y));
      if (targetId) {
        const path = findPath(snapshot, targetId);
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
    setExpanded((prev) => (prev.size > 0 ? prev : new Set([snapshot.id])));
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

  function togglePreset(preset: ResponsivePreset) {
    if (activePreset === preset.label) {
      setActivePreset(null);
      disableEmulation();
    } else {
      setActivePreset(preset.label);
      void window.browser.setDeviceEmulation(id, preset);
    }
  }

  // `activePresetRef`/`cardSizeRef` abaixo — o efeito de desmontagem só
  // roda uma vez (deps `[id]`), então sua closure capturaria pra sempre o
  // `activePreset`/`cardSize` de quando o componente MONTOU, não o valor
  // real no momento em que o inspector realmente fecha (um preset ligado
  // DEPOIS da montagem nunca seria desligado ao fechar). Refs espelhados
  // a cada render leem o valor atual de verdade dentro da cleanup.
  const activePresetRef = useRef(activePreset);
  activePresetRef.current = activePreset;
  const cardSizeRef = useRef(cardSize);
  cardSizeRef.current = cardSize;

  // Desliga a emulação de dispositivo se o card fechar o inspector (ou
  // desmontar) com um preset ainda ativo — não deve sobreviver ao
  // inspector fechado, senão a página fica "presa" num viewport mobile
  // sem nenhum controle visível pra desligar.
  useEffect(
    () => () => {
      if (activePresetRef.current) {
        void window.browser.setDeviceEmulation(id, null);
        void window.browser.resize(id, cardSizeRef.current.w, cardSizeRef.current.h);
      }
    },
    [id],
  );

  return (
    <div
      className={styles.inspector}
      data-role="browser-inspector"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className={styles.inspectorTabs}>
        <button data-role="inspector-tab" data-tab="elements" data-active={tab === "elements" || undefined} onClick={() => setTab("elements")}>
          Elements
        </button>
        <button data-role="inspector-tab" data-tab="console" data-active={tab === "console" || undefined} onClick={() => setTab("console")}>
          Console
        </button>
        <button data-role="inspector-tab" data-tab="responsive" data-active={tab === "responsive" || undefined} onClick={() => setTab("responsive")}>
          Responsivo
        </button>
        <div className={styles.inspectorTabsSpacer} />
        {tab === "elements" && (
          <button title="Atualizar árvore" onClick={() => void refreshTree()}>
            <Icon name="reload" size={13} />
          </button>
        )}
        <button title="Fechar inspector" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className={styles.inspectorBody}>
        {tab === "elements" &&
          (loadingTree ? (
            <div className={styles.inspectorEmpty}>Carregando árvore…</div>
          ) : tree ? (
            <div className={styles.tree} data-role="inspector-tree">
              <ElementsTree node={tree} selectedId={selectedId} expanded={expanded} onToggle={toggleNode} onSelect={selectNode} />
            </div>
          ) : (
            <div className={styles.inspectorEmpty}>Não foi possível ler a página.</div>
          ))}
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
        {tab === "responsive" && (
          <div className={styles.responsive}>
            <p className={styles.responsiveHint}>
              Emulação de dispositivo de verdade (viewport, DPR, media query mobile) — diferente de só redimensionar o
              card.
            </p>
            {RESPONSIVE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                data-role="inspector-responsive-preset"
                data-label={preset.label}
                data-active={activePreset === preset.label || undefined}
                onClick={() => togglePreset(preset)}
              >
                <Icon name={preset.mobile ? "viewportMobile" : "viewportTablet"} size={14} />
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
