/**
 * Right-click menu on empty canvas — the radial's quick actions as a list:
 * "Nova task aqui" first, then what can be created at the click, the tools and
 * the two overlays (radial, palette). Long-press / Q still open the radial.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../shared/i18n";
import type { ReactNode } from "react";
import {
  RailGlyphConnector,
  RailGlyphPalette,
  RailGlyphPen,
  RailGlyphPointer,
  RailGlyphSelect,
  RailGlyphTerminal,
} from "./RailGlyphs";
import { AgentHowStep, AgentWhoStep } from "./AgentFlow";
import { useAgentProviderRows, type AgentFormValues } from "./agent-flow-model";
import railStyles from "./Rail.module.css";
import styles from "./BoardCanvasMenu.module.css";

/** What a menu row asks the board to do. Spawns land at the click position. */
export type BoardCanvasMenuAction =
  | "quick-task"
  | "terminal"
  | "browser"
  | "files"
  | "changes"
  | "sticky"
  | "chat"
  | "remote-window"
  | "tool-pointer"
  | "tool-pen"
  | "tool-connector"
  | "tool-select"
  | "radial"
  | "palette";

export type BoardCanvasMenuProps = {
  x: number;
  y: number;
  /**
   * The board's new-agent form. With it, "Agente ou terminal" opens the rail's
   * "Novo agente" flow in a panel glued to the menu (create happens through
   * `onSelect("terminal")` with the form as filled); without it the row creates
   * a terminal straight away, as before.
   */
  agentFlow?: { form: AgentFormValues };
  onSelect: (action: BoardCanvasMenuAction) => void;
  onClose: () => void;
};

const IS_MAC = typeof window !== "undefined" && window.system?.platform === "darwin";
const MOD = IS_MAC ? "⌘" : "Ctrl";

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
);

const GLYPH = {
  task: svg(<path d="M4 9.5l3.2 3L14 5.5" />),
  browser: svg(
    <>
      <circle cx="9" cy="9" r="6" />
      <path d="M3 9h12M9 3c2 2 2 10 0 12M9 3c-2 2-2 10 0 12" />
    </>,
  ),
  code: svg(<path d="M6.5 5L3 9l3.5 4M11.5 5L15 9l-3.5 4" />),
  changes: svg(<path d="M9 3v8M5 7h8M5 14h8" />),
  note: svg(
    <>
      <rect x="3" y="3" width="12" height="12" rx="2" />
      <path d="M6 7h6M6 10h4" />
    </>,
  ),
  chat: svg(<path d="M3 4.5h12v8H8l-3 2.5v-2.5H3z" />),
  remote: svg(
    <>
      <rect x="2.5" y="3" width="13" height="9" rx="1.5" />
      <path d="M6.5 15h5M9 12v3" />
    </>,
  ),
  radial: svg(
    <>
      <circle cx="9" cy="9" r="6" />
      <circle cx="9" cy="9" r="2" />
    </>,
  ),
};

type Row = { action: BoardCanvasMenuAction; label: string; glyph: ReactNode; keys?: string[]; part?: string };

function rows(): { head?: string; items: Row[] }[] {
  return [
    {
      items: [{ action: "quick-task", label: t("boardCanvasMenu.newTask"), glyph: GLYPH.task, part: "board-canvas-new-task" }],
    },
    {
      head: t("boardCanvasMenu.createHere"),
      items: [
        { action: "terminal", label: t("boardCanvasMenu.agent"), glyph: <RailGlyphTerminal /> },
        { action: "browser", label: t("radial.browser"), glyph: GLYPH.browser },
        { action: "files", label: t("radial.code"), glyph: GLYPH.code },
        { action: "changes", label: t("radial.changes"), glyph: GLYPH.changes },
        { action: "sticky", label: t("radial.sticky"), glyph: GLYPH.note },
        { action: "chat", label: t("radial.chat"), glyph: GLYPH.chat },
        { action: "remote-window", label: t("boardCanvasMenu.remote"), glyph: GLYPH.remote },
      ],
    },
    {
      head: t("boardCanvasMenu.tools"),
      items: [
        { action: "tool-pointer", label: t("radial.pointer"), glyph: <RailGlyphPointer />, keys: ["V"] },
        { action: "tool-pen", label: t("radial.pen"), glyph: <RailGlyphPen />, keys: ["P"] },
        { action: "tool-connector", label: t("radial.connector"), glyph: <RailGlyphConnector />, keys: ["C"] },
        { action: "tool-select", label: t("radial.select"), glyph: <RailGlyphSelect />, keys: ["S"] },
      ],
    },
    {
      items: [
        { action: "radial", label: t("boardCanvasMenu.radial"), glyph: GLYPH.radial, keys: ["Q"] },
        { action: "palette", label: t("boardCanvasMenu.palette"), glyph: <RailGlyphPalette />, keys: [MOD, "K"] },
      ],
    },
  ];
}

/** Gap between the menu and its side panel, and the margin kept to the window edge. */
const SUB_GAP = 4;
const SUB_EDGE = 8;
/** Pointer dwell before the panel opens, and the grace before it closes when the pointer wanders. */
const SUB_OPEN_MS = 150;
const SUB_CLOSE_MS = 200;
const SUB_WIDTH = 296;
/** The panel's top lines up with the row's text, past the menu padding. */
const SUB_TOP_OFFSET = 7;

type SubStep = "who" | "how";

/**
 * The menu's second step: the rail's "Novo agente" flow in a panel glued to the
 * menu, aligned to the row, flipped to the left when the right side is full and
 * pulled back inside the window when it is too tall.
 */
function AgentSubmenu({
  form,
  menuEl,
  rowEl,
  focusFirst,
  onPicked,
  onBackToRow,
  onCreate,
  onPointerEnter,
}: {
  form: AgentFormValues;
  menuEl: HTMLElement | null;
  rowEl: HTMLElement | null;
  focusFirst: boolean;
  onPicked: () => void;
  onBackToRow: () => void;
  onCreate: () => void;
  onPointerEnter: () => void;
}) {
  const subRef = useRef<HTMLElement>(null);
  const [step, setStep] = useState<SubStep>("who");
  const [pickedLabel, setPickedLabel] = useState("");
  const { rows, effortValuesFor } = useAgentProviderRows(form.providers);

  useLayoutEffect(() => {
    const el = subRef.current;
    if (!el || !menuEl || !rowEl) return;
    const menu = menuEl.getBoundingClientRect();
    const row = rowEl.getBoundingClientRect();
    const maxHeight = window.innerHeight - 2 * SUB_EDGE;
    el.style.maxHeight = `${maxHeight}px`;
    const height = Math.min(el.offsetHeight, maxHeight);
    const fitsRight = menu.right + SUB_GAP + SUB_WIDTH <= window.innerWidth - SUB_EDGE;
    const left = fitsRight ? menu.right + SUB_GAP : Math.max(SUB_EDGE, menu.left - SUB_GAP - SUB_WIDTH);
    const top = Math.max(SUB_EDGE, Math.min(row.top - SUB_TOP_OFFSET, window.innerHeight - SUB_EDGE - height));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.dataset.side = fitsRight ? "right" : "left";
  }, [menuEl, rowEl, step, rows.length]);

  useEffect(() => {
    if (!focusFirst) return;
    const el = subRef.current;
    el?.querySelector<HTMLButtonElement>("button:not(:disabled)[data-provider]")?.focus();
  }, [focusFirst]);

  // A step change replaces the focused control, so the new step takes focus:
  // the folder field for "how", the provider last chosen (or the first) for "who".
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const el = subRef.current;
    if (!el) return;
    if (step === "how") el.querySelector<HTMLInputElement>("input")?.focus();
    else {
      (
        el.querySelector<HTMLButtonElement>(`button:not(:disabled)[data-provider="${form.newProvider}"]`) ??
        el.querySelector<HTMLButtonElement>("button:not(:disabled)[data-provider]")
      )?.focus();
    }
    // Focus moves only when the step changes, not when the form values do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (step === "how") setStep("who");
      else onBackToRow();
      return;
    }
    if (step === "who" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const tiles = Array.from(subRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)[data-provider]") ?? []);
      if (tiles.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (at + 1) % tiles.length : (at - 1 + tiles.length) % tiles.length;
      tiles[next]?.focus();
      return;
    }
    if (step === "how" && e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      onCreate();
    }
  }

  return (
    <section
      ref={subRef}
      className={styles.sub}
      data-part="ctx-submenu"
      aria-label={t("rail.v3.title.agent")}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
    >
      <header className={railStyles.panelHeader}>
        <div className={railStyles.panelTitleRow}>
          <h2 className={railStyles.panelTitle}>{t("rail.v3.title.agent")}</h2>
          <span className={railStyles.panelHint} />
        </div>
        <div className={railStyles.stepRow}>
          <span className={`${railStyles.stepDot} ${railStyles.stepDotOn}`} />
          <span className={`${railStyles.stepDot}${step === "how" ? ` ${railStyles.stepDotOn}` : ""}`} />
          <span className={railStyles.stepLabel}>{step === "who" ? t("rail.v3.step.who") : t("rail.v3.step.how")}</span>
        </div>
      </header>
      <div className={railStyles.panelBody}>
        {step === "who" ? (
          <AgentWhoStep
            rows={rows}
            onPick={(row) => {
              form.setNewProvider(row.id);
              setPickedLabel(row.label);
              setStep("how");
              onPicked();
            }}
          />
        ) : (
          <AgentHowStep
            form={form}
            pickedLabel={pickedLabel}
            effortValues={effortValuesFor(form.newProvider)}
            onBack={() => setStep("who")}
            onCreate={onCreate}
          />
        )}
      </div>
      <div className={styles.legend} data-part="submenu-legend">
        <span>
          <span className={styles.kbd}>←</span> {t("boardCanvasMenu.sub.back")}
        </span>
        <span>
          <span className={styles.kbd}>→</span> {t("boardCanvasMenu.sub.open")}
        </span>
        <span>
          <span className={styles.kbd}>⏎</span> {t("boardCanvasMenu.sub.pick")}
        </span>
        <span>
          <span className={styles.kbd}>Esc</span> {t("boardCanvasMenu.sub.close")}
        </span>
      </div>
    </section>
  );
}

export function BoardCanvasMenu({ x, y, agentFlow, onSelect, onClose }: BoardCanvasMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  /** Opened with the keyboard or a click: the panel takes focus; a hover does not steal it. */
  const [subFocus, setSubFocus] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const openSub = useCallback(
    (focus: boolean) => {
      clearTimers();
      setSubFocus(focus);
      setSubOpen(true);
    },
    [clearTimers],
  );
  const closeSubSoon = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setSubOpen(false);
      setSubFocus(false);
    }, SUB_CLOSE_MS);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-part='board-canvas-menu'], [data-part='ctx-submenu']")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // Keep the whole menu on screen: flip above/left of the click when it would
  // run past the window edge (the list is taller than a plain context menu).
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" && agentFlow && document.activeElement === rowRef.current) {
      e.preventDefault();
      openSub(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return createPortal(
    <>
      <div
        ref={menuRef}
        className={styles.menu}
        role="menu"
        aria-label={t("boardCanvasMenu.aria")}
        data-part="board-canvas-menu"
        style={{ left: x, top: y }}
        onKeyDown={onMenuKeyDown}
      >
        {rows().map((group, gi) => (
          <div key={gi} className={styles.group}>
            {gi > 0 && <span className={styles.sep} aria-hidden="true" />}
            {group.head && <span className={styles.section}>{group.head}</span>}
            {group.items.map((row, ri) => {
              const hasSub = Boolean(agentFlow) && row.action === "terminal";
              const active = hasSub ? subOpen : gi === 0 && ri === 0 && !subOpen;
              return (
                <button
                  key={row.action}
                  ref={hasSub ? rowRef : undefined}
                  type="button"
                  role="menuitem"
                  aria-haspopup={hasSub ? "menu" : undefined}
                  aria-expanded={hasSub ? subOpen : undefined}
                  className={`${styles.item}${active ? ` ${styles.itemActive}` : ""}`}
                  data-part={row.part ?? `board-canvas-${row.action}`}
                  onPointerEnter={() => {
                    if (hasSub) {
                      if (subOpen) {
                        clearTimers();
                      } else if (openTimer.current === null) {
                        openTimer.current = window.setTimeout(() => openSub(false), SUB_OPEN_MS);
                      }
                    } else if (subOpen || openTimer.current !== null) {
                      closeSubSoon();
                    }
                  }}
                  onClick={() => {
                    if (hasSub) {
                      openSub(true);
                      return;
                    }
                    onSelect(row.action);
                    onClose();
                  }}
                >
                  <span className={styles.glyph}>{row.glyph}</span>
                  <span className={styles.label}>{row.label}</span>
                  {hasSub && (
                    <svg
                      className={styles.chevron}
                      data-part="ctx-chevron"
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3.5 2l3 3-3 3" />
                    </svg>
                  )}
                  {row.keys?.map((k) => (
                    <span key={k} className={styles.kbd}>
                      {k}
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {agentFlow && subOpen && (
        <AgentSubmenu
          form={agentFlow.form}
          menuEl={menuRef.current}
          rowEl={rowRef.current}
          focusFirst={subFocus}
          onPicked={clearTimers}
          onBackToRow={() => {
            clearTimers();
            setSubOpen(false);
            setSubFocus(false);
            rowRef.current?.focus();
          }}
          onCreate={() => {
            onSelect("terminal");
            onClose();
          }}
          onPointerEnter={clearTimers}
        />
      )}
    </>,
    document.body,
  );
}
