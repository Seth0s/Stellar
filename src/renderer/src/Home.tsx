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
  suggestedProject,
  availableProjects,
  onChangeRoot,
  onOpenBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
}: {
  boards: BoardRow[];
  boardCounts: Record<string, BoardCounts>;
  /** Last path segment of the current workspace root — see Topbar.tsx's
   * same prop. */
  rootName: string;
  suggestedProject: string;
  availableProjects: string[];
  onChangeRoot: () => void;
  onOpenBoard: (id: string) => void;
  onCreateBoard: (name: string, project: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, project: string) => void;
  onDeleteBoard: (id: string) => void;
}) {
  const [modal, setModal] = useState<ModalState>(null);
  const allProjectOptions = Array.from(
    new Set([...availableProjects, ...boards.map((b) => b.project).filter(Boolean)]),
  ).sort((a, b) => a.localeCompare(b));

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
                    <button key={b.id} className="home-session-card" onClick={() => onOpenBoard(b.id)}>
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
                      <span className="home-session-dates">
                        <span title={new Date(b.created_at).toLocaleString("pt-BR")}>
                          criado {formatDate(b.created_at)}
                        </span>
                        <span title={b.last_accessed_at ? new Date(b.last_accessed_at).toLocaleString("pt-BR") : undefined}>
                          {b.last_accessed_at ? `acessado ${formatRelative(b.last_accessed_at)}` : "nunca acessado"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {modal?.mode === "create" && (
        <SessionModal
          mode="create"
          suggestedProject={suggestedProject}
          availableProjects={allProjectOptions}
          onChangeRoot={onChangeRoot}
          onCreate={onCreateBoard}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <SessionModal
          mode="edit"
          board={modal.board}
          availableProjects={allProjectOptions}
          onChangeRoot={onChangeRoot}
          canDelete={boards.length > 1}
          onSave={onUpdateBoard}
          onDelete={onDeleteBoard}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
