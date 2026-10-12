/**
 * Right-click menu on empty canvas — the radial's quick actions as a list:
 * "Nova task aqui" first, then what can be created at the click, the tools and
 * the two overlays (radial, palette). Long-press / Q still open the radial.
 */

import { useEffect, useRef } from "react";
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

export function BoardCanvasMenu({ x, y, onSelect, onClose }: BoardCanvasMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-part='board-canvas-menu']")) return;
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
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return createPortal(
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
          {group.items.map((row, ri) => (
            <button
              key={row.action}
              type="button"
              role="menuitem"
              className={`${styles.item}${gi === 0 && ri === 0 ? ` ${styles.itemActive}` : ""}`}
              data-part={row.part ?? `board-canvas-${row.action}`}
              onClick={() => {
                onSelect(row.action);
                onClose();
              }}
            >
              <span className={styles.glyph}>{row.glyph}</span>
              <span className={styles.label}>{row.label}</span>
              {row.keys?.map((k) => (
                <span key={k} className={styles.kbd}>
                  {k}
                </span>
              ))}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}
