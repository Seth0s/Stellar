import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import type { DirEntry } from "../../preload/index";

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** `value` relative to `root` ("" if `value` is `root` itself or outside it). */
function relOf(root: string, value: string): string {
  if (value === root) return "";
  if (value.startsWith(root + "/")) return value.slice(root.length + 1);
  return "";
}

function absOf(root: string, rel: string): string {
  return rel ? `${root}/${rel}` : root;
}

/** Parent of an absolute path, or `null` once there's nowhere higher to
 * go (filesystem root). Pure string math — no `window.fs` round trip
 * needed just to know an ancestor's own name. */
function dirName(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return trimmed.length > 0 && i === 0 ? "/" : null;
  return trimmed.slice(0, i);
}

/** Up to `count` ancestors of `path`, nearest first. */
function ancestorsOf(path: string, count: number): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  let cur = dirName(path);
  while (cur && out.length < count) {
    out.push({ path: cur, name: baseName(cur) });
    cur = dirName(cur);
  }
  return out;
}

/** Every proper prefix of `rel` (not including `rel` itself) — the dirs
 * that need expanding, in order, to reveal `rel` as a row in the tree. */
function properAncestors(rel: string): string[] {
  if (!rel) return [];
  const parts = rel.split("/");
  const out: string[] = [""];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * DESIGN-BACKLOG.md item 1 revisited — "esse sistema de seleção de
 * projeto não está funcional, além de não persistir o caminho correto...
 * quero que fosse igual o explorador de arquivos, com árvore estilizada,
 * e header com caminho (selecionável)". Replaces the flat `<select>` of
 * sibling-folder names (ProjectPicker.tsx, now deleted) with a real
 * directory tree rooted at the workspace, reusing FilesCard.tsx's own
 * tree classes/IPC (`window.fs.list`/`window.fs.create`) so it actually
 * looks and behaves like the file explorer, not just a themed dropdown.
 * `value`/`onChange` are real absolute paths now, not free-text labels —
 * that's the other half of the fix: a session's cwd used to be whatever
 * label the user typed, completely disconnected from where its terminals
 * actually spawned (always DEFAULT_CWD, see App.tsx's activeBoardCwd).
 */
export function PathPicker({
  root,
  value,
  onChange,
  onChangeRoot,
  onNavigateRoot,
  className,
}: {
  root: string;
  value: string;
  onChange: (absPath: string) => void;
  /** Native OS folder dialog — for jumping somewhere the header's ancestor
   * crumbs can't reach (sideways, not just up). Small icon next to the
   * crumbs now, not a footer button (2026-08-27 revisit — the user asked
   * for the header to carry root-navigation instead). */
  onChangeRoot: () => void;
  /** Promotes an ancestor of `root` to be the new root, no dialog — what
   * clicking one of the header's "até 2 caminhos anteriores" crumbs does.
   * Recomputed from `root` on every render, so walking up repeatedly keeps
   * revealing further ancestors on its own (2026-08-27 revisit: "se eu
   * voltei uma pasta, adiciona no header +1 pasta anterior"). */
  onNavigateRoot: (path: string) => void;
  /** Raises this popover's z-index above SessionModal's own (see
   * Popover.tsx) — the default 800 sits behind `.modal-root`'s 2000. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  async function loadDir(rel: string) {
    try {
      const entries = await window.fs.list(root, rel);
      setKids((prev) => ({ ...prev, [rel]: entries.filter((e) => e.isDir) }));
    } catch (e) {
      setError(String(e));
    }
  }

  // Opening the panel: auto-expand + fetch every ancestor of the current
  // value, so whatever's already picked is visible/highlighted instead of
  // landing back at the root every time.
  useEffect(() => {
    if (!open) return;
    setError(null);
    const rel = relOf(root, value);
    const toExpand = ["", ...properAncestors(rel)];
    setExpanded(new Set(toExpand));
    for (const r of new Set([...toExpand, rel])) void loadDir(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root]);

  function toggle(rel: string) {
    const willOpen = !expanded.has(rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(rel);
      else next.delete(rel);
      return next;
    });
    if (willOpen && !kids[rel]) void loadDir(rel);
  }

  function select(rel: string) {
    onChange(absOf(root, rel));
  }

  /** An ancestor crumb: promote it to root AND select it (same "you are
   * now here" semantics as clicking the root crumb itself picks root). */
  function selectAncestor(path: string) {
    onNavigateRoot(path);
    onChange(path);
  }

  function startCreate(parentRel: string) {
    if (!expanded.has(parentRel)) toggle(parentRel);
    setCreating(parentRel);
    setCreateDraft("");
  }

  async function commitCreate() {
    if (creating === null) return;
    const parentRel = creating;
    const name = createDraft.trim();
    setCreating(null);
    if (!name) return;
    try {
      await window.fs.create(root, parentRel, name, "folder");
      await loadDir(parentRel);
      setExpanded((prev) => new Set(prev).add(parentRel));
      select(parentRel ? `${parentRel}/${name}` : name);
    } catch (e) {
      setError(String(e));
    }
  }

  const rel = relOf(root, value);
  const crumbSegments = rel ? rel.split("/") : [];
  // "até 2 caminhos anteriores" (2026-08-27) — nearest-first from
  // ancestorsOf, reversed here so the render order reads oldest → newest,
  // ending right before the root crumb.
  const ancestors = ancestorsOf(root, 2).reverse();

  function createRow(parentRel: string, depth: number) {
    if (creating !== parentRel) return null;
    return (
      <div className="files-create-row" style={{ paddingLeft: 6 + depth * 14 }}>
        <input
          className="files-node-rename-input"
          autoFocus
          value={createDraft}
          placeholder="nome da pasta"
          onChange={(e) => setCreateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitCreate();
            if (e.key === "Escape") setCreating(null);
          }}
          onBlur={() => void commitCreate()}
        />
      </div>
    );
  }

  function renderNode(entry: DirEntry, parentRel: string, depth: number) {
    const nodeRel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
    const isOpen = expanded.has(nodeRel);
    const isSelected = nodeRel === rel;
    return (
      <div key={nodeRel}>
        <div
          className={`files-node${isSelected ? " files-node-active" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <span
            className="files-node-main"
            onClick={() => {
              toggle(nodeRel);
              select(nodeRel);
            }}
          >
            <Icon name={isOpen ? "folderOpen" : "files"} size={14} />
            <span className="files-node-name">{entry.name}</span>
          </span>
          <span className="files-node-actions">
            <button
              type="button"
              title="Nova pasta aqui"
              onClick={(e) => {
                e.stopPropagation();
                startCreate(nodeRel);
              }}
            >
              <Icon name="newFolder" size={12} />
            </button>
          </span>
        </div>
        {isOpen && (kids[nodeRel] ?? []).map((child) => renderNode(child, nodeRel, depth + 1))}
        {isOpen && createRow(nodeRel, depth + 1)}
      </div>
    );
  }

  return (
    <div className="path-picker">
      <button
        type="button"
        ref={btnRef}
        className="resume-input path-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        title={value}
      >
        <Icon name="files" size={13} />
        <span className="path-picker-trigger-text">{rel || baseName(root)}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      <Popover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} className={className} gap={44}>
        <div className="path-picker-panel">
          <div className="path-picker-crumbs">
            <button
              type="button"
              className="path-picker-root-btn"
              title="Escolher outra pasta raiz…"
              onClick={onChangeRoot}
            >
              <Icon name="folderOpen" size={12} />
            </button>
            {ancestors.map((a) => (
              <span key={a.path} className="path-picker-crumb-item">
                <button type="button" className="path-picker-crumb path-picker-crumb-muted" onClick={() => selectAncestor(a.path)}>
                  {a.name}
                </button>
                <span className="path-picker-crumb-sep">/</span>
              </span>
            ))}
            <button type="button" className="path-picker-crumb" onClick={() => select("")}>
              {baseName(root)}
            </button>
            {crumbSegments.map((seg, i) => {
              const segRel = crumbSegments.slice(0, i + 1).join("/");
              return (
                <span key={segRel} className="path-picker-crumb-item">
                  <span className="path-picker-crumb-sep">/</span>
                  <button type="button" className="path-picker-crumb" onClick={() => select(segRel)}>
                    {seg}
                  </button>
                </span>
              );
            })}
          </div>
          <div className="files-tree path-picker-tree thin-scroll">
            {(kids[""] ?? []).map((entry) => renderNode(entry, "", 0))}
            {kids[""] && kids[""].length === 0 && creating !== "" && (
              <div className="path-picker-empty">nenhuma subpasta</div>
            )}
          </div>
          {createRow("", 0)}
          {error && <div className="path-picker-empty">{error}</div>}
          <div className="path-picker-footer">
            <button type="button" className="path-picker-footer-btn" onClick={() => startCreate("")}>
              <Icon name="newFolder" size={13} />
              nova pasta
            </button>
            <button type="button" className="path-picker-footer-btn path-picker-footer-btn--primary" onClick={() => setOpen(false)}>
              <Icon name="check" size={13} />
              usar esta pasta
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
