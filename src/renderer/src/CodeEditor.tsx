import { useEffect, useRef } from "react";
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, gutter, GutterMarker, Tooltip, showTooltip } from "@codemirror/view";
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
  });
}

const hoverAgentLine = StateEffect.define<number | null>();
const hoverAgentField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(hoverAgentLine)) return e.value;
    return value;
  },
  provide: (field) =>
    showTooltip.computeN([field, agentMarksField], (state) => {
      const lineNo = state.field(field);
      if (lineNo == null) return [];
      const mark = state.field(agentMarksField).get(lineNo);
      if (!mark || lineNo < 1 || lineNo > state.doc.lines) return [];
      const tip = decideGutterTooltip(mark, Date.now());
      const line = state.doc.line(lineNo);
      const tooltip: Tooltip = {
        pos: line.from,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-agent-tooltip";
          const title = document.createElement("strong");
          title.textContent = tip.title;
          dom.appendChild(title);
          if (tip.taskLine) {
            const task = document.createElement("span");
            task.className = "muted";
            task.textContent = tip.taskLine;
            dom.appendChild(task);
          }
          if (tip.whenLine) {
            const when = document.createElement("span");
            when.className = "muted";
            when.textContent = tip.whenLine;
            dom.appendChild(when);
          }
          const actions = document.createElement("div");
          actions.className = "actions";
          const viewDiff = document.createElement("button");
          viewDiff.type = "button";
          viewDiff.textContent = "Ver diff";
          viewDiff.dataset.action = "diff";
          viewDiff.dataset.cardId = mark.cardId;
          viewDiff.dataset.taskId = mark.taskId ?? "";
          const openCard = document.createElement("button");
          openCard.type = "button";
          openCard.textContent = "Abrir o card";
          openCard.dataset.action = "open-card";
          openCard.dataset.cardId = mark.cardId;
          actions.appendChild(viewDiff);
          actions.appendChild(openCard);
          dom.appendChild(actions);
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
  onAgentGutterAction,
  plain,
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
  onAgentGutterAction?: (action: "diff" | "open-card", mark: AgentLineMark) => void;
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
  const onAgentGutterActionRef = useRef(onAgentGutterAction);
  onAgentGutterActionRef.current = onAgentGutterAction;
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
          agentGutter(),
          EditorView.domEventHandlers({
            mousemove(event, v) {
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) {
                v.dispatch({ effects: hoverAgentLine.of(null) });
                return false;
              }
              const line = v.state.doc.lineAt(pos).number;
              const mark = v.state.field(agentMarksField).get(line);
              v.dispatch({ effects: hoverAgentLine.of(mark ? line : null) });
              return false;
            },
            mouseleave(_event, v) {
              v.dispatch({ effects: hoverAgentLine.of(null) });
              return false;
            },
            mousedown(event, v) {
              const t = event.target as HTMLElement | null;
              const btn = t?.closest?.("button[data-action]") as HTMLButtonElement | null;
              if (!btn) return false;
              const action = btn.dataset.action === "open-card" ? "open-card" : "diff";
              const cardId = btn.dataset.cardId ?? "";
              const lineNo = v.state.field(hoverAgentField);
              const mark =
                (lineNo != null ? v.state.field(agentMarksField).get(lineNo) : undefined) ??
                [...v.state.field(agentMarksField).values()].find((m) => m.cardId === cardId);
              if (mark) onAgentGutterActionRef.current?.(action, mark);
              event.preventDefault();
              return true;
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
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
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

  return <div className="code-editor" ref={containerRef} />;
}
