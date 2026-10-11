import { useEffect, useMemo, useState } from "react";
import { buildProviderGroups } from "./provider-groups";
import { useAvailableAgentProviders } from "./useAgentAvailability";
import { useProviderClassification } from "./useProviderClassification";
import { decideProviderUsage } from "./provider-usage-decision";
import type { ProviderUsageStats } from "../../main/provider-usage";
import type { Tool } from "./card-types";
import { t, type MessageKey } from "../../shared/i18n";
import { WIDTH_PRESETS } from "./pen-presets";
import { providerAccentVar } from "./provider-icon-map";
import {
  RailGlyphAi,
  RailGlyphCollapse,
  RailGlyphConnector,
  RailGlyphExport,
  RailGlyphFind,
  RailGlyphGroup,
  RailGlyphLogo,
  RailGlyphPen,
  RailGlyphPlus,
  RailGlyphPointer,
  RailGlyphSelect,
  RailGlyphSettings,
  RailGlyphTerminal,
} from "./RailGlyphs";
import styles from "./Rail.module.css";

export type RailStep = "tools" | "collapsed" | "pen" | "add" | "terminal1" | "terminal2" | "cards" | "ai";

export type RailCard = {
  id: string;
  kind: string;
  label: string | null;
  statusText?: string | null;
  statusTone?: "live" | "wait" | "idle" | "note";
};

const RAIL_COLLAPSED_KEY = "ac.railCollapsed";

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

type MockProviderRow = {
  id: string;
  label: string;
  disabled: boolean;
  quota: { text: string; warn: boolean } | null;
};

/** Prototype terminal1 provider list (Rail.dc.html). */
const PROTO_TERMINAL1_ROWS: MockProviderRow[] = [
  { id: "claude", label: "Claude Code", disabled: false, quota: { text: "77% da semana", warn: false } },
  { id: "agy", label: "Antigravity", disabled: false, quota: { text: "só Gemini", warn: false } },
  { id: "commandcode", label: "Command Code", disabled: true, quota: { text: "sem cota até sex", warn: true } },
  { id: "codex", label: "Codex", disabled: true, quota: { text: "sem crédito", warn: true } },
  { id: "bash", label: "Terminal (bash)", disabled: false, quota: null },
];

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`${styles.kbd}${className ? ` ${className}` : ""}`}>{children}</span>;
}

function LogoMark() {
  return (
    <span className={styles.logo} aria-hidden="true">
      <RailGlyphLogo />
    </span>
  );
}

function quotaLabel(stats: ProviderUsageStats | undefined, nowMs: number): { text: string; warn: boolean } | null {
  const view = decideProviderUsage({ stats, nowMs });
  if (view.kind === "measured" && view.bars.length > 0) {
    const week = view.bars.find((b) => b.key === "week") ?? view.bars[0];
    return { text: t("rail.v3.quota.week", { value: String(week.percent) }), warn: false };
  }
  if (view.kind === "unavailable") {
    // Keep the chip short — long CLI reasons belong in Settings, not the rail row.
    return { text: t("settings.providers.quotaUnavailable"), warn: true };
  }
  return null;
}

export function Rail({
  tool,
  setTool,
  strokeColors,
  strokeColor,
  setStrokeColor,
  strokeWidth,
  setStrokeWidth,
  canGroup,
  onGroup,
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
  onDockWidthChange,
  summarizeProviderLabel,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  strokeColors: readonly string[];
  strokeColor: string;
  setStrokeColor: (c: string) => void;
  strokeWidth: number;
  setStrokeWidth: (w: number) => void;
  canGroup: boolean;
  onGroup: () => void;
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
  onDockWidthChange?: (widthPx: number) => void;
  summarizeProviderLabel?: string;
}) {
  const availableProviders = useAvailableAgentProviders();
  const providerClassification = useProviderClassification();
  const providerGroups = buildProviderGroups({
    orderedIds: providers,
    available: availableProviders,
    dynamicIds: providerClassification.dynamicIds,
    skippedIds: providerClassification.skippedIds,
  });

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
  const [step, setStep] = useState<RailStep>(() => (localStorage.getItem(RAIL_COLLAPSED_KEY) === "1" ? "collapsed" : "tools"));
  const [findQuery, setFindQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pickedProviderLabel, setPickedProviderLabel] = useState("Claude Code");
  const [providerUsage, setProviderUsage] = useState<Record<string, ProviderUsageStats | undefined>>({});
  const [mockFindCards, setMockFindCards] = useState<RailCard[] | null>(null);
  /** Proto label says "Nesta sessão · 9" while listing 6 rows — keep that surface count when seeded. */
  const [mockSessionCount, setMockSessionCount] = useState<number | null>(null);
  const [mockTerminal1Rows, setMockTerminal1Rows] = useState<MockProviderRow[] | null>(null);

  const showAgentFields = newProvider !== "bash";
  const effortValues = availableProviders.find((p) => p.id === newProvider)?.effortValues ?? [];
  const effortLabel = (v: string) =>
    (
      {
        high: "alto",
        medium: "médio",
        low: "baixo",
        xhigh: "muito alto",
        max: "máximo",
        alto: "alto",
        médio: "médio",
        baixo: "baixo",
      } as Record<string, string>
    )[v] ?? v;

  useEffect(() => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    onDockWidthChange?.(collapsed ? 56 : 440);
  }, [collapsed, onDockWidthChange]);

  useEffect(() => {
    if (tool === "pen" && !collapsed) setStep("pen");
  }, [tool, collapsed]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ids = [...providerGroups.native, ...providerGroups.generic].map((p) => p.id).filter((id) => id !== "bash");
    void Promise.all(
      ids.map(async (id) => {
        try {
          const stats = await window.providerUsage.get(id);
          return [id, stats] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, ProviderUsageStats | undefined> = {};
      for (const [id, stats] of entries) next[id] = stats;
      setProviderUsage(next);
    });
    return () => {
      cancelled = true;
    };
  }, [providerGroups]);

  useEffect(() => {
    const api = {
      setStep: (next: RailStep) => {
        if (next !== "cards") {
          setMockFindCards(null);
          setMockSessionCount(null);
        }
        if (next !== "terminal1") setMockTerminal1Rows(null);
        if (next === "collapsed") {
          setCollapsed(true);
          setStep("collapsed");
          return;
        }
        setCollapsed(false);
        setStep(next);
        if (next === "pen") setTool("pen");
        if (next === "tools") setTool("pointer");
      },
      getStep: () => (collapsed ? "collapsed" : step),
      /** Seed find-card list to match Rail.dc.html mock (6 rows + tones). */
      seedCardsFind: () => {
        setMockFindCards(PROTO_FIND_CARDS);
        setMockSessionCount(9);
        setFindQuery("");
        setMockTerminal1Rows(null);
        setCollapsed(false);
        setStep("cards");
      },
      /** Seed terminal1 provider rows to match Rail.dc.html mock. */
      seedTerminal1: () => {
        setMockTerminal1Rows(PROTO_TERMINAL1_ROWS);
        setMockFindCards(null);
        setMockSessionCount(null);
        setCollapsed(false);
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
        const values = availableProviders.find((p) => p.id === providerId)?.effortValues ?? [];
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
        setCollapsed(false);
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
    availableProviders,
    collapsed,
    step,
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
    if (next === "collapsed") {
      setCollapsed(true);
      setStep("collapsed");
      return;
    }
    setCollapsed(false);
    setStep(next);
  }

  function toggleCollapse() {
    if (collapsed) {
      setCollapsed(false);
      setStep(step === "collapsed" ? "tools" : step);
    } else {
      setCollapsed(true);
      setStep("collapsed");
    }
  }

  const titles: Record<Exclude<RailStep, "collapsed">, [string, string]> = {
    tools: [t("rail.v3.title.tools"), t("rail.v3.hint.open")],
    pen: [t("rail.v3.title.pen"), "P"],
    add: [t("rail.v3.title.add"), t("rail.v3.hint.add")],
    terminal1: [t("rail.v3.title.agent"), ""],
    terminal2: [t("rail.v3.title.agent"), ""],
    cards: [t("rail.v3.title.find"), "Ctrl F"],
    ai: [t("rail.v3.title.ai"), ""],
  };

  const activeStep: Exclude<RailStep, "collapsed"> = step === "collapsed" ? "tools" : step;
  const [panelTitle, panelHint] = titles[activeStep];
  const isTerm = activeStep === "terminal1" || activeStep === "terminal2";

  const providerRows = useMemo(() => {
    if (mockTerminal1Rows) return mockTerminal1Rows;
    const rows: MockProviderRow[] = [];
    for (const opt of [...providerGroups.native, ...providerGroups.generic]) {
      if (opt.id === "bash") continue;
      const quota = quotaLabel(providerUsage?.[opt.id], nowMs);
      const disabled = Boolean(quota?.warn && /sem cota|sem crédito|no quota|no credit/i.test(quota.text));
      // Prototype labels Claude as "Claude Code"; keep that surface string.
      rows.push({ id: opt.id, label: opt.id === "claude" ? "Claude Code" : opt.label, disabled, quota });
    }
    rows.push({ id: "bash", label: t("rail.v3.provider.bash"), disabled: false, quota: null });
    return rows;
  }, [mockTerminal1Rows, providerGroups, providerUsage, nowMs]);

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
    if (next === "pen") go("pen");
    else go("tools");
  }

  function sessionMode(): "new" | "continue" | "resume" {
    if (newResumeId.trim()) return "resume";
    if (newContinueLast) return "continue";
    return "new";
  }

  function setSessionMode(mode: "new" | "continue" | "resume") {
    if (mode === "new") {
      setNewContinueLast(false);
      setNewResumeId("");
    } else if (mode === "continue") {
      setNewContinueLast(true);
      setNewResumeId("");
    } else {
      setNewContinueLast(false);
      if (!newResumeId.trim()) setNewResumeId("");
    }
  }

  const open = !collapsed;
  // Proto (Rail.dc.html): pointer lit only on tools/collapsed. When the panel is
  // open on add/term/cards/ai, only that step button lights — not pointer too.
  // Collapsed strip still reflects the real tool (V / pen / connector / …).
  const pointerOn = collapsed ? tool === "pointer" : step === "tools";
  const penOn = collapsed ? tool === "pen" : step === "pen";

  return (
    <div
      className={styles.dock}
      data-role="rail-dock"
      data-rail-step={collapsed ? "collapsed" : step}
      data-rail-collapsed={collapsed ? "1" : "0"}
      style={{ width: collapsed ? "var(--rail-width-strip)" : "var(--rail-width-open)" }}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <nav className={`${styles.strip} rail`} aria-label={t("rail.toolbar")}>
        <LogoMark />
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${pointerOn ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.pointer")}
          aria-label={t("rail.v3.aria.pointer")}
          onClick={() => selectTool("pointer")}
        >
          <RailGlyphPointer />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${penOn ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.pen")}
          aria-label={t("rail.v3.aria.pen")}
          onClick={() => selectTool(tool === "pen" ? "pointer" : "pen")}
        >
          <RailGlyphPen />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${tool === "connector" ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.connector")}
          aria-label={t("rail.v3.aria.connector")}
          onClick={() => selectTool(tool === "connector" ? "pointer" : "connector")}
        >
          <RailGlyphConnector />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${tool === "select" ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.select")}
          aria-label={t("rail.v3.aria.select")}
          onClick={() => selectTool(tool === "select" ? "pointer" : "select")}
        >
          <RailGlyphSelect />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${tool === "export" ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.export")}
          aria-label={t("rail.v3.aria.export")}
          onClick={() => selectTool(tool === "export" ? "pointer" : "export")}
        >
          <RailGlyphExport />
        </button>
        <span className={styles.stripDivider} aria-hidden="true" />
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${step === "add" || step === "terminal1" || step === "terminal2" ? ` ${styles.navBtnOn}` : ""}`}
          data-role="rail-add-card"
          title={t("rail.addCard")}
          aria-label={t("rail.v3.aria.add")}
          onClick={() => go(step === "add" || step === "terminal1" || step === "terminal2" ? "tools" : "add")}
        >
          <RailGlyphPlus />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${step === "cards" ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.findCard")}
          aria-label={t("rail.v3.aria.find")}
          onClick={() => go(step === "cards" ? "tools" : "cards")}
        >
          <RailGlyphFind />
        </button>
        <button
          type="button"
          className={`rail-btn ${styles.navBtn}${step === "ai" ? ` ${styles.navBtnOn}` : ""}`}
          title={t("rail.aiActions")}
          aria-label={t("rail.v3.aria.ai")}
          onClick={() => go(step === "ai" ? "tools" : "ai")}
        >
          <RailGlyphAi />
        </button>
        <span className={styles.stripSpacer} />
        <button type="button" className={`rail-btn ${styles.navBtn}`} title={t("shortcuts.title")} aria-label={t("rail.v3.aria.shortcuts")} onClick={onOpenShortcuts}>
          <span className={styles.helpGlyph}>?</span>
        </button>
        <button type="button" className={`rail-btn ${styles.navBtn}`} title={t("rail.settings")} aria-label={t("rail.settingsAria")} onClick={onOpenSettings}>
          <RailGlyphSettings />
        </button>
        <button
          type="button"
          className={`rail-btn rail-toggle ${styles.navBtn}`}
          title={collapsed ? t("rail.show") : t("rail.hide")}
          aria-label={collapsed ? t("rail.v3.aria.expand") : t("rail.v3.aria.collapse")}
          onClick={toggleCollapse}
        >
          <RailGlyphCollapse />
        </button>
      </nav>

      {open && (
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
            {activeStep === "tools" && (
              <>
                <div className={styles.section}>
                  <span className={styles.sectionHead}>{t("rail.v3.section.tools")}</span>
                  <button type="button" className={`${styles.item}${tool === "pointer" ? ` ${styles.itemOn}` : ""}`} onClick={() => selectTool("pointer")}>
                    <RailGlyphPointer />
                    <span className={styles.itemGrow}>{t("rail.v3.tool.pointer")}</span>
                    <Kbd>V</Kbd>
                  </button>
                  <button type="button" className={styles.item} onClick={() => selectTool("pen")}>
                    <RailGlyphPen />
                    <span className={styles.itemGrow}>{t("rail.v3.tool.pen")}</span>
                    <Kbd>P</Kbd>
                  </button>
                  <button type="button" className={styles.item} onClick={() => selectTool("connector")}>
                    <RailGlyphConnector />
                    <span className={styles.itemGrow}>{t("rail.v3.tool.connector")}</span>
                    <Kbd>C</Kbd>
                  </button>
                  <button type="button" className={styles.item} onClick={() => selectTool("select")}>
                    <RailGlyphSelect />
                    <span className={styles.itemGrow}>{t("rail.v3.tool.select")}</span>
                    <Kbd>S</Kbd>
                  </button>
                  <button type="button" className={styles.item} onClick={() => selectTool("export")}>
                    <RailGlyphExport />
                    <span className={styles.itemGrow}>{t("rail.v3.tool.export")}</span>
                  </button>
                </div>
                <div className={styles.section}>
                  <span className={styles.sectionHead}>{t("rail.v3.section.board")}</span>
                  <button type="button" className={styles.item} onClick={() => go("add")}>
                    <RailGlyphPlus />
                    <span className={styles.itemGrow}>{t("rail.v3.board.add")}</span>
                    <span className={styles.kbdRow}>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>⇧</Kbd>
                      <Kbd>N</Kbd>
                    </span>
                  </button>
                  <button type="button" className={styles.item} onClick={() => go("cards")}>
                    <RailGlyphFind />
                    <span className={styles.itemGrow}>{t("rail.v3.board.find")}</span>
                    <span className={styles.kbdRow}>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>F</Kbd>
                    </span>
                  </button>
                  <button type="button" className={styles.item} onClick={() => go("ai")}>
                    <RailGlyphAi />
                    <span className={styles.itemGrow}>{t("rail.v3.board.ai")}</span>
                  </button>
                  <button type="button" className={styles.item} disabled={!canGroup} onClick={onGroup}>
                    <RailGlyphGroup />
                    <span className={styles.itemGrow}>{t("rail.v3.board.group")}</span>
                    <span className={styles.kbdRow}>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>G</Kbd>
                    </span>
                  </button>
                </div>
                <div className={styles.tip}>
                  {t("rail.v3.tip.shortcuts")} <Kbd>?</Kbd> · {t("rail.v3.tip.palette")}{" "}
                  <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
                </div>
              </>
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
                  {t("rail.v3.pen.tip")} <Kbd>Esc</Kbd> {t("rail.v3.pen.tipEsc")} <Kbd>Ctrl</Kbd> <Kbd>Z</Kbd>{" "}
                  {t("rail.v3.pen.tipUndo")}
                </span>
              </>
            )}

            {activeStep === "add" && (
              <>
                <button type="button" className={`${styles.tile} ${styles.tileHero}`} data-kind="terminal" onClick={() => go("terminal1")}>
                  <span className={styles.tileHeroTitle}>
                    <RailGlyphTerminal />
                    {t("rail.v3.kind.terminal")}
                    <span className={styles.itemGrow} />
                    <span className={styles.kbdRow}>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>⇧</Kbd>
                      <Kbd>N</Kbd>
                    </span>
                  </span>
                  <span className={styles.tileDescHero}>{t("rail.v3.kind.terminalDesc")}</span>
                </button>
                <div className={styles.tileGrid}>
                  {ADD_GRID.map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      className={`${styles.tile} popover-row`}
                      data-kind={item.kind}
                      onClick={() => {
                        if (item.kind === "media") onCreateMedia();
                        else onCreate(item.kind);
                        go("tools");
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
              <>
                <button type="button" className={styles.back} onClick={() => go("add")}>
                  ‹ {t("rail.v3.title.add")}
                </button>
                <span className={styles.sectionHead}>{t("rail.v3.whoRuns")}</span>
                <div className={styles.section} style={{ gap: 6 }}>
                  {providerRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className={`${styles.tile} ${styles.tileRow}${row.disabled ? ` ${styles.tileRowDisabled}` : ""}`}
                      disabled={row.disabled}
                      onClick={() => {
                        setNewProvider(row.id);
                        setPickedProviderLabel(row.label);
                        go("terminal2");
                      }}
                    >
                      <span
                        className={`${styles.providerDot}${row.id === "bash" ? ` ${styles.providerDotBash}` : ""}`}
                        style={row.id === "bash" ? undefined : { background: providerAccentVar(row.id) }}
                      />
                      <span className={styles.providerName}>{row.label}</span>
                      {row.quota && (
                        <span className={`${styles.providerQuota}${row.quota.warn ? ` ${styles.providerQuotaWarn}` : ""}`}>
                          {row.quota.text}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {activeStep === "terminal2" && (
              <>
                <button type="button" className={styles.back} onClick={() => go("terminal1")}>
                  ‹ {pickedProviderLabel}
                </button>
                <label className={styles.fieldLabel}>
                  {t("rail.v3.label.folder")}
                  <input className={`${styles.field} ${styles.fieldMono}`} value={newCwd} onChange={(e) => setNewCwd(e.target.value)} />
                </label>
                {showAgentFields && (
                  <>
                    <div className={styles.formGrid}>
                      <label className={styles.fieldLabel}>
                        {t("rail.v3.label.model")}
                        <select className={styles.field} value={newModel} onChange={(e) => setNewModel(e.target.value)}>
                          <option value="">{t("rail.providerDefault")}</option>
                          <option value="Sonnet 5.5">Sonnet 5.5</option>
                          <option value="Opus 5.5">Opus 5.5</option>
                        </select>
                      </label>
                      <label className={styles.fieldLabel}>
                        {t("rail.v3.label.effort")}
                        <select className={styles.field} value={newEffort} onChange={(e) => setNewEffort(e.target.value)}>
                          <option value="">{t("rail.providerDefault")}</option>
                          {(effortValues.length > 0 ? effortValues : ["alto", "médio", "baixo"]).map((v) => (
                            <option key={v} value={v}>
                              {effortLabel(v)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <span className={styles.sectionHead}>{t("rail.v3.session")}</span>
                    <div className={styles.sessionList}>
                      <label className={styles.sessionOption}>
                        <input type="radio" name="rail-session" checked={sessionMode() === "new"} onChange={() => setSessionMode("new")} />
                        {t("rail.v3.session.new")}
                      </label>
                      <label className={styles.sessionOption}>
                        <input
                          type="radio"
                          name="rail-session"
                          checked={sessionMode() === "continue"}
                          onChange={() => setSessionMode("continue")}
                        />
                        {t("rail.v3.session.continue")}
                      </label>
                      <label className={styles.sessionOption}>
                        <input type="radio" name="rail-session" checked={sessionMode() === "resume"} onChange={() => setSessionMode("resume")} />
                        {t("rail.v3.session.resume")}
                      </label>
                    </div>
                    {sessionMode() === "resume" && (
                      <input
                        className={styles.field}
                        value={newResumeId}
                        placeholder={t("rail.label.resumeId")}
                        onChange={(e) => setNewResumeId(e.target.value)}
                      />
                    )}
                    <label className={styles.fieldLabel}>
                      <span>
                        {t("rail.v3.label.extra")} <span className={styles.fieldOptional}>{t("rail.v3.label.optional")}</span>
                      </span>
                      <textarea
                        className={`${styles.field} ${styles.fieldArea}`}
                        value={newSystemPrompt}
                        placeholder={t("rail.v3.label.extraPlaceholder")}
                        onChange={(e) => setNewSystemPrompt(e.target.value)}
                      />
                    </label>
                  </>
                )}
                <div className={styles.actions}>
                  <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={() => go("terminal1")}>
                    {t("rail.v3.back")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => {
                      onCreateTerminal();
                      go("tools");
                    }}
                  >
                    {t("rail.v3.openCard")} <Kbd className={styles.btnKbd}>⏎</Kbd>
                  </button>
                </div>
              </>
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
                    go("tools");
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
                    go("tools");
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
