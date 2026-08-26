import { useEffect, useRef, useState } from "react";
import { TerminalCard } from "./TerminalCard";
import { FilesCard } from "./FilesCard";
import { ChangesCard } from "./ChangesCard";
import { StickyCard } from "./StickyCard";
import { BrowserCard } from "./BrowserCard";
import { StrokeCard, STROKE_COLORS } from "./StrokeCard";
import { BrowserAskModal } from "./BrowserAskModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
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
  hitTest,
  isInView,
  quadraticControlPoint,
  rectCenter,
  rectsOverlap,
  screenToWorld,
  viewportWorldRect,
  type BoardItem,
  type Point,
  type Rect,
} from "./board-model";
import type { BoardCounts, BoardRow, CardRow } from "../../preload/index";
import "./app.css";

/** `label` is a user-set display name (header rename) — null means "use the
 * kind-specific default" (provider id for terminals, KIND_LABEL for
 * everything else), never re-derived once set. */
type BaseCard = { id: string; rect: Rect; groupId: string | null; label: string | null };

type TerminalCardData = BaseCard & {
  kind: "terminal";
  provider: string;
  cwd: string;
  resumeId: string | null;
  /** One-shot launch preference, never persisted (see AGENTS.md) — always false for a card restored from the store. */
  continueLast: boolean;
  model: string | null;
  systemPrompt: string | null;
};

type FilesCardData = BaseCard & { kind: "files"; root: string };
type ChangesCardData = BaseCard & { kind: "changes"; root: string };
type StickyCardData = BaseCard & { kind: "sticky"; content: string; color: string };
type BrowserCardData = BaseCard & { kind: "browser"; url: string; ownerCardId: string | null };
type StrokeCardData = BaseCard & {
  kind: "stroke";
  points: [number, number][];
  color: string;
  width: number;
  style: "solid" | "marker";
};

type Card =
  | TerminalCardData
  | FilesCardData
  | ChangesCardData
  | StickyCardData
  | BrowserCardData
  | StrokeCardData;

type Connector = { id: string; fromCardId: string; toCardId: string };
type Tool = "pointer" | "pen" | "connector" | "select";

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
  stroke: "desenho",
};

const ACTIVE_BOARD_KEY = "ac.activeBoardId";

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
  const [loaded, setLoaded] = useState(false);
  const [world, setWorld] = useState({ panX: 0, panY: 0, zoom: 1 });
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
  const [connectorDraft, setConnectorDraft] = useState<{ fromId: string; point: Point } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Cards mid-close-animation — still rendered (with the .closing class),
   * removed from `cards` only once that finishes (see finalizeCloseCard). */
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [bgStyle, setBgStyle] = useState<BgStyle>(() => {
    const saved = localStorage.getItem(BG_STYLE_KEY);
    return (BG_STYLE_ORDER as string[]).includes(saved ?? "") ? (saved as BgStyle) : "dots";
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [reflowing, setReflowing] = useState(false);
  const [boards, setBoards] = useState<BoardRow[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardCounts, setBoardCounts] = useState<Record<string, BoardCounts>>({});
  /** Live per-card status (item 1) — only ever populated for the currently
   * loaded board's terminal cards (see TerminalCard's onStatusChange); every
   * OTHER board's "ativos" count falls back to the structural proxy from
   * `boardCounts` (provider !== "bash"), since a non-loaded board's PTYs
   * aren't running at all (switching boards kills them, see AGENTS.md). */
  const [liveStatus, setLiveStatus] = useState<Record<string, "ok" | "error" | "exited">>({});
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>([]);
  const nextId = useRef(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<Card[]>([]);
  cardsRef.current = cards;
  const activeBoardIdRef = useRef<string | null>(null);
  activeBoardIdRef.current = activeBoardId;

  useEffect(() => {
    const offUrlSeen = window.pty.onUrlSeen((id, url) => {
      setSeenUrls((prev) => (prev[id]?.includes(url) ? prev : { ...prev, [id]: [...(prev[id] ?? []), url] }));
    });
    const offAskOpen = window.browser.onAskOpen((requestId, requesterId, url) => {
      setPendingAsk({ requestId, requesterId, url });
    });
    return () => {
      offUrlSeen();
      offAskOpen();
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

  /** Swaps the whole board in: cards/connectors of the previous board are
   * replaced wholesale, which unmounts their card components — that's what
   * actually stops a departing board's terminal PTYs/browser views (see
   * AGENTS.md, "switching boards" — no special-case cleanup code needed,
   * it's a natural consequence of the id sets no longer overlapping). A
   * board with no rows yet (brand new, or the very first launch) seeds one
   * bash terminal, same as the original single-board bootstrap did. */
  function refreshBoardCounts() {
    void window.store.cardCounts().then(setBoardCounts);
  }

  async function loadBoard(boardId: string) {
    const [rows, connectorRows] = await Promise.all([
      window.store.list(boardId),
      window.store.connectors.list(boardId),
    ]);
    setConnectors(connectorRows.map((r) => ({ id: r.id, fromCardId: r.from_card_id, toCardId: r.to_card_id })));
    setWorld({ panX: 0, panY: 0, zoom: 1 });
    // Every id here belonged to the departing board — never valid for
    // whatever loads next (see the module comment on liveStatus above).
    setLiveStatus({});
    if (rows.length === 0) {
      const id = String(nextId.current++);
      const card: Card = {
        id,
        kind: "terminal",
        provider: "bash",
        cwd: DEFAULT_CWD,
        resumeId: null,
        continueLast: false,
        model: null,
        systemPrompt: null,
        rect: cascadeSlot(0),
        groupId: null,
        label: null,
      };
      setCards([card]);
      setOrder([id]);
      void window.store.upsert(toRow(card, boardId));
    } else {
      const restored = rows.map(fromRow);
      setCards(restored);
      setOrder(restored.map((c) => c.id));
    }
    refreshBoardCounts();
  }

  useEffect(() => {
    (async () => {
      const [fetchedBoards, seed] = await Promise.all([window.store.boards.list(), window.store.nextIdSeed()]);
      nextId.current = seed + 1;
      setBoards(fetchedBoards);
      const stored = localStorage.getItem(ACTIVE_BOARD_KEY);
      const initial = fetchedBoards.find((b) => b.id === stored)?.id ?? fetchedBoards[0]?.id ?? "default";
      setActiveBoardId(initial);
      await loadBoard(initial);
      setLoaded(true);
    })();
  }, []);

  async function switchBoard(id: string) {
    if (id === activeBoardIdRef.current) return;
    setActiveBoardId(id);
    localStorage.setItem(ACTIVE_BOARD_KEY, id);
    await loadBoard(id);
  }

  async function createBoard(name: string, project: string) {
    const id = String(nextId.current++);
    const now = Date.now();
    const board: BoardRow = { id, name, project, created_at: now, updated_at: now };
    setBoards((prev) => [...prev, board]);
    void window.store.boards.upsert(board);
    await switchBoard(id);
    toast(`sessão "${name}" criada`);
  }

  function renameBoard(id: string, name: string) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, name, updated_at: Date.now() } : b)));
    const board = boards.find((b) => b.id === id);
    if (board) void window.store.boards.upsert({ ...board, name, updated_at: Date.now() });
  }

  function changeBoardProject(id: string, project: string) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, project, updated_at: Date.now() } : b)));
    const board = boards.find((b) => b.id === id);
    if (board) void window.store.boards.upsert({ ...board, project, updated_at: Date.now() });
  }

  async function deleteBoard(id: string) {
    if (boards.length <= 1) return;
    const remaining = boards.filter((b) => b.id !== id);
    setBoards(remaining);
    void window.store.boards.delete(id);
    refreshBoardCounts();
    if (id === activeBoardIdRef.current) {
      const next = remaining[0].id;
      setActiveBoardId(next);
      localStorage.setItem(ACTIVE_BOARD_KEY, next);
      await loadBoard(next);
    }
    toast("sessão excluída");
  }

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

  function addTerminalCard() {
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
      rect: centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  function addFilesCard() {
    const id = String(nextId.current++);
    addCard({ id, kind: "files", root: DEFAULT_CWD, rect: centeredSlot(visibleRect, cards.length), groupId: null, label: null });
  }

  function addChangesCard() {
    const id = String(nextId.current++);
    addCard({ id, kind: "changes", root: DEFAULT_CWD, rect: centeredSlot(visibleRect, cards.length), groupId: null, label: null });
  }

  function addStickyCard() {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "sticky",
      content: "",
      color: "yellow",
      rect: centeredSlot(visibleRect, cards.length),
      groupId: null,
      label: null,
    });
  }

  /** Human path, via the rail button — no owner, no consent gate (see AGENTS.md). */
  function addBrowserCard() {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "browser",
      url: "about:blank",
      ownerCardId: null,
      rect: centeredSlot(visibleRect, cards.length),
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

  function zoomBy(factor: number) {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    setWorld((prev) => {
      const newZoom = Math.min(3, Math.max(0.2, prev.zoom * factor));
      const worldX = (vw / 2 - prev.panX) / prev.zoom;
      const worldY = (vh / 2 - prev.panY) / prev.zoom;
      return { zoom: newZoom, panX: vw / 2 - newZoom * worldX, panY: vh / 2 - newZoom * worldY };
    });
  }

  function fitView() {
    const vp = viewportRef.current;
    const box = bboxOf(cardsRef.current.map((c) => c.rect));
    if (!vp || !box) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const PAD = 60;
    const scale = Math.min((vw - PAD * 2) / box.w, (vh - PAD * 2) / box.h);
    const zoom = Math.min(3, Math.max(0.2, scale));
    setWorld({
      zoom,
      panX: vw / 2 - (box.x + box.w / 2) * zoom,
      panY: vh / 2 - (box.y + box.h / 2) * zoom,
    });
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
  function closeCard(id: string) {
    setClosingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setTimeout(() => finalizeCloseCard(id), 180);
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

  /** Group/ungroup (item 4) — organizational only, no containment or shared
   * rect: grouping just stamps a shared `groupId` (reusing the same global
   * id counter every other id in this app already shares) so a drag on any
   * member moves the rest together (see changeRect above). */
  function groupSelected() {
    if (selectedIds.size < 2) return;
    const groupId = String(nextId.current++);
    const next = cardsRef.current.map((c) => (selectedIds.has(c.id) ? { ...c, groupId } : c));
    setCards(next);
    for (const c of next) if (selectedIds.has(c.id)) void window.store.upsert(toRow(c, activeBoardIdRef.current!));
    toast("cards agrupados");
  }

  function ungroupSelected() {
    const next = cardsRef.current.map((c) => (selectedIds.has(c.id) ? { ...c, groupId: null } : c));
    setCards(next);
    for (const c of next) if (selectedIds.has(c.id)) void window.store.upsert(toRow(c, activeBoardIdRef.current!));
    toast("grupo desfeito");
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

  /** Screen client coords -> world coords, via the viewport's own current bounding rect (matches onWheel's math). */
  function clientToWorld(clientX: number, clientY: number): Point {
    const rect = viewportRef.current?.getBoundingClientRect();
    return screenToWorld({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }, world);
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

  /** Drag from a card, in "connector" tool mode, to another card — released via CardFrame.onConnectorStart. */
  function startConnectorDrag(fromId: string, e: React.PointerEvent) {
    e.stopPropagation();
    setConnectorDraft({ fromId, point: clientToWorld(e.clientX, e.clientY) });
    function onMove(ev: PointerEvent) {
      setConnectorDraft({ fromId, point: clientToWorld(ev.clientX, ev.clientY) });
    }
    function onUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setConnectorDraft(null);
      const releasePoint = clientToWorld(ev.clientX, ev.clientY);
      const target = hitTest(cardsRef.current as BoardItem[], releasePoint, order);
      if (target && target.id !== fromId) addConnector(fromId, target.id);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Rubber-band marquee (item 4) — a dedicated tool, deliberately not
   * reusing the pointer tool's own background-drag (that's pan, already
   * fixed/validated in an earlier round — see AGENTS.md). A click without a
   * real drag clears the selection instead of selecting an empty rect. */
  function startMarqueeSelect(e: React.PointerEvent) {
    const startPoint = clientToWorld(e.clientX, e.clientY);
    let currentRect: Rect = { x: startPoint.x, y: startPoint.y, w: 0, h: 0 };
    setMarquee(currentRect);
    function onMove(ev: PointerEvent) {
      const p = clientToWorld(ev.clientX, ev.clientY);
      currentRect = {
        x: Math.min(startPoint.x, p.x),
        y: Math.min(startPoint.y, p.y),
        w: Math.abs(p.x - startPoint.x),
        h: Math.abs(p.y - startPoint.y),
      };
      setMarquee(currentRect);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (currentRect.w < 3 && currentRect.h < 3) {
        setSelectedIds(new Set());
        return;
      }
      const hits = cardsRef.current.filter((c) => rectsOverlap(currentRect, c.rect)).map((c) => c.id);
      setSelectedIds(new Set(hits));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** A click (not drag) directly on a card while the select tool is active —
   * CardFrame routes this here instead of starting its normal drag (see its
   * `interactionMode === "select"` guard). Shift/ctrl adds to the existing
   * selection instead of replacing it. */
  function selectCard(id: string, e: React.PointerEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
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
    const startX = e.clientX;
    const startY = e.clientY;
    const start = world;
    function onMove(ev: PointerEvent) {
      setWorld({ ...start, panX: start.panX + (ev.clientX - startX), panY: start.panY + (ev.clientY - startY) });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    setWorld((prev) => {
      const newZoom = Math.min(3, Math.max(0.2, prev.zoom * factor));
      const worldX = (screenX - prev.panX) / prev.zoom;
      const worldY = (screenY - prev.panY) / prev.zoom;
      return {
        zoom: newZoom,
        panX: screenX - newZoom * worldX,
        panY: screenY - newZoom * worldY,
      };
    });
  }

  if (!loaded) return <div className="viewport" />;

  const viewportSize = viewportRef.current
    ? { width: viewportRef.current.clientWidth, height: viewportRef.current.clientHeight }
    : { width: window.innerWidth, height: window.innerHeight };
  const visibleRect = viewportWorldRect(viewportSize, world);
  const viewportOrigin = viewportRef.current
    ? (() => {
        const r = viewportRef.current!.getBoundingClientRect();
        return { x: r.x, y: r.y };
      })()
    : { x: 0, y: 0 };

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
        onCreateFiles={addFilesCard}
        onCreateChanges={addChangesCard}
        onCreateSticky={addStickyCard}
        onCreateBrowser={addBrowserCard}
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
        onSwitchBoard={switchBoard}
        onCreateBoard={createBoard}
        onRenameBoard={renameBoard}
        onChangeProject={changeBoardProject}
        onDeleteBoard={deleteBoard}
      />
      <Hint />
      <ToastHost />
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
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
