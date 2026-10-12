import { useEffect, useRef } from "react";
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  RangeSetBuilder,
  Annotation,
  Prec,
  Transaction,
  Facet,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  keymap,
  lineNumbers,
  lineNumberWidgetMarker,
  gutterLineClass,
  gutterWidgetClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  gutter,
  GutterMarker,
  Tooltip,
  showTooltip,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  HighlightStyle,
  type LanguageSupport,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import type { AgentLineMark } from "./code-line-attribution-decision";
import { decideGutterTooltip } from "./code-gutter-tooltip-decision";
import { LIVE_DIFF_FOLD_AT, decideGhostFolded, decideLineChanges, type LiveDiff, type LiveDiffHunk } from "./code-live-diff-decision";

/**
 * DESIGN-BACKLOG.md item 21, ponto 11 — `FilesCard`'s "código" view was a
 * bare `<textarea>`: no line numbers, no syntax highlight, no indentation
 * guides — a plain HTML file rendered as flat, uncolored text. This wraps
 * CodeMirror 6 (chosen over a lighter textarea+Prism overlay per the
 * user's own pick — "editor de verdade... igual VSCode") behind the exact
 * same `value`/`onChange` contract the textarea had, so `FilesCard.tsx`
 * itself barely changed.
 *
 * Every CodeMirror package here is dynamically `import()`-ed (see
 * `loadLanguage` below and this module's own lazy load in `FilesCard.tsx`)
 * — same reasoning `MarkdownPreview` already uses for `marked`/`dompurify`:
 * a session that never opens the files card's code view shouldn't pay for
 * any of this in the initial bundle.
 */

/** Custom theme instead of importing a generic one (`@codemirror/theme-
 * one-dark` et al.) — reuses this app's own CSS custom properties
 * (tokens.css) so the editor matches the rest of the UI exactly instead of
 * introducing a second, slightly-different dark palette. */
const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--surface)",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "var(--foam)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foam)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(69, 200, 255, 0.25)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.04)" },
    ".cm-gutters": {
      backgroundColor: "var(--surface)",
      color: "var(--muted)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer" },
    // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 6) — gutter de
    // breakpoint da aba Sources do Inspector. Só existe quando
    // `breakpointLines`/`onToggleBreakpoint` são passados (FilesCard.tsx
    // nunca passa esses props, então nunca renderiza esse gutter).
    ".cm-breakpoint-gutter": { width: "14px", cursor: "pointer" },
    ".cm-breakpoint-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
    ".cm-breakpoint-marker": {
      width: "9px",
      height: "9px",
      borderRadius: "50%",
      backgroundColor: "var(--danger)",
    },
    ".cm-agent-gutter": { width: "4px", marginRight: "10px" },
    ".cm-agent-gutter .cm-gutterElement": { padding: 0 },
    ".cm-agent-mark": { width: "4px", height: "100%", minHeight: "21px", display: "block" },
    // Live diff: the row background says WHAT changed (green added, red
    // removed), the 4px strip in `.cm-agent-gutter` says WHO.
    ".cm-live-add": { backgroundColor: "rgba(63, 182, 139, 0.12)" },
    ".cm-live-add-gutter": { backgroundColor: "rgba(63, 182, 139, 0.12)" },
    ".cm-live-fresh": { animation: "cm-live-fresh 2.4s ease-out 1" },
    "@keyframes cm-live-fresh": {
      from: { boxShadow: "inset 0 0 0 999px rgba(63, 182, 139, 0.28)" },
      to: { boxShadow: "inset 0 0 0 999px rgba(63, 182, 139, 0)" },
    },
    ".cm-live-word": { backgroundColor: "rgba(63, 182, 139, 0.32)", borderRadius: "3px" },
    ".cm-live-sign-gutter": { width: "14px" },
    ".cm-live-sign-gutter .cm-gutterElement": { padding: 0, textAlign: "center", fontSize: "12px" },
    ".cm-live-sign": { display: "block", height: "21px", lineHeight: "21px" },
    ".cm-live-sign-add": { color: "#3fb68b" },
    ".cm-live-sign-del": { color: "#e0846f" },
    ".cm-live-ghost": { backgroundColor: "rgba(224, 132, 111, 0.12)", cursor: "default" },
    ".cm-live-ghost-row": {
      height: "21px",
      lineHeight: "21px",
      whiteSpace: "pre",
      overflow: "hidden",
      padding: "0 2px 0 6px",
      opacity: 0.62,
      fontFamily: "var(--font-mono)",
    },
    ".cm-live-ghost-word": { backgroundColor: "rgba(224, 132, 111, 0.35)", borderRadius: "3px" },
    ".cm-live-ghost-fold": {
      display: "block",
      width: "100%",
      height: "21px",
      lineHeight: "21px",
      padding: "0 2px 0 6px",
      border: 0,
      background: "transparent",
      color: "#c9a39d",
      font: "inherit",
      fontSize: "11.5px",
      textAlign: "left",
      cursor: "pointer",
    },
    ".cm-live-num-del": { color: "#7a4a45" },
    ".cm-live-ghost-gutter": { backgroundColor: "rgba(224, 132, 111, 0.12)" },
    ".cm-agent-tooltip": {
      background: "#12151d",
      border: "1px solid #343c55",
      borderRadius: "9px",
      boxShadow: "0 8px 24px #000a",
      padding: "8px 10px",
      maxWidth: "300px",
      fontSize: "12px",
      color: "#e8eaf0",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    },
    ".cm-agent-tooltip strong": { fontWeight: 600 },
    ".cm-agent-tooltip .muted": { color: "#8d94a6" },
    ".cm-agent-tooltip .actions": { display: "flex", gap: "6px", marginTop: "4px" },
    ".cm-agent-tooltip button": {
      minHeight: "28px",
      padding: "0 10px",
      borderRadius: "7px",
      border: "1px solid #2a2f3d",
      background: "#161a24",
      color: "#e8eaf0",
      font: "inherit",
      fontSize: "12px",
      cursor: "pointer",
    },
    // DESIGN-BACKLOG.md §2.0 item 4 — app default scrollbar lives on
    // `*` + bare `::-webkit-scrollbar*` in layout.css. `.cm-scroller`
    // is CodeMirror's internal scroll container (not a DOM node we own),
    // and the theme injects styles that can outrank the global webkit
    // pseudos — keep the same values here so the editor matches the
    // app default even when CM's own rules would otherwise win.
    ".cm-scroller": { overflow: "auto", scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent" },
    ".cm-scroller::-webkit-scrollbar": { width: "6px", height: "6px" },
    ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
    ".cm-scroller::-webkit-scrollbar-thumb": { background: "var(--border)", borderRadius: "999px" },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": { background: "var(--muted)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(69, 200, 255, 0.18)",
      outline: "1px solid var(--foam)",
    },
  },
  { dark: true },
);

/** Token colors mapped onto this app's existing accent palette (tokens.css)
 * instead of a new set of hardcoded hexes — the same colors every card
 * kind/provider accent already uses elsewhere in the UI. */
const highlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: "var(--foam)" },
  { tag: [t.string, t.special(t.string)], color: "var(--good)" },
  { tag: [t.number, t.bool, t.null], color: "var(--signal)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--violet)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--warn)" },
  { tag: t.definition(t.variableName), color: "var(--text)" },
  { tag: t.propertyName, color: "var(--foam)" },
  { tag: [t.tagName], color: "var(--foam)" },
  { tag: [t.attributeName], color: "var(--warn)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** One dynamic-import loader per extension group, each pulling in only
 * the language package(s) that file kind actually needs. `null` means
 * "no specific grammar" — the editor still gets every non-language
 * feature (line numbers, folding, indent guides), just no token colors,
 * same as VSCode with no extension installed for an exotic file type. */
const LANG_LOADERS: Record<string, () => Promise<LanguageSupport | null>> = {
  ".js": () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ".jsx": () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ".mjs": () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ".cjs": () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ".ts": () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  ".tsx": () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  ".py": () => import("@codemirror/lang-python").then((m) => m.python()),
  ".json": () => import("@codemirror/lang-json").then((m) => m.json()),
  ".css": () => import("@codemirror/lang-css").then((m) => m.css()),
  ".scss": () => import("@codemirror/lang-css").then((m) => m.css()),
  ".html": () => import("@codemirror/lang-html").then((m) => m.html()),
  ".md": () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  ".markdown": () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  ".rs": () => import("@codemirror/lang-rust").then((m) => m.rust()),
  ".c": () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  ".h": () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  ".cpp": () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  ".hpp": () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  ".java": () => import("@codemirror/lang-java").then((m) => m.java()),
  ".php": () => import("@codemirror/lang-php").then((m) => m.php()),
  ".sql": () => import("@codemirror/lang-sql").then((m) => m.sql()),
  // Long-tail languages via CM5-style stream modes, wrapped as a
  // LanguageSupport — no dedicated @codemirror/lang-* package exists for
  // these, but the legacy adapter still gets real tokenizing/highlighting,
  // just without the fancier tree-sitter-style features (folding by AST
  // node, etc — folding still works by indentation).
  ".sh": () => legacyLang("shell"),
  ".bash": () => legacyLang("shell"),
  ".rb": () => legacyLang("ruby"),
  ".go": () => legacyLang("go"),
  ".yaml": () => legacyLang("yaml"),
  ".yml": () => legacyLang("yaml"),
  ".toml": () => legacyLang("toml"),
  ".ini": () => legacyLang("properties"),
  ".env": () => legacyLang("properties"),
};

// DESIGN-BACKLOG.md item 54 — the previous version built the import
// path via string concatenation (`"@codemirror/legacy-modes/mode/" +
// mode`), which Vite/Rollup's dynamic-import-vars analysis can't
// resolve statically (real warning seen live in `npm run dev`'s
// output, not just theoretical — see the plugin's own docs linked in
// that warning). That's not just cosmetic: an import Vite can't
// analyze isn't guaranteed to be included correctly in a PACKAGED
// build's bundle the same way `npm run dev`'s dev server tolerates it
// (confirmed by rebuilding `npm run package` output and inspecting the
// bundled dist — see AGENTS.md's changelog entry for this item). Every
// branch here is now a literal, individually-analyzable `import()` —
// each one is its own real module Vite can see and bundle at build
// time, not a single dynamic path built from a variable.
async function legacyLang(mode: "shell" | "ruby" | "go" | "yaml" | "toml" | "properties"): Promise<LanguageSupport | null> {
  const { StreamLanguage } = await import("@codemirror/language");
  const modeExport = await (async () => {
    switch (mode) {
      case "shell":
        return (await import("@codemirror/legacy-modes/mode/shell")).shell;
      case "ruby":
        return (await import("@codemirror/legacy-modes/mode/ruby")).ruby;
      case "go":
        return (await import("@codemirror/legacy-modes/mode/go")).go;
      case "yaml":
        return (await import("@codemirror/legacy-modes/mode/yaml")).yaml;
      case "toml":
        return (await import("@codemirror/legacy-modes/mode/toml")).toml;
      case "properties":
        return (await import("@codemirror/legacy-modes/mode/properties")).properties;
    }
  })();
  // StreamLanguage.define returns a Language, not a LanguageSupport — cast
  // is safe for our purposes here, we only ever pass this into
  // EditorState.create's extensions array, which accepts both.
  return StreamLanguage.define(modeExport as never) as unknown as LanguageSupport;
}

/** Fase 6 (adoção de CDP) — gutter clicável de breakpoint. `breakpointLinesField`
 * guarda o conjunto de linhas (1-indexed, mesma convenção de `jumpToLine`)
 * como estado do CodeMirror; `setBreakpointLines` é o único jeito de
 * alterá-lo — React é a fonte de verdade (`BrowserInspector.tsx`'s
 * `breakpointsByUrl`, sincronizado via `Debugger.setBreakpointByUrl`/
 * `removeBreakpoint`), o CodeMirror só REFLETE isso; um clique no gutter
 * não altera o field sozinho, só chama `onToggle(line)` pra React decidir. */
const setBreakpointLines = StateEffect.define<Set<number>>();
const breakpointLinesField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointLines)) return e.value;
    return value;
  },
});

class BreakpointDot extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-breakpoint-marker";
    return el;
  }
}
const breakpointDot = new BreakpointDot();

function breakpointGutter(onToggle: (line: number) => void) {
  return gutter({
    class: "cm-breakpoint-gutter",
    markers(view) {
      const lines = view.state.field(breakpointLinesField);
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const lineNo of [...lines].sort((a, b) => a - b)) {
        if (lineNo < 1 || lineNo > view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNo);
        builder.add(line.from, line.from, breakpointDot);
      }
      return builder.finish();
    },
    domEventHandlers: {
      mousedown(view, line) {
        onToggle(view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  });
}

function loadLanguage(filename: string): Promise<LanguageSupport | null> {
  const i = filename.lastIndexOf(".");
  const e = i === -1 ? "" : filename.slice(i).toLowerCase();
  const loader = LANG_LOADERS[e];
  return loader ? loader().catch(() => null) : Promise.resolve(null);
}

const setAgentMarks = StateEffect.define<Map<number, AgentLineMark>>();
const agentMarksField = StateField.define<Map<number, AgentLineMark>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setAgentMarks)) return e.value;
    return value;
  },
});

class AgentStrip extends GutterMarker {
  constructor(readonly color: string) {
    super();
  }
  eq(other: AgentStrip) {
    return other.color === this.color;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-agent-mark";
    el.style.background = this.color;
    return el;
  }
}

function agentGutter() {
  return gutter({
    class: "cm-agent-gutter",
    markers(view) {
      const marks = view.state.field(agentMarksField);
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const [lineNo, mark] of [...marks.entries()].sort((a, b) => a[0] - b[0])) {
        if (lineNo < 1 || lineNo > view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNo);
        builder.add(line.from, line.from, new AgentStrip(mark.color));
      }
      return builder.finish();
    },
    widgetMarker(_view, widget) {
      return widget instanceof GhostWidget && widget.color ? new StripBlock(widget.color, widget.rows) : null;
    },
  });
}

/** Doc sync from disk keeps the user's scroll and cursor: it is applied as a
 * minimal replace, kept out of undo history, and never reported as an edit. */
const externalSync = Annotation.define<boolean>();

export type LiveLabels = {
  /** "N linhas removidas" row, folded or open. */
  removedRows: (count: number, open: boolean) => string;
  accept: string;
  openCard: string;
  changedSinceOpen: string;
  stats: (added: number, removed: number) => string;
};

export type LiveActionInfo = { hunkId: string; cardId: string | null };

const DEFAULT_LIVE_LABELS: LiveLabels = {
  removedRows: (count) => String(count),
  accept: "",
  openCard: "",
  changedSinceOpen: "",
  stats: () => "",
};

const liveLabelsFacet = Facet.define<LiveLabels, LiveLabels | null>({ combine: (v) => v[0] ?? null });
const liveActionFacet = Facet.define<(action: "accept" | "open-card", info: LiveActionInfo) => void, ((action: "accept" | "open-card", info: LiveActionInfo) => void) | null>({
  combine: (v) => v[0] ?? null,
});

type LiveInput = { diff: LiveDiff | null; fresh: ReadonlySet<string>; colors: ReadonlyMap<string, string> };
type LiveState = LiveInput & { expanded: ReadonlySet<string>; decos: DecorationSet };

const setLiveDiff = StateEffect.define<LiveInput>();
const toggleGhost = StateEffect.define<string>();

class GhostWidget extends WidgetType {
  constructor(
    readonly hunk: LiveDiffHunk,
    readonly folded: boolean,
    readonly color: string | null,
    readonly label: string,
  ) {
    super();
  }
  /** An open removal long enough to fold keeps a collapse row on top. */
  get lead(): number {
    return !this.folded && this.hunk.ghosts.length >= LIVE_DIFF_FOLD_AT ? 1 : 0;
  }
  /** Rows drawn; the gutters mirror this so every column lines up. */
  get rows(): number {
    return this.folded ? 1 : this.hunk.ghosts.length + this.lead;
  }
  /** Known up front, so a ghost above the viewport does not nudge the scroll. */
  get estimatedHeight() {
    return this.rows * 21;
  }
  eq(other: GhostWidget) {
    return (
      other.hunk.id === this.hunk.id &&
      other.folded === this.folded &&
      other.color === this.color &&
      other.label === this.label
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-live-ghost";
    dom.dataset.hunk = this.hunk.id;
    if (this.folded || this.lead > 0) dom.appendChild(this.toggleRow(view));
    if (this.folded) return dom;
    for (const g of this.hunk.ghosts) {
      const row = document.createElement("div");
      row.className = "cm-live-ghost-row";
      if (g.word && g.word[1] > g.word[0]) {
        row.appendChild(document.createTextNode(g.text.slice(0, g.word[0])));
        const w = document.createElement("span");
        w.className = "cm-live-ghost-word";
        w.textContent = g.text.slice(g.word[0], g.word[1]);
        row.appendChild(w);
        row.appendChild(document.createTextNode(g.text.slice(g.word[1])));
      } else {
        row.textContent = g.text;
      }
      dom.appendChild(row);
    }
    return dom;
  }
  private toggleRow(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-live-ghost-fold";
    btn.textContent = `${this.folded ? "▸" : "▾"} ${this.label}`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleGhost.of(this.hunk.id) });
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

function buildLiveDecorations(state: EditorState, input: LiveInput, expanded: ReadonlySet<string>): DecorationSet {
  const diff = input.diff;
  if (!diff) return Decoration.none;
  const labels = state.facet(liveLabelsFacet);
  const doc = state.doc;
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  for (const h of diff.hunks) {
    const fresh = input.fresh.has(h.id);
    for (let n = h.fromLine; n <= h.toLine && n <= doc.lines; n++) {
      const line = doc.line(n);
      ranges.push(Decoration.line({ class: `cm-live-add${fresh ? " cm-live-fresh" : ""}` }).range(line.from));
      const word = diff.words.get(n);
      if (word) {
        const from = Math.min(line.from + word[0], line.to);
        const to = Math.min(line.from + word[1], line.to);
        if (to > from) ranges.push(Decoration.mark({ class: "cm-live-word" }).range(from, to));
      }
    }
    if (h.ghosts.length > 0) {
      const isOpen = expanded.has(h.id);
      const folded = decideGhostFolded(h.ghosts.length, isOpen);
      const atEnd = h.anchorLine > doc.lines;
      const pos = atEnd ? doc.length : doc.line(h.anchorLine).from;
      const label = labels?.removedRows(h.ghosts.length, isOpen) ?? String(h.ghosts.length);
      ranges.push(
        Decoration.widget({
          widget: new GhostWidget(h, folded, input.colors.get(h.id) ?? null, label),
          block: true,
          side: atEnd ? 1 : -1,
        }).range(pos),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const liveField = StateField.define<LiveState>({
  create: () => ({ diff: null, fresh: new Set(), colors: new Map(), expanded: new Set(), decos: Decoration.none }),
  update(value, tr) {
    let next = value;
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(setLiveDiff)) {
        next = { ...next, ...e.value };
        rebuild = true;
      } else if (e.is(toggleGhost)) {
        const expanded = new Set(next.expanded);
        if (expanded.has(e.value)) expanded.delete(e.value);
        else expanded.add(e.value);
        next = { ...next, expanded };
        rebuild = true;
      }
    }
    if (rebuild) return { ...next, decos: buildLiveDecorations(tr.state, next, next.expanded) };
    if (tr.docChanged) return { ...next, decos: next.decos.map(tr.changes) };
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

function hunkAtLine(diff: LiveDiff | null, line: number): LiveDiffHunk | null {
  if (!diff) return null;
  return diff.hunks.find((h) => line >= h.fromLine && line <= h.toLine) ?? null;
}

class SignMarker extends GutterMarker {
  constructor(
    readonly sign: "+" | "-",
    readonly rows: number,
    /** Blank rows first, for the collapse row of an open removal. */
    readonly lead = 0,
  ) {
    super();
  }
  eq(other: SignMarker) {
    return other.sign === this.sign && other.rows === this.rows && other.lead === this.lead;
  }
  toDOM() {
    const wrap = document.createElement("span");
    for (let i = 0; i < this.rows; i++) {
      const el = document.createElement("span");
      el.className = `cm-live-sign ${this.sign === "+" ? "cm-live-sign-add" : "cm-live-sign-del"}`;
      el.textContent = i < this.lead ? "" : this.sign === "+" ? "+" : "−";
      wrap.appendChild(el);
    }
    return wrap;
  }
}

class GhostNumbers extends GutterMarker {
  constructor(readonly numbers: ReadonlyArray<number | null>) {
    super();
  }
  eq(other: GhostNumbers) {
    return other.numbers.length === this.numbers.length && other.numbers.every((n, i) => n === this.numbers[i]);
  }
  toDOM() {
    const wrap = document.createElement("span");
    for (const n of this.numbers) {
      const el = document.createElement("span");
      el.className = "cm-live-num-del";
      el.style.display = "block";
      el.style.height = "21px";
      el.style.lineHeight = "21px";
      el.textContent = n == null ? "" : String(n);
      wrap.appendChild(el);
    }
    return wrap;
  }
}

class TintMarker extends GutterMarker {
  constructor(readonly cls: string) {
    super();
    this.elementClass = cls;
  }
  eq(other: TintMarker) {
    return other.cls === this.cls;
  }
}
const addTint = new TintMarker("cm-live-add-gutter");
const ghostTint = new TintMarker("cm-live-ghost-gutter");

class StripBlock extends GutterMarker {
  constructor(
    readonly color: string,
    readonly rows: number,
  ) {
    super();
  }
  eq(other: StripBlock) {
    return other.color === this.color && other.rows === this.rows;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-agent-mark";
    el.style.background = this.color;
    el.style.minHeight = `${21 * this.rows}px`;
    return el;
  }
}

function liveExtensions(): Extension[] {
  return [
    liveField,
    gutter({
      class: "cm-live-sign-gutter",
      markers(view) {
        const { diff } = view.state.field(liveField);
        const builder = new RangeSetBuilder<GutterMarker>();
        if (!diff) return builder.finish();
        const plus = new SignMarker("+", 1);
        for (const h of diff.hunks) {
          for (let n = h.fromLine; n <= h.toLine && n <= view.state.doc.lines; n++) {
            const line = view.state.doc.line(n);
            builder.add(line.from, line.from, plus);
          }
        }
        return builder.finish();
      },
      widgetMarker(_view, widget) {
        return widget instanceof GhostWidget ? new SignMarker("-", widget.rows, widget.lead) : null;
      },
    }),
    lineNumberWidgetMarker.of((_view, widget) =>
      widget instanceof GhostWidget
        ? new GhostNumbers(
            widget.folded
              ? [widget.hunk.ghosts[0]!.oldLine]
              : [...Array<null>(widget.lead).fill(null), ...widget.hunk.ghosts.map((g) => g.oldLine)],
          )
        : null,
    ),
    gutterLineClass.compute([liveField], (state) => {
      const { diff } = state.field(liveField);
      const builder = new RangeSetBuilder<GutterMarker>();
      if (!diff) return builder.finish();
      for (const h of diff.hunks) {
        for (let n = h.fromLine; n <= h.toLine && n <= state.doc.lines; n++) {
          const line = state.doc.line(n);
          builder.add(line.from, line.from, addTint);
        }
      }
      return builder.finish();
    }),
    gutterWidgetClass.of((_view, widget) => (widget instanceof GhostWidget ? ghostTint : null)),
  ];
}

const hoverAgentLine = StateEffect.define<number | null>();
const hoverAgentField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(hoverAgentLine)) return e.value;
    return value;
  },
  provide: (field) =>
    showTooltip.computeN([field, agentMarksField, liveField], (state) => {
      const lineNo = state.field(field);
      if (lineNo == null || lineNo < 1 || lineNo > state.doc.lines) return [];
      const hunk = hunkAtLine(state.field(liveField).diff, lineNo);
      if (!hunk) return [];
      const mark = state.field(agentMarksField).get(lineNo);
      const labels = state.facet(liveLabelsFacet);
      const line = state.doc.line(lineNo);
      const tooltip: Tooltip = {
        pos: line.from,
        above: true,
        create(view) {
          const dom = document.createElement("div");
          dom.className = "cm-agent-tooltip";
          const add = (cls: string | null, text: string, tag: "strong" | "span" = "span") => {
            const el = document.createElement(tag);
            if (cls) el.className = cls;
            el.textContent = text;
            dom.appendChild(el);
          };
          if (mark) {
            const tip = decideGutterTooltip(mark, Date.now());
            add(null, tip.title, "strong");
            if (tip.taskLine) add("muted", tip.taskLine);
            if (tip.whenLine) add("muted", tip.whenLine);
          } else {
            add(null, labels?.changedSinceOpen ?? "", "strong");
          }
          add("muted", labels?.stats(hunk.added, hunk.removed) ?? "");
          const actions = document.createElement("div");
          actions.className = "actions";
          const button = (text: string, action: "accept" | "open-card") => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = text;
            btn.addEventListener("mousedown", (e) => {
              e.preventDefault();
              e.stopPropagation();
              view.state.facet(liveActionFacet)?.(action, { hunkId: hunk.id, cardId: mark?.cardId ?? null });
              view.dispatch({ effects: hoverAgentLine.of(null) });
            });
            actions.appendChild(btn);
          };
          button(labels?.accept ?? "", "accept");
          if (mark) button(labels?.openCard ?? "", "open-card");
          dom.appendChild(actions);
          // Moving from the line onto the tooltip must not close it, or its
          // buttons would be out of reach.
          dom.addEventListener("mouseleave", () => view.dispatch({ effects: hoverAgentLine.of(null) }));
          return { dom };
        },
      };
      return [tooltip];
    }),
});

export function CodeEditor({
  value,
  onChange,
  filename,
  jumpToLine,
  readOnly,
  breakpointLines,
  onToggleBreakpoint,
  onCursorChange,
  agentLineMarks,
  plain,
  syncEpoch,
  liveDiff,
  liveFresh,
  liveColors,
  liveLabels,
  onLiveAction,
  onHunkNav,
  jumpRequest,
  onViewportLines,
}: {
  /** Initial content only — read once when the editor mounts (or when
   * `filename` changes, forcing a remount). Typing updates CodeMirror's
   * own internal document; this is NOT re-synced from `value` on every
   * keystroke (see the module doc comment) — `FilesCard.tsx` keys this
   * component by the selected file's path so a genuinely different file
   * always gets a fresh instance instead of fighting a live one. */
  value: string;
  onChange: (value: string) => void;
  filename: string;
  /** DESIGN-BACKLOG.md item 51 — set from a content-search match. Same
   * "read once at mount, never again" contract as `value` above — this
   * component has no way to re-jump without a remount (a new `filename`/
   * key), which is exactly what FilesCard.tsx already does for every
   * genuinely different file. 1-indexed, matching how editors and
   * `fs-tools.ts`'s `ContentMatch.line` both count lines. */
  jumpToLine?: number | null;
  /** DESIGN-BACKLOG.md §2.1 item 7 — the inspector's Sources tab reuses
   * this component for a genuinely read-only source viewer (not just a
   * `onChange` that silently discards edits, which would let the user
   * type into something that visually looks editable but isn't real).
   * Defaults to false — every existing caller (FilesCard.tsx) keeps
   * editing exactly as before. */
  readOnly?: boolean;
  /** Fase 6 (adoção de CDP) — linhas com breakpoint (1-indexed), fonte de
   * verdade em `BrowserInspector.tsx`. Ambos ausentes (padrão) = sem
   * gutter de breakpoint nenhum — `FilesCard.tsx` nunca passa isso. */
  breakpointLines?: Set<number>;
  onToggleBreakpoint?: (line: number) => void;
  /** 1-based line/column for the status bar. */
  onCursorChange?: (line: number, col: number) => void;
  /** Lines attributed to a live card/task (from declared diffs only). */
  agentLineMarks?: Map<number, AgentLineMark>;
  /** Bumps when the text on disk changed under a clean tab: `value` is then
   * applied to the open document in place (scroll and cursor stay). */
  syncEpoch?: number;
  /** Changes since the baseline, drawn inline: tinted rows, `+`/`−` signs,
   * removed rows as ghosts between the current ones. */
  liveDiff?: LiveDiff | null;
  /** Hunk ids that a live write just produced (they pulse once). */
  liveFresh?: ReadonlySet<string>;
  /** Strip color of the ghost rows, by hunk id (only where authorship is known). */
  liveColors?: ReadonlyMap<string, string>;
  liveLabels?: LiveLabels;
  onLiveAction?: (action: "accept" | "open-card", info: LiveActionInfo) => void;
  /** Alt+ArrowDown / Alt+ArrowUp. */
  onHunkNav?: (dir: 1 | -1) => void;
  /** Scrolls to `line` (and moves the cursor there) when `nonce` changes. */
  jumpRequest?: { line: number; nonce: number } | null;
  /** First and last line actually on screen. */
  onViewportLines?: (top: number, bottom: number) => void;
  /** Large-buffer mode: skip language parse, indent guides, fold gutter
   * and syntax highlighting so opening / board pan stay on the frame
   * budget. Line numbers and editing still work. */
  plain?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callback in a ref so the mount effect below doesn't need
  // `onChange` in its dependency array (a new inline arrow prop every
  // render would otherwise tear down and rebuild the whole editor).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  onToggleBreakpointRef.current = onToggleBreakpoint;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const onLiveActionRef = useRef(onLiveAction);
  onLiveActionRef.current = onLiveAction;
  const onHunkNavRef = useRef(onHunkNav);
  onHunkNavRef.current = onHunkNav;
  const onViewportLinesRef = useRef(onViewportLines);
  onViewportLinesRef.current = onViewportLines;
  const reportViewportRef = useRef<((v: EditorView) => void) | null>(null);
  const liveLabelsRef = useRef(liveLabels);
  liveLabelsRef.current = liveLabels;
  const agentMarksRef = useRef(agentLineMarks);
  agentMarksRef.current = agentLineMarks;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    const languageCompartment = new Compartment();

    const heavyExtensions = plain
      ? []
      : [
          indentOnInput(),
          bracketMatching(),
          foldGutter(),
          indentationMarkers({ hideFirstIndent: true }),
          syntaxHighlighting(highlightStyle, { fallback: true }),
        ];

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          ...heavyExtensions,
          editorTheme,
          agentMarksField.init(() => agentLineMarks ?? new Map()),
          hoverAgentField,
          ...liveExtensions(),
          liveLabelsFacet.of(liveLabelsRef.current ?? DEFAULT_LIVE_LABELS),
          liveActionFacet.of((action, info) => onLiveActionRef.current?.(action, info)),
          agentGutter(),
          EditorView.domEventHandlers({
            mousemove(event, v) {
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) {
                v.dispatch({ effects: hoverAgentLine.of(null) });
                return false;
              }
              const line = v.state.doc.lineAt(pos).number;
              const hit = hunkAtLine(v.state.field(liveField).diff, line);
              if (v.state.field(hoverAgentField) !== (hit ? line : null)) {
                v.dispatch({ effects: hoverAgentLine.of(hit ? line : null) });
              }
              return false;
            },
            mouseleave(event, v) {
              const to = event.relatedTarget as HTMLElement | null;
              if (to?.closest?.(".cm-tooltip")) return false;
              v.dispatch({ effects: hoverAgentLine.of(null) });
              return false;
            },
          }),
          ...(onToggleBreakpoint
            ? [breakpointLinesField.init(() => breakpointLines ?? new Set()), breakpointGutter((line) => onToggleBreakpointRef.current?.(line))]
            : []),
          keymap.of(
            plain
              ? [...defaultKeymap, ...historyKeymap, indentWithTab]
              : [...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab],
          ),
          // Above the default keymap, which binds these keys to "move line".
          Prec.high(keymap.of([
            {
              key: "Alt-ArrowDown",
              run: () => {
                if (!onHunkNavRef.current) return false;
                onHunkNavRef.current(1);
                return true;
              },
            },
            {
              key: "Alt-ArrowUp",
              run: () => {
                if (!onHunkNavRef.current) return false;
                onHunkNavRef.current(-1);
                return true;
              },
            },
          ])),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(externalSync))) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.docChanged || update.viewportChanged || update.geometryChanged) reportViewport(update.view);
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              onCursorChangeRef.current?.(line.number, head - line.from + 1);
            }
          }),
          languageCompartment.of([]),
          EditorState.readOnly.of(Boolean(readOnly)),
          EditorView.editable.of(!readOnly),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    let viewportFrame = 0;
    const reportViewport = (v: EditorView) => {
      if (viewportFrame) return;
      viewportFrame = requestAnimationFrame(() => {
        viewportFrame = 0;
        const cb = onViewportLinesRef.current;
        if (!cb || viewRef.current !== v) return;
        const top = v.scrollDOM.scrollTop;
        const first = v.state.doc.lineAt(v.lineBlockAtHeight(top).from).number;
        const last = v.state.doc.lineAt(v.lineBlockAtHeight(top + v.scrollDOM.clientHeight).from).number;
        cb(first, last);
      });
    };
    reportViewportRef.current = reportViewport;
    const onScroll = () => reportViewport(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    reportViewport(view);

    // DESIGN-BACKLOG.md item 51 — clamp defensively: a stale match (the
    // file changed on disk since the search ran) could reference a line
    // number past the actual document's end, which `doc.line()` throws
    // on rather than clamping itself.
    if (jumpToLine && jumpToLine >= 1) {
      const lineNum = Math.min(jumpToLine, view.state.doc.lines);
      const pos = view.state.doc.line(lineNum).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }

    if (!plain) {
      loadLanguage(filename).then((lang) => {
        if (cancelled || !lang) return;
        view.dispatch({ effects: languageCompartment.reconfigure(lang) });
      });
    }

    return () => {
      cancelled = true;
      if (viewportFrame) cancelAnimationFrame(viewportFrame);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      reportViewportRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
    // Deliberately `filename` + `plain` — see the `value` prop doc above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, plain]);

  // Sincroniza o gutter de breakpoint SEM remontar o editor (perderia
  // scroll/cursor a cada toggle) — React continua a fonte de verdade,
  // este efeito só reflete `breakpointLines` no field do CodeMirror.
  useEffect(() => {
    if (!viewRef.current || !breakpointLines) return;
    viewRef.current.dispatch({ effects: setBreakpointLines.of(breakpointLines) });
  }, [breakpointLines]);

  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({ effects: setAgentMarks.of(agentLineMarks ?? new Map()) });
  }, [agentLineMarks]);

  // One transaction for "the text changed on disk" and "here is the diff for
  // that text": the new rows are applied to the open document in place (scroll
  // and cursor stay) and the marks for it land with them, so ghost rows above
  // the viewport never nudge the scroll in a second step.
  const noFresh = useRef<ReadonlySet<string>>(new Set()).current;
  const noColors = useRef<ReadonlyMap<string, string>>(new Map()).current;
  const valueRef = useRef(value);
  valueRef.current = value;
  const syncedEpoch = useRef(syncEpoch);
  const pendingPin = useRef<{ pos: number; within: number } | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const liveEffect = setLiveDiff.of({
      diff: liveDiff ?? null,
      fresh: liveFresh ?? noFresh,
      colors: liveColors ?? noColors,
    });
    let changes: ReturnType<typeof decideLineChanges> | null = null;
    if (syncEpoch !== syncedEpoch.current) {
      syncedEpoch.current = syncEpoch;
      const current = view.state.doc.toString();
      if (current !== valueRef.current) changes = decideLineChanges(current, valueRef.current);
    }
    // Pin the first visible line: edits and ghost rows above the viewport
    // change the height of what is scrolled past, and the pin is applied with
    // the new heights, in the same update. A pin that CodeMirror has not
    // applied yet still stands (the DOM scroll position is stale until then),
    // so a second update right behind the first keeps the first one's anchor.
    const top = view.scrollDOM.scrollTop;
    const height = Math.max(0, top - view.documentPadding.top);
    const spec = changes ? view.state.changes(changes) : null;
    let anchorPos: number | null = null;
    let within = 0;
    if (pendingPin.current) {
      anchorPos = pendingPin.current.pos;
      within = pendingPin.current.within;
    } else if (top > 0) {
      const block = view.lineBlockAtHeight(height);
      anchorPos = block.from;
      within = height - block.top;
    }
    const pos = anchorPos != null ? (spec ? spec.mapPos(anchorPos, -1) : anchorPos) : null;
    view.dispatch({
      ...(spec ? { changes: spec, annotations: [externalSync.of(true), Transaction.addToHistory.of(false)] } : {}),
      effects: [liveEffect],
    });
    if (pos != null) {
      pendingPin.current = { pos, within };
      // CodeMirror's own scroll effect is not applied reliably when the
      // update comes from outside a user event, so the pin is set directly,
      // now and once the layout has settled.
      const apply = () => {
        const pin = pendingPin.current;
        if (!pin || viewRef.current !== view) return;
        const target = view.lineBlockAt(pin.pos).top + view.documentPadding.top + pin.within;
        if (Math.abs(view.scrollDOM.scrollTop - target) >= 1) view.scrollDOM.scrollTop = target;
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
      if (pinTimer.current) clearTimeout(pinTimer.current);
      pinTimer.current = setTimeout(() => {
        apply();
        pendingPin.current = null;
      }, 250);
    }
    // The editor remounts on file change; the mount effect above runs first.
  }, [syncEpoch, liveDiff, liveFresh, liveColors, filename, plain, noFresh, noColors]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpRequest) return;
    const line = Math.min(Math.max(1, jumpRequest.line), view.state.doc.lines);
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    // Only a new request jumps, never a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest?.nonce]);

  return <div className="code-editor" ref={containerRef} />;
}
