import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import type { Rect } from "./board-model";
import type { DirEntry, GitStatus } from "../../preload/index";

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
 * one of the four providers this app spawns (claude/codex/cursor/gemini)
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
          <Icon name={fileIconFor(entry.name, entry.isDir, isOpen)} size={14} />
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
                  title="Novo arquivo aqui"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.onCreateFile(entry.path);
                  }}
                >
                  <Icon name="newFile" size={12} />
                </button>
                <button
                  title="Nova pasta aqui"
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
              title="Renomear"
              onClick={(e) => {
                e.stopPropagation();
                actions.onStartRename(entry.path, entry.name);
              }}
            >
              <Icon name="pen" size={12} />
            </button>
            <button
              title={isDeleteArmed ? "Clique de novo pra confirmar" : "Excluir"}
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

export function FilesCard({
  rect,
  zoom,
  zIndex,
  root,
  interactionMode,
  selected,
  reflowing,
  closing,
  label,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onConnectorStart,
  onSelectStart,
}: {
  rect: Rect;
  zoom: number;
  zIndex: number;
  root: string;
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  label: string | null;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // DESIGN-BACKLOG.md item 21, ponto 11 — `null` means "not loaded yet",
  // distinct from `""` (a genuinely empty file). CodeEditor only mounts
  // once this is non-null, so a file switch never hands CodeMirror a
  // stale previous-file snapshot as its initial doc while the real
  // content is still in flight over IPC.
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [view, setView] = useState<"code" | "preview">("code");
  const [dirty, setDirty] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
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

  // DESIGN-BACKLOG.md item 46 — `git-tools.ts`'s `git:status` already
  // returns `branch`; `ChangesCard` was the only consumer. `null` while
  // loading, distinct from `{ repo: false }` (a real, confirmed non-repo
  // root) — this card's header shows nothing in either "still loading"
  // or "not a repo" case, only once a branch name is actually known.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    setKids({});
    setExpanded(new Set());
    setSelectedPath(null);
    setGitStatus(null);
    window.fs.list(root, "").then(
      (entries) => setKids((prev) => ({ ...prev, "": entries })),
      (e) => setError(String(e)),
    );
    window.git.status(root).then(setGitStatus);
  }, [root]);

  // Every armed "click again to confirm" delete auto-disarms after a few
  // seconds — an armed trash icon left sitting there is a trap for whoever
  // clicks the tree next, not a real confirmation.
  useEffect(() => {
    return () => {
      if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current);
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

  function selectFile(path: string) {
    setSelectedPath(path);
    setDirty(false);
    setTooLarge(false);
    setError(null);
    setImageDataUrl(null);
    setContent(null);
    const kind = mediaKind(path);
    if (kind === "image") {
      window.fs.readImage(root, path).then(
        (result) => {
          if ("tooLarge" in result || "notImage" in result) {
            setTooLarge(true);
          } else {
            setImageDataUrl(result.dataUrl);
          }
        },
        (e) => setError(String(e)),
      );
      return;
    }
    setView(kind === "markdown" ? "preview" : "code");
    window.fs.read(root, path).then(
      (result) => {
        if ("tooLarge" in result) {
          setTooLarge(true);
          setContent("");
        } else {
          setContent(result.content);
        }
      },
      (e) => setError(String(e)),
    );
  }

  function save() {
    if (!selectedPath || content === null) return;
    window.fs.write(root, selectedPath, content).then(
      () => setDirty(false),
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
    if (!autoSave || !dirty || !selectedPath || content === null) return;
    const timer = setTimeout(() => save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, dirty, content, selectedPath]);

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
      if (selectedPath === path) setSelectedPath(null);
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
          if (selectedPath === path || selectedPath?.startsWith(path + "/")) setSelectedPath(null);
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
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
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
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="files" size={14} />
            <CardTag label={label ?? "arquivos"} onRename={onRename} />
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
            <span className="files-card-branch" title={`branch: ${gitStatus.branch}`}>
              <Icon name="changes" size={11} />
              {gitStatus.branch}
            </span>
          )}
        </span>
      }
    >
      <div className="files-card-body">
        <div className="files-tree-panel">
          <div className="files-tree-toolbar">
            <button title="Novo arquivo na raiz" onClick={() => startCreate("", "file")}>
              <Icon name="newFile" size={13} />
            </button>
            <button title="Nova pasta na raiz" onClick={() => startCreate("", "folder")}>
              <Icon name="newFolder" size={13} />
            </button>
          </div>
          {creating && (
            <div className="files-create-row">
              <span className="files-create-hint">
                {creating.kind === "file" ? "arquivo" : "pasta"} em /{creating.parentPath}
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
          <div className="files-tree thin-scroll">
            {(kids[""] ?? []).map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                kids={kids}
                expanded={expanded}
                selectedPath={selectedPath}
                actions={treeActions}
              />
            ))}
          </div>
        </div>
        <div className="files-editor">
          {selectedPath && (
            <div className="files-editor-head">
              <span className="files-editor-head-path">
                <span className="files-editor-head-path-text">{selectedPath}</span>
                {mediaKind(selectedPath) !== "image" && content !== null && (
                  <span className="files-editor-token-count" title="Estimativa de tokens (chars/4) — aproximada, não é o tokenizer real de nenhum provider">
                    ~{formatTokenCount(estimateTokens(content))} tokens
                  </span>
                )}
              </span>
              <div className="files-editor-head-actions">
                {mediaKind(selectedPath) === "markdown" && (
                  <button onClick={() => setView(view === "code" ? "preview" : "code")}>
                    {view === "code" ? "preview" : "código"}
                  </button>
                )}
                {mediaKind(selectedPath) !== "image" && (
                  <label
                    className="files-editor-autosave-toggle"
                    title="Salvar automaticamente ~1s depois de parar de digitar"
                  >
                    <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
                    auto-save
                  </label>
                )}
                {mediaKind(selectedPath) !== "image" && (
                  <button disabled={!dirty} onClick={save}>
                    {autoSave && dirty ? "salvando…" : "salvar"}
                  </button>
                )}
              </div>
            </div>
          )}
          {tooLarge && <div className="files-editor-msg">arquivo maior que 512KB, sem preview</div>}
          {error && <div className="files-editor-msg">{error}</div>}
          {selectedPath && !tooLarge && mediaKind(selectedPath) === "image" && imageDataUrl && (
            <div className="files-editor-image thin-scroll">
              <img src={imageDataUrl} alt={selectedPath} />
            </div>
          )}
          {selectedPath && !tooLarge && mediaKind(selectedPath) === "markdown" && view === "preview" && (
            content === null ? (
              <div className="files-editor-msg">carregando…</div>
            ) : (
              <Markdown
                content={content}
                className="files-editor-preview thin-scroll"
                loadingFallback={<div className="files-editor-preview files-editor-msg">carregando preview…</div>}
              />
            )
          )}
          {selectedPath &&
            !tooLarge &&
            mediaKind(selectedPath) !== "image" &&
            !(mediaKind(selectedPath) === "markdown" && view === "preview") &&
            (content === null ? (
              <div className="files-editor-msg">carregando…</div>
            ) : (
              // DESIGN-BACKLOG.md item 21, ponto 11 — real editor
              // (CodeEditor.tsx, CodeMirror 6) instead of a bare
              // `<textarea>`: line numbers, syntax highlight per
              // extension, indentation guides, code folding. Keyed by
              // `selectedPath` so switching files always mounts a fresh
              // editor instance (see CodeEditor.tsx's own doc comment on
              // why `value` is read only once, not kept in sync live).
              <Suspense fallback={<div className="files-editor-msg">carregando editor…</div>}>
                <CodeEditor
                  key={selectedPath}
                  value={content}
                  filename={selectedPath}
                  onChange={(next) => {
                    setContent(next);
                    setDirty(true);
                  }}
                />
              </Suspense>
            ))}
        </div>
      </div>
    </CardFrame>
  );
}
