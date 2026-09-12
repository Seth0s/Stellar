import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import { CardFrame } from "./CardFrame";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import type { Rect } from "./board-model";
import type { ContentMatch, DirEntry, GitStatus } from "../../preload/index";

// DESIGN-BACKLOG.md item 21, ponto 11 — `React.lazy`, not a plain static
// import: CodeEditor.tsx pulls in CodeMirror's core (state/view/commands/
// language/highlight/indentation-markers) statically at its own top, which
// measured ~700KB added to the MAIN bundle when this was a regular import
// (`VISUALIZE=1 npm run build` before/after confirmed it) — FilesCard.tsx
// itself is always mounted eagerly (files is one of the base card kinds),
// so a plain import here would make every session pay for CodeMirror even
// if its code view is never opened. Same reasoning as `MarkdownPreview`'s
// dynamic `import()` below, just via the component-level API since this
// one needs to render more than a single effect.
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

type MediaKind = "image" | "markdown" | "text";

// DESIGN-BACKLOG.md item 48 — same `ac.<name>`/"1"/"0" localStorage
// convention as `RAIL_COLLAPSED_KEY`/`SESSIONS_PANEL_OPEN_KEY`. A
// per-viewer app preference (every FilesCard in every session shares
// it), not per-file state — matches "auto-save" being a global editor
// habit in VSCode too, not a per-file toggle. Default OFF: manual save
// is the app's current, established behavior — auto-save changes what
// "leaving a file dirty" means (crash/close now silently writes instead
// of losing the edit, but also means a half-finished edit can hit disk),
// so it's opt-in rather than a silent behavior change for existing users.
const AUTOSAVE_KEY = "ac.filesAutoSave";
const AUTOSAVE_DEBOUNCE_MS = 800;
// DESIGN-BACKLOG.md item 49 — debounced so typing a query doesn't fire a
// real recursive filesystem walk (`fs-tools.ts`'s `searchFileNames`) on
// every keystroke.
const SEARCH_DEBOUNCE_MS = 250;
// DESIGN-BACKLOG.md item 53 — the tree/explorer panel had a hardcoded
// `width: 220px` (cards.css) with no way to resize it at all. Same
// `ac.<name>` localStorage convention as `RAIL_COLLAPSED_KEY` — a
// per-viewer app preference, not per-board/per-file, matching "auto-
// save" (item 48) and every other FilesCard preference so far.
const TREE_WIDTH_KEY = "ac.filesTreeWidth";
const TREE_WIDTH_DEFAULT = 220;
const TREE_WIDTH_MIN = 140;
const TREE_WIDTH_MAX = 480;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp"]);
const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]);
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".c", ".h", ".cpp", ".hpp",
  ".java", ".kt", ".rb", ".php", ".sh", ".bash", ".css", ".scss", ".html", ".sql", ".swift",
]);

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function mediaKind(path: string): MediaKind {
  const e = ext(path);
  if (IMAGE_EXTS.has(e)) return "image";
  if (e === ".md" || e === ".markdown") return "markdown";
  return "text";
}

/** DESIGN-BACKLOG.md item 13 — "explorador de arquivos de verdade": real
 * per-extension icons instead of every row looking the same. */
function fileIconFor(name: string, isDir: boolean, isOpen: boolean): IconName {
  if (isDir) return isOpen ? "folderOpen" : "files";
  const e = ext(name);
  if (IMAGE_EXTS.has(e)) return "fileImage";
  if (e === ".md" || e === ".markdown") return "fileMarkdown";
  if (CONFIG_EXTS.has(e)) return "fileConfig";
  if (CODE_EXTS.has(e)) return "fileCode";
  return "fileGeneric";
}

/** DESIGN-BACKLOG.md item 52 — every `CODE_EXTS`/`CONFIG_EXTS` file
 * shared the exact same `fileCode`/`fileConfig` glyph AND color, so a
 * `.ts` row looked identical to a `.py` row at a glance. lucide-react
 * has no per-LANGUAGE glyph (it's a generic outline icon set, not a
 * logo/brand set like `simple-icons` or VSCode's own file-icon themes —
 * pulling one of those in for this alone is real bundle weight for a
 * cosmetic upgrade, same size-conscious call as item 47's tokenizer).
 * Same shape, but tinted per-language — colors are the well-known
 * GitHub Linguist palette (the same association most developers already
 * have from GitHub's own language bar), not this app's own accent
 * tokens, since the point here is per-LANGUAGE identity, not this app's
 * UI theme. Anything unmapped falls back to `undefined` (the icon's own
 * default `currentColor`) — same honest "no color = no claim" stance as
 * `fileGeneric` above. */
const EXT_COLOR: Record<string, string> = {
  ".ts": "#3178c6",
  ".tsx": "#3178c6",
  ".js": "#f1e05a",
  ".jsx": "#f1e05a",
  ".mjs": "#f1e05a",
  ".cjs": "#f1e05a",
  ".py": "#3572a5",
  ".rs": "#dea584",
  ".go": "#00add8",
  ".c": "#555555",
  ".h": "#555555",
  ".cpp": "#f34b7d",
  ".hpp": "#f34b7d",
  ".java": "#b07219",
  ".kt": "#a97bff",
  ".rb": "#701516",
  ".php": "#4f5d95",
  ".sh": "#89e051",
  ".bash": "#89e051",
  ".css": "#563d7c",
  ".scss": "#c6538c",
  ".html": "#e34c26",
  ".sql": "#e38c00",
  ".swift": "#f05138",
  ".json": "#292929",
  ".yaml": "#cb171e",
  ".yml": "#cb171e",
  ".toml": "#9c4221",
  ".ini": "#6d8086",
  ".env": "#6d8086",
};

function fileColorFor(name: string): string | undefined {
  return EXT_COLOR[ext(name)];
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** DESIGN-BACKLOG.md item 47 — a real tokenizer (`gpt-tokenizer` et al.)
 * only implements OpenAI's own encodings and would only be accurate for
 * one of the four providers this app spawns (claude/codex/cursor/antigravity)
 * anyway — Anthropic and Google don't publish a JS tokenizer at all — and
 * pulls in several MB of BPE rank tables for that one encoding alone.
 * chars/4 is the same rough heuristic used industry-wide as a provider-
 * agnostic estimate; labeled with "~" in the UI so it never reads as
 * exact. Good enough to answer "is this file cheap or expensive to hand
 * an agent as context", which is the actual question in this app. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** DESIGN-BACKLOG.md item 50 — one open tab. Everything that used to be
 * flat card-level state (`content`/`dirty`/`view`/`tooLarge`/
 * `imageDataUrl`) now lives per-tab, keyed by `path`, so switching tabs
 * never discards an unsaved edit in another one — a real capability this
 * refactor buys, not just a visual bar. `openTabs` is plain insertion
 * order (matches VSCode's own default tab order, not an MRU list — MRU
 * only drives VSCode's separate Ctrl+Tab switcher, not the tab bar
 * itself). */
type OpenTab = {
  path: string;
  /** `null` = still loading — same "not `""`" distinction the old flat
   * `content` state already relied on. */
  content: string | null;
  imageDataUrl: string | null;
  view: "code" | "preview";
  dirty: boolean;
  tooLarge: boolean;
  /** DESIGN-BACKLOG.md item 51 — set only when this tab was opened from
   * a content-search match; consumed once by `CodeEditor`'s own mount
   * effect (never re-read after, same "read once" contract as its
   * `value` prop) to scroll straight to the matching line. */
  pendingJumpLine: number | null;
};

/** Bundled so `TreeNode` (recursive, one prop object per node instead of a
 * dozen individual callbacks threaded through every level) stays readable —
 * same shape every level down, just re-passed as-is. */
type TreeActions = {
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
  renamingPath: string | null;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  onStartRename: (path: string, currentName: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  deleteArmedPath: string | null;
  onDeleteClick: (path: string) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
};

function TreeNode({
  entry,
  depth,
  kids,
  expanded,
  selectedPath,
  actions,
}: {
  entry: DirEntry;
  depth: number;
  kids: Record<string, DirEntry[]>;
  expanded: Set<string>;
  selectedPath: string | null;
  actions: TreeActions;
}) {
  const isOpen = expanded.has(entry.path);
  const isRenaming = actions.renamingPath === entry.path;
  const isDeleteArmed = actions.deleteArmedPath === entry.path;
  return (
    <>
      <div
        className={`files-node${selectedPath === entry.path ? " files-node-active" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <span
          className="files-node-main"
          onClick={() => !isRenaming && (entry.isDir ? actions.onToggle(entry.path) : actions.onSelectFile(entry.path))}
        >
          <Icon name={fileIconFor(entry.name, entry.isDir, isOpen)} size={14} color={entry.isDir ? undefined : fileColorFor(entry.name)} />
          {isRenaming ? (
            <input
              className="files-node-rename-input"
              autoFocus
              value={actions.renameDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => actions.setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") actions.onCommitRename();
                if (e.key === "Escape") actions.onCancelRename();
              }}
              onBlur={actions.onCommitRename}
            />
          ) : (
            <span className="files-node-name">{entry.name}</span>
          )}
        </span>
        {!isRenaming && (
          <span className="files-node-actions">
            {entry.isDir && (
              <>
                <button
                  title={t("files.newFileHere")}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.onCreateFile(entry.path);
                  }}
                >
                  <Icon name="newFile" size={12} />
                </button>
                <button
                  title={t("files.newFolderHere")}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.onCreateFolder(entry.path);
                  }}
                >
                  <Icon name="newFolder" size={12} />
                </button>
              </>
            )}
            <button
              title={t("files.rename")}
              onClick={(e) => {
                e.stopPropagation();
                actions.onStartRename(entry.path, entry.name);
              }}
            >
              <Icon name="pen" size={12} />
            </button>
            <button
              title={isDeleteArmed ? t("files.deleteConfirm") : t("files.delete")}
              className={isDeleteArmed ? "files-node-delete-armed" : ""}
              onClick={(e) => {
                e.stopPropagation();
                actions.onDeleteClick(entry.path);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </span>
        )}
      </div>
      {entry.isDir &&
        isOpen &&
        (kids[entry.path] ?? []).map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            kids={kids}
            expanded={expanded}
            selectedPath={selectedPath}
            actions={actions}
          />
        ))}
    </>
  );
}

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function FilesCardInner({
  rect,
  zoom,
  zIndex,
  root,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
  screenProjected,
  panX,
  panY,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  root: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern StickyCard/BrowserCard already use. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
}) {
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // DESIGN-BACKLOG.md item 50 — replaces the old flat `selectedPath` +
  // `content`/`dirty`/`view`/`tooLarge`/`imageDataUrl` state. `activeTab`/
  // `content`/etc. below are DERIVED (plain `const`, not `useState`) from
  // `openTabs`/`activePath` — every other line of this component that
  // used to read the flat state still reads a same-named local, so the
  // render body (JSX) barely changed shape.
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const activeTab = openTabs.find((t) => t.path === activePath) ?? null;
  const content = activeTab?.content ?? null;
  const imageDataUrl = activeTab?.imageDataUrl ?? null;
  const view = activeTab?.view ?? "code";
  const dirty = activeTab?.dirty ?? false;
  const tooLarge = activeTab?.tooLarge ?? false;
  const [error, setError] = useState<string | null>(null);
  // DESIGN-BACKLOG.md item 48.
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem(AUTOSAVE_KEY) === "1");

  // DESIGN-BACKLOG.md item 13 — quick actions state (rename/delete/create).
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteArmedPath, setDeleteArmedPath] = useState<string | null>(null);
  const deleteArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [creating, setCreating] = useState<{ parentPath: string; kind: "file" | "folder" } | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  // DESIGN-BACKLOG.md item 50 — same "click again to confirm" pattern as
  // `deleteArmedPath` just above, reused here for closing a DIRTY tab
  // (silently discarding an unsaved edit would be a real regression this
  // feature must not introduce). A clean tab just closes on the first
  // click — no arming needed, nothing to lose.
  const [closeArmedPath, setCloseArmedPath] = useState<string | null>(null);
  const closeArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DESIGN-BACKLOG.md item 53 — resizable tree/explorer panel.
  const [treeWidth, setTreeWidth] = useState(() => {
    const saved = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return saved >= TREE_WIDTH_MIN && saved <= TREE_WIDTH_MAX ? saved : TREE_WIDTH_DEFAULT;
  });
  const resizingRef = useRef(false);

  function startTreeResize(e: React.PointerEvent) {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = treeWidth;
    function onMove(ev: PointerEvent) {
      if (!resizingRef.current) return;
      const next = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, startWidth + (ev.clientX - startX)));
      setTreeWidth(next);
    }
    function onUp() {
      resizingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
  }, [treeWidth]);

  // DESIGN-BACKLOG.md item 46 — `git-tools.ts`'s `git:status` already
  // returns `branch`; `ChangesCard` was the only consumer. `null` while
  // loading, distinct from `{ repo: false }` (a real, confirmed non-repo
  // root) — this card's header shows nothing in either "still loading"
  // or "not a repo" case, only once a branch name is actually known.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  // DESIGN-BACKLOG.md item 49/51 — filename OR full-text search
  // (`searchMode`). A non-empty `searchQuery` swaps the tree view for a
  // flat results list of whichever kind is active; `searching` covers
  // the round-trip so a slow search on a huge tree doesn't read as "no
  // matches" while still in flight.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"name" | "content">("name");
  const [searchResults, setSearchResults] = useState<DirEntry[]>([]);
  const [contentResults, setContentResults] = useState<ContentMatch[]>([]);
  const [searching, setSearching] = useState(false);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  function updateTab(path: string, patch: Partial<OpenTab>) {
    setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  }

  const reloadAll = useCallback(async () => {
    try {
      const rootEntries = await window.fs.list(root, "");
      const newKids: Record<string, DirEntry[]> = { "": rootEntries };

      const currentExpanded = Array.from(expandedRef.current);
      await Promise.all(
        currentExpanded.map(async (dirPath) => {
          try {
            const dirEntries = await window.fs.list(root, dirPath);
            newKids[dirPath] = dirEntries;
          } catch {
            // Directory might have been removed
          }
        }),
      );
      setKids(newKids);
    } catch (e) {
      setError(String(e));
    }

    try {
      const git = await window.git.status(root);
      setGitStatus(git);
    } catch {
      // Ignore git status errors
    }

    // Refresh non-dirty open tabs if their content changed on disk
    const tabs = openTabsRef.current;
    for (const tab of tabs) {
      if (!tab.dirty) {
        const kind = mediaKind(tab.path);
        if (kind === "image") {
          window.fs
            .readImage(root, tab.path)
            .then((result) => {
              if ("dataUrl" in result && result.dataUrl !== tab.imageDataUrl) {
                updateTab(tab.path, { imageDataUrl: result.dataUrl });
              }
            })
            .catch(() => {});
        } else {
          window.fs
            .read(root, tab.path)
            .then((result) => {
              if ("content" in result && result.content !== tab.content) {
                updateTab(tab.path, { content: result.content });
              }
            })
            .catch(() => {});
        }
      }
    }
  }, [root]);

  useEffect(() => {
    setKids({});
    setExpanded(new Set());
    setOpenTabs([]);
    setActivePath(null);
    setGitStatus(null);
    setSearchQuery("");
    setSearchResults([]);
    setContentResults([]);
    window.fs.list(root, "").then(
      (entries) => setKids((prev) => ({ ...prev, "": entries })),
      (e) => setError(String(e)),
    );
    window.git.status(root).then(setGitStatus).catch(() => {});

    // DESIGN-BACKLOG.md item 67 — Live file watching
    void window.fs.watch(root);
    const unlisten = window.fs.onChanged((changedRoot) => {
      if (changedRoot === root) {
        void reloadAll();
      }
    });

    return () => {
      unlisten();
      void window.fs.unwatch(root);
    };
  }, [root, reloadAll]);

  // Every armed "click again to confirm" delete/close-tab auto-disarms
  // after a few seconds — an armed trash icon or tab left sitting there is
  // a trap for whoever clicks next, not a real confirmation.
  useEffect(() => {
    return () => {
      if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current);
      if (closeArmTimer.current) clearTimeout(closeArmTimer.current);
    };
  }, []);

  async function refreshDir(path: string) {
    try {
      const entries = await window.fs.list(root, path);
      setKids((prev) => ({ ...prev, [path]: entries }));
    } catch (e) {
      setError(String(e));
    }
  }

  function toggle(path: string) {
    const willOpen = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (willOpen && !kids[path]) void refreshDir(path);
  }

  function selectFile(path: string, jumpToLine?: number) {
    setError(null);
    setActivePath(path);
    // DESIGN-BACKLOG.md item 50 — already open: just switch tabs, don't
    // refetch/reset. This is the real behavior change tabs buy beyond a
    // visual bar — reopening a file mid-edit no longer discards it.
    // (item 51: this also means a content-search click on an
    // ALREADY-open tab won't re-jump to the new line — a known, small
    // scope cut, see `pendingJumpLine`'s own doc comment.)
    if (openTabs.some((t) => t.path === path)) return;
    const kind = mediaKind(path);
    setOpenTabs((prev) => [
      ...prev,
      {
        path,
        content: null,
        imageDataUrl: null,
        view: kind === "markdown" ? "preview" : "code",
        dirty: false,
        tooLarge: false,
        pendingJumpLine: jumpToLine ?? null,
      },
    ]);
    if (kind === "image") {
      window.fs.readImage(root, path).then(
        (result) => {
          if ("tooLarge" in result || "notImage" in result) updateTab(path, { tooLarge: true });
          else updateTab(path, { imageDataUrl: result.dataUrl });
        },
        (e) => setError(String(e)),
      );
      return;
    }
    window.fs.read(root, path).then(
      (result) => {
        if ("tooLarge" in result) updateTab(path, { tooLarge: true, content: "" });
        else updateTab(path, { content: result.content });
      },
      (e) => setError(String(e)),
    );
  }

  /** DESIGN-BACKLOG.md item 50 — closing the ACTIVE tab activates its
   * left neighbor (same convention as a browser tab strip), computed
   * from its index BEFORE removal: everything left of that index keeps
   * the same index after filtering, so `next[idx - 1]` still lands on
   * the correct neighbor. Falls back to the new first tab, then `null`
   * if no tabs remain. */
  function closeTab(path: string) {
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.dirty && closeArmedPath !== path) {
      if (closeArmTimer.current) clearTimeout(closeArmTimer.current);
      setCloseArmedPath(path);
      closeArmTimer.current = setTimeout(() => setCloseArmedPath(null), 3000);
      return;
    }
    if (closeArmTimer.current) clearTimeout(closeArmTimer.current);
    setCloseArmedPath(null);
    const idx = openTabs.findIndex((t) => t.path === path);
    const next = openTabs.filter((t) => t.path !== path);
    setOpenTabs(next);
    if (activePath === path) {
      setActivePath(next.length === 0 ? null : (next[Math.max(0, idx - 1)]?.path ?? next[0].path));
    }
  }

  function save() {
    if (!activePath || content === null) return;
    window.fs.write(root, activePath, content).then(
      () => updateTab(activePath, { dirty: false }),
      (e) => setError(String(e)),
    );
  }

  useEffect(() => {
    localStorage.setItem(AUTOSAVE_KEY, autoSave ? "1" : "0");
  }, [autoSave]);

  // DESIGN-BACKLOG.md item 48 — debounced, not "save on every keystroke":
  // a save on each of possibly hundreds of keystrokes/sec (fast typing,
  // paste of a large block) would mean an IPC round-trip + disk write
  // per keystroke. Waits for AUTOSAVE_DEBOUNCE_MS of no further change
  // to `content` before writing — same shape as this app's other
  // debounced-persist effects. `dirty` in the dep array (not just
  // `content`) so a save that just completed (dirty flips false) doesn't
  // re-arm a redundant timer for content that's already on disk.
  useEffect(() => {
    if (!autoSave || !dirty || !activePath || content === null) return;
    const timer = setTimeout(() => save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, dirty, content, activePath]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setContentResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      // DESIGN-BACKLOG.md item 51 — same debounce, whichever mode is
      // active; the two search kinds never run at once.
      const search = searchMode === "name" ? window.fs.searchNames(root, q) : window.fs.searchContents(root, q);
      search.then(
        (entries) => {
          if (cancelled) return;
          if (searchMode === "name") setSearchResults(entries as DirEntry[]);
          else setContentResults(entries as ContentMatch[]);
          setSearching(false);
        },
        (e) => {
          if (!cancelled) {
            setError(String(e));
            setSearching(false);
          }
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchMode, root]);

  function startRename(path: string, currentName: string) {
    setRenamingPath(path);
    setRenameDraft(currentName);
  }

  async function commitRename() {
    if (!renamingPath) return;
    const path = renamingPath;
    const newName = renameDraft.trim();
    setRenamingPath(null);
    if (!newName || newName === nameOf(path)) return;
    try {
      await window.fs.rename(root, path, newName);
      await refreshDir(parentOf(path));
      // DESIGN-BACKLOG.md item 50 — an open tab under the renamed path
      // keeps its content/dirty state, just relabeled to the new name
      // (mirrors VSCode: renaming a file open in an editor doesn't close
      // it). Only the exact-path case, matching this function's own
      // pre-existing scope — a folder rename rewriting every nested open
      // tab's path prefix is a separate concern, not touched here.
      const parent = parentOf(path);
      const newPath = parent ? `${parent}/${newName}` : newName;
      setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, path: newPath } : t)));
      setActivePath((prev) => (prev === path ? newPath : prev));
    } catch (e) {
      setError(String(e));
    }
  }

  function cancelRename() {
    setRenamingPath(null);
  }

  function onDeleteClick(path: string) {
    if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current);
    if (deleteArmedPath === path) {
      setDeleteArmedPath(null);
      window.fs
        .delete(root, path)
        .then(() => refreshDir(parentOf(path)))
        .then(() => {
          // DESIGN-BACKLOG.md item 50 — close every open tab under the
          // deleted path (the file itself, or anything nested under a
          // deleted folder — same prefix check the old single-selection
          // code already used), not just clear a single selection.
          setOpenTabs((prev) => {
            const next = prev.filter((t) => t.path !== path && !t.path.startsWith(path + "/"));
            setActivePath((prevActive) =>
              prevActive === path || prevActive?.startsWith(path + "/")
                ? (next[next.length - 1]?.path ?? null)
                : prevActive,
            );
            return next;
          });
        })
        .catch((e) => setError(String(e)));
    } else {
      setDeleteArmedPath(path);
      deleteArmTimer.current = setTimeout(() => setDeleteArmedPath(null), 3000);
    }
  }

  function startCreate(parentPath: string, kind: "file" | "folder") {
    setCreating({ parentPath, kind });
    setCreateDraft("");
  }

  async function commitCreate() {
    if (!creating) return;
    const { parentPath, kind } = creating;
    const name = createDraft.trim();
    setCreating(null);
    if (!name) return;
    try {
      await window.fs.create(root, parentPath, name, kind);
      await refreshDir(parentPath);
      if (parentPath && !expanded.has(parentPath)) {
        setExpanded((prev) => new Set(prev).add(parentPath));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const treeActions: TreeActions = {
    onToggle: toggle,
    onSelectFile: selectFile,
    renamingPath,
    renameDraft,
    setRenameDraft,
    onStartRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: cancelRename,
    deleteArmedPath,
    onDeleteClick,
    onCreateFile: (parentPath) => startCreate(parentPath, "file"),
    onCreateFolder: (parentPath) => startCreate(parentPath, "folder"),
  };

  return (
    <CardFrame
      className="files-card"
      kind="files"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-files)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="files" size={14} />
          </span>
          <span className="card-head-actions">
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={
        <span className="files-card-foot-row">
          <span className="files-card-foot-text">{root}</span>
          {gitStatus?.repo && (
            <span className="files-card-branch" title={t("files.branchTitle", { branch: gitStatus.branch })}>
              <Icon name="changes" size={11} />
              {gitStatus.branch}
            </span>
          )}
        </span>
      }
    >
      <div className="files-card-body">
        <div className="files-tree-panel" style={{ width: treeWidth }}>
          <div className="files-tree-toolbar">
            <button title={t("files.newFileRoot")} onClick={() => startCreate("", "file")}>
              <Icon name="newFile" size={13} />
            </button>
            <button title={t("files.newFolderRoot")} onClick={() => startCreate("", "folder")}>
              <Icon name="newFolder" size={13} />
            </button>
          </div>
          {/* DESIGN-BACKLOG.md item 49/51 — filename OR full-text search
              across the whole tree, not just the currently-expanded
              directories. A non-empty query swaps the tree below for a
              flat results list of whichever mode is active. */}
          <div className="files-search-row">
            <Icon name="findCard" size={12} />
            <input
              className="files-search-input"
              placeholder={searchMode === "name" ? t("files.searchFilePh") : t("files.searchContentPh")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
            />
            {searchQuery && (
              <button className="files-search-clear" title={t("files.clearSearch")} onClick={() => setSearchQuery("")}>
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
          <div className="files-search-mode-toggle">
            <button
              className={searchMode === "name" ? "files-search-mode-active" : ""}
              title={t("files.searchByName")}
              onClick={() => setSearchMode("name")}
            >
              {t("files.searchNameShort")}
            </button>
            <button
              className={searchMode === "content" ? "files-search-mode-active" : ""}
              title={t("files.searchInContent")}
              onClick={() => setSearchMode("content")}
            >
              {t("files.searchContentShort")}
            </button>
          </div>
          {creating && (
            <div className="files-create-row">
              <span className="files-create-hint">
                {t("files.createIn", {
                  kind: creating.kind === "file" ? t("files.createKindFile") : t("files.createKindFolder"),
                  path: creating.parentPath,
                })}
              </span>
              <input
                className="files-node-rename-input"
                autoFocus
                value={createDraft}
                onChange={(e) => setCreateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitCreate();
                  if (e.key === "Escape") setCreating(null);
                }}
                onBlur={() => void commitCreate()}
              />
            </div>
          )}
          {searchQuery.trim() && searchMode === "content" ? (
            <div className="files-tree">
              {searching && <div className="files-search-msg">{t("files.searching")}</div>}
              {!searching && contentResults.length === 0 && <div className="files-search-msg">{t("files.noContentMatch")}</div>}
              {!searching &&
                contentResults.map((match) => (
                  <div
                    key={`${match.path}:${match.line}`}
                    className="files-node files-search-result files-content-result"
                    onClick={() => {
                      selectFile(match.path, match.line);
                      setSearchQuery("");
                    }}
                  >
                    <span className="files-node-main files-content-result-main">
                      <span className="files-content-result-head">
                        <Icon name={fileIconFor(nameOf(match.path), false, false)} size={13} color={fileColorFor(match.path)} />
                        <span className="files-node-name">{nameOf(match.path)}</span>
                        <span className="files-content-result-line">:{match.line}</span>
                      </span>
                      <span className="files-content-result-snippet">{match.text}</span>
                    </span>
                  </div>
                ))}
            </div>
          ) : searchQuery.trim() ? (
            <div className="files-tree">
              {searching && <div className="files-search-msg">{t("files.searching")}</div>}
              {!searching && searchResults.length === 0 && <div className="files-search-msg">{t("files.noFileMatch")}</div>}
              {!searching &&
                searchResults.map((entry) => (
                  <div
                    key={entry.path}
                    className={`files-node files-search-result${activePath === entry.path ? " files-node-active" : ""}`}
                    onClick={() => {
                      if (!entry.isDir) {
                        selectFile(entry.path);
                        setSearchQuery("");
                      }
                    }}
                  >
                    <span className="files-node-main">
                      <Icon name={fileIconFor(entry.name, entry.isDir, false)} size={14} color={entry.isDir ? undefined : fileColorFor(entry.name)} />
                      <span className="files-node-name">{entry.name}</span>
                      <span className="files-search-result-path">{parentOf(entry.path) || "/"}</span>
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <div className="files-tree">
              {(kids[""] ?? []).map((entry) => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  kids={kids}
                  expanded={expanded}
                  selectedPath={activePath}
                  actions={treeActions}
                />
              ))}
            </div>
          )}
        </div>
        {/* DESIGN-BACKLOG.md item 53 — drag handle to resize the tree
            panel; `.files-tree-panel`'s width used to be a hardcoded
            220px with no way to widen/narrow it at all. */}
        <div className="files-tree-resize" onPointerDown={startTreeResize} />
        <div className="files-editor">
          {/* DESIGN-BACKLOG.md item 50 — horizontal tab bar, one pill per
              open file (insertion order). A dirty tab shows a dot instead
              of its close × until closing is explicitly confirmed
              (`closeArmedPath`, same "click again" convention as deleting
              a tree row) — silently discarding an unsaved edit here would
              be a real regression this feature must not introduce. */}
          {openTabs.length > 0 && (
            <div className="files-tabs-bar">
              {openTabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`files-tab${tab.path === activePath ? " files-tab-active" : ""}`}
                  title={tab.path}
                  onClick={() => setActivePath(tab.path)}
                >
                  <Icon name={fileIconFor(nameOf(tab.path), false, false)} size={12} color={fileColorFor(tab.path)} />
                  <span className="files-tab-name">{nameOf(tab.path)}</span>
                  <button
                    className={`files-tab-close${closeArmedPath === tab.path ? " files-tab-close-armed" : ""}`}
                    title={
                      closeArmedPath === tab.path
                        ? t("files.closeDiscard")
                        : tab.dirty
                          ? t("files.closeUnsaved")
                          : t("files.closeTab")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.path);
                    }}
                  >
                    {tab.dirty && closeArmedPath !== tab.path ? <span className="files-tab-dirty-dot" /> : <Icon name="close" size={10} />}
                  </button>
                </div>
              ))}
            </div>
          )}
          {activePath && (
            <div className="files-editor-head">
              <span className="files-editor-head-path">
                <span className="files-editor-head-path-text">{activePath}</span>
                {mediaKind(activePath) !== "image" && content !== null && (
                  <span className="files-editor-token-count" title={t("files.tokenEstimate")}>
                    {t("files.tokensApprox", { count: formatTokenCount(estimateTokens(content)) })}
                  </span>
                )}
              </span>
              <div className="files-editor-head-actions">
                {mediaKind(activePath) === "markdown" && (
                  <button onClick={() => updateTab(activePath, { view: view === "code" ? "preview" : "code" })}>
                    {view === "code" ? t("files.viewPreview") : t("files.viewCode")}
                  </button>
                )}
                {mediaKind(activePath) !== "image" && (
                  <label className="files-editor-autosave-toggle" title={t("files.autosave")}>
                    <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
                    {t("files.autoSaveLabel")}
                  </label>
                )}
                {mediaKind(activePath) !== "image" && (
                  <button disabled={!dirty} onClick={save}>
                    {autoSave && dirty ? t("common.saving") : t("common.save")}
                  </button>
                )}
              </div>
            </div>
          )}
          {tooLarge && <div className="files-editor-msg">{t("files.tooLarge")}</div>}
          {error && <div className="files-editor-msg">{error}</div>}
          {activePath && !tooLarge && mediaKind(activePath) === "image" && imageDataUrl && (
            <div className="files-editor-image">
              <img src={imageDataUrl} alt={activePath} />
            </div>
          )}
          {activePath && !tooLarge && mediaKind(activePath) === "markdown" && view === "preview" && (
            content === null ? (
              <div className="files-editor-msg">{t("common.loading")}</div>
            ) : (
              <Markdown
                content={content}
                className="files-editor-preview"
                loadingFallback={<div className="files-editor-preview files-editor-msg">{t("files.loadingPreview")}</div>}
              />
            )
          )}
          {activePath &&
            !tooLarge &&
            mediaKind(activePath) !== "image" &&
            !(mediaKind(activePath) === "markdown" && view === "preview") &&
            (content === null ? (
              <div className="files-editor-msg">{t("common.loading")}</div>
            ) : (
              // DESIGN-BACKLOG.md item 21, ponto 11 — real editor
              // (CodeEditor.tsx, CodeMirror 6) instead of a bare
              // `<textarea>`: line numbers, syntax highlight per
              // extension, indentation guides, code folding. Keyed by
              // `activePath` so switching files/tabs always mounts a
              // fresh editor instance (see CodeEditor.tsx's own doc
              // comment on why `value` is read only once, not kept in
              // sync live — item 50: this is exactly what makes each
              // tab's CodeMirror state independent of the others).
              <Suspense fallback={<div className="files-editor-msg">{t("files.loadingEditor")}</div>}>
                <CodeEditor
                  key={activePath}
                  value={content}
                  filename={activePath}
                  jumpToLine={activeTab?.pendingJumpLine}
                  onChange={(next) => {
                    if (activePath) updateTab(activePath, { content: next, dirty: true });
                  }}
                />
              </Suspense>
            ))}
        </div>
      </div>
    </CardFrame>
  );
}

export const FilesCard = memo(FilesCardInner);
