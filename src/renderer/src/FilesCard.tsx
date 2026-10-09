import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import { CardFrame } from "./CardFrame";
import { decideFilesFooter } from "./card-footer-decision";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import type { Rect } from "./board-model";
import type { ContentMatch, DirEntry, GitAttribution, GitStatus, TaskBoardItem } from "../../preload/index";
import { decideOpenFileOnDiskChange, type DiskConflictFlag } from "../../shared/file-reload-decision";
import { STELLAR_PATHS_MIME, joinProjectPath } from "./terminal-drop-decision";
import {
  decideCodeFileBadge,
  decideGitLetter,
  gitLetterColor,
} from "./code-file-icon-decision";
import { folderColorAtDepth, folderFillAtDepth } from "./code-folder-color-decision";
import { decideTerritoryEditWarn, pathInTerritory } from "./code-territory-warn-decision";
import { decideAgentLineMarks, type AgentLineHunk } from "./code-line-attribution-decision";
import { decideDiffHunkRangesForFile } from "./code-diff-hunk-lines-decision";
import { decideFuzzyFileHits } from "./code-fuzzy-match-decision";
import { decideBreadcrumbSymbol } from "./code-breadcrumb-symbol-decision";
import { decideCodeProblems, type CodeProblem } from "./code-diagnostics-decision";
import {
  decideAgentDotByPath,
  decideTerritoryRoster,
} from "./code-territory-roster-decision";
import {
  decideEditorPerfMode,
  decideMinimapBars,
  extractLineWindow,
} from "./code-editor-perf-decision";
import styles from "./FilesCard.module.css";

const PROVIDER_ACCENT: Record<string, string> = {
  claude: "#f0883e",
  anthropic: "#f0883e",
  codex: "#5b8cff",
  openai: "#5b8cff",
  cursor: "#8fdcc0",
  gemini: "#e89bc4",
  bash: "#8d94a6",
};

function accentForProvider(provider: string | null | undefined): string {
  if (!provider) return "#7d8cff";
  return PROVIDER_ACCENT[provider.toLowerCase()] ?? "#7d8cff";
}

type SidePanel = "files" | "search" | "git" | "agents" | "problems";
type BottomTab = "problems" | "output" | "timeline" | "send";

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
/** Codigo-SPEC.md side panel width — narrower defaults truncate filenames. */
const TREE_WIDTH_DEFAULT = 270;
const TREE_WIDTH_MIN = 180;
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
  /**
   * Disk diverged while this tab had unsaved edits (or the file vanished).
   * Never used as a license to overwrite `content` — see
   * `decideOpenFileOnDiskChange`. Cleared on a successful save.
   */
  diskConflict: DiskConflictFlag | null;
  /**
   * Bumps when a clean tab takes new bytes from disk. CodeEditor reads
   * `value` once at mount (it owns the document after that), so a live
   * disk reload has to remount — FilesCard keys the editor on this,
   * without touching CodeEditor.tsx.
   */
  contentEpoch: number;
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
  /** Absolute path for an in-app drag onto a terminal (or elsewhere). */
  absolutePathFor: (relativePath: string) => string;
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
  /** Relative path → porcelain status letter from `git.status`. */
  gitByPath: Record<string, string>;
  /** Relative path → accent color of a live agent touching the file. */
  agentDotByPath: Record<string, string>;
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
  const badge = entry.isDir ? null : decideCodeFileBadge(entry.name);
  const gitLetter = entry.isDir ? null : decideGitLetter(actions.gitByPath[entry.path]);
  const agentDot = entry.isDir ? null : actions.agentDotByPath[entry.path];
  const folderStroke = folderColorAtDepth(depth);
  const folderFill = folderFillAtDepth(depth);
  return (
    <>
      <div
        className={`${styles.treeRow}${selectedPath === entry.path ? ` ${styles.treeSel}` : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        draggable={!entry.isDir && !isRenaming}
        onDragStart={(e) => {
          if (entry.isDir) return;
          const abs = actions.absolutePathFor(entry.path);
          e.dataTransfer.setData(STELLAR_PATHS_MIME, JSON.stringify([abs]));
          e.dataTransfer.setData("text/plain", abs);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => !isRenaming && (entry.isDir ? actions.onToggle(entry.path) : actions.onSelectFile(entry.path))}
      >
        {entry.isDir ? (
          <span className={styles.chev} aria-hidden="true">
            {isOpen ? "▾" : "▸"}
          </span>
        ) : (
          <span className={styles.chev} aria-hidden="true" />
        )}
        {entry.isDir ? (
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
            <path
              d="M1 2.5a1 1 0 0 1 1-1h4l1.5 1.5H14a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"
              fill={folderFill}
              stroke={folderStroke}
              strokeWidth="1.2"
            />
          </svg>
        ) : (
          badge && (
            <span className={styles.langBadge} style={{ background: badge.background, color: badge.color }} aria-hidden="true">
              {badge.text}
            </span>
          )
        )}
        <span className="files-node-main" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
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
        {!isRenaming && agentDot && <span className={styles.agentDot} style={{ background: agentDot }} aria-hidden="true" />}
        {!isRenaming && gitLetter && (
          <span className={styles.gitLetter} style={{ color: gitLetterColor(gitLetter) }}>
            {gitLetter}
          </span>
        )}
        {!isRenaming && (
          <span className="files-node-actions" onClick={(e) => e.stopPropagation()}>
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
  cardId,
  rect,
  zoom,
  zIndex,
  root,
  folderCardCount = 0,
  boardTasks = [],
  cardProviders = {},
  onFocusCard,
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
  cardId: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  root: string;
  folderCardCount?: number;
  /** Live Fila tasks for this board — territory / cardAlive only. */
  boardTasks?: TaskBoardItem[];
  /** cardId → provider (for accent colors). */
  cardProviders?: Record<string, string>;
  onFocusCard?: (cardId: string) => void;
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
  // Autosave is silent (SPEC status bar shows "salvo"; no chrome checkbox).
  // Opt-out only via localStorage key set to "0".
  const [autoSave] = useState(() => localStorage.getItem(AUTOSAVE_KEY) !== "0");

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
  const [treeResizing, setTreeResizing] = useState(false);
  const resizingRef = useRef(false);

  function startTreeResize(e: React.PointerEvent) {
    e.preventDefault();
    resizingRef.current = true;
    setTreeResizing(true);
    const startX = e.clientX;
    const startWidth = treeWidth;
    function onMove(ev: PointerEvent) {
      if (!resizingRef.current) return;
      const next = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, startWidth + (ev.clientX - startX)));
      setTreeWidth(next);
    }
    function onUp() {
      resizingRef.current = false;
      setTreeResizing(false);
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
  const [attribution, setAttribution] = useState<GitAttribution | null>(null);
  const [sidePanel, setSidePanel] = useState<SidePanel>("files");
  const [bottomTab, setBottomTab] = useState<BottomTab>("problems");
  const [diffOn, setDiffOn] = useState(false);
  const [headText, setHeadText] = useState<string | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const [goToQuery, setGoToQuery] = useState("");
  const [goToHits, setGoToHits] = useState<Array<{ path: string; name: string; score: number }>>([]);
  const [goToIndex, setGoToIndex] = useState(0);
  const [territoryWarn, setTerritoryWarn] = useState<null | { path: string; agents: Array<{ cardId: string; label: string | null }> }>(null);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [problems, setProblems] = useState<CodeProblem[]>([]);
  /** Empty hint vs "no checker in this project" after an on-save diagnose. */
  const [problemsHint, setProblemsHint] = useState<"idle" | "no-checker" | "failed">("idle");
  const [agentHunks, setAgentHunks] = useState<AgentLineHunk[]>([]);
  const [outputLog, setOutputLog] = useState<string>("");

  const rosterColors = useMemo(
    () =>
      Object.entries(cardProviders).map(([cardId, provider]) => ({
        cardId,
        color: accentForProvider(provider),
      })),
    [cardProviders],
  );

  const territoryAgents = useMemo(
    () =>
      decideTerritoryRoster(
        boardTasks.map((task) => ({
          id: task.id,
          status: task.status,
          cardAlive: task.cardAlive,
          territory: task.territory,
          cards: task.cards,
        })),
        rosterColors,
      ),
    [boardTasks, rosterColors],
  );

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

  const gitByPath = useMemo(() => {
    const out: Record<string, string> = {};
    if (gitStatus?.repo) {
      for (const e of gitStatus.entries) out[e.path] = e.status;
    }
    return out;
  }, [gitStatus]);

  const agentDotByPath = useMemo(() => {
    const out: Record<string, string> = {};
    // Territory of running agents wins (live roster).
    const fromTerritory = decideAgentDotByPath(
      territoryAgents,
      rosterColors,
      [
        ...(attribution?.files ?? []).map((f) => f.path),
        ...(gitStatus?.repo ? gitStatus.entries.map((e) => e.path) : []),
        ...Object.keys(kids).flatMap((dir) => (kids[dir] ?? []).filter((e) => !e.isDir).map((e) => e.path)),
      ],
      pathInTerritory,
    );
    Object.assign(out, fromTerritory);
    // Declared attribution fills gaps with the declaring card's accent.
    for (const f of attribution?.files ?? []) {
      if (out[f.path]) continue;
      if (f.state !== "declared" || f.declared.length === 0) continue;
      const cardId = f.declared[0]!.cardId;
      out[f.path] = accentForProvider(cardProviders[cardId]) || "#f0883e";
    }
    return out;
  }, [attribution, territoryAgents, rosterColors, gitStatus, kids, cardProviders]);

  const agentLineMarks = useMemo(() => decideAgentLineMarks(agentHunks), [agentHunks]);

  const editorPerf = useMemo(
    () => (content == null ? null : decideEditorPerfMode(content)),
    [content],
  );

  const breadcrumbSymbol = useMemo(() => {
    if (!activePath || content == null) return null;
    // Only scan a short window above the cursor — splitting the whole
    // buffer on every cursor move stalls pan when a large file is open.
    const win = extractLineWindow(content, cursorPos.line, 80);
    return decideBreadcrumbSymbol(win.text, win.cursorLineInWindow);
  }, [activePath, content, cursorPos.line]);

  const minimapBars = useMemo(() => {
    if (content == null) return [];
    return decideMinimapBars(content, 80, (lineNo) => agentLineMarks.get(lineNo)?.color);
  }, [content, agentLineMarks]);

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
    try {
      setAttribution(await window.git.attribution(root));
    } catch {
      setAttribution(null);
    }

    // Open-file policy: never overwrite a dirty buffer. Clean tabs
    // take disk; dirty tabs keep what was typed and grow a notice.
    // Justification lives on `decideOpenFileOnDiskChange`. Awaited so
    // the in-flight lock covers the reads, not just the tree listing.
    const tabs = openTabsRef.current;
    await Promise.all(
      tabs.map(async (tab) => {
        const kind = mediaKind(tab.path);
        if (kind === "image") {
          let disk: string | null;
          try {
            const result = await window.fs.readImage(root, tab.path);
            disk = "dataUrl" in result ? result.dataUrl : null;
          } catch {
            disk = null;
          }
          const decision = decideOpenFileOnDiskChange({
            dirty: tab.dirty,
            diskContent: disk,
            editorContent: tab.imageDataUrl,
          });
          if (decision.action === "reload" && disk) {
            updateTab(tab.path, { imageDataUrl: disk, diskConflict: null });
          } else if (decision.action === "keep-and-flag") {
            updateTab(tab.path, { diskConflict: decision.flag });
          }
          return;
        }
        let disk: string | null;
        try {
          const result = await window.fs.read(root, tab.path);
          disk = "content" in result ? result.content : null;
        } catch {
          disk = null;
        }
        const decision = decideOpenFileOnDiskChange({
          dirty: tab.dirty,
          diskContent: disk,
          editorContent: tab.content,
        });
        if (decision.action === "reload" && disk !== null) {
          updateTab(tab.path, { content: disk, diskConflict: null, contentEpoch: tab.contentEpoch + 1 });
        } else if (decision.action === "keep-and-flag") {
          updateTab(tab.path, { diskConflict: decision.flag });
        }
      }),
    );
  }, [root]);

  // One FilesCard mount = one watcher client. Stable across root
  // changes so a remount is the only thing that mints a new id —
  // unmount of THIS card must drop THIS client (care 4).
  const watchClientIdRef = useRef(
    `files-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
  );
  const reloadInFlightRef = useRef(false);
  const reloadAgainRef = useRef(false);

  const scheduleReload = useCallback(() => {
    if (reloadInFlightRef.current) {
      reloadAgainRef.current = true;
      return;
    }
    reloadInFlightRef.current = true;
    void reloadAll().finally(() => {
      reloadInFlightRef.current = false;
      if (reloadAgainRef.current) {
        reloadAgainRef.current = false;
        scheduleReload();
      }
    });
  }, [reloadAll]);

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

    const clientId = watchClientIdRef.current;
    void window.fs.watch(root, clientId);
    const unlisten = window.fs.onChanged((changedRoot) => {
      if (changedRoot === root) scheduleReload();
    });

    return () => {
      unlisten();
      void window.fs.unwatch(root, clientId);
    };
  }, [root, scheduleReload]);

  // Care 2: only directories the tree is showing (root + expanded).
  // Ignored names are dropped again in main, so expanding `out` still
  // does not register an inotify watch.
  useEffect(() => {
    void window.fs.setWatchedDirs(root, watchClientIdRef.current, ["", ...expanded]);
  }, [root, expanded]);

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
    // Sempre refetch ao expandir, mesmo com `kids[path]` populado. O
    // observador só cobre a raiz e as pastas EXPANDIDAS (efeito acima),
    // então enquanto uma pasta fica colapsada nada do que acontece dentro
    // dela gera evento — e `reloadAll`, que é quem purga entradas
    // colapsadas de `kids`, só roda por evento. Sem nenhuma mudança em
    // outro diretório observado nesse intervalo, a listagem antiga
    // sobrevive e o re-expandir mostrava o disco de antes (review do
    // 01420e9). Uma listagem por expansão é o mesmo custo da primeira.
    if (willOpen) void refreshDir(path);
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
        // Markdown preview of a large buffer builds a full HTML DOM and
        // stalls board pan — start in code view; switch to preview only
        // after the buffer is known to be small enough (see read below).
        view: "code",
        dirty: false,
        tooLarge: false,
        diskConflict: null,
        contentEpoch: 0,
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
        else {
          const perf = decideEditorPerfMode(result.content);
          updateTab(path, {
            content: result.content,
            view: kind === "markdown" && perf.allowMarkdownPreview ? "preview" : "code",
          });
        }
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
    const path = activePath;
    const body = content;
    window.fs.write(root, path, body).then(
      async () => {
        updateTab(path, { dirty: false, diskConflict: null });
        try {
          const result = await window.fs.diagnoseProject(root, path);
          if (result.status === "no-checker") {
            setProblems([]);
            setProblemsHint("no-checker");
            setOutputLog((prev) => `${prev ? `${prev}\n` : ""}[diagnose] no checker in project`.slice(-4000));
            return;
          }
          if (result.status === "failed") {
            setProblemsHint("failed");
            setOutputLog((prev) =>
              `${prev ? `${prev}\n` : ""}[diagnose] failed: ${result.detail}`.slice(-4000),
            );
            return;
          }
          const next = decideCodeProblems(result.diagnostics);
          setProblems(next);
          setProblemsHint("idle");
          setOutputLog((prev) =>
            `${prev ? `${prev}\n` : ""}[diagnose] ${path}: ${next.length} problem(s)`.slice(-4000),
          );
        } catch (e) {
          setProblemsHint("failed");
          setOutputLog((prev) => `${prev ? `${prev}\n` : ""}[diagnose] ${String(e)}`.slice(-4000));
        }
      },
      (e) => setError(String(e)),
    );
  }

  // HEAD text for side-by-side diff + agent line marks from declared
  // attribution ∩ working-tree diff hunks (no invented authorship).
  useEffect(() => {
    if (!activePath) {
      setHeadText(null);
      setAgentHunks([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const head = await window.git.showHead(root, activePath);
        if (!cancelled) setHeadText(head);
      } catch {
        if (!cancelled) setHeadText(null);
      }
      try {
        const patch = await window.git.diffHead(root, activePath);
        const ranges = decideDiffHunkRangesForFile(patch, activePath);
        const declared = (attribution?.files ?? []).find((f) => f.path === activePath && f.state === "declared");
        const owner = declared?.declared[0];
        const territoryHit = territoryAgents.find(
          (a) => a.running && a.territory.some((p) => pathInTerritory(activePath, p)),
        );
        const cardIdForMark = owner?.cardId ?? territoryHit?.cardId;
        if (!cardIdForMark || ranges.length === 0) {
          if (!cancelled) setAgentHunks([]);
          return;
        }
        const color = accentForProvider(cardProviders[cardIdForMark]);
        const task = boardTasks.find((t) => t.cards.some((c) => c.cardId === cardIdForMark));
        const hunks: AgentLineHunk[] = ranges.map((r) => ({
          ...r,
          cardId: cardIdForMark,
          color,
          label: owner?.label ?? territoryHit?.label ?? cardIdForMark,
          taskId: task?.id ?? null,
          taskTitle: task?.promptPreview?.slice(0, 40) ?? null,
          at: owner?.updatedAt ?? task?.updatedAt ?? null,
        }));
        if (!cancelled) setAgentHunks(hunks);
      } catch {
        if (!cancelled) setAgentHunks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, root, attribution, territoryAgents, cardProviders, boardTasks]);

  useEffect(() => {
    const q = goToQuery.trim();
    if (!goToOpen || !q) {
      setGoToHits([]);
      setGoToIndex(0);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.fs.searchNames(root, q).then(
        (entries) => {
          if (cancelled) return;
          const hits = decideFuzzyFileHits(
            q,
            entries.filter((e) => !e.isDir).map((e) => ({ path: e.path, name: e.name })),
          );
          setGoToHits(hits);
          setGoToIndex(0);
        },
        () => {
          if (!cancelled) setGoToHits([]);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [goToQuery, goToOpen, root]);

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

  function requestSelectFile(path: string, jumpToLine?: number) {
    const decision = decideTerritoryEditWarn(path, territoryAgents);
    if (decision.action === "warn") {
      setTerritoryWarn({ path, agents: decision.agents });
      return;
    }
    selectFile(path, jumpToLine);
  }

  const treeActions: TreeActions = {
    onToggle: toggle,
    onSelectFile: requestSelectFile,
    absolutePathFor: (relativePath) => joinProjectPath(root, relativePath),
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
    gitByPath,
    agentDotByPath,
  };

  const sideTitles: Record<SidePanel, string> = {
    files: t("files.sideFiles"),
    search: t("files.sideSearch"),
    git: t("files.sideGit"),
    agents: t("files.sideAgents"),
    problems: t("files.sideProblems"),
  };
  const changedCount = gitStatus?.repo ? gitStatus.entries.length : 0;
  const agentCount = territoryAgents.filter((a) => a.running).length;
  const problemCount = problems.length;
  const repoStatus = gitStatus?.repo ? gitStatus : null;
  const filesFooter = decideFilesFooter({
    repo: repoStatus !== null,
    branch: repoStatus?.branch ?? "",
    changedEntries: repoStatus?.entries.length ?? 0,
    folderCardCount,
  });

  return (
    <CardFrame
      className="files-card"
      kind="files"
      cardId={cardId}
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
      headerContext={activePath ? parentOf(activePath) || root : root}
      headerContent={
        <>
          <span className={styles.headTools} data-no-drag>
            <label className={styles.headGoto} onPointerDown={(e) => e.stopPropagation()}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" />
                <path d="M9.5 9.5L13 13" />
              </svg>
              <input
                aria-label={t("files.gotoTitle")}
                placeholder={t("files.gotoPlaceholder")}
                value={goToOpen ? goToQuery : ""}
                readOnly={!goToOpen}
                onFocus={() => {
                  setGoToOpen(true);
                  setGoToQuery("");
                }}
                onChange={(e) => {
                  setGoToOpen(true);
                  setGoToQuery(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setGoToOpen(false);
                    setGoToQuery("");
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setGoToIndex((i) => Math.min(i + 1, Math.max(0, goToHits.length - 1)));
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setGoToIndex((i) => Math.max(0, i - 1));
                  }
                  if (e.key === "Enter") {
                    const hit = goToHits[goToIndex] ?? (goToQuery.trim() ? { path: goToQuery.trim() } : null);
                    if (hit) {
                      requestSelectFile(hit.path);
                      setGoToOpen(false);
                      setGoToQuery("");
                    }
                  }
                }}
              />
            </label>
            {agentCount > 0 && (
              <span className={styles.headAgentsPill} title={t("files.agentsWorkingHere", { count: String(agentCount) })}>
                <span className={styles.headAgentsDot} aria-hidden="true" />
                {t("files.agentsWorkingHere", { count: String(agentCount) })}
              </span>
            )}
          </span>
          <span className="card-head-actions">
            <button type="button" onClick={onClose} aria-label={t("common.close")}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
      footerContent={
        <span className={`card-foot-row ${styles.footExtras} files-card-foot-row`}>
          {filesFooter.branch !== null && (
            <span className="files-card-branch" title={t("files.branchTitle", { branch: filesFooter.branch })}>
              {filesFooter.branch}
            </span>
          )}
          {filesFooter.changedCount !== null && (
            <span className={styles.footDirty} data-tone="warn">
              {t("files.changedCount", { count: String(filesFooter.changedCount) })}
            </span>
          )}
          {problemCount > 0 && (
            <span className={styles.footErr}>
              ✕ {problems.filter((p) => p.severity === "error").length} ! {problems.filter((p) => p.severity === "warning").length}
            </span>
          )}
          {activePath && mediaKind(activePath) !== "image" && (
            <span>
              {t("files.lnCol", { line: String(cursorPos.line), col: String(cursorPos.col) })}
            </span>
          )}
          {activePath && <span>{t("files.indentSpaces")}</span>}
          {activePath && <span>UTF-8</span>}
          {activePath && <span>{ext(activePath).replace(".", "").toUpperCase() || t("files.langText")}</span>}
          {activePath && mediaKind(activePath) !== "image" && content !== null && (
            <span>{t("files.tokensApprox", { count: formatTokenCount(estimateTokens(content)) })}</span>
          )}
          {activePath && (
            <span className={dirty ? styles.footDirty : styles.footOk}>
              {dirty ? t("files.unsaved") : t("files.saved")}
            </span>
          )}
          {filesFooter.folderCardCount !== null && (
            <span>{t("files.folderCards", { count: String(filesFooter.folderCardCount) })}</span>
          )}
        </span>
      }
    >
      <div className={styles.ide} onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setGoToOpen(true);
          setGoToQuery("");
        }
      }}>
        {goToOpen && (
          <div className={styles.goTo} role="dialog" aria-label={t("files.gotoTitle")}>
            <input
              className={styles.searchInput}
              autoFocus
              placeholder={t("files.gotoPlaceholder")}
              value={goToQuery}
              onChange={(e) => setGoToQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setGoToOpen(false);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setGoToIndex((i) => Math.min(i + 1, Math.max(0, goToHits.length - 1)));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setGoToIndex((i) => Math.max(0, i - 1));
                }
                if (e.key === "Enter") {
                  const hit = goToHits[goToIndex] ?? (goToQuery.trim() ? { path: goToQuery.trim() } : null);
                  if (hit) {
                    requestSelectFile(hit.path);
                    setGoToOpen(false);
                  }
                }
              }}
            />
            {goToHits.map((hit, i) => (
              <button
                key={hit.path}
                type="button"
                className={`${styles.goToHit}${i === goToIndex ? ` ${styles.goToHitOn}` : ""}`}
                onMouseEnter={() => setGoToIndex(i)}
                onClick={() => {
                  requestSelectFile(hit.path);
                  setGoToOpen(false);
                }}
              >
                <span>{hit.name}</span>
                <span className={styles.goToPath}>{parentOf(hit.path) || "/"}</span>
              </button>
            ))}
          </div>
        )}
        {territoryWarn && (
          <div className={styles.warnOverlay}>
            <div className={styles.warnDialog} role="alertdialog">
              <strong>{t("files.territoryWarnTitle")}</strong>
              <span>
                {t("files.territoryWarnBody", {
                  agents: territoryWarn.agents.map((a) => a.label ?? a.cardId).join(", "),
                  path: territoryWarn.path,
                })}
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button type="button" className={styles.btn} onClick={() => setTerritoryWarn(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    const p = territoryWarn.path;
                    setTerritoryWarn(null);
                    selectFile(p);
                  }}
                >
                  {t("files.territoryWarnEdit")}
                </button>
              </span>
            </div>
          </div>
        )}
        <div className={styles.row}>
          <nav className={styles.rail} aria-label="Painéis">
            {(
              [
                ["files", t("files.railFiles"), null],
                ["search", t("files.railSearch"), null],
                ["git", t("files.railGit"), changedCount || null],
                ["agents", t("files.railAgents"), agentCount || null],
                ["problems", t("files.railProblems"), problemCount || null],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                className={`${styles.railBtn}${sidePanel === id ? ` ${styles.railOn}` : ""}`}
                aria-label={label}
                onClick={() => {
                  setSidePanel(id);
                  if (id === "search") setSearchMode("content");
                }}
              >
                <Icon
                  name={id === "files" ? "files" : id === "search" ? "findCard" : id === "git" ? "changes" : id === "agents" ? "terminal" : "devTools"}
                  size={18}
                />
                {count !== null && count > 0 && (
                  <span className={`${styles.badge}${id === "problems" ? ` ${styles.badgeDanger}` : ""}`}>{count}</span>
                )}
              </button>
            ))}
          </nav>
          <aside className={styles.side} aria-label={sideTitles[sidePanel]} style={{ width: treeWidth }}>
            <div className={styles.sideTitle}>{sideTitles[sidePanel]}</div>
            <div className={styles.sideBody}>
        <div className="files-tree-panel" style={{ width: "100%", border: 0 }}>
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
              {sidePanel === "files" &&
                (kids[""] ?? []).map((entry) => (
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
          {sidePanel === "files" && (
            <div className={styles.legend}>
              <span>{t("files.legendFolders")}</span>
              <span>{t("files.legendFiles")}</span>
            </div>
          )}
          {sidePanel === "git" && (
            <div className="mono" style={{ display: "flex", flexDirection: "column", padding: "0 0 8px" }}>
              <div style={{ padding: "0 10px 8px", fontSize: 12, color: "#c9cede" }}>
                {filesFooter.branch ?? "—"} · {changedCount} alterados
              </div>
              {(attribution?.files ?? []).map((f) => (
                <div
                  key={f.path}
                  className={styles.treeRow}
                  onClick={() => requestSelectFile(f.path)}
                >
                  <span style={{ flex: 1 }}>{nameOf(f.path)}</span>
                  <span style={{ color: "#8d94a6", fontSize: 11 }}>{f.state}</span>
                </div>
              ))}
              {gitStatus?.repo &&
                gitStatus.entries.map((e) => (
                  <div key={e.path} className={styles.treeRow} onClick={() => requestSelectFile(e.path)}>
                    <span style={{ flex: 1 }}>{nameOf(e.path)}</span>
                    <span style={{ color: "#3fb68b" }}>+{e.insertions}</span>
                    <span style={{ color: "#e0846f" }}>−{e.deletions}</span>
                  </div>
                ))}
            </div>
          )}
          {sidePanel === "agents" && (
            <div style={{ padding: "0 0 10px", display: "flex", flexDirection: "column", gap: 8 }}>
              {territoryAgents.filter((a) => a.running).length === 0 && (
                <span style={{ padding: "0 10px", fontSize: 12, color: "#8d94a6" }}>{t("files.agentsEmpty")}</span>
              )}
              {territoryAgents
                .filter((a) => a.running)
                .map((a) => (
                  <div key={a.cardId} className={styles.agentCard}>
                    <span style={{ fontSize: 13 }}>{a.label ?? a.cardId}</span>
                    <span className="mono" style={{ fontSize: 11.5, color: "#8d94a6" }}>
                      {t("files.agentsTerritory", {
                        paths: `${a.territory.slice(0, 4).join(", ")}${a.territory.length > 4 ? "…" : ""}`,
                      })}
                    </span>
                  </div>
                ))}
              <span style={{ padding: "0 10px", fontSize: 12, color: "#8d94a6", lineHeight: 1.5 }}>
                {t("files.agentsNote")}
              </span>
            </div>
          )}
          {sidePanel === "problems" && (
            <div className="mono" style={{ display: "flex", flexDirection: "column" }}>
              {problems.length === 0 && (
                <span style={{ padding: "6px 10px", fontSize: 12, color: "#8d94a6" }}>
                  {problemsHint === "no-checker"
                    ? t("files.problemsNoChecker")
                    : problemsHint === "failed"
                      ? t("files.problemsFailed")
                      : t("files.problemsHint")}
                </span>
              )}
              {problems.map((p, i) => (
                <div
                  key={`${p.path}:${p.line}:${i}`}
                  className={styles.treeRow}
                  style={{ color: p.severity === "error" ? "#f2a093" : "#f0b25c" }}
                  onClick={() => requestSelectFile(p.path, p.line)}
                >
                  {p.severity === "error" ? "✕" : "!"} {nameOf(p.path)}:{p.line} · {p.message}
                </div>
              ))}
            </div>
          )}
        </div>
            </div>
          </aside>
        {/* DESIGN-BACKLOG.md item 53 — drag handle to resize the tree
            panel; `.files-tree-panel`'s width used to be a hardcoded
            220px with no way to widen/narrow it at all. */}
        <div
          className={`files-tree-resize${treeResizing ? " is-dragging" : ""}`}
          onPointerDown={startTreeResize}
        />
        <div className={`${styles.main} files-editor`}>
          {/* DESIGN-BACKLOG.md item 50 — horizontal tab bar, one pill per
              open file (insertion order). A dirty tab shows a dot instead
              of its close × until closing is explicitly confirmed
              (`closeArmedPath`, same "click again" convention as deleting
              a tree row) — silently discarding an unsaved edit here would
              be a real regression this feature must not introduce. */}
          {openTabs.length > 0 && (
            <div className={styles.tabs} role="tablist">
              {openTabs.map((tab) => {
                const tabBadge = decideCodeFileBadge(tab.path);
                return (
                  <span
                    key={tab.path}
                    role="tab"
                    aria-selected={tab.path === activePath}
                    className={`${styles.tab}${tab.path === activePath ? ` ${styles.tabOn}` : ""}`}
                    title={tab.path}
                    onClick={() => setActivePath(tab.path)}
                  >
                    <span className={styles.langBadge} style={{ width: 14, height: 14, fontSize: 6.5, background: tabBadge.background, color: tabBadge.color }}>
                      {tabBadge.text}
                    </span>
                    <span className="files-tab-name">{nameOf(tab.path)}</span>
                    {agentDotByPath[tab.path] && <span className={styles.agentDot} style={{ background: agentDotByPath[tab.path] }} />}
                    {tab.dirty && !agentDotByPath[tab.path] && <span className={styles.agentDot} style={{ background: "#e8eaf0" }} />}
                    <button
                      type="button"
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
                  </span>
                );
              })}
              <span className={styles.tabActions}>
                <button type="button" className={styles.btn} onClick={() => setDiffOn((v) => !v)}>
                  {diffOn ? t("files.diffClose") : t("files.diffWithHead")}
                </button>
                <button type="button" className={styles.btn} disabled title={t("files.splitSoon")}>
                  {t("files.split")}
                </button>
              </span>
            </div>
          )}
          {activePath && (
            <div className={styles.crumbs}>
              {activePath.split("/").map((part, i, parts) => (
                <span key={`${part}-${i}`}>
                  {i > 0 ? " › " : ""}
                  {i === parts.length - 1 ? <span className={styles.crumbSym}>{part}</span> : part}
                </span>
              ))}
              {breadcrumbSymbol && (
                <>
                  <span> › </span>
                  <span className={styles.crumbSym}>{breadcrumbSymbol}</span>
                </>
              )}
              <span style={{ flex: 1 }} />
              {mediaKind(activePath) === "markdown" && (
                <button
                  type="button"
                  className={styles.btn}
                  disabled={view === "code" && editorPerf != null && !editorPerf.allowMarkdownPreview}
                  title={
                    view === "code" && editorPerf != null && !editorPerf.allowMarkdownPreview
                      ? t("files.previewDisabledLarge")
                      : undefined
                  }
                  onClick={() => {
                    if (view === "code" && editorPerf != null && !editorPerf.allowMarkdownPreview) return;
                    updateTab(activePath, { view: view === "code" ? "preview" : "code" });
                  }}
                >
                  {view === "code" ? t("files.viewPreview") : t("files.viewCode")}
                </button>
              )}
            </div>
          )}
          {tooLarge && <div className="files-editor-msg">{t("files.tooLarge")}</div>}
          {error && <div className="files-editor-msg">{error}</div>}
          {activeTab?.diskConflict === "modified" && (
            <div className="files-editor-msg">{t("files.diskChangedDirty")}</div>
          )}
          {activeTab?.diskConflict === "gone" && <div className="files-editor-msg">{t("files.diskGone")}</div>}
          {editorPerf?.showPlainBanner && !tooLarge && (
            <div className={`files-editor-msg ${styles.plainBanner}`} role="status">
              {t("files.plainModeBanner", { lines: String(editorPerf.lineCount) })}
            </div>
          )}
          {activePath && !tooLarge && mediaKind(activePath) === "image" && imageDataUrl && (
            <div className="files-editor-image">
              <img src={imageDataUrl} alt={activePath} />
            </div>
          )}
          {activePath &&
            !tooLarge &&
            mediaKind(activePath) === "markdown" &&
            view === "preview" &&
            editorPerf?.allowMarkdownPreview !== false && (
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
          <div className={styles.editorRow}>
            <div className={styles.editorPane}>
          {activePath &&
            !tooLarge &&
            mediaKind(activePath) !== "image" &&
            !(mediaKind(activePath) === "markdown" && view === "preview" && editorPerf?.allowMarkdownPreview !== false) &&
            (content === null ? (
              <div className="files-editor-msg">{t("common.loading")}</div>
            ) : (
              <Suspense fallback={<div className="files-editor-msg">{t("files.loadingEditor")}</div>}>
                <CodeEditor
                  key={`${activePath}:${activeTab?.contentEpoch ?? 0}:${editorPerf?.mode ?? "full"}`}
                  value={content}
                  filename={activePath}
                  jumpToLine={activeTab?.pendingJumpLine}
                  plain={editorPerf?.mode === "plain"}
                  agentLineMarks={agentLineMarks}
                  onAgentGutterAction={(action, mark) => {
                    if (action === "open-card") onFocusCard?.(mark.cardId);
                    if (action === "diff") setDiffOn(true);
                  }}
                  onChange={(next) => {
                    if (activePath) updateTab(activePath, { content: next, dirty: true });
                  }}
                  onCursorChange={(line, col) => setCursorPos({ line, col })}
                />
              </Suspense>
            ))}
            </div>
            {diffOn && (
              <div className={styles.diffPane} aria-label={t("files.diffHeadLabel")}>
                <div style={{ marginBottom: 6 }}>{t("files.diffHeadLabel")}</div>
                {activePath == null ? (
                  t("files.diffNeedFile")
                ) : headText == null ? (
                  t("files.diffNoHead")
                ) : (
                  <pre className={styles.diffPre}>{headText}</pre>
                )}
              </div>
            )}
            <div className={styles.minimap} aria-hidden="true">
              {minimapBars.map((bar) => (
                <span
                  key={bar.lineNo}
                  className={styles.minimapBar}
                  style={{
                    width: `${bar.widthPct}%`,
                    background: bar.color,
                  }}
                />
              ))}
            </div>
          </div>
          <div className={styles.bottom}>
            <div className={styles.bottomTabs} role="tablist">
              {(
                [
                  ["problems", t("files.bottomProblems", { count: problemCount ? ` ${problemCount}` : "" })],
                  ["output", t("files.bottomOutput")],
                  ["timeline", t("files.bottomTimeline")],
                  ["send", t("files.bottomSend")],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.pt}${bottomTab === id ? ` ${styles.ptOn}` : ""}`}
                  onClick={() => setBottomTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.bottomBody}>
              {bottomTab === "problems" &&
                (problems.length === 0 ? (
                  <span style={{ color: "#8d94a6" }}>
                    {problemsHint === "no-checker"
                      ? t("files.problemsNoChecker")
                      : problemsHint === "failed"
                        ? t("files.problemsFailed")
                        : t("files.problemsHint")}
                  </span>
                ) : (
                  problems.map((p, i) => (
                    <span key={`${p.path}-${i}`} style={{ color: p.severity === "error" ? "#f2a093" : "#f0b25c" }}>
                      {p.severity === "error" ? "✕" : "!"} {nameOf(p.path)}:{p.line} · {p.message}
                    </span>
                  ))
                ))}
              {bottomTab === "output" && (
                <span style={{ color: "#8d94a6", whiteSpace: "pre-wrap" }}>
                  {outputLog || t("files.outputEmpty")}
                </span>
              )}
              {bottomTab === "timeline" && (
                <span style={{ color: "#8d94a6" }}>
                  {(attribution?.files ?? [])
                    .filter((f) => f.path === activePath)
                    .flatMap((f) => f.declared.map((d) => `${d.label ?? d.cardId} · ${new Date(d.updatedAt).toLocaleString()}`))
                    .join("\n") || t("files.timelineEmpty")}
                </span>
              )}
              {bottomTab === "send" && (
                <span style={{ color: "#8d94a6" }}>{t("files.sendHint")}</span>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
    </CardFrame>
  );
}

export const FilesCard = memo(FilesCardInner);
