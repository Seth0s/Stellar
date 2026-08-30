import { useState } from "react";
import { ConstellationBg } from "./ConstellationBg";
import { Icon } from "./icons";
import { SessionModal } from "./SessionModal";
import { StellarMark } from "./StellarMark";
import { groupByProject, StatusDot, type Board, type BoardCounts } from "./sessions";
import type { SessionTemplate } from "./useBoardStore";
import type { BoardRow } from "../../preload/index";

type ModalState = { mode: "create" } | { mode: "edit"; board: Board } | null;

/** DESIGN-BACKLOG.md item 14 — absolute date for "criado em", short
 * relative wording for "último acesso" (a raw timestamp doesn't read at a
 * glance the way "há 2h"/"ontem" does). Falls back to the absolute date
 * past a month — "há 47 dias" stops being useful. */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("pt-BR");
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `há ${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "ontem";
  if (day < 30) return `há ${day} dias`;
  return formatDate(ts);
}

/**
 * DESIGN-BACKLOG.md item 8 — boots to this instead of straight into a
 * board (decided by the user: always, not just "no saved session"). Same
 * session data Topbar's popover already shows (grouped by project,
 * agent/active counts), just at home-screen scale — this is also now
 * where create/edit actually lives day-to-day; Topbar's own popover
 * stays a quick switcher for while you're already inside a session.
 */
export function Home({
  boards,
  boardCounts,
  rootName,
  workspaceRoot,
  defaultCwd,
  onChangeRoot,
  onNavigateRoot,
  onOpenBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onToggleAutonomous,
  onSetConcurrencyCap,
}: {
  boards: BoardRow[];
  boardCounts: Record<string, BoardCounts>;
  /** Last path segment of the current workspace root — see Topbar.tsx's
   * same prop. */
  rootName: string;
  /** Workspace root — PathPicker's tree is rooted here. */
  workspaceRoot: string;
  /** Starting path for a brand-new session (App.tsx's DEFAULT_CWD). */
  defaultCwd: string;
  onChangeRoot: () => void;
  onNavigateRoot: (path: string) => void;
  onOpenBoard: (id: string) => void;
  onCreateBoard: (name: string, cwd: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, cwd: string) => void;
  onDeleteBoard: (id: string) => void;
  /** DESIGN-BACKLOG.md item 59 — separate from onUpdateBoard, fires
   * immediately (see Topbar.tsx's same prop). */
  onToggleAutonomous: (id: string, autonomous: boolean) => void;
  /** DESIGN-BACKLOG.md item 60, peça 2. */
  onSetConcurrencyCap: (id: string, cap: number | null) => void;
}) {
  const [modal, setModal] = useState<ModalState>(null);

  // "Recente" badge (item 14) — the single most recently opened session
  // across every project, not per-group; only meaningful with more than
  // one session, and only for one that's actually been opened since the
  // `last_accessed_at` column existed (`createBoard` seeds it, but a
  // board from before this migration has `null`).
  const mostRecentId =
    boards.length > 1
      ? boards.reduce<{ id: string; at: number } | null>((best, b) => {
          if (!b.last_accessed_at) return best;
          return !best || b.last_accessed_at > best.at ? { id: b.id, at: b.last_accessed_at } : best;
        }, null)?.id
      : null;

  return (
    <div className="home">
      <div className="home-bg" aria-hidden="true" />
      <ConstellationBg />
      <div className="home-header">
        <h1>
          <StellarMark size={22} />
          {rootName}
        </h1>
        <button className="primary" onClick={() => setModal({ mode: "create" })}>
          + nova sessão
        </button>
      </div>
      {/* item 2 (DESIGN-BACKLOG.md) — the session list used to have no
          scroll container of its own, so a long list scrolled `.home`
          itself, dragging the fixed background layers above along with
          it ("quebra o background") and only ever showing the OS's
          default full-width scrollbar. This is the one thing that
          scrolls now — background/header stay put, and its own thin
          scrollbar (styles/layout.css) sits right against the grid. */}
      <div className="home-scroll thin-scroll">
        {boards.length === 0 ? (
          <div className="home-empty">
            <p>nenhuma sessão ainda</p>
            <button className="primary" onClick={() => setModal({ mode: "create" })}>
              criar a primeira
            </button>
          </div>
        ) : (
          <div className="home-groups">
            {groupByProject(boards).map(([project, group]) => (
              <div key={project} className="home-group">
                <div className="home-group-label">{project.toUpperCase()}</div>
                <div className="home-grid">
                  {group.map((b) => {
                    const counts = boardCounts[b.id];
                    return (
                      <button
                        key={b.id}
                        className="home-session-card"
                        title={b.cwd || undefined}
                        onClick={() => onOpenBoard(b.id)}
                      >
                        {b.id === mostRecentId && <span className="home-session-recent">recente</span>}
                        <span
                          className={`home-session-edit${b.id === mostRecentId ? " home-session-edit--below-badge" : ""}`}
                          title="Editar sessão"
                          onClick={(e) => {
                            e.stopPropagation();
                            setModal({ mode: "edit", board: b });
                          }}
                        >
                          <Icon name="pen" size={13} />
                        </span>
                        <span className="home-session-name">{b.name}</span>
                        <span className="home-session-counts">
                          <StatusDot counts={counts} />
                          {counts ? `${counts.agents} agentes · ${counts.active} ativos` : "0 agentes"}
                        </span>
                        {/* item 2 — "tirar as datas pra fora do card": only
                            the relative "último acesso" stays on the card
                            face now, one line instead of two; the full
                            created/accessed timestamps (and "criado em")
                            are still there, just as a hover tooltip. */}
                        <span
                          className="home-session-dates"
                          title={
                            `criado ${new Date(b.created_at).toLocaleString("pt-BR")}` +
                            (b.last_accessed_at ? `\nacessado ${new Date(b.last_accessed_at).toLocaleString("pt-BR")}` : "")
                          }
                        >
                          {b.last_accessed_at ? `acessado ${formatRelative(b.last_accessed_at)}` : "nunca acessado"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {modal?.mode === "create" && (
        <SessionModal
          mode="create"
          defaultCwd={defaultCwd}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          onCreate={onCreateBoard}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <SessionModal
          mode="edit"
          // Fresh lookup, not the stale snapshot from when the pencil was
          // clicked — see Topbar.tsx's identical comment (item 59).
          board={boards.find((b) => b.id === modal.board.id) ?? modal.board}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          canDelete={boards.length > 1}
          onSave={onUpdateBoard}
          onDelete={onDeleteBoard}
          onToggleAutonomous={onToggleAutonomous}
          onSetConcurrencyCap={onSetConcurrencyCap}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
