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
type ConsoleLine = { level: string; message: string; at: number };
type Tab = "elements" | "console" | "network" | "application" | "responsive";
type NetworkLine = { method: string; url: string; status: number | null; error?: string; at: number };
type Dock = "right" | "bottom" | "left";
type StorageArea = "local" | "session" | "cookies";

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
  const [activeEmulation, setActiveEmulation] = useState<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean; label: string } | null>(
    null,
  );
  const [customW, setCustomW] = useState(390);
  const [customH, setCustomH] = useState(844);
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

  function togglePreset(preset: ResponsivePreset) {
    if (activeEmulation?.label === preset.label) {
      setActiveEmulation(null);
      disableEmulation();
    } else {
      applyEmulation(preset.width, preset.height, preset.deviceScaleFactor, preset.mobile, preset.label);
    }
  }

  function applyCustomSize() {
    applyEmulation(customW, customH, activeEmulation?.deviceScaleFactor ?? 2, customW < 768, `${customW}×${customH} (personalizado)`);
  }

  function pickRulerWidth(w: number) {
    setCustomW(w);
    applyEmulation(w, activeEmulation?.height ?? customH, activeEmulation?.deviceScaleFactor ?? 2, w < 768, `${w}×${activeEmulation?.height ?? customH} (personalizado)`);
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

  // Desliga a emulação de dispositivo se o card fechar o inspector (ou
  // desmontar) com uma ainda ativa — não deve sobreviver ao inspector
  // fechado, senão a página fica "presa" num viewport mobile sem nenhum
  // controle visível pra desligar.
  useEffect(
    () => () => {
      if (activeEmulationRef.current) {
        void window.browser.setDeviceEmulation(id, null);
        void window.browser.resize(id, cardSizeRef.current.w, cardSizeRef.current.h);
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
        <button data-role="inspector-tab" data-tab="responsive" data-active={tab === "responsive" || undefined} onClick={() => setTab("responsive")}>
          Responsivo
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
                data-active={activeEmulation?.label === preset.label || undefined}
                onClick={() => togglePreset(preset)}
              >
                <Icon name={preset.mobile ? "viewportMobile" : "viewportTablet"} size={14} />
                {preset.label}
              </button>
            ))}
            <div className={styles.customSize}>
              <span className={styles.responsiveHint}>Tamanho personalizado</span>
              <div className={styles.customSizeRow}>
                <input
                  type="number"
                  data-role="inspector-custom-width"
                  value={customW}
                  onChange={(e) => setCustomW(Number(e.target.value) || 0)}
                />
                <span>×</span>
                <input
                  type="number"
                  data-role="inspector-custom-height"
                  value={customH}
                  onChange={(e) => setCustomH(Number(e.target.value) || 0)}
                />
                <button data-role="inspector-apply-custom-size" onClick={applyCustomSize}>
                  Aplicar
                </button>
              </div>
              <div className={styles.widthRuler} data-role="inspector-width-ruler">
                {WIDTH_RULER.map((w) => (
                  <button key={w} data-role="inspector-width-preset" data-width={w} onClick={() => pickRulerWidth(w)}>
                    {w}
                  </button>
                ))}
              </div>
              {activeEmulation && (
                <button
                  className={styles.stopEmulation}
                  data-role="inspector-stop-emulation"
                  onClick={() => {
                    setActiveEmulation(null);
                    disableEmulation();
                  }}
                >
                  Parar emulação ({activeEmulation.label})
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
