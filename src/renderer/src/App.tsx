import { useEffect, useRef, useState } from "react";
import { TerminalCard } from "./TerminalCard";
import { FilesCard } from "./FilesCard";
import { ChangesCard } from "./ChangesCard";
import { StickyCard } from "./StickyCard";
import { BrowserCard } from "./BrowserCard";
import { RemoteWindowCard } from "./RemoteWindowCard";
import { StrokeCard, STROKE_COLORS } from "./StrokeCard";
import { BrowserAskModal } from "./BrowserAskModal";
import { ConfirmModal } from "./ConfirmModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import { RemotePairingModal } from "./RemotePairingModal";
import { Rail } from "./Rail";
import { Topbar } from "./Topbar";
import { Titlebar } from "./Titlebar";
import { Hint } from "./Hint";
import { ToastHost } from "./ToastHost";
import { toast } from "./useToast";
import {
  bboxOf,
  cascadeSlot,
  centeredSlot,
  clipLineToRect,
  isInView,
  pointSlot,
  quadraticControlPoint,
  rectCenter,
  rectsOverlap,
  worldRectToScreen,
  type Point,
  type Rect,
} from "./board-model";
import type { BoardCounts, CardRow } from "../../preload/index";
import { useWorldTransform } from "./useWorldTransform";
import { useConnectorDrag } from "./useConnectorDrag";
import { useCardSelection } from "./useCardSelection";
import { useBoardStore } from "./useBoardStore";
import type { Card, Connector, StickyCardData, Tool } from "./card-types";
import "./app.css";

const DEFAULT_CWD = "/home/lucas/Workplace/Projects/agent-canvas";
/** The multi-repo workspace this app itself lives in (see CLAUDE.md at
 * this path) — its top-level directories are real sibling projects
 * (CentralByte, IdyPlatform, ...), offered as a real picker for "which
 * project is this session for" (item 1 follow-up: the user wants to
 * *select* a workspace, not type one blind). */
const WORKSPACE_ROOT = "/home/lucas/Workplace/Projects";

/** Suggests a project name for a new session (item 1) from the workspace
 * convention this very app lives in — the path segment right after
 * ".../Projects/" (e.g. "agent-canvas", "CentralByte"). Free-text and
 * editable in the UI, never re-derived once a session exists; just a
 * starting point, not a source of truth. */
function suggestProjectFromCwd(cwd: string): string {
  const match = cwd.match(/\/Projects\/([^/]+)/);
  return match ? match[1] : "";
}
const PROVIDER_OPTIONS = ["bash", "claude", "codex", "cursor"];
const MIN_STROKE_POINTS = 2;
const MIN_STROKE_DISTANCE = 2;
const STROKE_PADDING = 8;
const REFLOW_MS = 320;
const GRID_SPACING = 28;
const ZOOM_STEP = 1.15;

const KIND_LABEL: Record<Card["kind"], string> = {
  terminal: "terminal",
  files: "arquivos",
  changes: "changes",
  sticky: "nota adesiva",
  browser: "navegador",
  "remote-window": "janela externa",
  stroke: "desenho",
};

/** Canvas background pattern — per-viewer preference (not per-board data,
 * doesn't need to sync/persist to the store), cycled by a topbar button.
 * "dots" is the original look; "grid"/"lines" answer the "personalização
 * de fundo com coordenadas/linhas" ask (graph paper / ruled notebook
 * paper); "plain" for when any pattern is unwanted. */
type BgStyle = "dots" | "grid" | "lines" | "plain";
const BG_STYLE_KEY = "ac.bgStyle";
const BG_STYLE_ORDER: BgStyle[] = ["dots", "grid", "lines", "plain"];
const BG_STYLE_LABEL: Record<BgStyle, string> = { dots: "pontos", grid: "grade", lines: "linhas", plain: "liso" };

function backgroundCss(style: BgStyle, dotSize: number, panX: number, panY: number): React.CSSProperties {
  const backgroundPosition = `${panX % dotSize}px ${panY % dotSize}px`;
  switch (style) {
    case "dots":
      return {
        backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.14) 1px, transparent 1px)",
        backgroundSize: `${dotSize}px ${dotSize}px`,
        backgroundPosition,
      };
    case "grid":
      return {
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px), " +
          "linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px)",
        backgroundSize: `${dotSize}px ${dotSize}px`,
        backgroundPosition,
      };
    case "lines":
      // 2x the spacing of the other styles — reads as ruled notebook paper,
      // not a measurement grid.
      return {
        backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)",
        backgroundSize: `${dotSize * 2}px ${dotSize * 2}px`,
        backgroundPosition,
      };
    case "plain":
      return {};
  }
}

// files/changes/sticky don't use provider/resume_id/model/system_prompt for
// their vendor meaning — the generic `cards` schema is reused as-is (no
// migration) by repurposing `cwd` (root path, or sticky note content) and
// `provider` (unused/"" for files+changes, sticky's color for sticky).
function toRow(card: Card, boardId: string): CardRow {
  const base = {
    id: card.id,
    board_id: boardId,
    group_id: card.groupId,
    label: card.label,
    updated_at: Date.now(),
    ...card.rect,
  };
  switch (card.kind) {
    case "terminal":
      return {
        ...base,
        kind: "terminal",
        provider: card.provider,
        cwd: card.cwd,
        resume_id: card.resumeId,
        model: card.model,
        system_prompt: card.systemPrompt,
      };
    case "files":
      return { ...base, kind: "files", provider: "", cwd: card.root, resume_id: null, model: null, system_prompt: null };
    case "changes":
      return { ...base, kind: "changes", provider: "", cwd: card.root, resume_id: null, model: null, system_prompt: null };
    case "sticky":
      return {
        ...base,
        kind: "sticky",
        provider: card.color,
        cwd: card.content,
        resume_id: null,
        model: null,
        system_prompt: null,
      };
    case "browser":
      return {
        ...base,
        kind: "browser",
        provider: card.ownerCardId ?? "",
        cwd: card.url,
        resume_id: null,
        model: null,
        system_prompt: null,
      };
    case "remote-window":
      return { ...base, kind: "remote-window", provider: "", cwd: "", resume_id: null, model: null, system_prompt: null };
    case "stroke":
      return {
        ...base,
        kind: "stroke",
        provider: card.color,
        cwd: JSON.stringify({ points: card.points, width: card.width, style: card.style }),
        resume_id: null,
        model: null,
        system_prompt: null,
      };
  }
}

const DEFAULT_STROKE_WIDTH = 3;

/** Accepts the current `{points, width, style}` shape and the legacy bare
 * `[number,number][]` rows written before the pen panel (item 3) existed —
 * any other/malformed shape renders as an empty stroke rather than crash. */
function parseStroke(raw: string): { points: [number, number][]; width: number; style: "solid" | "marker" } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { points: parsed, width: DEFAULT_STROKE_WIDTH, style: "solid" };
    if (parsed && Array.isArray(parsed.points)) {
      return {
        points: parsed.points,
        width: typeof parsed.width === "number" ? parsed.width : DEFAULT_STROKE_WIDTH,
        style: parsed.style === "marker" ? "marker" : "solid",
      };
    }
  } catch {
    // malformed/legacy row — render as an empty stroke rather than crash.
  }
  return { points: [], width: DEFAULT_STROKE_WIDTH, style: "solid" };
}

function fromRow(r: CardRow): Card {
  const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  const groupId = r.group_id ?? null;
  const label = r.label ?? null;
  switch (r.kind) {
    case "files":
      return { id: r.id, kind: "files", root: r.cwd, rect, groupId, label };
    case "changes":
      return { id: r.id, kind: "changes", root: r.cwd, rect, groupId, label };
    case "sticky":
      return { id: r.id, kind: "sticky", content: r.cwd, color: r.provider || "yellow", rect, groupId, label };
    case "browser":
      return { id: r.id, kind: "browser", url: r.cwd, ownerCardId: r.provider || null, rect, groupId, label };
    case "remote-window":
      return { id: r.id, kind: "remote-window", rect, groupId, label };
    case "stroke": {
      const { points, width, style } = parseStroke(r.cwd);
      return {
        id: r.id,
        kind: "stroke",
        points,
        width,
        style,
        color: r.provider || STROKE_COLORS[0],
        rect,
        groupId,
        label,
      };
    }
    default:
      return {
        id: r.id,
        kind: "terminal",
        provider: r.provider,
        cwd: r.cwd,
        resumeId: r.resume_id,
        continueLast: false,
        model: r.model,
        systemPrompt: r.system_prompt,
        label,
        rect,
        groupId,
      };
  }
}

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [newProvider, setNewProvider] = useState("bash");
  const [newResumeId, setNewResumeId] = useState("");
  const [newContinueLast, setNewContinueLast] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [newSystemPrompt, setNewSystemPrompt] = useState("");
  const [seenUrls, setSeenUrls] = useState<Record<string, string[]>>({});
  const [pendingAsk, setPendingAsk] = useState<{ requestId: string; requesterId: string; url: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [tool, setTool] = useState<Tool>("pointer");
  const [newStrokeColor, setNewStrokeColor] = useState<string>(STROKE_COLORS[0]);
  const [newStrokeWidth, setNewStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH);
  const [newStrokeStyle, setNewStrokeStyle] = useState<"solid" | "marker">("solid");
  const [drawingPoints, setDrawingPoints] = useState<Point[] | null>(null);
  /** Cards mid-close-animation — still rendered (with the .closing class),
   * removed from `cards` only once that finishes (see finalizeCloseCard). */
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [bgStyle, setBgStyle] = useState<BgStyle>(() => {
    const saved = localStorage.getItem(BG_STYLE_KEY);
    return (BG_STYLE_ORDER as string[]).includes(saved ?? "") ? (saved as BgStyle) : "dots";
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** Right-click on empty canvas (item 1's alternate spawn path) — `screen`
   * positions the menu itself, `world` is where the chosen card lands
   * (`pointSlot`), captured once at open time so panning/zooming while the
   * menu is open doesn't retarget the spawn. */
  const [radialMenu, setRadialMenu] = useState<{ screen: Point; world: Point } | null>(null);
  const [showRemotePairing, setShowRemotePairing] = useState(false);
  /** Set only when closeCard needs confirmation first (a terminal card
   * whose process is still live) — see closeCard/confirmCloseCard below. */
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [reflowing, setReflowing] = useState(false);
  /** Live per-card status (item 1) — only ever populated for the currently
   * loaded board's terminal cards (see TerminalCard's onStatusChange); every
   * OTHER board's "ativos" count falls back to the structural proxy from
   * `boardCounts` (provider !== "bash"), since a non-loaded board's PTYs
   * aren't running at all (switching boards kills them, see AGENTS.md). */
  const [liveStatus, setLiveStatus] = useState<Record<string, "ok" | "error" | "exited">>({});
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>([]);
  const nextId = useRef(1);
  const cardsRef = useRef<Card[]>([]);
  cardsRef.current = cards;
  const {
    world,
    setWorld,
    worldRef,
    viewportRef,
    viewportSize,
    viewportOrigin,
    visibleRect,
    clientToWorld,
    zoomBy,
    fitView,
    onWheel,
    startPan,
  } = useWorldTransform(cardsRef);
  const {
    loaded,
    boards,
    activeBoardId,
    activeBoardIdRef,
    boardCounts,
    switchBoard,
    createBoard,
    renameBoard,
    changeBoardProject,
    deleteBoard,
  } = useBoardStore(
    nextId,
    setCards,
    setOrder,
    setConnectors,
    setWorld,
    () => setLiveStatus({}),
    DEFAULT_CWD,
    toRow,
    fromRow,
  );

  useEffect(() => {
    const offUrlSeen = window.pty.onUrlSeen((id, url) => {
      setSeenUrls((prev) => (prev[id]?.includes(url) ? prev : { ...prev, [id]: [...(prev[id] ?? []), url] }));
    });
    const offAskOpen = window.browser.onAskOpen((requestId, requesterId, url) => {
      setPendingAsk({ requestId, requesterId, url });
    });
    // acbridge snapshot (item 4, DESIGN-BACKLOG.md) — main asks "what's on
    // screen for this target right now", only the renderer has the live
    // pan/zoom to answer. Reads cardsRef/worldRef (not `cards`/`world`
    // directly) since this listener is registered once at mount and needs
    // whatever's current at call time, not what was current when it was
    // registered.
    const offSnapshot = window.snapshot.onRectRequest((requestId, target) => {
      const vp = viewportRef.current?.getBoundingClientRect();
      const origin = vp ? { x: vp.x, y: vp.y } : { x: 0, y: 0 };
      let worldRect: Rect | null = null;
      if ("rect" in target) {
        worldRect = target.rect;
      } else {
        const card = cardsRef.current.find((c) => c.id === target.cardId);
        worldRect = card?.rect ?? null;
      }
      if (!worldRect) {
        window.snapshot.replyRect(requestId, null);
        return;
      }
      const screen = worldRectToScreen(worldRect, worldRef.current, origin);
      window.snapshot.replyRect(requestId, {
        x: Math.round(screen.x),
        y: Math.round(screen.y),
        width: Math.round(screen.w),
        height: Math.round(screen.h),
      });
    });
    return () => {
      offUrlSeen();
      offAskOpen();
      offSnapshot();
    };
  }, []);

  // Real sibling project directories, for the "select a project" picker
  // (item 1 follow-up) — best-effort: an unreadable/moved workspace root
  // just leaves the picker with only the free-text fallback, never blocks
  // the app.
  useEffect(() => {
    window.fs
      .list(WORKSPACE_ROOT, "")
      .then((entries) => setWorkspaceProjects(entries.filter((e) => e.isDir).map((e) => e.name)))
      .catch(() => {});
  }, []);

  // Escape exits pen/connector tool mode. Not required for correctness —
  // releasing the pointer already ends any in-progress stroke/connector
  // drag on its own (both are plain pointerdown→window pointermove/up
  // closures, immune to this component re-rendering) — just a cheap,
  // obvious way out for anyone who forgets which tool is active.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setTool("pointer");
        setShowShortcuts(false);
        setPendingCloseId(null);
        setRadialMenu(null);
        setShowRemotePairing(false);
      }
      if (e.key === "F11") {
        e.preventDefault();
        void window.winControls.toggleFullscreen();
        return;
      }
      // Single-letter tool shortcuts (documented in the pen panel, item 3) —
      // never fire while the user is typing into a real input (sticky note,
      // files editor, browser address bar, any popover field).
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "v" || e.key === "V") setTool("pointer");
      if (e.key === "p" || e.key === "P") setTool("pen");
      if (e.key === "c" || e.key === "C") setTool("connector");
      if (e.key === "s" || e.key === "S") setTool("select");
      // "?" (shift+/ on most layouts, but e.key already reports the shifted
      // character) — see DESIGN-BACKLOG.md item 1: shortcuts existed but
      // were only discoverable inside the pen panel's own popover.
      if (e.key === "?") setShowShortcuts((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function raise(id: string) {
    setOrder((prev) => [...prev.filter((x) => x !== id), id]);
  }

  function addCard(card: Card) {
    setCards((prev) => [...prev, card]);
    setOrder((prev) => [...prev, card.id]);
    void window.store.upsert(toRow(card, activeBoardIdRef.current!));
    toast(`${KIND_LABEL[card.kind]} criado${card.kind === "sticky" ? "a" : ""}`);
  }

  function addConnector(fromCardId: string, toCardId: string) {
    const id = String(nextId.current++);
    const connector = { id, fromCardId, toCardId };
    setConnectors((prev) => [...prev, connector]);
    void window.store.connectors.upsert({
      id,
      board_id: activeBoardIdRef.current!,
      from_card_id: fromCardId,
      to_card_id: toCardId,
      updated_at: Date.now(),
    });
    toast("conector criado");
  }

  const { connectorDraft, startConnectorDrag } = useConnectorDrag(clientToWorld, cardsRef, order, addConnector);
  const { selectedIds, setSelectedIds, marquee, startMarqueeSelect, selectCard, groupSelected, ungroupSelected } =
    useCardSelection(cardsRef, setCards, activeBoardIdRef, nextId, clientToWorld, toRow);

  function removeConnector(id: string) {
    setConnectors((prev) => prev.filter((c) => c.id !== id));
    void window.store.connectors.delete(id);
    toast("conector removido");
  }

  /** Finalizes a pen stroke into a real `kind:"stroke"` card — its rect is the drawn bounding box, not the toolbar-button cascade slot. */
  function finishStroke(points: Point[], color: string) {
    if (points.length < MIN_STROKE_POINTS) return;
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const w = maxX - minX + STROKE_PADDING * 2;
    const h = maxY - minY + STROKE_PADDING * 2;
    if (w <= STROKE_PADDING * 2 || h <= STROKE_PADDING * 2) return;
    const normalized: [number, number][] = points.map((p) => [
      (p.x - minX + STROKE_PADDING) / w,
      (p.y - minY + STROKE_PADDING) / h,
    ]);
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "stroke",
      points: normalized,
      color,
      width: newStrokeWidth,
      style: newStrokeStyle,
      rect: { x: minX - STROKE_PADDING, y: minY - STROKE_PADDING, w, h },
      groupId: null,
      label: null,
    });
  }

  /** `at`: world point to spawn at (radial menu, item 1) — omitted for the
   * rail's own buttons, which keep centering on the visible viewport. */
  function addTerminalCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "terminal",
      provider: newProvider,
      cwd: DEFAULT_CWD,
      resumeId: newResumeId.trim() || null,
      continueLast: newResumeId.trim() === "" && newContinueLast,
      model: newModel.trim() || null,
      systemPrompt: newSystemPrompt.trim() || null,
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  function addFilesCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "files",
      root: DEFAULT_CWD,
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  function addChangesCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "changes",
      root: DEFAULT_CWD,
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  function addStickyCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "sticky",
      content: "",
      color: "yellow",
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  /** Human path, via the rail button or radial menu — no owner, no consent gate (see AGENTS.md). */
  function addBrowserCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "browser",
      url: "about:blank",
      ownerCardId: null,
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  function addRemoteWindowCard(at?: Point) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "remote-window",
      rect: at ? pointSlot(at) : centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  /** Agent-requested (post-Allow) or a seenUrls chip click — both are already-consented. Reuses this owner's existing browser card if one is open, else opens a new one. No toast here — this path isn't the human "I just clicked +browser" moment the toasts above are for. */
  function openBrowserFor(ownerCardId: string | null, url: string) {
    const existing = cardsRef.current.find((c) => c.kind === "browser" && c.ownerCardId === ownerCardId);
    if (existing) {
      void window.browser.navigate(existing.id, url);
      raise(existing.id);
      void window.browser.raise(existing.id);
      return;
    }
    const id = String(nextId.current++);
    const card: Card = {
      id,
      kind: "browser",
      url,
      ownerCardId,
      rect: centeredSlot(visibleRect, cardsRef.current.length),
      groupId: null,
      label: null,
    };
    setCards((prev) => [...prev, card]);
    setOrder((prev) => [...prev, id]);
    void window.store.upsert(toRow(card, activeBoardIdRef.current!));
  }

  function allowAsk() {
    if (!pendingAsk) return;
    const { requestId, requesterId, url } = pendingAsk;
    setPendingAsk(null);
    openBrowserFor(requesterId, url);
    void window.browser.resolveAsk(requestId, true);
  }

  function denyAsk() {
    if (!pendingAsk) return;
    void window.browser.resolveAsk(pendingAsk.requestId, false);
    setPendingAsk(null);
  }

  /** Reuses cascadeSlot (already the grid a new card lands on) — reorganize is just re-running that grid over every existing card. */
  function aiReorganize() {
    const next = cardsRef.current.map((c, i) => ({ ...c, rect: cascadeSlot(i) }));
    setReflowing(true);
    setCards(next);
    next.forEach((c) => void window.store.upsert(toRow(c, activeBoardIdRef.current!)));
    toast("Cards organizados");
    window.setTimeout(() => setReflowing(false), REFLOW_MS);
  }

  /** Read-only snapshot for the AI action below — never mutates a card, never reads terminal scrollback (out of scope, see AGENTS.md). */
  async function buildBoardSnapshot(): Promise<string> {
    const lines: string[] = [];
    for (const c of cardsRef.current) {
      if (c.kind === "sticky") {
        lines.push(`- [nota adesiva, ${c.color}] ${c.content || "(vazia)"}`);
      } else if (c.kind === "files") {
        lines.push(`- [arquivos] raiz: ${c.root}`);
      } else if (c.kind === "changes") {
        try {
          const status = await window.git.status(c.root);
          if (!status.repo) {
            lines.push(`- [changes] raiz: ${c.root} (não é um repositório git)`);
          } else {
            const entries = status.entries.map((e) => `${e.status} ${e.path}`).join(", ");
            lines.push(
              `- [changes] raiz: ${c.root} (branch ${status.branch}, +${status.insertions}/-${status.deletions}${
                entries ? `: ${entries}` : ""
              })`,
            );
          }
        } catch {
          lines.push(`- [changes] raiz: ${c.root} (status indisponível)`);
        }
      } else if (c.kind === "browser") {
        lines.push(`- [navegador] ${c.url}`);
      } else if (c.kind === "stroke") {
        lines.push(`- [desenho] ${c.points.length} pontos`);
      } else if (c.kind === "remote-window") {
        lines.push(`- [janela externa] controle remoto`);
      } else {
        lines.push(`- [terminal ${c.provider}] cwd: ${c.cwd}`);
      }
    }
    for (const conn of connectors) {
      lines.push(`- [conector] ${describeCard(conn.fromCardId)} → ${describeCard(conn.toCardId)}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(board vazio)";
  }

  /** "Resumir" — the only AI action implemented so far. Read-only: the result becomes a new sticky note, nothing on the board is mutated on the AI's behalf (see AGENTS.md). */
  async function summarizeBoard() {
    if (newProvider === "bash" || aiBusy) return;
    setAiBusy(true);
    try {
      const snapshot = await buildBoardSnapshot();
      const prompt =
        `Aqui está o estado atual de um board de cards (canvas de trabalho):\n\n${snapshot}\n\n` +
        "Resuma esse estado em 2-4 frases, em português. Não use nenhuma ferramenta, responda só com o texto do resumo.";
      const result = await window.ai.summarize(newProvider, DEFAULT_CWD, prompt);
      const id = String(nextId.current++);
      const content = "text" in result ? result.text : `Erro: ${result.error}`;
      addCard({ id, kind: "sticky", content, color: "blue", rect: cascadeSlot(cardsRef.current.length), groupId: null, label: null });
      toast("Nota de resumo criada");
    } finally {
      setAiBusy(false);
    }
  }

  function describeCard(id: string): string {
    const c = cardsRef.current.find((x) => x.id === id);
    if (c?.kind === "terminal") return `${c.provider} #${id}`;
    return `card #${id}`;
  }

  /** The actual removal — cards/order/connectors/selection/liveStatus state
   * plus the store. Split from `closeCard` below so the close animation can
   * play first: the DOM node has to still exist while `.closing`'s
   * animation runs, so this only fires once that animation ends, not on
   * the click that requested the close. */
  function finalizeCloseCard(id: string) {
    setCards((prev) => prev.filter((c) => c.id !== id));
    setOrder((prev) => prev.filter((x) => x !== id));
    setConnectors((prev) => prev.filter((c) => c.fromCardId !== id && c.toCardId !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setLiveStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setClosingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void window.store.delete(id);
    void window.store.connectors.deleteForCard(id);
  }

  /** Every card's own onClose calls this, not finalizeCloseCard directly —
   * marks the card as closing (CardFrame renders it with the .closing
   * animation class) and lets the animation's own end event trigger the
   * real removal. Also schedules finalizeCloseCard as a plain timeout, not
   * just on animationend: `prefers-reduced-motion: reduce` drops the
   * animation entirely (animations.css), which means no animationend event
   * ever fires — without this fallback the card would stay stuck forever
   * for anyone with that preference set. finalizeCloseCard no-ops safely
   * if called twice (whichever path fires first wins). */
  function beginCloseAnimation(id: string) {
    setClosingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setTimeout(() => finalizeCloseCard(id), 180);
  }

  /** A terminal card whose process hasn't reported "error"/"exited" yet is
   * assumed live — closing it kills a real running process, with no undo
   * (DESIGN-BACKLOG.md item 7: closing was instant and irreversible, the
   * one item flagged as an actual data-loss risk rather than convenience).
   * Every other card kind, and a terminal that's already dead, closes
   * immediately same as before — there's nothing to lose there, and
   * demanding confirmation for a files/sticky/browser card would just be
   * friction with no safety benefit. */
  function closeCard(id: string) {
    const card = cardsRef.current.find((c) => c.id === id);
    const isLiveTerminal = card?.kind === "terminal" && liveStatus[id] !== "error" && liveStatus[id] !== "exited";
    if (isLiveTerminal) {
      setPendingCloseId(id);
      return;
    }
    beginCloseAnimation(id);
  }

  function confirmCloseCard() {
    if (!pendingCloseId) return;
    beginCloseAnimation(pendingCloseId);
    setPendingCloseId(null);
  }

  function cancelCloseCard() {
    setPendingCloseId(null);
  }

  function cycleBgStyle() {
    setBgStyle((prev) => {
      const next = BG_STYLE_ORDER[(BG_STYLE_ORDER.indexOf(prev) + 1) % BG_STYLE_ORDER.length];
      localStorage.setItem(BG_STYLE_KEY, next);
      return next;
    });
  }

  function renameCard(id: string, label: string) {
    setCards((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, label } : c));
      const updated = next.find((c) => c.id === id);
      if (updated) void window.store.upsert(toRow(updated, activeBoardIdRef.current!));
      return next;
    });
  }

  function handleTerminalStatus(id: string, status: "ok" | "error" | "exited") {
    setLiveStatus((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }

  /** Moving a grouped card (item 4 — "just organization") drags every other
   * member of its group by the same delta. A resize never triggers this:
   * CardFrame's resize handler holds x/y fixed, so dx/dy is 0 and every
   * sibling's rect map is a no-op. */
  function changeRect(id: string, rect: Rect) {
    setCards((prev) => {
      const moving = prev.find((c) => c.id === id);
      if (!moving?.groupId) return prev.map((c) => (c.id === id ? { ...c, rect } : c));
      const dx = rect.x - moving.rect.x;
      const dy = rect.y - moving.rect.y;
      return prev.map((c) => {
        if (c.id === id) return { ...c, rect };
        if (c.groupId === moving.groupId) return { ...c, rect: { ...c.rect, x: c.rect.x + dx, y: c.rect.y + dy } };
        return c;
      });
    });
  }

  /**
   * A native browser view always paints above every DOM card regardless of
   * z-index — there's no way to make a dragged terminal/files/sticky card
   * visually cover a browser card the way DOM cards cover each other. Same
   * mitigation CentralByte's Fase 1 used for the identical structural
   * problem (native VTE over DOM): reject the move outright instead of
   * pretending overlap works.
   */
  function tryChangeRect(id: string, rect: Rect) {
    const moving = cardsRef.current.find((c) => c.id === id);
    if (!moving) return;
    const collides = cardsRef.current.some(
      (other) =>
        other.id !== id &&
        (moving.kind === "browser" || other.kind === "browser") &&
        rectsOverlap(rect, other.rect),
    );
    if (collides) return;
    changeRect(id, rect);
  }

  function commitRect(card: Card, rect: Rect) {
    void window.store.upsert(toRow({ ...card, rect }, activeBoardIdRef.current!));
    // changeRect already shifted every group sibling's rect in local state
    // during the drag (onChange fires per pointermove, ahead of this
    // pointerup-only commit) — persist their up-to-date rects too, reading
    // from cardsRef so it's the post-drag values, not `card`'s stale ones.
    if (card.groupId) {
      for (const sibling of cardsRef.current) {
        if (sibling.id !== card.id && sibling.groupId === card.groupId) {
          void window.store.upsert(toRow(sibling, activeBoardIdRef.current!));
        }
      }
    }
  }

  function resumeIdDiscovered(id: string, sessionId: string) {
    setCards((prev) => {
      const next = prev.map((c) => (c.id === id && c.kind === "terminal" ? { ...c, resumeId: sessionId } : c));
      const updated = next.find((c) => c.id === id);
      if (updated) void window.store.upsert(toRow(updated, activeBoardIdRef.current!));
      return next;
    });
  }

  function changeStickyContent(id: string, content: string) {
    setCards((prev) => prev.map((c) => (c.id === id && c.kind === "sticky" ? { ...c, content } : c)));
  }

  function commitStickyContent(card: StickyCardData, content: string) {
    void window.store.upsert(toRow({ ...card, content }, activeBoardIdRef.current!));
  }

  function commitStickyColor(card: StickyCardData, color: string) {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "sticky" ? { ...c, color } : c)));
    void window.store.upsert(toRow({ ...card, color }, activeBoardIdRef.current!));
  }

  function startDrawing(e: React.PointerEvent) {
    const points: Point[] = [];
    function addPoint(clientX: number, clientY: number) {
      const p = clientToWorld(clientX, clientY);
      const last = points[points.length - 1];
      if (last) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (Math.sqrt(dx * dx + dy * dy) < MIN_STROKE_DISTANCE) return;
      }
      points.push(p);
      setDrawingPoints([...points]);
    }
    addPoint(e.clientX, e.clientY);
    function onMove(ev: PointerEvent) {
      addPoint(ev.clientX, ev.clientY);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrawingPoints(null);
      finishStroke(points, newStrokeColor);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return;
    if (tool === "pen") {
      startDrawing(e);
      return;
    }
    if (tool === "select") {
      startMarqueeSelect(e);
      return;
    }
    if (tool === "connector") return;
    startPan(e);
  }

  /** Right-click on empty canvas opens the radial menu (item 1) instead of
   * the OS/Electron context menu — a card only, so a right-click on the
   * pen/select tools' own drag gestures isn't hijacked mid-drag. */
  function onBackgroundContextMenu(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setRadialMenu({ screen: { x: e.clientX, y: e.clientY }, world: clientToWorld(e.clientX, e.clientY) });
  }

  function selectRadialAction(action: RadialAction) {
    const at = radialMenu?.world;
    setRadialMenu(null);
    if (!at) return;
    if (action === "terminal") addTerminalCard(at);
    else if (action === "files") addFilesCard(at);
    else if (action === "changes") addChangesCard(at);
    else if (action === "sticky") addStickyCard(at);
    else if (action === "browser") addBrowserCard(at);
    else addRemoteWindowCard(at);
  }

  if (!loaded) return <div className="viewport" />;

  const dotSize = GRID_SPACING * world.zoom;
  const backgroundStyle = backgroundCss(bgStyle, dotSize, world.panX, world.panY);

  const selectedCards = cards.filter((c) => selectedIds.has(c.id));
  const canGroup = tool === "select" && selectedCards.length >= 2;
  const commonGroupId =
    selectedCards.length > 0 && selectedCards.every((c) => c.groupId && c.groupId === selectedCards[0].groupId)
      ? selectedCards[0].groupId
      : null;
  const canUngroup = tool === "select" && commonGroupId !== null;

  // Live override for the active board only (see liveStatus's comment) —
  // every other board keeps the structural proxy fetched over IPC.
  const activeTerminalCards = cards.filter((c) => c.kind === "terminal");
  const effectiveBoardCounts: Record<string, BoardCounts> = activeBoardId
    ? {
        ...boardCounts,
        [activeBoardId]: {
          agents: activeTerminalCards.length,
          active: activeTerminalCards.filter((c) => liveStatus[c.id] !== "error" && liveStatus[c.id] !== "exited")
            .length,
        },
      }
    : boardCounts;

  return (
    <div
      className="viewport"
      ref={viewportRef}
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
      onContextMenu={onBackgroundContextMenu}
      style={backgroundStyle}
    >
      <Titlebar />
      <div
        className="world"
        style={{ transform: `translate(${world.panX}px, ${world.panY}px) scale(${world.zoom})` }}
      >
        {cards.map((c) => {
          const zIndex = order.indexOf(c.id);
          const interactionMode = tool === "connector" ? "connector" : tool === "select" ? "select" : "normal";
          const onConnectorStart = (e: React.PointerEvent) => startConnectorDrag(c.id, e);
          const onSelectStart = (e: React.PointerEvent) => selectCard(c.id, e);
          const selected = selectedIds.has(c.id);
          if (c.kind === "terminal") {
            return (
              <TerminalCard
                key={c.id}
                id={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                providerId={c.provider}
                cwd={c.cwd}
                resumeId={c.resumeId}
                continueLast={c.continueLast}
                model={c.model}
                systemPrompt={c.systemPrompt}
                visible={isInView(c.rect, visibleRect)}
                seenUrls={seenUrls[c.id] ?? []}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                label={c.label}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onResumeIdDiscovered={(sessionId) => resumeIdDiscovered(c.id, sessionId)}
                onStatusChange={(status) => handleTerminalStatus(c.id, status)}
                onOpenUrl={(url) => openBrowserFor(null, url)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          if (c.kind === "files") {
            return (
              <FilesCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                root={c.root}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                label={c.label}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          if (c.kind === "changes") {
            return (
              <ChangesCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                root={c.root}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                label={c.label}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          if (c.kind === "sticky") {
            return (
              <StickyCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                content={c.content}
                color={c.color}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                label={c.label}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onContentChange={(content) => changeStickyContent(c.id, content)}
                onContentCommit={(content) => commitStickyContent(c, content)}
                onColorCommit={(color) => commitStickyColor(c, color)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          if (c.kind === "stroke") {
            return (
              <StrokeCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                points={c.points}
                color={c.color}
                width={c.width}
                style={c.style}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          if (c.kind === "remote-window") {
            return (
              <RemoteWindowCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                label={c.label}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
              />
            );
          }
          return (
            <BrowserCard
              key={c.id}
              id={c.id}
              rect={c.rect}
              zoom={world.zoom}
              zIndex={zIndex}
              world={world}
              viewportOrigin={viewportOrigin}
              viewportSize={viewportSize}
              visible={isInView(c.rect, visibleRect)}
              url={c.url}
              ownerCardId={c.ownerCardId}
              interactionMode={interactionMode}
              reflowing={reflowing}
              closing={closingIds.has(c.id)}
              onChange={(r) => tryChangeRect(c.id, r)}
              onCommit={(r) => commitRect(c, r)}
              onRaise={() => raise(c.id)}
              onClose={() => closeCard(c.id)}
              onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
              onConnectorStart={onConnectorStart}
              onSelectStart={onSelectStart}
              selected={selected}
            />
          );
        })}
        <svg className="board-overlay">
          <defs>
            <marker id="connector-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--foam)" }} />
            </marker>
          </defs>
          {(() => {
            const groupIds = new Set(cards.map((c) => c.groupId).filter((g): g is string => g !== null));
            const GROUP_PAD = 10;
            return [...groupIds].map((gid) => {
              const box = bboxOf(cards.filter((c) => c.groupId === gid).map((c) => c.rect));
              if (!box) return null;
              return (
                <rect
                  key={`group-${gid}`}
                  className="group-outline"
                  x={box.x - GROUP_PAD}
                  y={box.y - GROUP_PAD}
                  width={box.w + GROUP_PAD * 2}
                  height={box.h + GROUP_PAD * 2}
                />
              );
            });
          })()}
          {connectors.map((conn) => {
            const from = cards.find((c) => c.id === conn.fromCardId);
            const to = cards.find((c) => c.id === conn.toCardId);
            if (!from || !to) return null;
            const fromCenter = rectCenter(from.rect);
            const toCenter = rectCenter(to.rect);
            const start = clipLineToRect(fromCenter, toCenter, from.rect);
            const end = clipLineToRect(toCenter, fromCenter, to.rect);
            const control = quadraticControlPoint(start, end, 0.18);
            const midX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
            const midY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
            return (
              <g key={conn.id}>
                <path
                  className="connector-line"
                  d={`M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`}
                  markerEnd="url(#connector-arrow)"
                />
                <g
                  className="connector-delete"
                  style={{ pointerEvents: "auto" }}
                  transform={`translate(${midX}, ${midY})`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => removeConnector(conn.id)}
                >
                  <circle r={8} />
                  <text x={0} y={1} textAnchor="middle" dominantBaseline="middle">
                    ×
                  </text>
                </g>
              </g>
            );
          })}
          {connectorDraft &&
            (() => {
              const from = cards.find((c) => c.id === connectorDraft.fromId);
              if (!from) return null;
              const fromCenter = rectCenter(from.rect);
              const start = clipLineToRect(fromCenter, connectorDraft.point, from.rect);
              const control = quadraticControlPoint(start, connectorDraft.point, 0.18);
              return (
                <path
                  className="connector-draft"
                  d={`M${start.x},${start.y} Q${control.x},${control.y} ${connectorDraft.point.x},${connectorDraft.point.y}`}
                />
              );
            })()}
          {drawingPoints && drawingPoints.length > 1 && (
            <polyline
              className="pen-preview"
              points={drawingPoints.map((p) => `${p.x},${p.y}`).join(" ")}
              stroke={newStrokeColor}
              strokeWidth={newStrokeStyle === "marker" ? newStrokeWidth * 1.8 : newStrokeWidth}
              strokeOpacity={newStrokeStyle === "marker" ? 0.55 : 1}
            />
          )}
          {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
        </svg>
      </div>
      <Rail
        tool={tool}
        setTool={setTool}
        strokeColors={STROKE_COLORS}
        strokeColor={newStrokeColor}
        setStrokeColor={setNewStrokeColor}
        strokeWidth={newStrokeWidth}
        setStrokeWidth={setNewStrokeWidth}
        strokeStyle={newStrokeStyle}
        setStrokeStyle={setNewStrokeStyle}
        canGroup={canGroup}
        canUngroup={canUngroup}
        onGroup={groupSelected}
        onUngroup={ungroupSelected}
        providers={PROVIDER_OPTIONS}
        newProvider={newProvider}
        setNewProvider={setNewProvider}
        newResumeId={newResumeId}
        setNewResumeId={setNewResumeId}
        newContinueLast={newContinueLast}
        setNewContinueLast={setNewContinueLast}
        newModel={newModel}
        setNewModel={setNewModel}
        newSystemPrompt={newSystemPrompt}
        setNewSystemPrompt={setNewSystemPrompt}
        onCreateTerminal={addTerminalCard}
        // Real bug found and fixed while verifying an unrelated refactor
        // (see AGENTS.md): these five are wired straight to a native
        // `onClick`, which React calls with the SyntheticEvent as the
        // first argument — `addXCard`'s optional `at?: Point` (added for
        // the radial menu, item 1) silently received that event object as
        // `at` (truthy, so the `at ? pointSlot(at) : ...` branch always
        // won), and `pointSlot(event)` read `event.x`/`.y` — undefined on
        // a React SyntheticEvent — producing NaN coordinates that render
        // as (0,0). `onCreateTerminal` above is safe as-is because
        // Rail.tsx's own popover button already calls it with zero
        // arguments explicitly; these five call the setter directly.
        onCreateFiles={() => addFilesCard()}
        onCreateChanges={() => addChangesCard()}
        onCreateSticky={() => addStickyCard()}
        onCreateBrowser={() => addBrowserCard()}
        onCreateRemoteWindow={() => addRemoteWindowCard()}
        aiBusy={aiBusy}
        summarizeDisabled={newProvider === "bash"}
        onReorganize={aiReorganize}
        onSummarize={summarizeBoard}
      />
      <Topbar
        boards={boards}
        activeBoardId={activeBoardId!}
        boardCounts={effectiveBoardCounts}
        suggestedProject={suggestProjectFromCwd(DEFAULT_CWD)}
        availableProjects={workspaceProjects}
        zoom={world.zoom}
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onFit={fitView}
        bgStyleLabel={BG_STYLE_LABEL[bgStyle]}
        onCycleBgStyle={cycleBgStyle}
        onOpenRemote={() => setShowRemotePairing(true)}
        onSwitchBoard={switchBoard}
        onCreateBoard={createBoard}
        onRenameBoard={renameBoard}
        onChangeProject={changeBoardProject}
        onDeleteBoard={deleteBoard}
      />
      <Hint />
      <ToastHost />
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      {showRemotePairing && <RemotePairingModal onClose={() => setShowRemotePairing(false)} />}
      {radialMenu && (
        <RadialMenu
          x={radialMenu.screen.x}
          y={radialMenu.screen.y}
          onSelect={selectRadialAction}
          onClose={() => setRadialMenu(null)}
        />
      )}
      {pendingCloseId && (
        <ConfirmModal
          title="Fechar terminal?"
          message={`${describeCard(pendingCloseId)} ainda está rodando — fechar encerra o processo agora, sem como desfazer.`}
          confirmLabel="Fechar"
          danger
          onConfirm={confirmCloseCard}
          onCancel={cancelCloseCard}
        />
      )}
      {pendingAsk && (
        <BrowserAskModal
          url={pendingAsk.url}
          requesterLabel={describeCard(pendingAsk.requesterId)}
          onAllow={allowAsk}
          onDeny={denyAsk}
        />
      )}
    </div>
  );
}
