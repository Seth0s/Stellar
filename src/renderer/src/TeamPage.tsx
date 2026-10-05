import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type {
  TeamDetailInfo,
  TeamMemberInfo,
  TeamOverviewInfo,
  TeamRole,
  TeamSprintInfo,
  TeamTaskDetailInfo,
  TeamTaskInfo,
} from "../../preload/index";
import {
  TEAM_COLUMN_LABEL_KEY,
  TEAM_COLUMNS,
  TEAM_KIND_LABEL_KEY,
  TEAM_PRIORITY_LABEL_KEY,
  TEAM_STATE_LABEL_KEY,
  boardStats,
  canDrag,
  canReviewRole,
  claimableTasks,
  distributionCandidates,
  filterBoardTasks,
  groupBoardTasks,
  incomingOffers,
  isAssignee,
  isOwnerOrAdmin,
  memberAvatar,
  memberDisplayName,
  originLabelKey,
  originOptions,
  providerDot,
  teamEventKey,
  teamEventTone,
  type TeamColumn,
} from "./team-board-decisions";
import { TeamPanel } from "./TeamPanel";
import { TeamTaskForm } from "./TeamTaskForm";
import { TeamTaskDeleteDialog } from "./TeamTaskDeleteDialog";
import type { DeleteMode } from "./team-task-delete-decisions";
import { canWrite, decidePlanAccess, describePlanFailure } from "./PlanAccess";
import { PlanNotice, PlanSeatsNotice } from "./PlanGate";
import { useCloudPlan, usePlansUrl } from "./PlanHooks";
import styles from "./TeamPage.module.css";

type Sub = "overview" | "board" | "members" | "home" | "audit";
type TeamRef = { id: string; name: string };

function ageLabel(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function roleLabel(role: TeamRole): string {
  return t(role === "owner" ? "team.role.owner" : role === "admin" ? "team.role.admin" : "team.role.member");
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

/** Avatar chip with the person's B7.1 initials and their stable pastel tone. */
function Avatar({ members, accountId, small }: { members: readonly TeamMemberInfo[]; accountId: string | null; small?: boolean }) {
  const a = memberAvatar(members, accountId);
  return (
    <span
      className={`${styles.avatar}${small ? ` ${styles.avatarSm}` : ""} ${styles[`av${a.tone}`]}`}
    >
      {a.initials}
    </span>
  );
}

const MATRIX_ROWS: { key: MessageKey; owner: "yes" | "no" | "partial"; admin: "yes" | "no" | "partial"; member: "yes" | "no" | "partial" }[] = [
  { key: "teamTask.matrix.create", owner: "yes", admin: "yes", member: "no" },
  { key: "teamTask.matrix.move", owner: "yes", admin: "yes", member: "yes" },
  { key: "teamTask.matrix.review", owner: "yes", admin: "yes", member: "no" },
  { key: "teamTask.matrix.house", owner: "yes", admin: "yes", member: "no" },
  { key: "teamTask.matrix.members", owner: "yes", admin: "partial", member: "no" },
  { key: "teamTask.matrix.roles", owner: "yes", admin: "no", member: "no" },
];

function MatrixCell({ value }: { value: "yes" | "no" | "partial" }) {
  if (value === "yes") return <span className={styles.matrixYes}>{t("teamTask.matrix.yes")}</span>;
  if (value === "partial") return <span className={styles.matrixPartial}>{t("teamTask.matrix.partial")}</span>;
  return <span className={styles.matrixNo}>{t("teamTask.matrix.no")}</span>;
}

export function TeamPage({ boards }: { boards: TeamRef[] }) {
  const [overview, setOverview] = useState<TeamOverviewInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetailInfo | null>(null);
  const [tasks, setTasks] = useState<TeamTaskInfo[]>([]);
  const [sprints, setSprints] = useState<TeamSprintInfo[]>([]);
  const [sub, setSub] = useState<Sub>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [invites, setInvites] = useState<{ id: string; target: string; role: TeamRole }[]>([]);
  const [inviteTarget, setInviteTarget] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [filter, setFilter] = useState({ assigneeId: "", project: "", unassigned: false, search: "", mine: false });
  const [selectedTask, setSelectedTask] = useState<TeamTaskInfo | null>(null);
  const [taskDetail, setTaskDetail] = useState<TeamTaskDetailInfo | null>(null);
  const [comment, setComment] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formEditing, setFormEditing] = useState<TeamTaskInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamTaskInfo | null>(null);
  const [deleteInitial, setDeleteInitial] = useState<DeleteMode>("archive");
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const [seatsFull, setSeatsFull] = useState<number | null>(null);
  const pollRef = useRef<number | null>(null);

  const { plan: cloudPlan, loggedIn } = useCloudPlan();
  const plansUrl = usePlansUrl();
  // The team right is paid: on Free the section explains the Team plan and
  // locks create/invite/board; an expired plan keeps reading but blocks writes.
  const teamAccess = decidePlanAccess(cloudPlan, "team");
  const teamWritable = canWrite(teamAccess);
  // A refusal of a feature that is not granted becomes the plan notice, not a
  // raw server error (the board still shows its ordinary errors while granted).
  const errorDisplay = error ? describePlanFailure(teamAccess, error) : null;
  // The proactive band is the expired state; an unknown plan shows nothing until
  // a real server refusal turns into the plan notice.
  const planNotice = teamAccess.kind === "expired" ? teamAccess : errorDisplay?.kind === "plan" ? errorDisplay.access : null;

  const refreshOverview = useCallback(async () => {
    try {
      const res = await window.team.overview();
      if (res.ok) {
        setOverview(res.view);
        setLoadError(null);
        setSelected((cur) => cur ?? res.view.teams[0]?.id ?? null);
      } else {
        setOverview(null);
        setLoadError(res.error);
      }
    } catch {
      setOverview(null);
      setLoadError(t("teamTask.error"));
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  const loadTasks = useCallback(async (teamId: string, silent = false) => {
    try {
      const res = await window.team.tasks(teamId, { includeArchived: false });
      if (res.ok) {
        setTasks(res.list.tasks);
        setOffline(false);
        localStorage.setItem(`stellar.team.tasks.${teamId}`, JSON.stringify(res.list.tasks));
      } else if (!silent) {
        setError(res.error);
      }
    } catch {
      const cached = localStorage.getItem(`stellar.team.tasks.${teamId}`);
      if (cached) {
        try {
          setTasks(JSON.parse(cached) as TeamTaskInfo[]);
          setOffline(true);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const loadTeam = useCallback(
    async (teamId: string) => {
      setTaskDetail(null);
      setSelectedTask(null);
      setInvites([]);
      try {
        const [d, s, inv] = await Promise.all([window.team.detail(teamId), window.team.sprints(teamId), window.team.listInvites(teamId)]);
        if (d.ok) setDetail(d.detail);
        if (s.ok) setSprints(s.sprints);
        if (inv.ok) setInvites(inv.invites);
      } catch {
        /* keep cached tasks */
      }
      const cached = localStorage.getItem(`stellar.team.tasks.${teamId}`);
      if (cached) {
        try {
          setTasks(JSON.parse(cached) as TeamTaskInfo[]);
        } catch {
          /* ignore */
        }
      }
      await loadTasks(teamId);
    },
    [loadTasks],
  );

  useEffect(() => {
    if (!selected) return;
    void loadTeam(selected);
    pollRef.current = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadTasks(selected, true);
    }, 15000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [selected, loadTeam, loadTasks]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch {
      setError(t("teamTask.error"));
    } finally {
      setBusy(false);
    }
  }

  const accountId = overview?.accountId ?? null;
  const myRole: TeamRole | null = detail && accountId ? detail.members.find((m) => m.accountId === accountId)?.role ?? null : null;
  const isAdmin = isOwnerOrAdmin(myRole);
  const team = overview?.teams.find((x) => x.id === selected) ?? null;
  const stats = boardStats(tasks);
  const filtered = filterBoardTasks(tasks, {
    accountId,
    assigneeId: filter.assigneeId || null,
    project: filter.project || null,
    unassigned: filter.unassigned,
    search: filter.search,
    mine: filter.mine,
  });
  const grouped = groupBoardTasks(filtered);
  const offers = incomingOffers(tasks, accountId);
  const claimable = claimableTasks(tasks, accountId);

  async function handleCreateTeam(name: string) {
    if (!teamWritable) return;
    await run(async () => {
      const res = await window.team.create({ name });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refreshOverview();
      setSelected(res.value.team.id);
    });
  }

  async function handleInvite() {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.invite(selected, { target: inviteTarget.trim(), role: inviteRole });
      if (!res.ok) {
        // The team already uses every paid seat: name the count, not a raw error.
        if (res.reason === "seats-exceeded") {
          setSeatsFull(detail?.members.length ?? 0);
          return;
        }
        setError(res.reason === "forbidden" ? t("team.onlyAdmin") : res.error);
        return;
      }
      setSeatsFull(null);
      setInvites((prev) => [...prev, res.invite]);
      setInviteTarget("");
      setNote(t("team.invited", { target: res.invite.target }));
    });
  }

  async function handleDrag(task: TeamTaskInfo, to: TeamColumn) {
    if (!selected || !teamWritable) return;
    if (!canDrag({ role: myRole, accountId, task, to })) return;
    await run(async () => {
      const res = await window.team.moveTask(selected, task.id, to);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await loadTasks(selected);
    });
  }

  async function handleClaim(task: TeamTaskInfo) {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.claimTask(selected, task.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRequested((prev) => ({ ...prev, [task.id]: true }));
      setNote(t("teamTask.member.asked"));
    });
  }

  async function handleReturn(task: TeamTaskInfo) {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.returnTask(selected, task.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await loadTasks(selected);
    });
  }

  async function handleAccept(task: TeamTaskInfo, boardId: string) {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.acceptTask(selected, task.id, { boardId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const boardName = boards.find((b) => b.id === boardId)?.name ?? boardId;
      setNote(t("teamTask.member.accepted", { board: boardName }));
      await loadTasks(selected);
    });
  }

  async function openTask(task: TeamTaskInfo) {
    if (!selected) return;
    setSelectedTask(task);
    setTaskDetail(null);
    setComment("");
    try {
      const res = await window.team.taskDetail(selected, task.id);
      if (res.ok) setTaskDetail(res.detail);
    } catch {
      /* no detail */
    }
  }

  async function handleArchiveTask(task: TeamTaskInfo) {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.archiveTask(selected, task.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDeleteTarget(null);
      setSelectedTask(null);
      setTaskDetail(null);
      await loadTasks(selected);
    });
  }

  async function handleDeleteTask(task: TeamTaskInfo, confirm: string) {
    if (!selected || !teamWritable) return;
    await run(async () => {
      const res = await window.team.deleteTask(selected, task.id, confirm);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDeleteTarget(null);
      setSelectedTask(null);
      setTaskDetail(null);
      await loadTasks(selected);
    });
  }

  async function handleComment(task: TeamTaskInfo) {
    if (!selected || !teamWritable || comment.trim() === "") return;
    await run(async () => {
      const res = await window.team.commentTask(selected, task.id, comment.trim());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setComment("");
      await openTask(task);
    });
  }

  if (loggedIn && teamAccess.kind === "upgrade") {
    return (
      <div className={styles.page} data-part="team-plan-locked">
        <h1 className={styles.title}>{t("shell.team")}</h1>
        <PlanNotice access={teamAccess} plansUrl={plansUrl} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>{t("shell.team")}</h1>
        <div className={styles.muted}>{t("teamTask.noLogin")}</div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>{t("shell.team")}</h1>
        <div className={styles.muted}>{t("teamTask.loading")}</div>
      </div>
    );
  }

  if (overview.teams.length === 0) {
    return <CreateTeamScreen busy={busy} onError={setError} onCreate={handleCreateTeam} />;
  }

  const subItems: { id: Sub; label: MessageKey }[] = [
    { id: "overview", label: "teamTask.subnav.overview" },
    { id: "board", label: "teamTask.subnav.board" },
    { id: "members", label: "teamTask.subnav.members" },
    { id: "home", label: "teamTask.subnav.home" },
    { id: "audit", label: "teamTask.subnav.audit" },
  ];

  const activeSprint = sprints.find((s) => s.state === "ativa") ?? null;

  const closeDetail = () => {
    setSelectedTask(null);
    setTaskDetail(null);
  };

  const formElement = formOpen ? (
    <TeamTaskForm
      teamId={selected ?? ""}
      teamName={team?.name ?? ""}
      boards={boards}
      members={detail?.members ?? []}
      tasks={tasks}
      sprints={sprints}
      editing={formEditing}
      editingContract={formEditing ? taskDetail?.contract?.markdown ?? "" : ""}
      onClose={() => setFormOpen(false)}
      onCreateTeamTask={async (body) => {
        if (!selected) return { ok: false, error: t("teamTask.error") };
        const res = await window.team.createTask(selected, body);
        if (!res.ok) return { ok: false, error: res.error };
        await loadTasks(selected);
        return { ok: true };
      }}
      onUpdateTeamTask={async (task, body) => {
        if (!selected) return { ok: false, error: t("teamTask.error") };
        const res = await window.team.updateTask(selected, task.id, body, task.version);
        if (!res.ok) return { ok: false, error: res.conflict ? t("teamTask.error") : res.error };
        await loadTasks(selected);
        return { ok: true };
      }}
      onCreateLocalTask={async (boardId, prompt) => {
        const res = await window.tasks.create(boardId, prompt);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }}
    />
  ) : null;

  const deleteElement = deleteTarget ? (
    <TeamTaskDeleteDialog
      task={deleteTarget}
      dependents={taskDetail?.dependents ?? []}
      initialMode={deleteInitial}
      busy={busy}
      onClose={() => setDeleteTarget(null)}
      onArchive={() => void handleArchiveTask(deleteTarget)}
      onDelete={(confirm) => void handleDeleteTask(deleteTarget, confirm)}
    />
  ) : null;

  if (sub === "board") {
    return (
      <div className={styles.boardScreen} data-part="team-board">
        {loggedIn && planNotice ? <PlanNotice access={planNotice} plansUrl={plansUrl} /> : null}
        {offline ? <div className={styles.banner}>{t("teamTask.offline")}</div> : null}
        {note ? <div className={styles.note}>{note}</div> : null}
        {errorDisplay?.kind === "raw" ? <div className={styles.error}>{errorDisplay.error}</div> : null}
        {formElement}
        {deleteElement}
        <TeamBoard
          writable={teamWritable}
          tasks={tasks}
          grouped={grouped}
          members={detail?.members ?? []}
          accountId={accountId}
          myRole={myRole}
          isAdmin={isAdmin}
          filter={filter}
          offers={offers}
          claimable={claimable}
          requested={requested}
          boards={boards}
          busy={busy || !teamWritable}
          selectedTaskId={selectedTask?.id ?? null}
          detail={taskDetail}
          comment={comment}
          teamName={team?.name ?? ""}
          sprintName={activeSprint?.name ?? ""}
          openCount={stats.open}
          sprintDone={stats.done}
          onBack={() => setSub("overview")}
          onNewTask={() => {
            setFormEditing(null);
            setFormOpen(true);
          }}
          onFilter={setFilter}
          onSelect={(task) => void openTask(task)}
          onDrag={(task, to) => void handleDrag(task, to)}
          onClaim={(task) => void handleClaim(task)}
          onReturn={(task) => void handleReturn(task)}
          onAccept={(task, boardId) => void handleAccept(task, boardId)}
          onComment={setComment}
          onSendComment={() => {
            if (selectedTask) void handleComment(selectedTask);
          }}
          onCloseDetail={closeDetail}
          onEditTask={(task) => {
            setFormEditing(task);
            setFormOpen(true);
          }}
          onDuplicateTask={(task) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.createTask(selected, {
                title: `${task.title} (cópia)`,
                kind: task.kind,
                priority: task.priority,
                territory: task.territory,
                gates: task.gates.map((g) => g),
                allow_commit: task.allowCommit,
                report_schema: task.reportSchema,
                max_retries: task.maxRetries,
                ...(task.provider !== "" ? { provider: task.provider } : {}),
                ...(task.reviewerId ? { reviewer_id: task.reviewerId } : {}),
              });
              if (!res.ok) setError(res.error);
              else await loadTasks(selected);
            })
          }
          onCopyLinkTask={(task) => {
            const link = `stellar://team/${task.teamId}/task/${task.id}`;
            const clip = navigator.clipboard;
            if (clip) void clip.writeText(link).catch(() => setNote(link));
            else setNote(link);
          }}
          onPauseTask={(task) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.returnTask(selected, task.id);
              if (!res.ok) setError(res.error);
              else await loadTasks(selected);
            })
          }
          onArchive={() => {
            if (selectedTask) {
              setDeleteInitial("archive");
              setDeleteTarget(selectedTask);
            }
          }}
          onDelete={() => {
            if (selectedTask) {
              setDeleteInitial("purge");
              setDeleteTarget(selectedTask);
            }
          }}
          onAssign={(task, body) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.assignTask(selected, task.id, body);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              await loadTasks(selected);
            })
          }
          onAutoDispatch={(task, enabled) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.autoDispatchTask(selected, task.id, enabled);
              if (!res.ok) setError(res.error);
              else await loadTasks(selected);
            })
          }
          onUpdateFields={(task, body) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.updateTask(selected, task.id, body, task.version);
              if (!res.ok) {
                setError(res.conflict ? t("teamTask.error") : res.error);
                return;
              }
              await loadTasks(selected);
            })
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{team?.name ?? t("shell.team")}</h1>
          <div className={styles.subtitle}>
            {myRole ? t("teamTask.subtitle.role", { role: roleLabel(myRole) }) : t("teamTask.subtitle.noRole")}
          </div>
        </div>
        <span className={styles.headerSpacer} />
        {overview.teams.length > 1 ? (
          <select className={styles.select} value={selected ?? ""} onChange={(e) => setSelected(e.target.value)} aria-label={t("teamTask.selectTeam")}>
            {overview.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" className={styles.btn} onClick={() => setSub("board")}>
          {t("teamTask.openBoard")}
        </button>
        {isAdmin ? (
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setSub("members")}>
            {t("teamTask.invite")}
          </button>
        ) : null}
      </div>

      {loggedIn && planNotice ? <PlanNotice access={planNotice} plansUrl={plansUrl} /> : null}
      {seatsFull !== null ? <PlanSeatsNotice seats={seatsFull} /> : null}
      {offline ? <div className={styles.banner}>{t("teamTask.offline")}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {formElement}

      {deleteElement}

      <div className={styles.layout}>
        <nav className={styles.subnav} aria-label={t("teamTask.subnav.aria")}>
          {subItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-team-sub={item.id}
              className={`${styles.teamTab}${sub === item.id ? ` ${styles.teamTabOn}` : ""}`}
              aria-current={sub === item.id ? "page" : undefined}
              onClick={() => setSub(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </nav>

        <span className={styles.grow}>
          {sub === "overview" || sub === "audit" || sub === "members" ? (
            <TeamAdminView
              stats={stats}
              members={detail?.members ?? []}
              accountId={accountId}
              tasks={tasks}
              sprints={sprints}
              invites={invites}
              inviteTarget={inviteTarget}
              inviteRole={inviteRole}
              canManage={isAdmin && teamWritable}
              myRole={myRole}
              busy={busy || !teamWritable}
              auditOnly={sub === "audit"}
              membersOnly={sub === "members"}
              onInviteTarget={setInviteTarget}
              onInviteRole={setInviteRole}
              onInvite={() => void handleInvite()}
              onRevoke={(id) => void run(async () => {
                if (!selected) return;
                const res = await window.team.revokeInvite(selected, id);
                if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== id));
                else setError(res.error ?? t("teamTask.error"));
              })}
            />
          ) : null}

          {sub === "home" ? <TeamPanel inline /> : null}
        </span>
      </div>
    </div>
  );
}

function CreateTeamScreen({ busy, onError, onCreate }: { busy: boolean; onError: (e: string) => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t("shell.team")}</h1>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t("team.createTitle")}</h2>
        </div>
        <div className={styles.cardHead}>
          <input className={styles.input} placeholder={t("team.name")} value={name} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy || name.trim() === ""}
            onClick={() => {
              if (name.trim() === "") {
                onError(t("teamTask.error"));
                return;
              }
              onCreate(name.trim());
            }}
          >
            {t("team.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

function TeamAdminView({
  stats,
  members,
  accountId,
  tasks,
  sprints,
  invites,
  inviteTarget,
  inviteRole,
  canManage,
  myRole,
  busy,
  auditOnly,
  membersOnly,
  onInviteTarget,
  onInviteRole,
  onInvite,
  onRevoke,
}: {
  stats: ReturnType<typeof boardStats>;
  members: TeamMemberInfo[];
  accountId: string | null;
  tasks: TeamTaskInfo[];
  sprints: TeamSprintInfo[];
  invites: { id: string; target: string; role: TeamRole }[];
  inviteTarget: string;
  inviteRole: TeamRole;
  canManage: boolean;
  myRole: TeamRole | null;
  busy: boolean;
  auditOnly: boolean;
  membersOnly: boolean;
  onInviteTarget: (v: string) => void;
  onInviteRole: (r: TeamRole) => void;
  onInvite: () => void;
  onRevoke: (id: string) => void;
}) {
  const activeSprint = sprints.find((s) => s.state === "ativa") ?? sprints[0] ?? null;
  const activity = [...tasks].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "")).slice(0, 4);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--v2-s14)" }}>
      {!auditOnly && !membersOnly ? (
        <div className={styles.stats}>
          <Stat label={t("teamTask.stat.members")} value={String(members.length)} hint={t("teamTask.stat.invitePending", { n: String(invites.length) })} />
          <Stat label={t("teamTask.stat.open")} value={String(stats.open)} hint={t("teamTask.stat.noOwnerCount", { n: String(stats.unassigned) })} />
          <Stat label={t("teamTask.stat.review")} value={String(stats.awaitingReview)} hint={activeSprint ? activeSprint.name : "—"} warn />
          <Stat label={t("teamTask.stat.house")} value={t("teamTask.stat.houseRev", { n: "—" })} hint={t("teamTask.stat.houseHint")} />
        </div>
      ) : null}

      {!auditOnly ? (
        <div className={styles.layout}>
          <section className={`${styles.card} ${styles.grow}`} aria-labelledby="team-members">
            <div className={styles.cardHead}>
              <h2 id="team-members" className={styles.cardTitle}>
                {t("teamTask.members.title")}
              </h2>
              <span className={styles.cardHint}>{t("teamTask.members.keepOwner")}</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t("teamTask.th.person")}</th>
                    <th>{t("teamTask.th.role")}</th>
                    <th>{t("teamTask.th.tasks")}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.accountId}>
                      <td>
                        <span className={styles.person}>
                          <Avatar members={members} accountId={m.accountId} />
                          <span className={styles.personText}>
                            <span>{m.accountId === accountId ? t("team.you") : memberDisplayName(members, m.accountId)}</span>
                            <span className={styles.personMeta}>{m.email ?? m.accountId}</span>
                          </span>
                        </span>
                      </td>
                      <td>{roleLabel(m.role)}</td>
                      <td>{tasks.filter((task) => task.assigneeId === m.accountId).length}</td>
                    </tr>
                  ))}
                  {invites.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <span className={styles.person}>
                          <span className={styles.avatar} style={{ border: "1px dashed var(--v2-dashed)", background: "transparent" }}>
                            @
                          </span>
                          <span className={styles.personText}>
                            <span>{inv.target}</span>
                            <span className={styles.personMeta}>{t("teamTask.invitePendingLabel")}</span>
                          </span>
                        </span>
                      </td>
                      <td className={styles.muted}>{roleLabel(inv.role)}</td>
                      <td>
                        <button type="button" className={styles.btn} disabled={busy} onClick={() => onRevoke(inv.id)}>
                          {t("team.revoke")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {!membersOnly ? (
            <section className={styles.side} aria-labelledby="team-matrix">
              <div className={styles.card}>
                <div className={styles.cardHead}>
                  <h2 id="team-matrix" className={styles.cardTitle}>
                    {t("teamTask.matrix.title")}
                  </h2>
                </div>
                <div className={styles.cardHead}>
                  <div className={styles.matrix}>
                    <span />
                    <span className={styles.matrixHead}>Owner</span>
                    <span className={styles.matrixHead}>Admin</span>
                    <span className={styles.matrixHead}>Membro</span>
                    {MATRIX_ROWS.map((row) => (
                      <div key={row.key} style={{ display: "contents" }}>
                        <span className={styles.matrixRowLabel}>{t(row.key)}</span>
                        <MatrixCell value={row.owner} />
                        <MatrixCell value={row.admin} />
                        <MatrixCell value={row.member} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.cardHead}>
                  <div className={styles.divider} style={{ flex: 1 }} />
                </div>
                <div className={styles.cardHead}>
                  <h3 className={styles.cardTitle}>{t("teamTask.activity.title")}</h3>
                </div>
                <div className={styles.cardHead}>
                  <div className={styles.activity}>
                    {activity.length === 0 ? (
                      <span className={styles.muted}>{t("teamTask.activity.empty")}</span>
                    ) : (
                      activity.map((task) => (
                        <span key={task.id}>
                          <b>{task.ref}</b> · {t(TEAM_STATE_LABEL_KEY[task.state])} · {ageLabel(task.updatedAt)}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {canManage ? (
                <div className={styles.card}>
                  <div className={styles.cardHead}>
                    <h2 className={styles.cardTitle}>{t("team.inviteTitle")}</h2>
                  </div>
                  <div className={styles.cardHead}>
                    <input
                      className={styles.input}
                      placeholder={t("team.inviteTarget")}
                      value={inviteTarget}
                      onChange={(e) => onInviteTarget(e.target.value)}
                    />
                    <select className={styles.select} value={inviteRole} onChange={(e) => onInviteRole(e.target.value as TeamRole)}>
                      <option value="member">{roleLabel("member")}</option>
                      <option value="admin">{roleLabel("admin")}</option>
                      {myRole === "owner" ? <option value="owner">{roleLabel("owner")}</option> : null}
                    </select>
                    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || inviteTarget.trim() === ""} onClick={onInvite}>
                      {t("team.invite")}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>{t("teamTask.activity.title")}</h2>
          </div>
          <div className={styles.cardHead}>
            <div className={styles.activity}>
              {activity.length === 0 ? (
                <span className={styles.muted}>{t("teamTask.activity.empty")}</span>
              ) : (
                activity.map((task) => (
                  <span key={task.id}>
                    <b>{task.ref}</b> · {t(TEAM_STATE_LABEL_KEY[task.state])} · {ageLabel(task.updatedAt)}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className={styles.cardHead}>
            <span className={styles.muted}>{t("teamTask.audit.note")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className={`${styles.stat}${warn ? ` ${styles.statWarn}` : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue}${warn ? ` ${styles.statValueWarn}` : ""}`}>{value}</span>
      <span className={styles.statHint}>{hint}</span>
    </div>
  );
}

function TeamBoard({
  tasks,
  grouped,
  members,
  accountId,
  myRole,
  isAdmin,
  filter,
  offers,
  claimable,
  requested,
  boards,
  busy,
  writable,
  selectedTaskId,
  detail,
  comment,
  teamName,
  sprintName,
  openCount,
  sprintDone,
  onBack,
  onNewTask,
  onFilter,
  onSelect,
  onDrag,
  onClaim,
  onReturn,
  onAccept,
  onComment,
  onSendComment,
  onCloseDetail,
  onEditTask,
  onDuplicateTask,
  onCopyLinkTask,
  onPauseTask,
  onArchive,
  onDelete,
  onAssign,
  onAutoDispatch,
  onUpdateFields,
}: {
  tasks: TeamTaskInfo[];
  grouped: Record<TeamColumn, TeamTaskInfo[]>;
  members: TeamMemberInfo[];
  accountId: string | null;
  myRole: TeamRole | null;
  isAdmin: boolean;
  filter: { assigneeId: string; project: string; unassigned: boolean; search: string; mine: boolean };
  offers: TeamTaskInfo[];
  claimable: TeamTaskInfo[];
  requested: Record<string, boolean>;
  boards: TeamRef[];
  busy: boolean;
  writable: boolean;
  selectedTaskId: string | null;
  detail: TeamTaskDetailInfo | null;
  comment: string;
  teamName: string;
  sprintName: string;
  openCount: number;
  sprintDone: number;
  onBack: () => void;
  onNewTask: () => void;
  onFilter: (f: { assigneeId: string; project: string; unassigned: boolean; search: string; mine: boolean }) => void;
  onSelect: (task: TeamTaskInfo) => void;
  onDrag: (task: TeamTaskInfo, to: TeamColumn) => void;
  onClaim: (task: TeamTaskInfo) => void;
  onReturn: (task: TeamTaskInfo) => void;
  onAccept: (task: TeamTaskInfo, boardId: string) => void;
  onComment: (v: string) => void;
  onSendComment: () => void;
  onCloseDetail: () => void;
  onEditTask: (task: TeamTaskInfo) => void;
  onDuplicateTask: (task: TeamTaskInfo) => void;
  onCopyLinkTask: (task: TeamTaskInfo) => void;
  onPauseTask: (task: TeamTaskInfo) => void;
  onArchive: () => void;
  onDelete: () => void;
  onAssign: (task: TeamTaskInfo, body: { assignee_id?: string; session_label?: string; unassign?: boolean }) => void;
  onAutoDispatch: (task: TeamTaskInfo, enabled: boolean) => void;
  onUpdateFields: (task: TeamTaskInfo, body: Record<string, unknown>) => void;
}) {
  const [dragTask, setDragTask] = useState<string | null>(null);
  const [panel, setPanel] = useState<"distribute" | "detail">(isAdmin ? "distribute" : "detail");
  const selected = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const candidates = distributionCandidates(members, tasks, selected ?? undefined);
  const origins = originOptions(tasks);
  const detailOpen = panel === "detail" && selected !== null;

  useEffect(() => {
    setPanel(isAdmin ? "distribute" : "detail");
  }, [selectedTaskId, isAdmin]);

  return (
    <div className={styles.board}>
      <div className={styles.boardBar}>
        <button type="button" className={styles.backLink} onClick={onBack} data-part="board-back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M11 7H3M6.5 3.5L3 7l3.5 3.5" />
          </svg>
          {teamName}
        </button>
        <h1 className={styles.boardTitle}>{t("teamTask.subnav.board")}</h1>
        <span className={styles.boardMeta}>
          {sprintName ? `${sprintName} · ` : ""}
          {t("teamTask.board.openCount", { n: String(openCount) })}
        </span>
        <span className={styles.headerSpacer} />
        <div className={styles.avatarRow} aria-label={t("teamTask.board.filterPerson")}>
          {members.map((m) => {
            const av = memberAvatar(members, m.accountId);
            return (
              <button
                key={m.accountId}
                type="button"
                className={`${styles.avatar} ${styles.avatarSm} ${styles[`av${av.tone}`]}${filter.assigneeId === m.accountId ? ` ${styles.avatarOn}` : ""}`}
                title={m.accountId === accountId ? t("team.you") : memberDisplayName(members, m.accountId)}
                aria-pressed={filter.assigneeId === m.accountId}
                onClick={() => onFilter({ ...filter, assigneeId: filter.assigneeId === m.accountId ? "" : m.accountId })}
              >
                {av.initials}
              </button>
            );
          })}
        </div>
        <select
          className={styles.projectSelect}
          value={filter.project}
          aria-label={t("teamTask.board.projectAll")}
          onChange={(e) => onFilter({ ...filter, project: e.target.value })}
        >
          <option value="">{t("teamTask.board.projectAll")}</option>
          {origins.map((origin) => (
            <option key={origin} value={origin}>
              {t(originLabelKey(origin))}
            </option>
          ))}
        </select>
        <input
          className={styles.search}
          placeholder={t("teamTask.board.search")}
          value={filter.search}
          onChange={(e) => onFilter({ ...filter, search: e.target.value })}
        />
        <label className={styles.row} style={{ gap: "var(--v2-s3)" }}>
          <input type="checkbox" checked={filter.unassigned} onChange={(e) => onFilter({ ...filter, unassigned: e.target.checked })} />
          <span className={styles.muted}>{t("teamTask.board.onlyNoOwner")}</span>
        </label>
        <div className={styles.teamTabs}>
          <button
            type="button"
            className={`${styles.teamTab}${!filter.mine ? ` ${styles.teamTabOn}` : ""}`}
            aria-pressed={!filter.mine}
            onClick={() => onFilter({ ...filter, mine: false })}
          >
            {t("teamTask.member.all")}
          </button>
          <button
            type="button"
            className={`${styles.teamTab}${filter.mine ? ` ${styles.teamTabOn}` : ""}`}
            aria-pressed={filter.mine}
            onClick={() => onFilter({ ...filter, mine: true })}
          >
            {t("teamTask.member.mine")}
          </button>
        </div>
        {isAdmin ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            data-part="board-new-task"
            disabled={busy}
            onClick={onNewTask}
          >
            + {t("teamTask.board.newTask")}
          </button>
        ) : null}
      </div>

      {!isAdmin ? <div className={styles.boardBanner}>{t("teamTask.member.banner")}</div> : null}

      <div className={`${styles.boardBody}${detailOpen ? ` ${styles.boardBodyDetail}` : ""}`}>
        <div className={styles.columns}>
          {TEAM_COLUMNS.map((column) => (
            <section
              key={column}
              className={styles.col}
              data-column={column}
              aria-label={t(TEAM_COLUMN_LABEL_KEY[column])}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const task = tasks.find((x) => x.id === dragTask);
                setDragTask(null);
                if (task) onDrag(task, column);
              }}
            >
              <div className={styles.colHead}>
                <span className={`${styles.colTitle}${column === "aguardando_revisao" ? ` ${styles.colTitleReview}` : ""}`}>
                  {t(TEAM_COLUMN_LABEL_KEY[column])}
                </span>
                <span className={styles.colCount}>{grouped[column].length}</span>
              </div>
              <div className={styles.colList}>
                {grouped[column].map((task) => {
                  const mine = isAssignee(task, accountId);
                  const draggable =
                    canDrag({ role: myRole, accountId, task, to: "rodando" }) ||
                    canDrag({ role: myRole, accountId, task, to: "aguardando_revisao" });
                  return (
                    <div
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      draggable={writable && draggable}
                      data-task-id={task.id}
                      className={`${styles.taskCard}${mine ? ` ${styles.taskCardMine}` : ""}${selectedTaskId === task.id ? ` ${styles.taskCardSelected}` : ""}`}
                      onDragStart={() => {
                        if (writable) setDragTask(task.id);
                      }}
                      onDragEnd={() => setDragTask(null)}
                      onClick={() => onSelect(task)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSelect(task);
                      }}
                    >
                      <span className={styles.taskTitle}>
                        <span className={styles.muted}>{task.ref} </span>
                        {task.title}
                      </span>
                      <span className={styles.chips}>
                        <span className={styles.chip}>{t(originLabelKey(task.originKind))}</span>
                        <span className={styles.chip}>{t(TEAM_KIND_LABEL_KEY[task.kind])}</span>
                        {task.state === "aguardando_revisao" && task.gatesTotal !== null ? (
                          <span className={`${styles.chip} ${styles.chipOk}`}>
                            {t("teamTask.gates", { passed: String(task.gatesPassed ?? 0), total: String(task.gatesTotal) })}
                          </span>
                        ) : null}
                        {mine ? <span className={`${styles.chip} ${styles.chipMine}`}>{t("teamTask.member.yours")}</span> : null}
                      </span>
                      <span className={styles.taskFoot}>
                        {task.state === "sem_dono" ? (
                          <>
                            <span className={`${styles.avatar} ${styles.avatarSm} ${styles.avatarEmpty}`}>?</span>
                            <span className={styles.muted}>{t("teamTask.board.idle")}</span>
                          </>
                        ) : task.state === "atribuida" ? (
                          <>
                            <Avatar members={members} accountId={task.assigneeId} small />
                            {task.assigneeId === accountId
                              ? t("teamTask.card.inMyQueue")
                              : t("teamTask.card.inQueue", { name: memberDisplayName(members, task.assigneeId) })}
                          </>
                        ) : task.state === "rodando" ? (
                          <>
                            <Avatar members={members} accountId={task.assigneeId} small />
                            <span className={styles.providerDot} style={{ background: providerDot(task.provider) }} />
                            {task.provider}
                            {" · "}
                            {ageLabel(task.startedAt ?? task.updatedAt)}
                          </>
                        ) : task.state === "aguardando_revisao" ? (
                          <>
                            <Avatar members={members} accountId={task.assigneeId} small />
                            {t("teamTask.card.reviewAt", { age: ageLabel(task.updatedAt) })}
                          </>
                        ) : null}
                      </span>
                      {!isAdmin && mine && task.state === "atribuida" ? (
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            onReturn(task);
                          }}
                        >
                          {t("teamTask.member.return")}
                        </button>
                      ) : null}
                      {!isAdmin && !task.assigneeId && task.state === "sem_dono" ? (
                        requested[task.id] ? (
                          <span className={styles.muted}>{t("teamTask.member.asked")}</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              onClaim(task);
                            }}
                          >
                            {t("teamTask.member.askToTake")}
                          </button>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {column === "aguardando_revisao" ? (
                <div className={styles.colFoot}>{t("teamTask.card.sprintDone", { n: String(sprintDone) })}</div>
              ) : null}
            </section>
          ))}
        </div>

        {detailOpen && selected ? (
          <aside className={styles.detailPanel} aria-label={t("teamTask.detail.tab.activity")}>
            <TaskInsight
              task={selected}
              detail={detail}
              members={members}
              sprintName={sprintName}
              isAdmin={isAdmin}
              busy={busy}
              comment={comment}
              onComment={onComment}
              onSend={onSendComment}
              onClose={onCloseDetail}
              onBack={isAdmin ? () => setPanel("distribute") : undefined}
              onEdit={() => onEditTask(selected)}
              onDuplicate={() => onDuplicateTask(selected)}
              onCopyLink={() => onCopyLinkTask(selected)}
              onPause={() => onPauseTask(selected)}
              onArchive={onArchive}
              onDelete={onDelete}
            />
          </aside>
        ) : (
          <aside className={styles.boardAside} aria-label={isAdmin ? t("teamTask.distribute.title") : t("teamTask.member.arrived")}>
            {isAdmin ? (
              <DistributePanel
                task={selected}
                candidates={candidates}
                members={members}
                accountId={accountId}
                busy={busy}
                onAssign={onAssign}
                onAutoDispatch={onAutoDispatch}
                onUpdateFields={onUpdateFields}
                onClose={onCloseDetail}
                onShowDetail={() => setPanel("detail")}
              />
            ) : (
              <MemberAside
                offers={offers}
                claimableCount={claimable.length}
                members={members}
                boards={boards}
                busy={busy}
                onAccept={onAccept}
                onReturn={onReturn}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function DistributePanel({
  task,
  candidates,
  members,
  accountId,
  busy,
  onAssign,
  onAutoDispatch,
  onUpdateFields,
  onClose,
  onShowDetail,
}: {
  task: TeamTaskInfo | null;
  candidates: ReturnType<typeof distributionCandidates>;
  members: TeamMemberInfo[];
  accountId: string | null;
  busy: boolean;
  onAssign: (task: TeamTaskInfo, body: { assignee_id?: string; session_label?: string; unassign?: boolean }) => void;
  onAutoDispatch: (task: TeamTaskInfo, enabled: boolean) => void;
  onUpdateFields: (task: TeamTaskInfo, body: Record<string, unknown>) => void;
  onClose: () => void;
  onShowDetail: () => void;
}) {
  const [assignee, setAssignee] = useState<string>("");
  useEffect(() => {
    setAssignee(task?.assigneeId ?? "");
  }, [task?.id, task?.assigneeId]);

  const name = (id: string | null) => (id === accountId ? t("team.you") : memberDisplayName(members, id));
  const reviewers = members.filter((m) => canReviewRole(m.role));
  const gateCommands = task ? task.gates.map((g) => (typeof g === "string" ? g : g.cmd)) : [];

  return (
    <div className={styles.distribute}>
      <div className={styles.panelHead}>
        <span className={styles.fieldLabel}>{t("teamTask.distribute.title")}</span>
        <span className={styles.headerSpacer} />
        {task ? (
          <button type="button" className={styles.iconBtn} aria-label={t("teamTask.panel.close")} onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        ) : null}
      </div>
      {!task ? (
        <div className={styles.infoBox}>{t("teamTask.distribute.pick")}</div>
      ) : (
        <>
          <div className={styles.panelTitleRow}>
            <h2 className={styles.cardTitle}>{task.title}</h2>
            <button type="button" className={styles.btn} onClick={onShowDetail} data-part="task-detail-open">
              {t("teamTask.distribute.detail")}
            </button>
          </div>
          <div className={styles.chips}>
            {task.territory.map((terr) => (
              <span key={terr} className={styles.chip}>
                {terr}
              </span>
            ))}
            {gateCommands.length > 0 ? <span className={styles.chip}>gates: {gateCommands.join(" · ")}</span> : null}
            {task.reviewerId ? <span className={styles.chip}>{t("teamTask.reviewRequested")}</span> : null}
          </div>
          <div>
            <div className={styles.fieldLabel}>{t("teamTask.distribute.forWhom")}</div>
            {candidates.map((c) => (
              <button
                key={c.accountId}
                type="button"
                className={`${styles.memberRow}${assignee === c.accountId ? ` ${styles.memberRowOn}` : ""}`}
                onClick={() => setAssignee(c.accountId)}
              >
                <Avatar members={members} accountId={c.accountId} small />
                <span className={styles.memberText}>
                  <span>{name(c.accountId)}</span>
                  <span className={styles.loadTag}>
                    {t("teamTask.distribute.running", { n: String(c.running) })}
                    {c.knows.length > 0 ? ` · ${t("teamTask.distribute.knows", { territory: c.knows[0] })}` : ""}
                  </span>
                </span>
                {c.tone === "free" ? <span className={`${styles.loadTag} ${styles.loadFree}`}>{t("teamTask.distribute.free")}</span> : null}
                {c.tone === "full" ? <span className={`${styles.loadTag} ${styles.loadFull}`}>{t("teamTask.distribute.full")}</span> : null}
              </button>
            ))}
          </div>
          <div>
            <div className={styles.fieldLabel}>{t("teamTask.distribute.session")}</div>
            <select className={styles.select} style={{ width: "100%" }} value="">
              <option value="">{t("teamTask.distribute.sessionPerson")}</option>
            </select>
          </div>
          <div className={styles.grid2}>
            <div>
              <div className={styles.fieldLabel}>{t("teamTask.distribute.priority")}</div>
              <select
                className={styles.select}
                style={{ width: "100%" }}
                value={task.priority}
                onChange={(e) => onUpdateFields(task, { priority: e.target.value })}
              >
                {(["baixa", "media", "alta", "urgente"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(TEAM_PRIORITY_LABEL_KEY[p])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className={styles.fieldLabel}>{t("teamTask.distribute.reviewer")}</div>
              <select
                className={styles.select}
                style={{ width: "100%" }}
                value={task.reviewerId ?? ""}
                onChange={(e) => onUpdateFields(task, { reviewer_id: e.target.value || null })}
              >
                <option value="">{t("teamTask.distribute.reviewerNone")}</option>
                {reviewers.map((m) => (
                  <option key={m.accountId} value={m.accountId}>
                    {name(m.accountId)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.infoBox}>{t("teamTask.distribute.note")}</div>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.assignBtn}`}
            disabled={busy || !assignee}
            onClick={() => onAssign(task, { assignee_id: assignee })}
          >
            {t("teamTask.distribute.assign", { name: assignee ? name(assignee) : "" })}
          </button>
          <div className={styles.row}>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => onAssign(task, { unassign: true })}>
              {t("teamTask.distribute.unassign")}
            </button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => onAutoDispatch(task, !task.autoDispatch)}>
              {task.autoDispatch ? t("teamTask.distribute.autoOn") : t("teamTask.distribute.auto")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MemberAside({
  offers,
  claimableCount,
  members,
  boards,
  busy,
  onAccept,
  onReturn,
}: {
  offers: TeamTaskInfo[];
  claimableCount: number;
  members: TeamMemberInfo[];
  boards: TeamRef[];
  busy: boolean;
  onAccept: (task: TeamTaskInfo, boardId: string) => void;
  onReturn: (task: TeamTaskInfo) => void;
}) {
  const [boardChoice, setBoardChoice] = useState<string>(boards[0]?.id ?? "");
  useEffect(() => {
    if (!boards.some((b) => b.id === boardChoice)) setBoardChoice(boards[0]?.id ?? "");
  }, [boards, boardChoice]);
  return (
    <aside className={styles.distribute} aria-label={t("teamTask.member.arrived")}>
      <h2 className={styles.cardTitle}>{t("teamTask.member.arrived")}</h2>
      {offers.length === 0 ? (
        <div className={styles.muted}>{claimableCount > 0 ? t("teamTask.member.noneOffer") : t("teamTask.member.none")}</div>
      ) : (
        offers.map((task) => (
          <div key={task.id} className={styles.memberOffer}>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.muted}>
              {t("teamTask.member.from", {
                from: memberDisplayName(members, task.createdBy),
                priority: t(TEAM_PRIORITY_LABEL_KEY[task.priority]),
                reviewer: memberDisplayName(members, task.reviewerId),
              })}
            </span>
            <div>
              <div className={styles.fieldLabel}>{t("teamTask.member.session")}</div>
              <select className={styles.select} style={{ width: "100%" }} value={boardChoice} onChange={(e) => setBoardChoice(e.target.value)}>
                {boards.length === 0 ? <option value="">{t("teamTask.member.noBoard")}</option> : null}
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.row}>
              <button type="button" className={styles.btn} disabled={busy} onClick={() => onReturn(task)}>
                {t("teamTask.member.return")}
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !boardChoice} onClick={() => onAccept(task, boardChoice)}>
                {t("teamTask.member.accept")}
              </button>
            </div>
          </div>
        ))
      )}
      <span className={styles.muted}>{t("teamTask.member.acceptNote")}</span>
    </aside>
  );
}

type DetailTab = "activity" | "contract" | "gates" | "diff" | "reports";

function TaskInsight({
  task,
  detail,
  members,
  sprintName,
  isAdmin,
  busy,
  comment,
  onComment,
  onSend,
  onClose,
  onBack,
  onEdit,
  onArchive,
  onDelete,
  onDuplicate,
  onCopyLink,
  onPause,
}: {
  task: TeamTaskInfo;
  detail: TeamTaskDetailInfo | null;
  members: TeamMemberInfo[];
  sprintName: string;
  isAdmin: boolean;
  busy: boolean;
  comment: string;
  onComment: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  onBack?: () => void;
  onEdit?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCopyLink?: () => void;
  onPause?: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("activity");
  const [menu, setMenu] = useState(false);
  const deps = detail?.deps ?? [];
  const gateCmd = (g: TeamTaskInfo["gates"][number]) => (typeof g === "string" ? g : g.cmd);
  const gateExclusive = (g: TeamTaskInfo["gates"][number]) => (typeof g === "string" ? false : g.exclusive !== undefined);
  const tabs: { id: DetailTab; key: MessageKey }[] = [
    { id: "activity", key: "teamTask.detail.tab.activity" },
    { id: "contract", key: "teamTask.detail.tab.contract" },
    { id: "gates", key: "teamTask.detail.tab.gates" },
    { id: "diff", key: "teamTask.detail.tab.diff" },
    { id: "reports", key: "teamTask.detail.tab.reports" },
  ];
  return (
    <div className={styles.detail}>
      <div className={styles.detailTop}>
        {onBack ? (
          <button type="button" className={styles.iconBtn} aria-label={t("teamTask.detail.back")} onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M11 7H3M6.5 3.5L3 7l3.5 3.5" />
            </svg>
          </button>
        ) : null}
        <span className={styles.detailRef}>{task.ref}</span>
        <span className={`${styles.stateBadge}${task.state === "aguardando_revisao" ? ` ${styles.stateReview}` : ""}`}>
          {t(TEAM_STATE_LABEL_KEY[task.state])}
        </span>
        <span className={styles.detailKind}>
          {t(TEAM_KIND_LABEL_KEY[task.kind])}
          {sprintName ? ` · ${sprintName}` : ""}
          {` · ${t(TEAM_PRIORITY_LABEL_KEY[task.priority])}`}
        </span>
        <span className={styles.headerSpacer} />
        {isAdmin ? (
          <div className={styles.menuWrap}>
            <button type="button" className={styles.btn} aria-haspopup="menu" aria-expanded={menu} data-part="task-actions" onClick={() => setMenu((v) => !v)}>
              {t("teamTask.detail.actions")}
            </button>
            {menu ? (
              <div className={styles.menu} role="menu">
                {onEdit ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onEdit(); }}>
                    {t("teamTask.detail.action.editContract")}
                  </button>
                ) : null}
                {onDuplicate ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onDuplicate(); }}>
                    {t("teamTask.detail.action.duplicate")}
                  </button>
                ) : null}
                {onCopyLink ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onCopyLink(); }}>
                    {t("teamTask.detail.action.copyLink")}
                  </button>
                ) : null}
                {onPause ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onPause(); }}>
                    {t("teamTask.detail.action.pause")}
                  </button>
                ) : null}
                <div className={styles.menuSep} />
                <button type="button" className={styles.menuItem} role="menuitem" data-part="task-archive" onClick={() => { setMenu(false); onArchive(); }}>
                  {t("teamTask.detail.archive")}
                </button>
                <button type="button" className={`${styles.menuItem} ${styles.menuDanger}`} role="menuitem" data-part="task-delete" onClick={() => { setMenu(false); onDelete(); }}>
                  {t("teamTask.detail.delete")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <button type="button" className={styles.iconBtn} aria-label={t("teamTask.panel.close")} onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>

      <h2 className={styles.detailTitle}>{task.title}</h2>
      <div className={styles.detailMeta}>
        <span>{t("teamTask.detail.owner")} <b>{memberDisplayName(members, task.assigneeId)}</b></span>
        <span>{t("teamTask.detail.reviewer")} <b>{memberDisplayName(members, task.reviewerId)}</b></span>
        {task.provider ? (
          <span>
            {t("teamTask.detail.agent")} <b>{task.provider}</b> · {ageLabel(task.startedAt ?? task.updatedAt)}
          </span>
        ) : null}
        <span>{t("teamTask.detail.createdBy")} <b>{memberDisplayName(members, task.createdBy)}</b></span>
      </div>

      <div className={styles.tabs} role="tablist" aria-label={t("teamTask.detail.actions")}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            className={`${styles.tab}${tab === x.id ? ` ${styles.tabOn}` : ""}`}
            onClick={() => setTab(x.id)}
          >
            {t(x.key)}
          </button>
        ))}
      </div>

      <div className={styles.tabBody}>
        {tab === "activity" ? (
          <>
            <div className={styles.timeline}>
              {detail && detail.events.length > 0 ? (
                detail.events.map((e) => {
                  const actor = e.actorName || shortId(e.actorId);
                  const key = teamEventKey(e.kind);
                  const tone = teamEventTone(e.kind);
                  const toneClass = tone === "warn" ? styles.evDotWarn : tone === "accent" ? styles.evDotAccent : styles.evDotMuted;
                  return (
                    <span key={e.id} className={styles.eventRow}>
                      <span className={`${styles.eventDot} ${toneClass}`} aria-hidden="true" />
                      <span>
                        {key ? t(key, { actor }) : `${actor} · ${e.kind}`} · {ageLabel(e.at)}
                      </span>
                    </span>
                  );
                })
              ) : (
                <span className={styles.muted}>{t("teamTask.detail.noTimeline")}</span>
              )}
            </div>
            <div className={styles.field}>
              <div className={styles.fieldLabel}>{t("teamTask.detail.commentLabel")}</div>
              <textarea
                className={styles.commentArea}
                placeholder={t("teamTask.detail.commentPlaceholder")}
                value={comment}
                onChange={(e) => onComment(e.target.value)}
              />
              <div className={styles.rowEnd}>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || comment.trim() === ""} onClick={onSend}>
                  {t("teamTask.detail.commentSubmit")}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {tab === "contract" ? (
          <>
            <div className={styles.muted}>{t("teamTask.detail.version", { n: String(detail?.contract?.version ?? 1) })}</div>
            <pre className={styles.contract}>{detail?.contract?.markdown ?? t("teamTask.detail.noContract")}</pre>
            {task.territory.length > 0 || task.gates.length > 0 ? (
              <div className={styles.muted}>
                {task.territory.join(", ")}
                {task.gates.length > 0 ? ` · gates ${task.gates.map(gateCmd).join(", ")}` : ""}
              </div>
            ) : null}
            {onEdit ? (
              <div>
                <button type="button" className={styles.btn} disabled={busy} onClick={onEdit}>
                  {t("teamTask.detail.action.editContract")}
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "gates" ? (
          <>
            <div className={styles.muted}>{t("teamTask.detail.gatesHint")}</div>
            {task.gates.length === 0 ? (
              <div className={styles.placeholder}>{t("teamTask.detail.noContract")}</div>
            ) : (
              task.gates.map((g, i) => (
                <div key={`${gateCmd(g)}-${i}`} className={styles.gateLine}>
                  <span className={styles.mono}>{gateCmd(g)}</span>
                  <span className={styles.muted}>{gateExclusive(g) ? t("teamTask.detail.gateExclusive") : t("teamTask.detail.gatePending")}</span>
                </div>
              ))
            )}
          </>
        ) : null}

        {tab === "diff" ? (
          <div className={styles.placeholder}>
            {t("teamTask.detail.diffHint")} · {t("teamTask.detail.diffEmpty")}
          </div>
        ) : null}
        {tab === "reports" ? <div className={styles.placeholder}>{t("teamTask.detail.reportsEmpty")}</div> : null}
      </div>

      <div className={styles.detailFoot}>
        <span className={styles.muted}>
          {deps.length > 0
            ? t("teamTask.detail.deps", { deps: deps.map((d) => `#${d.shortId}`).join(", ") })
            : t("teamTask.detail.noDeps")}
        </span>
        <span className={styles.headerSpacer} />
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled>
          {t("teamTask.detail.approve")}
        </button>
      </div>
    </div>
  );
}
