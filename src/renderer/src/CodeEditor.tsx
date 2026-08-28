import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
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
    // DESIGN-BACKLOG.md item 45 — `.cm-scroller` is CodeMirror's OWN
    // internal scroll container (see the `.code-editor` comment in
    // cards.css), not an element this app renders directly, so the
    // app-wide `.thin-scroll` utility class can't be applied to it via
    // className — it has to be replicated here instead, in the one place
    // that already owns this editor's look and feel. Same values as
    // `.thin-scroll` (layout.css) — every other scrollable area in the
    // app used it, this one was missed when CodeMirror replaced the old
    // textarea. Both the standardized properties AND the webkit
    // pseudo-elements, matching `.thin-scroll` exactly — Chromium honors
    // `::-webkit-scrollbar` for the actual rendering, but leaving
    // `scrollbar-width`/`-color` unset here (unlike every other
    // scrollable area) would read wrong on `getComputedStyle` even if
    // the visual result happened to match.
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

function loadLanguage(filename: string): Promise<LanguageSupport | null> {
  const i = filename.lastIndexOf(".");
  const e = i === -1 ? "" : filename.slice(i).toLowerCase();
  const loader = LANG_LOADERS[e];
  return loader ? loader().catch(() => null) : Promise.resolve(null);
}

export function CodeEditor({
  value,
  onChange,
  filename,
  jumpToLine,
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callback in a ref so the mount effect below doesn't need
  // `onChange` in its dependency array (a new inline arrow prop every
  // render would otherwise tear down and rebuild the whole editor).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    const languageCompartment = new Compartment();

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          foldGutter(),
          indentationMarkers({ hideFirstIndent: true }),
          syntaxHighlighting(highlightStyle, { fallback: true }),
          editorTheme,
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          languageCompartment.of([]),
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

    loadLanguage(filename).then((lang) => {
      if (cancelled || !lang) return;
      view.dispatch({ effects: languageCompartment.reconfigure(lang) });
    });

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // Deliberately just `filename` — see the `value` prop doc above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  return <div className="code-editor" ref={containerRef} />;
}
