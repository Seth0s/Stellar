import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type { DirEntry } from "../../preload/index";

type MediaKind = "image" | "markdown" | "text";

function mediaKind(path: string): MediaKind {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp"].includes(ext)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
}

function TreeNode({
  entry,
  depth,
  kids,
  expanded,
  selectedPath,
  onToggle,
  onSelectFile,
}: {
  entry: DirEntry;
  depth: number;
  kids: Record<string, DirEntry[]>;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = expanded.has(entry.path);
  return (
    <>
      <div
        className={`files-node${selectedPath === entry.path ? " files-node-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (entry.isDir ? onToggle(entry.path) : onSelectFile(entry.path))}
      >
        {entry.isDir ? (isOpen ? "▾ " : "▸ ") : "  "}
        {entry.name}
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
            onToggle={onToggle}
            onSelectFile={onSelectFile}
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
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
}) {
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [view, setView] = useState<"code" | "preview">("code");
  const [dirty, setDirty] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKids({});
    setExpanded(new Set());
    setSelectedPath(null);
    window.fs.list(root, "").then(
      (entries) => setKids((prev) => ({ ...prev, "": entries })),
      (e) => setError(String(e)),
    );
  }, [root]);

  function toggle(path: string) {
    const willOpen = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (willOpen && !kids[path]) {
      window.fs.list(root, path).then(
        (entries) => setKids((p) => ({ ...p, [path]: entries })),
        (e) => setError(String(e)),
      );
    }
  }

  function selectFile(path: string) {
    setSelectedPath(path);
    setDirty(false);
    setTooLarge(false);
    setError(null);
    setImageDataUrl(null);
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
    if (!selectedPath) return;
    window.fs.write(root, selectedPath, content).then(
      () => setDirty(false),
      (e) => setError(String(e)),
    );
  }

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
    >
      <div className="files-card-body">
        <div className="files-tree">
          {(kids[""] ?? []).map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              kids={kids}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={toggle}
              onSelectFile={selectFile}
            />
          ))}
        </div>
        <div className="files-editor">
          {selectedPath && (
            <div className="files-editor-head">
              <span>{selectedPath}</span>
              <div className="files-editor-head-actions">
                {mediaKind(selectedPath) === "markdown" && (
                  <button onClick={() => setView(view === "code" ? "preview" : "code")}>
                    {view === "code" ? "preview" : "código"}
                  </button>
                )}
                {mediaKind(selectedPath) !== "image" && (
                  <button disabled={!dirty} onClick={save}>
                    salvar
                  </button>
                )}
              </div>
            </div>
          )}
          {tooLarge && <div className="files-editor-msg">arquivo maior que 512KB, sem preview</div>}
          {error && <div className="files-editor-msg">{error}</div>}
          {selectedPath && !tooLarge && mediaKind(selectedPath) === "image" && imageDataUrl && (
            <div className="files-editor-image">
              <img src={imageDataUrl} alt={selectedPath} />
            </div>
          )}
          {selectedPath && !tooLarge && mediaKind(selectedPath) === "markdown" && view === "preview" && (
            <div
              className="files-editor-preview"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content, { async: false })) }}
            />
          )}
          {selectedPath &&
            !tooLarge &&
            mediaKind(selectedPath) !== "image" &&
            !(mediaKind(selectedPath) === "markdown" && view === "preview") && (
              <textarea
                className="files-editor-textarea"
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
              />
            )}
        </div>
      </div>
      <div className="card-foot">{root}</div>
    </CardFrame>
  );
}
