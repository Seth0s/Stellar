import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentHowStep, AgentWhoStep } from "./AgentFlow";
import { useAgentProviderRows, type AgentProviderRow } from "./agent-flow-model";
import type { Tool } from "./card-types";
import { t, type MessageKey } from "../../shared/i18n";
import { WIDTH_PRESETS } from "./pen-presets";
import {
  RailGlyphAi,
  RailGlyphBoard,
  RailGlyphConnector,
  RailGlyphExport,
  RailGlyphFind,
  RailGlyphHide,
  RailGlyphHome,
  RailGlyphPalette,
  RailGlyphPen,
  RailGlyphPlus,
  RailGlyphPointer,
  RailGlyphSelect,
  RailGlyphSettings,
  RailGlyphTerminal,
} from "./RailGlyphs";
import { RailBoardPanel, type RailBoardInfo } from "./RailBoardPanel";
import { RailSessionsPanel } from "./RailSessionsPanel";
import type { Board, BoardCounts } from "./sessions";
import { ACCOUNT_SESSIONS_CHANGED_EVENT, sessionsInScope } from "./rail-sessions-scope-decision";
import {
  HIDE_DELAY_MS,
  ARCHIVED_OPEN_EVENT,
  OPEN_BOARD_PANEL_EVENT,
  OPEN_SESSIONS_EVENT,
  SESSION_CREATE_EVENT,
  SESSION_EDIT_EVENT,
  REVEAL_DELAY_MS,
  isEdgeSwipe,
  isInRevealZone,
  readRailHidden,
  shouldAutoHide,
  writeRailHidden,
} from "./rail-visibility-decision";
import styles from "./Rail.module.css";

/** `closed` = only the strip; every other step is a panel floating over the board. */
export type RailStep = "closed" | "pen" | "add" | "terminal1" | "terminal2" | "cards" | "ai" | "board" | "sessions";

export type RailCard = {
  id: string;
  kind: string;
  label: string | null;
  statusText?: string | null;
  statusTone?: "live" | "wait" | "idle" | "note";
  /** An agent card (terminal whose provider is not bash) — listed in the Board panel. */
  isAgent?: boolean;
};

const IS_MAC = typeof window !== "undefined" && window.system?.platform === "darwin";
/** Modifier as the prototype prints it: ⌘ on macOS, Ctrl elsewhere. */
const MOD = IS_MAC ? "⌘" : "Ctrl";

const ADD_GRID: { kind: "browser" | "files" | "changes" | "sticky" | "chat" | "media"; titleKey: MessageKey; descKey: MessageKey }[] = [
  { kind: "browser", titleKey: "rail.v3.kind.browser", descKey: "rail.v3.kind.browserDesc" },
  { kind: "files", titleKey: "rail.v3.kind.files", descKey: "rail.v3.kind.filesDesc" },
  { kind: "changes", titleKey: "rail.v3.kind.changes", descKey: "rail.v3.kind.changesDesc" },
  { kind: "sticky", titleKey: "rail.v3.kind.sticky", descKey: "rail.v3.kind.stickyDesc" },
  { kind: "chat", titleKey: "rail.v3.kind.chat", descKey: "rail.v3.kind.chatDesc" },
  { kind: "media", titleKey: "rail.v3.kind.media", descKey: "rail.v3.kind.mediaDesc" },
];

const PEN_TOKEN_COLORS = [
  "var(--rail-pen-1)",
  "var(--rail-pen-2)",
  "var(--rail-pen-3)",
  "var(--rail-pen-4)",
  "var(--rail-pen-5)",
] as const;

/** Prototype find-card mock (Rail.dc.html cards step) — used by verify seed. */
const PROTO_FIND_CARDS: RailCard[] = [
  { id: "mock-impl", kind: "terminal", label: "IMPL · Claude", statusText: "trabalhando · #511abc", statusTone: "live" },
  { id: "mock-explorer", kind: "terminal", label: "EXPLORER · Terminal", statusText: "trabalhando · #ad6787", statusTone: "live" },
  { id: "mock-revisor", kind: "terminal", label: "REVISOR", statusText: "espera você", statusTone: "wait" },
  { id: "mock-master", kind: "terminal", label: "Master", statusText: "parado", statusTone: "idle" },
  { id: "mock-fila", kind: "task", label: "Fila", statusText: "14 tasks", statusTone: "note" },
  { id: "mock-nota", kind: "sticky", label: "Nota · feedbacks", statusText: "editada hoje", statusTone: "note" },
];


/** Prototype terminal1 provider list (Rail.dc.html). */
const PROTO_TERMINAL1_ROWS: AgentProviderRow[] = [
  { id: "claude", label: "Claude Code", disabled: false, quota: { text: "77% da semana", warn: false }, quotaWarning: false, quotaWarningState: null, unavailableReason: null },
  { id: "agy", label: "Antigravity", disabled: false, quota: { text: "só Gemini", warn: false }, quotaWarning: false, quotaWarningState: null, unavailableReason: null },
  { id: "commandcode", label: "Command Code", disabled: false, quota: { text: "cota pode estar esgotada · renova 18:30", warn: true }, quotaWarning: true, quotaWarningState: "exhausted", unavailableReason: null },
  { id: "codex", label: "Codex", disabled: false, quota: { text: "cota desconhecida", warn: true }, quotaWarning: true, quotaWarningState: "unknown", unavailableReason: null },
  { id: "bash", label: "Terminal (bash)", disabled: false, quota: null, quotaWarning: false, quotaWarningState: null, unavailableReason: null },
];

/** Prototype Board panel facts (RailPassos.dc.html #no-topbar). */
const PROTO_BOARD: RailBoardInfo = {
  boardId: "proto-board",
  rootName: "Workspace",
  project: "Demo project",
  boardName: "Sprint board",
  autonomous: true,
  orchestratorCardId: null,
  orchestratorPresent: true,
};
const PROTO_BOARD_CARDS: RailCard[] = [
  { id: "mock-a", kind: "terminal", label: "Agent A", statusText: "trabalhando", statusTone: "live", isAgent: true },
  { id: "mock-b", kind: "terminal", label: "Agent B", statusText: "espera você", statusTone: "wait", isAgent: true },
  { id: "mock-c", kind: "terminal", label: "Agent C", statusText: "parado", statusTone: "idle", isAgent: true },
];

/** Prototype session list (RailPassos.dc.html #rail-sessions). */
const protoBoard = (id: string, name: string, project: string): Board => ({
  id,
  name,
  project,
  cwd: "",
  autonomous: false,
  concurrency_cap: null,
  orchestrator_card_id: null,
});
const PROTO_SESSIONS = {
  boards: [
    protoBoard("proto-board", "Sprint board", "Demo project"),
    protoBoard("proto-backlog", "Backlog", "Demo project"),
    protoBoard("proto-notes", "Notes", "Estudos"),
  ],
  counts: { "proto-board": { agents: 3 }, "proto-backlog": { agents: 1 }, "proto-notes": { agents: 0 } } as Record<string, BoardCounts>,
  activeId: "proto-board",
};

function clearTimer(ref: { current: number | null }) {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`${styles.kbd}${className ? ` ${className}` : ""}`}>{children}</span>;
}

/** Name + key shown to the right of a strip button on hover/focus. */
function NavTip({ label, keys }: { label: string; keys?: string[] }) {
  return (
    <span className={styles.navTip} role="tooltip">
      {label}
      {keys?.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

export function Rail({
  tool,
  setTool,
  strokeColors,
  strokeColor,
  setStrokeColor,
  strokeWidth,
  setStrokeWidth,
  providers,
  newProvider,
  setNewProvider,
  newResumeId,
  setNewResumeId,
  newContinueLast,
  setNewContinueLast,
  newModel,
  setNewModel,
  newEffort,
  setNewEffort,
  newSystemPrompt,
  setNewSystemPrompt,
  newCwd,
  setNewCwd,
  onCreateTerminal,
  onCreate,
  onCreateMedia,
  aiBusy,
  summarizeDisabled,
  onReorganize,
  onSummarize,
  cards,
  onJumpToCard,
  onOpenSettings,
  onOpenShortcuts,
  onGoHome,
  onOpenPalette,
  paletteOpen,
  board,
  boards,
  boardCounts,
  onSwitchBoard,
  summarizeProviderLabel,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  strokeColors: readonly string[];
  strokeColor: string;
  setStrokeColor: (c: string) => void;
  strokeWidth: number;
  setStrokeWidth: (w: number) => void;
  providers: string[];
  newProvider: string;
  setNewProvider: (p: string) => void;
  newResumeId: string;
  setNewResumeId: (v: string) => void;
  newContinueLast: boolean;
  setNewContinueLast: (v: boolean) => void;
  newModel: string;
  setNewModel: (v: string) => void;
  newEffort: string;
  setNewEffort: (v: string) => void;
  newSystemPrompt: string;
  setNewSystemPrompt: (v: string) => void;
  newCwd: string;
  setNewCwd: (v: string) => void;
  onCreateTerminal: () => void;
  onCreate: (kind: "files" | "changes" | "sticky" | "browser" | "chat") => void;
  onCreateMedia: () => void;
  aiBusy: boolean;
  summarizeDisabled: boolean;
  onReorganize: () => void;
  onSummarize: () => void;
  cards: RailCard[];
  onJumpToCard: (id: string) => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  /** Back to the session grid (the old floating Home button). */
  onGoHome: () => void;
  /** Opens the Ctrl K command palette. */
  onOpenPalette: () => void;
  /** Lights the palette button while the palette is open. */
  paletteOpen: boolean;
  /** Board / session facts shown by the Board panel and the strip dot. */
  board: RailBoardInfo;
  /** Sessions of the current scope (local or account), for the session list. */
  boards: Board[];
  boardCounts: Record<string, BoardCounts>;
  onSwitchBoard: (id: string) => void;
  summarizeProviderLabel?: string;
}) {
  const { rows: liveProviderRows, effortValuesFor } = useAgentProviderRows(providers);

  // `hidden` is the persisted preference; `revealed` is the transient edge
  // reveal of a hidden rail. There is deliberately no "open" button.
  const [hidden, setHidden] = useState(() => readRailHidden(window.localStorage));
  const [revealed, setRevealed] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [step, setStep] = useState<RailStep>("closed");
  const dockRef = useRef<HTMLDivElement>(null);
  const revealTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const swipeStartX = useRef<number | null>(null);
  const [findQuery, setFindQuery] = useState("");
  const [pickedProviderLabel, setPickedProviderLabel] = useState("Claude Code");
  const [mockFindCards, setMockFindCards] = useState<RailCard[] | null>(null);
  /** Proto label says "Nesta sessão · 9" while listing 6 rows — keep that surface count when seeded. */
  const [mockSessionCount, setMockSessionCount] = useState<number | null>(null);
  const [mockTerminal1Rows, setMockTerminal1Rows] = useState<AgentProviderRow[] | null>(null);
  /** Board panel fed with the prototype's facts (verify seed only). */
  const [mockBoard, setMockBoard] = useState<RailBoardInfo | null>(null);
  /** Session list fed with the prototype's sessions (verify seed only). */
  const [mockSessions, setMockSessions] = useState<{
    boards: Board[];
    counts: Record<string, BoardCounts>;
    activeId: string;
  } | null>(null);


  const panelOpen = step !== "closed";
  const stripVisible = !hidden || revealed;

  useEffect(() => {
    writeRailHidden(window.localStorage, hidden);
  }, [hidden]);

  // Choosing the pen (button or P) opens its options; drawing then starts with
  // a press on the board, which dismisses the panel like any outside press.
  useEffect(() => {
    if (tool === "pen") setStep("pen");
  }, [tool]);

  const closePanel = useCallback(() => setStep("closed"), []);

  // A press (mouse, pen or touch) or Esc outside the rail dismisses the panel.
  // The press is not consumed, so it still reaches the board (draw, pan, …).
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && dockRef.current?.contains(target)) return;
      // The board-path button toggles the Board panel itself; closing here first
      // would make its click reopen what the press just closed.
      if (target instanceof Element && target.closest("[data-rail-anchor]")) return;
      closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [panelOpen, closePanel]);

  // A revealed rail leaves 600 ms after nothing holds it any more.
  useEffect(() => {
    clearTimer(hideTimer);
    if (shouldAutoHide({ hidden, revealed, panelOpen, pointerInside })) {
      hideTimer.current = window.setTimeout(() => setRevealed(false), HIDE_DELAY_MS);
    }
    return () => clearTimer(hideTimer);
  }, [hidden, revealed, panelOpen, pointerInside]);

  useEffect(() => () => clearTimer(revealTimer), []);

  // The session list shows the scope of the open board (local, or one account
  // profile): the owners come from the database, read when the list opens and
  // again when the account code says they changed.
  const [owners, setOwners] = useState<{ id: string; account_profile_id?: string | null }[] | null>(null);
  const sessionsOpen = step === "sessions";
  useEffect(() => {
    if (!sessionsOpen) return;
    let cancelled = false;
    const read = () => {
      void window.store.boards
        .list()
        .then((rows) => {
          if (!cancelled) setOwners(rows);
        })
        .catch(() => undefined);
    };
    read();
    window.addEventListener(ACCOUNT_SESSIONS_CHANGED_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(ACCOUNT_SESSIONS_CHANGED_EVENT, read);
    };
  }, [sessionsOpen, boards.length]);

  // "Trocar de sessão…" can also be asked for from outside the rail.
  useEffect(() => {
    const openSessions = () => {
      setRevealed(true);
      setStep("sessions");
    };
    window.addEventListener(OPEN_SESSIONS_EVENT, openSessions);
    return () => window.removeEventListener(OPEN_SESSIONS_EVENT, openSessions);
  }, []);

  // The board path in the title strip opens (or closes) the Board panel, even
  // when the rail is hidden — it then slides in to hold the panel.
  useEffect(() => {
    const toggleBoard = () => {
      setRevealed(true);
      setStep((current) => (current === "board" ? "closed" : "board"));
    };
    window.addEventListener(OPEN_BOARD_PANEL_EVENT, toggleBoard);
    return () => window.removeEventListener(OPEN_BOARD_PANEL_EVENT, toggleBoard);
  }, []);

  const hideRail = useCallback(() => {
    clearTimer(revealTimer);
    setStep("closed");
    setRevealed(false);
    setPointerInside(false);
    setHidden(true);
  }, []);

  function onEdgePointerMove(e: React.PointerEvent) {
    if (e.pointerType === "touch") return;
    if (!isInRevealZone(e.pointerType, e.clientX)) {
      clearTimer(revealTimer);
      return;
    }
    if (revealTimer.current === null) {
      revealTimer.current = window.setTimeout(() => {
        revealTimer.current = null;
        setRevealed(true);
      }, REVEAL_DELAY_MS);
    }
  }

  function onEdgePointerDown(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    swipeStartX.current = e.clientX;
  }

  function onEdgeTouchMove(e: React.PointerEvent) {
    const start = swipeStartX.current;
    if (e.pointerType !== "touch" || start === null) return;
    if (isEdgeSwipe(start, e.clientX)) {
      swipeStartX.current = null;
      setRevealed(true);
    }
  }

  useEffect(() => {
    const api = {
      setStep: (next: RailStep) => {
        if (next !== "cards") {
          setMockFindCards(null);
          setMockSessionCount(null);
        }
        if (next !== "terminal1") setMockTerminal1Rows(null);
        setHidden(false);
        setStep(next);
        if (next === "pen") setTool("pen");
        if (next === "closed") setTool("pointer");
      },
      getStep: () => step,
      /** Hide the rail the way the hide button does (preference persists). */
      hide: () => hideRail(),
      /** Hidden + edge-revealed, as after a pointer dwell on the left edge. */
      reveal: () => {
        setStep("closed");
        setHidden(true);
        setRevealed(true);
      },
      isHidden: () => hidden,
      /** Drop the prototype board seed. */
      unseedBoard: () => {
        setMockBoard(null);
        setMockSessions(null);
      },
      /** Session list with the prototype's sessions (RailPassos.dc.html). */
      seedSessions: () => {
        setMockBoard(PROTO_BOARD);
        setMockSessions(PROTO_SESSIONS);
        setHidden(false);
        setStep("sessions");
      },
      /** Board panel with the prototype's mock facts (RailPassos.dc.html). */
      seedBoard: () => {
        setMockBoard(PROTO_BOARD);
        setHidden(false);
        setStep("board");
      },
      /** Seed find-card list to match Rail.dc.html mock (6 rows + tones). */
      seedCardsFind: () => {
        setMockFindCards(PROTO_FIND_CARDS);
        setMockSessionCount(9);
        setFindQuery("");
        setMockTerminal1Rows(null);
        setStep("cards");
      },
      /** Seed terminal1 provider rows to match Rail.dc.html mock. */
      seedTerminal1: () => {
        setMockTerminal1Rows(PROTO_TERMINAL1_ROWS);
        setMockFindCards(null);
        setMockSessionCount(null);
        setStep("terminal1");
      },
      /** Seed the new-agent form so screenshots match the prototype mock. */
      seedTerminal2: (opts?: {
        providerId?: string;
        providerLabel?: string;
        cwd?: string;
        model?: string;
        effort?: string;
        session?: "new" | "continue" | "resume";
        systemPrompt?: string;
      }) => {
        const providerId = opts?.providerId ?? "claude";
        const values = effortValuesFor(providerId);
        const wanted = opts?.effort ?? "alto";
        const effort =
          values.includes(wanted)
            ? wanted
            : wanted === "alto" && values.includes("high")
              ? "high"
              : wanted === "médio" && values.includes("medium")
                ? "medium"
                : wanted === "baixo" && values.includes("low")
                  ? "low"
                  : values[0] ?? wanted;
        setNewProvider(providerId);
        setPickedProviderLabel(opts?.providerLabel ?? (providerId === "claude" ? "Claude Code" : providerId));
        setNewCwd(opts?.cwd ?? "~/Workplace/Projects/Stellar");
        setNewModel(opts?.model ?? "Sonnet 5.5");
        setNewEffort(effort);
        const session = opts?.session ?? "new";
        if (session === "new") {
          setNewContinueLast(false);
          setNewResumeId("");
        } else if (session === "continue") {
          setNewContinueLast(true);
          setNewResumeId("");
        } else {
          setNewContinueLast(false);
          setNewResumeId(opts?.systemPrompt ? "" : "sess-demo");
        }
        setNewSystemPrompt(opts?.systemPrompt ?? "");
        setMockFindCards(null);
        setMockSessionCount(null);
        setMockTerminal1Rows(null);
        setStep("terminal2");
      },
      measureDock: () => {
        const dock = document.querySelector('[data-role="rail-dock"]');
        const strip = dock?.querySelector(".rail");
        const panel = dock?.querySelector('[data-role="rail-panel"]');
        const r = (el: Element | null | undefined) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { width: b.width, height: b.height, x: b.x, y: b.y };
        };
        return {
          dpr: window.devicePixelRatio,
          zoom: document.body.style.zoom || "1",
          dock: r(dock),
          strip: r(strip),
          panel: r(panel),
        };
      },
      measureCardsAlign: () => {
        const panel = document.querySelector('[data-role="rail-panel"]');
        if (!panel) return null;
        const field = panel.querySelector("input");
        const session = panel.querySelector("[data-role='rail-find-session']");
        const tip = panel.querySelector("[data-role='rail-find-tip']");
        const r = (el: Element | null) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, width: b.width };
        };
        const f = r(field);
        const s = r(session);
        const t = r(tip);
        return {
          field: f,
          session: s,
          tip: t,
          sessionDelta: f && s ? s.x - f.x : null,
          tipDelta: f && t ? t.x - f.x : null,
        };
      },
    };
    (window as unknown as { __stellarRail?: typeof api }).__stellarRail = api;
    return () => {
      delete (window as unknown as { __stellarRail?: typeof api }).__stellarRail;
    };
  }, [
    effortValuesFor,
    hidden,
    step,
    hideRail,
    setTool,
    setNewProvider,
    setNewCwd,
    setNewModel,
    setNewEffort,
    setNewContinueLast,
    setNewResumeId,
    setNewSystemPrompt,
  ]);

  function go(next: RailStep) {
    setStep(next);
  }

  /** Strip button that owns a panel: a second press closes it. */
  function togglePanel(next: Exclude<RailStep, "closed">, group?: RailStep[]) {
    const owned = group ?? [next];
    setStep(owned.includes(step) ? "closed" : next);
  }

  const titles: Record<Exclude<RailStep, "closed">, [string, string]> = {
    pen: [t("rail.v3.title.pen"), "P"],
    add: [t("rail.v3.title.add"), t("rail.v3.hint.add")],
    terminal1: [t("rail.v3.title.agent"), ""],
    terminal2: [t("rail.v3.title.agent"), ""],
    cards: [t("rail.v3.title.find"), `${MOD} F`],
    ai: [t("rail.v3.title.ai"), ""],
    board: [t("rail.v3.title.board"), (mockBoard ?? board).project],
    sessions: [t("rail.v3.title.sessions"), (mockBoard ?? board).project],
  };

  const activeStep = step === "closed" ? null : step;
  const [panelTitle, panelHint] = activeStep ? titles[activeStep] : ["", ""];
  const isTerm = activeStep === "terminal1" || activeStep === "terminal2";


  const providerRows = mockTerminal1Rows ?? liveProviderRows;

  const cardSource = mockFindCards ?? cards;
  const filteredCards = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return cardSource;
    return cardSource.filter((c) => {
      const hay = `${c.label ?? ""} ${c.kind} ${c.statusText ?? ""} ${c.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [cardSource, findQuery]);

  const penColors = strokeColors.length >= 5 ? strokeColors : PEN_TOKEN_COLORS;

  function selectTool(next: Tool) {
    setTool(next);
    setStep(next === "pen" ? "pen" : "closed");
  }

  // Which strip button is lit. With a panel open only the panel's own button
  // lights; with the strip alone the real tool (V / P / C / S / export) does.
  const pointerOn = step === "closed" && tool === "pointer";
  const penOn = tool === "pen";
  const addOn = step === "add" || step === "terminal1" || step === "terminal2";
  const navClass = (on: boolean) => `rail-btn ${styles.navBtn}${on ? ` ${styles.navBtnOn}` : ""}`;

  const agentForm = {
    providers,
    newProvider,
    setNewProvider,
    newResumeId,
    setNewResumeId,
    newContinueLast,
    setNewContinueLast,
    newModel,
    setNewModel,
    newEffort,
    setNewEffort,
    newSystemPrompt,
    setNewSystemPrompt,
    newCwd,
    setNewCwd,
  };

  const boardInfo = mockBoard ?? board;

  return (
    <div
      className={styles.dock}
      ref={dockRef}
      data-role="rail-dock"
      data-rail-step={step}
      data-rail-hidden={hidden ? "1" : "0"}
      data-rail-revealed={revealed ? "1" : "0"}
      data-panel-open={panelOpen ? "1" : "0"}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
    >
      {!stripVisible && (
        <div
          className={styles.edge}
          data-role="rail-edge"
          onPointerMove={onEdgePointerMove}
          onPointerLeave={() => clearTimer(revealTimer)}
          onPointerDown={onEdgePointerDown}
          onPointerUp={() => {
            swipeStartX.current = null;
          }}
          onPointerCancel={() => {
            swipeStartX.current = null;
          }}
          onPointerMoveCapture={onEdgeTouchMove}
        >
          <span className={styles.edgeHint} data-role="rail-edge-hint" />
        </div>
      )}
      <nav
        className={`${styles.strip} rail${stripVisible ? "" : ` ${styles.stripHidden}`}${hidden && revealed ? ` ${styles.stripRevealed}` : ""}`}
        aria-label={t("rail.toolbar")}
        aria-hidden={stripVisible ? undefined : true}
      >
        <button
          type="button"
          className={`rail-btn topbar-home ${styles.navBtn}`}
          data-role="rail-home"
          aria-label={t("rail.v3.aria.home")}
          onClick={onGoHome}
        >
          <RailGlyphHome />
          <NavTip label={t("rail.v3.tip.home")} />
        </button>
        <span className={styles.stripDivider} aria-hidden="true" />
        <button type="button" className={navClass(pointerOn)} aria-label={t("rail.v3.aria.pointer")} onClick={() => selectTool("pointer")}>
          <RailGlyphPointer />
          <NavTip label={t("rail.v3.tool.pointer")} keys={["V"]} />
        </button>
        <button
          type="button"
          className={navClass(penOn)}
          aria-label={t("rail.v3.aria.pen")}
          onClick={() => selectTool(tool === "pen" ? "pointer" : "pen")}
        >
          <RailGlyphPen />
          <NavTip label={t("rail.v3.tool.pen")} keys={["P"]} />
        </button>
        <button
          type="button"
          className={navClass(tool === "connector")}
          aria-label={t("rail.v3.aria.connector")}
          onClick={() => selectTool(tool === "connector" ? "pointer" : "connector")}
        >
          <RailGlyphConnector />
          <NavTip label={t("rail.v3.tool.connector")} keys={["C"]} />
        </button>
        <button
          type="button"
          className={navClass(tool === "select")}
          aria-label={t("rail.v3.aria.select")}
          onClick={() => selectTool(tool === "select" ? "pointer" : "select")}
        >
          <RailGlyphSelect />
          <NavTip label={t("rail.v3.tool.select")} keys={["S"]} />
        </button>
        <button
          type="button"
          className={navClass(tool === "export")}
          aria-label={t("rail.v3.aria.export")}
          onClick={() => selectTool(tool === "export" ? "pointer" : "export")}
        >
          <RailGlyphExport />
          <NavTip label={t("rail.v3.tool.export")} />
        </button>
        <span className={styles.stripDivider} aria-hidden="true" />
        <button
          type="button"
          className={navClass(addOn)}
          data-role="rail-add-card"
          aria-label={t("rail.v3.aria.add")}
          onClick={() => togglePanel("add", ["add", "terminal1", "terminal2"])}
        >
          <RailGlyphPlus />
          <NavTip label={t("rail.v3.board.add")} keys={[MOD, "⇧", "N"]} />
        </button>
        <button type="button" className={navClass(step === "cards")} aria-label={t("rail.v3.aria.find")} onClick={() => togglePanel("cards")}>
          <RailGlyphFind />
          <NavTip label={t("rail.v3.board.find")} keys={[MOD, "F"]} />
        </button>
        <button
          type="button"
          className={navClass(paletteOpen)}
          data-role="rail-palette"
          aria-label={t("rail.v3.aria.palette")}
          onClick={() => {
            setStep("closed");
            onOpenPalette();
          }}
        >
          <RailGlyphPalette />
          <NavTip label={t("rail.v3.tip.paletteName")} keys={[MOD, "K"]} />
        </button>
        <button type="button" className={navClass(step === "ai")} aria-label={t("rail.v3.aria.ai")} onClick={() => togglePanel("ai")}>
          <RailGlyphAi />
          <NavTip label={t("rail.v3.board.ai")} />
        </button>
        <span className={styles.stripSpacer} />
        <button
          type="button"
          className={navClass(step === "board")}
          data-role="rail-board"
          data-autonomous={board.autonomous ? "1" : undefined}
          aria-label={t("rail.v3.aria.board")}
          onClick={() => togglePanel("board")}
        >
          <RailGlyphBoard />
          {boardInfo.autonomous && <span className={styles.navDot} data-role="rail-board-dot" />}
          <NavTip label={t("rail.v3.tip.board")} />
        </button>
        <button type="button" className={navClass(false)} aria-label={t("rail.v3.aria.shortcuts")} onClick={onOpenShortcuts}>
          <span className={styles.helpGlyph}>?</span>
          <NavTip label={t("shortcuts.title")} keys={["?"]} />
        </button>
        <button type="button" className={navClass(false)} data-role="rail-settings" aria-label={t("rail.settingsAria")} onClick={onOpenSettings}>
          <RailGlyphSettings />
          <NavTip label={t("rail.settings")} />
        </button>
        <button type="button" className={`rail-btn rail-hide ${styles.navBtn}`} data-role="rail-hide" aria-label={t("rail.v3.aria.hide")} onClick={hideRail}>
          <RailGlyphHide />
          <NavTip label={t("rail.v3.tip.hide")} />
        </button>
      </nav>

      {activeStep && stripVisible && (
        <section className={styles.panel} aria-label={panelTitle} data-role="rail-panel">
          <header className={styles.panelHeader}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>{panelTitle}</h2>
              {panelHint ? <span className={styles.panelHint}>{panelHint}</span> : <span className={styles.panelHint} />}
            </div>
            {isTerm && (
              <div className={styles.stepRow}>
                <span className={`${styles.stepDot} ${styles.stepDotOn}`} />
                <span className={`${styles.stepDot}${activeStep === "terminal2" ? ` ${styles.stepDotOn}` : ""}`} />
                <span className={styles.stepLabel}>
                  {activeStep === "terminal1" ? t("rail.v3.step.who") : t("rail.v3.step.how")}
                </span>
              </div>
            )}
          </header>

          <div className={styles.panelBody}>
            {activeStep === "board" && (
              <RailBoardPanel
                board={boardInfo}
                cards={mockBoard ? PROTO_BOARD_CARDS : cards}
                loadAgentRoles={mockBoard ? false : true}
                onOpenSessions={() => setStep("sessions")}
              />
            )}

            {activeStep === "sessions" && (
              <RailSessionsPanel
                boards={mockSessions?.boards ?? sessionsInScope(boards, owners, board.boardId)}
                boardCounts={mockSessions?.counts ?? boardCounts}
                activeBoardId={mockSessions ? mockSessions.activeId : board.boardId}
                onBack={() => setStep("board")}
                onSwitch={(id) => {
                  setStep("closed");
                  onSwitchBoard(id);
                }}
                onEdit={(id) => {
                  setStep("closed");
                  window.dispatchEvent(new CustomEvent(SESSION_EDIT_EVENT, { detail: { boardId: id } }));
                }}
                onNew={() => {
                  setStep("closed");
                  window.dispatchEvent(new Event(SESSION_CREATE_EVENT));
                }}
                onArchived={() => {
                  setStep("closed");
                  window.dispatchEvent(new Event(ARCHIVED_OPEN_EVENT));
                }}
              />
            )}

            {activeStep === "pen" && (
              <>
                <span className={styles.sectionHead}>{t("rail.v3.pen.color")}</span>
                <div className={styles.penSwatches}>
                  {penColors.slice(0, 5).map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`${styles.penSwatch}${c === strokeColor ? ` ${styles.penSwatchOn}` : ""}`}
                      style={{ background: c }}
                      aria-label={t("pen.colorLabel")}
                      onClick={() => setStrokeColor(c)}
                    />
                  ))}
                </div>
                <span className={styles.sectionHead}>{t("rail.v3.pen.width")}</span>
                <div className={styles.penWidths}>
                  {WIDTH_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      className={`${styles.btn} ${styles.penWidthBtn}${strokeWidth === p.value ? ` ${styles.penWidthBtnOn}` : ""}`}
                      aria-label={t(p.labelKey)}
                      onClick={() => setStrokeWidth(p.value)}
                    >
                      <span
                        className={`${styles.penBar}${
                          p.value <= 2 ? ` ${styles.penBarThin}` : p.value <= 4 ? ` ${styles.penBarMid}` : ` ${styles.penBarThick}`
                        }`}
                      />
                    </button>
                  ))}
                </div>
                <span className={styles.footnote}>
                  {t("rail.v3.pen.tip")} <Kbd>Esc</Kbd> {t("rail.v3.pen.tipEsc")} <Kbd>{MOD}</Kbd> <Kbd>Z</Kbd>{" "}
                  {t("rail.v3.pen.tipUndo")}
                </span>
              </>
            )}

            {activeStep === "add" && (
              <>
                <button type="button" className={`${styles.tile} ${styles.tileHero}`} data-kind="terminal" onClick={() => go("terminal1")}>
                  <span className={styles.tileHeroTitle}>
                    <span className={styles.tileHeroGlyph}>
                      <RailGlyphTerminal />
                    </span>
                    {t("rail.v3.kind.terminal")}
                  </span>
                  <span className={styles.tileHeroMeta}>
                    <span className={styles.itemGrow}>{t("rail.v3.kind.terminalDesc")}</span>
                    <Kbd>{MOD}</Kbd>
                    <Kbd>⇧</Kbd>
                    <Kbd>N</Kbd>
                  </span>
                </button>
                <div className={styles.tileGrid}>
                  {ADD_GRID.map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      className={styles.tile}
                      data-kind={item.kind}
                      onClick={() => {
                        if (item.kind === "media") onCreateMedia();
                        else onCreate(item.kind);
                        setStep("closed");
                      }}
                    >
                      <span className={styles.tileTitle}>{t(item.titleKey)}</span>
                      <span className={styles.tileDesc}>{t(item.descKey)}</span>
                    </button>
                  ))}
                </div>
                <span className={styles.footnote}>{t("rail.v3.add.footnote")}</span>
              </>
            )}

            {activeStep === "terminal1" && (
              <AgentWhoStep
                rows={providerRows}
                back={{ label: t("rail.v3.title.add"), onClick: () => go("add") }}
                onPick={(row) => {
                  setNewProvider(row.id);
                  setPickedProviderLabel(row.label);
                  go("terminal2");
                }}
              />
            )}

            {activeStep === "terminal2" && (
              <AgentHowStep
                form={agentForm}
                pickedLabel={pickedProviderLabel}
                effortValues={effortValuesFor(newProvider)}
                onBack={() => go("terminal1")}
                onCreate={() => {
                  onCreateTerminal();
                  setStep("closed");
                }}
              />
            )}

            {activeStep === "cards" && (
              <>
                <input
                  className={styles.field}
                  data-role="rail-find-input"
                  aria-label={t("rail.v3.find.placeholder")}
                  placeholder={t("rail.v3.find.placeholder")}
                  value={findQuery}
                  onChange={(e) => setFindQuery(e.target.value)}
                />
                <span className={`${styles.sectionHead} ${styles.sectionHeadFlush}`} data-role="rail-find-session">
                  {t("rail.v3.find.session", { count: String(mockSessionCount ?? filteredCards.length) })}
                </span>
                <div className={styles.section} data-role="rail-find-list">
                  {filteredCards.length === 0 ? (
                    <div className={styles.footnote}>{t("rail.noCardsYet")}</div>
                  ) : (
                    filteredCards.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={styles.item}
                        onClick={() => {
                          onJumpToCard(c.id);
                        }}
                      >
                        <span
                          className={`${styles.statusDot}${
                            c.statusTone === "note"
                              ? ` ${styles.statusDotSquare}`
                              : c.statusTone === "live"
                                ? ` ${styles.statusLive}`
                                : c.statusTone === "wait"
                                  ? ` ${styles.statusWait}`
                                  : ` ${styles.statusIdle}`
                          }`}
                        />
                        <span className={styles.itemStack}>
                          <span>{c.label ?? c.kind}</span>
                          {c.statusText && (
                            <span className={`${styles.itemSub}${c.statusTone === "wait" ? ` ${styles.itemSubWarn}` : ""}`}>
                              {c.statusText}
                            </span>
                          )}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <span className={styles.footnote} data-role="rail-find-tip">
                  {t("rail.v3.find.tip")} <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("rail.v3.find.and")} <Kbd>⏎</Kbd> {t("rail.v3.find.also")}.
                </span>
              </>
            )}

            {activeStep === "ai" && (
              <>
                <button
                  type="button"
                  className={styles.tile}
                  disabled={summarizeDisabled || aiBusy}
                  onClick={() => {
                    onSummarize();
                    setStep("closed");
                  }}
                >
                  <span className={styles.aiTileTitle}>{aiBusy ? t("rail.summarizing") : t("rail.v3.ai.summarize")}</span>
                  <span className={styles.aiTileDesc}>{t("rail.v3.ai.summarizeDesc")}</span>
                  <span className={styles.aiTileMeta}>
                    {summarizeDisabled
                      ? t("rail.summarizeNeedProvider")
                      : t("rail.v3.ai.uses", { provider: summarizeProviderLabel ?? "Claude · Sonnet 5.5" })}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.tile}
                  onClick={() => {
                    onReorganize();
                    setStep("closed");
                  }}
                >
                  <span className={styles.aiTileTitle}>{t("rail.v3.ai.organize")}</span>
                  <span className={styles.aiTileDesc}>{t("rail.v3.ai.organizeDesc")}</span>
                  <span className={styles.aiTileMeta}>{t("rail.v3.ai.organizeMeta")}</span>
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
