import { useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type {
  TeamDetailInfo,
  TeamInviteCreatedInfo,
  TeamInviteInfo,
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
import {
  INVITE_ROLES,
  canDeleteTeam,
  canManageMembers,
  canRenameTeam,
  consumeTeamSub,
  inviteDaysLeft,
  memberRowState,
  ownerCount,
  seatsView,
  slugMatches,
  type SeatsView,
} from "./team-admin-decisions";
import { Rich } from "./InviteDialog";
import { isTeamSub, publishTeamSubs, setTeamSub, useTeamNav, type TeamSub } from "./team-nav";
import { TeamPanel } from "./TeamPanel";
import { TeamTaskForm } from "./TeamTaskForm";
import { TeamTaskDeleteDialog } from "./TeamTaskDeleteDialog";
import type { DeleteMode } from "./team-task-delete-decisions";
import { canWrite, decidePlanAccess, describePlanFailure, type PlanAccess } from "./PlanAccess";
import { PlanNotice } from "./PlanGate";
import { useCloudPlan, usePlansUrl } from "./PlanHooks";
import { ImportWizard } from "./ImportWizard";
import { IntegrationsPage } from "./IntegrationsPage";
import styles from "./TeamPage.module.css";

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

export function TeamPage({
  boards,
  initialTeamId,
  initialTaskId,
  initialUnassigned = false,
}: {
  boards: TeamRef[];
  /** Open this team when arriving from the inbox notification click. */
  initialTeamId?: string;
  /** Select this task after the team board loads (inbox deep-link). */
  initialTaskId?: string;
  /** Ctrl+K Distribuir — open board filtered to unassigned. */
  initialUnassigned?: boolean;
}) {
  const [overview, setOverview] = useState<TeamOverviewInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialTeamId ?? null);
  const [detail, setDetail] = useState<TeamDetailInfo | null>(null);
  const [tasks, setTasks] = useState<TeamTaskInfo[]>([]);
  const [sprints, setSprints] = useState<TeamSprintInfo[]>([]);
  // The open section lives in a small shared store: the sidebar nests the
  // sections under "Team" and this page renders the one that is open.
  useState(() => {
    const asked = consumeTeamSub();
    setTeamSub(isTeamSub(asked) ? asked : "overview");
    return true;
  });
  const sub = useTeamNav().sub;
  const [cmdOpen, setCmdOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [invites, setInvites] = useState<TeamInviteInfo[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [filter, setFilter] = useState({ assigneeId: "", project: "", unassigned: false, search: "", mine: false });
  const [selectedTask, setSelectedTask] = useState<TeamTaskInfo | null>(null);
  const [taskDetail, setTaskDetail] = useState<TeamTaskDetailInfo | null>(null);
  const [comment, setComment] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formEditing, setFormEditing] = useState<TeamTaskInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamTaskInfo | null>(null);
  const [deleteInitial, setDeleteInitial] = useState<DeleteMode>("archive");
  const [requested, setRequested] = useState<Record<string, boolean>>({});

  const { plan: cloudPlan, loggedIn } = useCloudPlan();
  const plansUrl = usePlansUrl();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
      }
      if (e.key === "Escape") setCmdOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The team right is paid: on Free the section explains the Team plan and
  // locks create/invite/board; an expired plan keeps reading but blocks writes.
  const rawAccess = decidePlanAccess(cloudPlan, "team");
  // The cached plan can lag behind the account (an invite accepted a moment ago):
  // belonging to a team already means the team right is held through it, so an
  // "upgrade" reading while teams exist is stale, not a refusal. The server still
  // decides every write.
  const teamAccess: PlanAccess =
    rawAccess.kind === "upgrade" && overview !== null && overview.teams.length > 0
      ? { kind: "granted", source: "team", teamId: overview.teams[0].id }
      : rawAccess;
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
    // Team board refresh follows the account SSE stream instead of a timed
    // poll — inbox/task events nudge a silent reload of the open board.
    if (!window.inbox?.onEvent) return;
    return window.inbox.onEvent((event) => {
      if (document.visibilityState !== "visible") return;
      if (event.name === "task" || event.name === "inbox" || event.name === "") {
        void loadTasks(selected, true);
      }
    });
  }, [selected, loadTeam, loadTasks]);

  useEffect(() => {
    if (!initialTeamId) return;
    setSelected(initialTeamId);
  }, [initialTeamId]);

  useEffect(() => {
    if (!initialUnassigned) return;
    setFilter((f) => ({ ...f, unassigned: true }));
    setTeamSub("board");
  }, [initialUnassigned]);

  useEffect(() => {
    if (!initialTaskId || !selected || tasks.length === 0) return;
    const hit = tasks.find((task) => task.id === initialTaskId);
    if (hit) {
      setSelectedTask(hit);
      setTeamSub("board");
      void window.team.taskDetail(selected, hit.id).then((res) => {
        if (res.ok) setTaskDetail(res.detail);
      });
    }
  }, [initialTaskId, selected, tasks]);

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
  const hasTeam = overview !== null && overview.teams.length > 0;
  const subsOffered: TeamSub[] = hasTeam
    ? ["overview", "board", "members", "home", "import", "integrations", "audit", ...(canRenameTeam(myRole) ? (["settings"] as const) : [])]
    : [];
  const subsKey = subsOffered.join(",");
  useEffect(() => {
    publishTeamSubs(subsKey === "" ? [] : (subsKey.split(",") as TeamSub[]));
    return () => publishTeamSubs([]);
  }, [subsKey]);
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

  /** Reads the team back after a change that moves members or seats. */
  async function reloadDetail(teamId: string) {
    const res = await window.team.detail(teamId);
    if (res.ok) setDetail(res.detail);
  }

  /** The invite dialog renders the outcome itself; this only keeps the page's
   *  pending list and seats in step. */
  async function createInvite(target: string, role: TeamRole, delivery: "email" | "link") {
    if (!selected || !teamWritable) return { ok: false as const, reason: "error" as const, error: t("teamTask.error") };
    const res = await window.team.invite(selected, { target: target.trim(), role, delivery });
    if (res.ok) setInvites((prev) => [...prev, res.invite]);
    else if (res.reason === "seats-exceeded") void reloadDetail(selected);
    return res;
  }

  async function handleChangeRole(member: TeamMemberInfo, role: TeamRole) {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.changeRole(selected, member.accountId, role);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await reloadDetail(selected);
      setNote(t("teamAdmin.member.roleChanged"));
    });
  }

  async function handleRemoveMember(member: TeamMemberInfo, members: readonly TeamMemberInfo[]) {
    if (!selected) return;
    if (!window.confirm(t("team.removeConfirm", { who: memberDisplayName(members, member.accountId) }))) return;
    await run(async () => {
      const res = await window.team.removeMember(selected, member.accountId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await reloadDetail(selected);
      setNote(t("teamAdmin.member.removed"));
    });
  }

  /** The team is gone for this person (left or deleted): back to the team list. */
  function leaveSelectedTeam(message: string) {
    setSelected(null);
    setDetail(null);
    setTasks([]);
    setInvites([]);
    setTeamSub("overview");
    void refreshOverview().then(() => setNote(message));
  }

  async function handleLeave() {
    if (!selected) return;
    if (!window.confirm(t("teamAdmin.member.leaveConfirm"))) return;
    await run(async () => {
      const res = await window.team.leave(selected);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      leaveSelectedTeam(t("teamAdmin.member.left"));
    });
  }

  async function handleRename(name: string) {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.renameTeam(selected, name);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const renamed = res.team;
      setOverview((prev) => (prev ? { ...prev, teams: prev.teams.map((x) => (x.id === renamed.id ? { ...x, name: renamed.name } : x)) } : prev));
      setDetail((prev) => (prev ? { ...prev, team: { ...prev.team, name: renamed.name } } : prev));
      setNote(t("teamAdmin.settings.saved"));
    });
  }

  async function handleDeleteTeam(slugConfirm: string) {
    if (!selected) return;
    const name = team?.name ?? "";
    await run(async () => {
      const res = await window.team.deleteTeam(selected, slugConfirm);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      leaveSelectedTeam(t("teamAdmin.settings.deleted", { name }));
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

  async function handleComment(task: TeamTaskInfo, mentions: string[] = []) {
    if (!selected || !teamWritable || comment.trim() === "") return;
    await run(async () => {
      const res = await window.team.commentTask(selected, task.id, comment.trim(), mentions);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setComment("");
      await openTask(task);
    });
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
    return (
      <CreateTeamScreen
        locked={loggedIn && teamAccess.kind === "upgrade"}
        busy={busy}
        error={error}
        note={note}
        onCreate={handleCreateTeam}
      />
    );
  }


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

  if (sub === "import" && selected) {
    return (
      <ImportWizard
        teamId={selected}
        teamName={team?.name ?? ""}
        role={myRole}
        onBack={() => setTeamSub("overview")}
        onOpenTeamBoard={() => setTeamSub("board")}
      />
    );
  }

  if (sub === "integrations" && selected) {
    return (
      <IntegrationsPage
        teamId={selected}
        teamName={team?.name ?? ""}
        role={myRole}
        members={detail?.members ?? []}
        onBack={() => setTeamSub("overview")}
      />
    );
  }

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
          onBack={() => setTeamSub("overview")}
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
          onSendComment={(mentions) => {
            if (selectedTask) void handleComment(selectedTask, mentions);
          }}
          onCloseDetail={closeDetail}
          onEditTask={(task) => {
            setFormEditing(task);
            setFormOpen(true);
          }}
          sprints={sprints}
          shareFilePaths={team?.shareFilePaths ?? false}
          onCreateSubtasks={(task, subtasks) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.createSubtasks(selected, task.id, subtasks);
              if (!res.ok) setError(res.error);
              else {
                await loadTasks(selected);
                await openTask(task);
              }
            })
          }
          onPatchSharePaths={(enabled) =>
            void run(async () => {
              if (!selected) return;
              const res = await window.team.patchTeam(selected, { share_file_paths: enabled });
              if (!res.ok) {
                setError(res.error);
                return;
              }
              setOverview((prev) =>
                prev
                  ? {
                      ...prev,
                      teams: prev.teams.map((x) => (x.id === selected ? { ...x, shareFilePaths: enabled } : x)),
                    }
                  : prev,
              );
            })
          }
          onDuplicateTask={(task) =>
            void run(async () => {
              if (!selected) return;
              const depIds = (taskDetail?.task.id === task.id ? taskDetail.deps : []).map((d) => d.id);
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
                ...(task.sprintId ? { sprint_id: task.sprintId } : {}),
                ...(depIds.length > 0 ? { depends_on: depIds } : {}),
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

  const seats = seatsView(detail?.seats ?? null);
  const canInvite = canManageMembers(myRole);
  const members = detail?.members ?? [];

  return (
    <div className={styles.page} data-part="team-page">
      <div className={styles.pageHead} data-part="team-head">
        <div className={styles.pageHeadText}>
          <h1 className={styles.title} data-part="team-title">
            {team?.name ?? t("shell.team")}
          </h1>
          <div className={styles.metaRow}>
            {seats.kind !== "unlimited" ? (
              <span
                className={`${styles.pill} ${seats.kind === "full" ? styles.pillBad : styles.pillOk}`}
                data-part="seats-pill"
                data-seats={seats.kind}
              >
                {t("teamAdmin.seats.pill", { used: seats.used, total: seats.total })}
              </span>
            ) : null}
            {team ? (
              <span className={styles.slugText}>
                {t("teamAdmin.slug")} <span className={styles.mono}>{team.slug}</span>
              </span>
            ) : null}
          </div>
        </div>
        {overview.teams.length > 1 ? (
          <select className={styles.select} value={selected ?? ""} onChange={(e) => setSelected(e.target.value)} aria-label={t("teamTask.selectTeam")}>
            {overview.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        ) : null}
        {canRenameTeam(myRole) ? (
          <button type="button" className={styles.headBtn} data-part="team-open-settings" onClick={() => setTeamSub("settings")}>
            {t("teamAdmin.subnav.settings")}
          </button>
        ) : null}
        {canInvite ? (
          <button
            type="button"
            className={`${styles.headBtn} ${styles.headBtnPrimary}`}
            data-part="team-open-invite"
            disabled={!teamWritable}
            onClick={() => setInviteOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M7 2.5v9M2.5 7h9" />
            </svg>
            {t("teamTask.invite")}
          </button>
        ) : null}
      </div>

      {cmdOpen ? (
        <div
          role="dialog"
          aria-label={t("team.cmdPalette.aria")}
          data-part="team-cmd-palette"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.55)",
            display: "grid",
            placeItems: "start center",
            paddingTop: 80,
            zIndex: 50,
          }}
          onClick={() => setCmdOpen(false)}
        >
          <div
            style={{
              width: "min(520px, 92vw)",
              borderRadius: 14,
              border: "1px solid var(--v2-line-soft)",
              background: "var(--v2-card)",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, fontWeight: 600, padding: "4px 8px" }}>{t("team.cmdPalette.title")}</div>
            <button
              type="button"
              className={styles.btn}
              data-part="cmd-import"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => {
                setCmdOpen(false);
                setTeamSub("import");
              }}
            >
              {t("teamImport.cmdPalette")}
            </button>
            <button
              type="button"
              className={styles.btn}
              data-part="cmd-integrations"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => {
                setCmdOpen(false);
                setTeamSub("integrations");
              }}
            >
              {t("teamIntegrations.cmdPalette")}
            </button>
          </div>
        </div>
      ) : null}

      {loggedIn && planNotice ? <PlanNotice access={planNotice} plansUrl={plansUrl} /> : null}
      {offline ? <div className={styles.banner}>{t("teamTask.offline")}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {formElement}

      {deleteElement}

      {inviteOpen && selected ? (
        <InviteModal
          seats={seats}
          myRole={myRole}
          onCreate={createInvite}
          onNote={setNote}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}

      <div data-part="team-content">
          {sub === "overview" || sub === "audit" || sub === "members" ? (
            <TeamAdminView
              stats={stats}
              members={members}
              seats={seats}
              accountId={accountId}
              tasks={tasks}
              invites={invites}
              myRole={myRole}
              busy={busy || !teamWritable}
              auditOnly={sub === "audit"}
              membersOnly={sub === "members"}
              onChangeRole={(member, role) => void handleChangeRole(member, role)}
              onRemove={(member) => void handleRemoveMember(member, members)}
              onLeave={() => void handleLeave()}
              onRevoke={(id) =>
                void run(async () => {
                  if (!selected) return;
                  const res = await window.team.revokeInvite(selected, id);
                  if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== id));
                  else setError(res.error ?? t("teamTask.error"));
                })
              }
            />
          ) : null}

          {sub === "settings" && team ? (
            <TeamSettingsView
              teamName={team.name}
              slug={team.slug}
              myRole={myRole}
              busy={busy || !teamWritable}
              onBack={() => setTeamSub("overview")}
              onRename={(name) => void handleRename(name)}
              onDelete={(slugConfirm) => void handleDeleteTeam(slugConfirm)}
            />
          ) : null}

          {sub === "home" ? <TeamPanel inline /> : null}
      </div>
    </div>
  );
}

function CreateTeamScreen({
  locked,
  busy,
  error,
  note,
  onCreate,
}: {
  /** No team plan on the account: the beta notice replaces the form. */
  locked: boolean;
  busy: boolean;
  error: string | null;
  note: string | null;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!locked && !busy && name.trim() !== "") onCreate(name.trim());
  };
  return (
    <div className={styles.createWrap} data-part="team-create">
      <div className={styles.createCard}>
        <h1 className={styles.createTitle} data-part="create-title">
          {t("teamAdmin.create.title")}
        </h1>
        {locked ? (
          <div className={styles.infoBox} data-part="beta-notice">
            {t("teamAdmin.create.beta")}
          </div>
        ) : null}
        {note ? <div className={styles.note}>{note}</div> : null}
        <div>
          <label className={styles.label} htmlFor="team-new-name">
            {t("team.name")}
          </label>
          <input
            id="team-new-name"
            className={styles.field}
            data-part="create-name"
            placeholder={t("teamAdmin.create.namePlaceholder")}
            value={name}
            disabled={locked || busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        {error ? (
          <div className={styles.errorBox} data-part="create-error" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          className={`${styles.headBtn} ${styles.headBtnPrimary}`}
          data-part="create-submit"
          disabled={locked || busy || name.trim() === ""}
          onClick={submit}
        >
          {t("teamAdmin.create.submit")}
        </button>
        {locked ? <p className={styles.hint}>{t("teamAdmin.create.betaFoot")}</p> : null}
      </div>
    </div>
  );
}

function InviteModal({
  seats,
  myRole,
  onCreate,
  onNote,
  onClose,
}: {
  seats: SeatsView;
  myRole: TeamRole | null;
  onCreate: (target: string, role: TeamRole, delivery: "email" | "link") => Promise<
    | { ok: true; invite: TeamInviteCreatedInfo }
    | { ok: false; reason: "invalid-target" | "forbidden" | "seats-exceeded" | "email-unavailable" | "error"; error: string }
  >;
  onNote: (note: string) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerLink, setOfferLink] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(seats.kind === "full");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = seats.kind === "unlimited" ? 0 : seats.total;
  const filled = target.trim() !== "";

  async function submit(delivery: "email" | "link") {
    setBusy(true);
    setError(null);
    setOfferLink(false);
    try {
      const res = await onCreate(target, role, delivery);
      if (!res.ok) {
        if (res.reason === "seats-exceeded") setBlocked(true);
        else {
          setError(res.reason === "forbidden" ? t("team.onlyAdmin") : res.error);
          setOfferLink(res.reason === "email-unavailable");
        }
        return;
      }
      if (delivery === "email") {
        onNote(t("team.invited", { target: res.invite.target }));
        onClose();
      } else if (res.invite.inviteUrl) {
        setLink(res.invite.inviteUrl);
      } else {
        setError(t("teamAdmin.invite.noLink"));
      }
    } catch {
      setError(t("teamTask.error"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError(t("teamAdmin.invite.copyFailed"));
    }
  }

  return (
    <div className={styles.veil} data-part="invite-modal">
      <div className={styles.modal} role="dialog" aria-labelledby="inv-form-t">
        <div className={styles.modalHead}>
          <h2 id="inv-form-t" className={styles.modalTitle} data-part="invite-title">
            {t("teamTask.invite")}
          </h2>
          <button type="button" className={styles.iconBtn} aria-label={t("teamAdmin.invite.close")} data-part="invite-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        <p className={styles.hint}>{t("teamAdmin.invite.hint")}</p>
        <div>
          <label className={styles.label} htmlFor="inv-target">
            {t("teamAdmin.invite.targetLabel")}
          </label>
          <input
            id="inv-target"
            className={styles.field}
            data-part="invite-target"
            placeholder={t("teamAdmin.invite.targetPlaceholder")}
            value={target}
            autoFocus
            readOnly={link !== null || blocked}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div>
          <label className={styles.label} htmlFor="inv-role">
            {t("teamAdmin.invite.roleLabel")}
          </label>
          <select
            id="inv-role"
            className={styles.fieldSelect}
            data-part="invite-role"
            value={role}
            disabled={link !== null}
            onChange={(e) => setRole(e.target.value as TeamRole)}
          >
            {INVITE_ROLES.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
              <option key={r} value={r}>
                {t(r === "admin" ? "teamAdmin.role.admin" : "teamAdmin.role.member")}
              </option>
            ))}
          </select>
        </div>

        {blocked ? (
          <>
            <div className={styles.warnBox} data-part="invite-full" role="alert">
              {t("teamAdmin.invite.full", { total })}
            </div>
            <div className={styles.btnRow}>
              <button type="button" className={`${styles.headBtn} ${styles.headBtnPrimary}`} data-part="invite-send-email" disabled>
                {t("teamAdmin.invite.sendEmail")}
              </button>
              <button type="button" className={styles.headBtn} data-part="invite-copy-link" disabled>
                {t("teamAdmin.invite.copyLink")}
              </button>
              <button type="button" className={styles.headBtn} data-part="invite-back" onClick={onClose}>
                {t("teamAdmin.invite.back")}
              </button>
            </div>
          </>
        ) : link ? (
          <div className={styles.stackCol} data-part="invite-copied">
            <div className={styles.linkRow}>
              <div className={styles.linkBox} data-part="invite-url">
                {link}
              </div>
              <button type="button" className={styles.headBtn} data-part="invite-copy" data-copied={copied ? "true" : "false"} onClick={() => void copy()}>
                {copied ? t("teamAdmin.invite.copied") : t("teamAdmin.invite.copy")}
              </button>
            </div>
            <p className={styles.hint}>{t("teamAdmin.invite.linkHint")}</p>
            <div className={styles.warnBox} data-part="invite-link-warn">
              {t("teamAdmin.invite.linkWarn")}
            </div>
            {error ? <div className={styles.errorBox}>{error}</div> : null}
            <button type="button" className={styles.headBtn} style={{ alignSelf: "flex-start" }} data-part="invite-done" onClick={onClose}>
              {t("teamAdmin.invite.done")}
            </button>
          </div>
        ) : (
          <>
            {error ? (
              <div className={styles.errorBox} data-part="invite-error" role="alert">
                {error}
                {offerLink ? ` ${t("teamAdmin.invite.emailUnavailable")}` : ""}
              </div>
            ) : null}
            <div className={styles.btnRow}>
              <button
                type="button"
                className={`${styles.headBtn} ${styles.headBtnPrimary}`}
                data-part="invite-send-email"
                disabled={busy || !filled}
                onClick={() => void submit("email")}
              >
                {t("teamAdmin.invite.sendEmail")}
              </button>
              <button type="button" className={styles.headBtn} data-part="invite-copy-link" disabled={busy || !filled} onClick={() => void submit("link")}>
                {t("teamAdmin.invite.copyLink")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TeamSettingsView({
  teamName,
  slug,
  myRole,
  busy,
  onBack,
  onRename,
  onDelete,
}: {
  teamName: string;
  slug: string;
  myRole: TeamRole | null;
  busy: boolean;
  onBack: () => void;
  onRename: (name: string) => void;
  onDelete: (slugConfirm: string) => void;
}) {
  const [name, setName] = useState(teamName);
  const [confirm, setConfirm] = useState("");
  // A rename from elsewhere (or the saved value) keeps the field in step.
  useEffect(() => setName(teamName), [teamName]);
  const mayRename = canRenameTeam(myRole);
  const mayDelete = canDeleteTeam(myRole);
  const dirty = name.trim() !== "" && name.trim() !== teamName;
  return (
    <div className={styles.stackCol} style={{ gap: "var(--v2-s11)" }} data-part="team-settings">
      <div className={styles.settingsHead}>
        <button type="button" className={styles.backLinkText} data-part="settings-back" onClick={onBack}>
          {t("teamAdmin.settings.back")}
        </button>
        <h1 className={styles.title} data-part="settings-title">
          {t("teamAdmin.settings.title")}
        </h1>
        <div className={styles.subtitle}>{t("teamAdmin.settings.sub", { name: teamName })}</div>
      </div>

      <section className={styles.settingsCard} data-part="settings-rename" aria-labelledby="set-name-t">
        <h2 id="set-name-t" className={styles.cardTitle} style={{ flex: "none" }}>
          {t("teamAdmin.settings.nameTitle")}
        </h2>
        <div>
          <label className={styles.label} htmlFor="set-rename">
            {t("teamAdmin.settings.nameLabel")}
          </label>
          <input
            id="set-rename"
            className={styles.field}
            data-part="rename-input"
            value={name}
            maxLength={80}
            disabled={!mayRename || busy}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className={styles.hint}>
          <Rich template={t("teamAdmin.settings.slugHint", { slug: "{slug}" })} slots={{ slug: { text: slug, className: styles.mono } }} />
        </div>
        {!mayRename ? <div className={styles.hint}>{t("teamAdmin.settings.renameForbidden")}</div> : null}
        <div>
          <button
            type="button"
            className={`${styles.headBtn} ${styles.headBtnPrimary}`}
            data-part="rename-save"
            disabled={!mayRename || busy || name.trim() === ""}
            onClick={() => (dirty ? onRename(name.trim()) : undefined)}
          >
            {t("teamAdmin.settings.save")}
          </button>
        </div>
      </section>

      <section className={`${styles.settingsCard} ${styles.settingsDanger}`} data-part="settings-danger" aria-labelledby="set-danger-t">
        <h2 id="set-danger-t" className={styles.dangerTitle}>
          {t("teamAdmin.settings.dangerTitle")}
        </h2>
        <p className={`${styles.hint} ${styles.dangerText}`}>{t("teamAdmin.settings.dangerText")}</p>
        {mayDelete ? (
          <>
            <div>
              <label className={`${styles.label} ${styles.dangerText}`} htmlFor="set-del-slug">
                <Rich
                  template={t("teamAdmin.settings.deleteLabel", { slug: "{slug}" })}
                  slots={{ slug: { text: slug, className: styles.mono } }}
                />
              </label>
              <input
                id="set-del-slug"
                className={`${styles.field} ${styles.fieldDanger}`}
                data-part="delete-slug"
                placeholder={slug}
                autoComplete="off"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <div>
              <button
                type="button"
                className={`${styles.headBtn} ${styles.headBtnDanger}`}
                data-part="delete-team"
                disabled={busy || !slugMatches(confirm, slug)}
                onClick={() => onDelete(confirm.trim())}
              >
                {t("teamAdmin.settings.delete")}
              </button>
            </div>
          </>
        ) : (
          <div className={styles.hint}>{t("teamAdmin.settings.deleteForbidden")}</div>
        )}
      </section>
    </div>
  );
}

function TeamAdminView({
  stats,
  members,
  seats,
  accountId,
  tasks,
  invites,
  myRole,
  busy,
  auditOnly,
  membersOnly,
  onChangeRole,
  onRemove,
  onLeave,
  onRevoke,
}: {
  stats: ReturnType<typeof boardStats>;
  members: TeamMemberInfo[];
  seats: SeatsView;
  accountId: string | null;
  tasks: TeamTaskInfo[];
  invites: TeamInviteInfo[];
  myRole: TeamRole | null;
  busy: boolean;
  auditOnly: boolean;
  membersOnly: boolean;
  onChangeRole: (member: TeamMemberInfo, role: TeamRole) => void;
  onRemove: (member: TeamMemberInfo) => void;
  onLeave: () => void;
  onRevoke: (id: string) => void;
}) {
  const activity = [...tasks].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "")).slice(0, 4);
  const now = Date.now();
  const soleOwner = myRole === "owner" && ownerCount(members) <= 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--v2-s11)" }}>
      {!auditOnly && seats.kind === "full" ? (
        <div className={styles.warnBox} data-part="seats-full-banner" role="status">
          {t("teamAdmin.seats.fullBanner", { total: seats.total })}
        </div>
      ) : null}

      {!auditOnly && !membersOnly ? (
        <div className={styles.stats3} data-part="team-stats">
          <Stat
            label={t("teamTask.stat.members")}
            value={String(members.length)}
            hint={invites.length === 1 ? t("teamTask.stat.invitePending", { n: "1" }) : t("teamAdmin.stat.invitesPending", { n: String(invites.length) })}
            part="members"
          />
          <Stat
            label={t("teamAdmin.stat.seats")}
            value={seats.kind === "unlimited" ? t("teamAdmin.stat.seatsNone") : t("teamAdmin.stat.seatsValue", { used: seats.used, total: seats.total })}
            hint={seats.kind === "unlimited" ? t("teamAdmin.stat.seatsNoneHint") : t("teamAdmin.stat.seatsHint")}
            part="seats"
          />
          <Stat label={t("teamTask.stat.open")} value={String(stats.open)} hint={t("teamTask.stat.noOwnerCount", { n: String(stats.unassigned) })} part="open" />
        </div>
      ) : null}

      {!auditOnly ? (
        <section className={styles.membersCard} aria-labelledby="team-members" data-part="members-card">
          <div className={styles.sectionHead}>
            <h2 id="team-members" className={styles.cardTitle}>
              {t("teamTask.members.title")}
            </h2>
            <span className={styles.hint}>{t("teamTask.members.keepOwner")}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.mTable} data-part="members-table">
              <thead>
                <tr>
                  <th>{t("teamTask.th.person")}</th>
                  <th>{t("teamTask.th.role")}</th>
                  <th>{t("teamTask.th.tasks")}</th>
                  <th>
                    <span className={styles.srOnly}>{t("teamAdmin.th.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const row = memberRowState({ members, member: m, accountId, myRole });
                  const isSelf = m.accountId === accountId;
                  const name = memberDisplayName(members, m.accountId);
                  const roleTitle =
                    row.roleLock === "last-owner" ? t("teamAdmin.member.lastOwnerRole") : row.roleLock === "permission" ? t("teamAdmin.member.noPermission") : undefined;
                  return (
                    <tr key={m.accountId} data-part="member-row" data-member={m.accountId}>
                      <td>
                        <span className={styles.person}>
                          <Avatar members={members} accountId={m.accountId} />
                          <span className={styles.personText}>
                            <span>{name}</span>
                            <span className={styles.personMeta}>
                              {isSelf ? t("teamAdmin.member.you", { email: m.email ?? m.accountId }) : m.email ?? m.accountId}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <select
                          className={styles.roleSelect}
                          data-part="member-role"
                          aria-label={t("teamAdmin.member.roleAria", { name })}
                          title={roleTitle}
                          value={m.role}
                          disabled={busy || !row.canChangeRole}
                          onChange={(e) => onChangeRole(m, e.target.value as TeamRole)}
                        >
                          {(row.roleOptions.length > 0 ? row.roleOptions : [m.role]).map((r) => (
                            <option key={r} value={r}>
                              {t(r === "owner" ? "teamAdmin.role.owner" : r === "admin" ? "teamAdmin.role.admin" : "teamAdmin.role.member")}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{tasks.filter((task) => task.assigneeId === m.accountId).length}</td>
                      <td>
                        <span className={styles.rowActions}>
                          {row.action === "leave" ? (
                            <button
                              type="button"
                              className={`${styles.headBtn} ${styles.rowBtn}`}
                              data-part="member-leave"
                              disabled={busy || row.actionLock !== null}
                              title={row.actionLock === "last-owner" ? t("teamAdmin.member.leaveBlocked") : undefined}
                              onClick={onLeave}
                            >
                              {t("teamAdmin.member.leave")}
                            </button>
                          ) : null}
                          {row.action === "remove" ? (
                            <button
                              type="button"
                              className={`${styles.headBtn} ${styles.rowBtn} ${styles.rowBtnDanger}`}
                              data-part="member-remove"
                              disabled={busy || row.actionLock !== null}
                              onClick={() => onRemove(m)}
                            >
                              {t("team.remove")}
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {invites.map((inv) => {
                  const days = inviteDaysLeft(inv, now);
                  const meta =
                    days === null
                      ? t("teamTask.invitePendingLabel")
                      : days === 0
                        ? t("teamAdmin.invite.expiresToday")
                        : days === 1
                          ? t("teamAdmin.invite.expiresOne")
                          : t("teamAdmin.invite.expires", { n: days });
                  return (
                    <tr key={inv.id} data-part="pending-row">
                      <td>
                        <span className={styles.person}>
                          <span className={styles.pendingAvatar}>@</span>
                          <span className={styles.personText}>
                            <span>{inv.target}</span>
                            <span className={styles.pendingMeta}>{meta}</span>
                          </span>
                        </span>
                      </td>
                      <td className={styles.pendingRole}>{t(inv.role === "owner" ? "teamAdmin.role.owner" : inv.role === "admin" ? "teamAdmin.role.admin" : "teamAdmin.role.member")}</td>
                      <td className={styles.dashCell}>—</td>
                      <td>
                        <button type="button" className={`${styles.headBtn} ${styles.rowBtn}`} data-part="invite-revoke" disabled={busy} onClick={() => onRevoke(inv.id)}>
                          {t("team.revoke")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {soleOwner ? (
            <div className={`${styles.hint} ${styles.footHint}`} data-part="last-owner-hint">
              {t("teamAdmin.lastOwnerHint")}
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>{t("teamAdmin.audit.matrixTitle")}</h2>
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
          </div>
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
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, warn, part }: { label: string; value: string; hint: string; warn?: boolean; part?: string }) {
  return (
    <div className={`${styles.stat}${warn ? ` ${styles.statWarn}` : ""}`} data-part={part ? `stat-${part}` : undefined}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statBig}${warn ? ` ${styles.statValueWarn}` : ""}`}>{value}</span>
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
  sprints,
  shareFilePaths,
  onCreateSubtasks,
  onPatchSharePaths,
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
  onSendComment: (mentions?: string[]) => void;
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
  sprints: TeamSprintInfo[];
  shareFilePaths: boolean;
  onCreateSubtasks: (task: TeamTaskInfo, subtasks: Array<{ title: string; kind: string; priority?: string }>) => void;
  onPatchSharePaths: (enabled: boolean) => void;
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
        <h1 className={styles.boardTitle}>{t("teamAdmin.boardTitle")}</h1>
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
              sprints={sprints}
              sprintName={sprintName}
              isAdmin={isAdmin}
              busy={busy}
              comment={comment}
              shareFilePaths={shareFilePaths}
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
              onAssign={(body) => onAssign(selected, body)}
              onUpdateFields={(body) => onUpdateFields(selected, body)}
              onCreateSubtasks={(subtasks) => onCreateSubtasks(selected, subtasks)}
              onPatchSharePaths={onPatchSharePaths}
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
type ActionMode = null | "reassign" | "reviewer" | "sprint" | "subtasks";

function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.includes(" ") || query.includes("\n")) return null;
  return { start: at, query };
}

function TaskInsight({
  task,
  detail,
  members,
  sprints,
  sprintName,
  isAdmin,
  busy,
  comment,
  shareFilePaths,
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
  onAssign,
  onUpdateFields,
  onCreateSubtasks,
  onPatchSharePaths,
}: {
  task: TeamTaskInfo;
  detail: TeamTaskDetailInfo | null;
  members: TeamMemberInfo[];
  sprints: TeamSprintInfo[];
  sprintName: string;
  isAdmin: boolean;
  busy: boolean;
  comment: string;
  shareFilePaths: boolean;
  onComment: (v: string) => void;
  onSend: (mentions?: string[]) => void;
  onClose: () => void;
  onBack?: () => void;
  onEdit?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCopyLink?: () => void;
  onPause?: () => void;
  onAssign: (body: { assignee_id?: string; session_label?: string; unassign?: boolean }) => void;
  onUpdateFields: (body: Record<string, unknown>) => void;
  onCreateSubtasks: (subtasks: Array<{ title: string; kind: string; priority?: string }>) => void;
  onPatchSharePaths: (enabled: boolean) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("activity");
  const [menu, setMenu] = useState(false);
  const [action, setAction] = useState<ActionMode>(null);
  const [pickMember, setPickMember] = useState("");
  const [pickSprint, setPickSprint] = useState(task.sprintId ?? "");
  const [subtaskText, setSubtaskText] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const deps = detail?.deps ?? [];
  const dependents = detail?.dependents ?? [];
  const changes = detail?.changes;
  const reports = detail?.reports ?? [];
  const gateCmd = (g: TeamTaskInfo["gates"][number]) => (typeof g === "string" ? g : g.cmd);
  const gateExclusive = (g: TeamTaskInfo["gates"][number]) => (typeof g === "string" ? false : g.exclusive !== undefined);
  const reviewers = members.filter((m) => canReviewRole(m.role));
  const mentionHit = mentionQueryAt(comment, caret);
  const mentionMatches = mentionHit
    ? members.filter((m) => {
        const name = memberDisplayName(members, m.accountId).toLowerCase();
        const q = mentionHit.query.toLowerCase();
        return name.includes(q) || m.avatarInitials.toLowerCase().includes(q);
      }).slice(0, 8)
    : [];

  const tabs: { id: DetailTab; key: MessageKey }[] = [
    { id: "activity", key: "teamTask.detail.tab.activity" },
    { id: "contract", key: "teamTask.detail.tab.contract" },
    { id: "gates", key: "teamTask.detail.tab.gates" },
    { id: "diff", key: "teamTask.detail.tab.diff" },
    { id: "reports", key: "teamTask.detail.tab.reports" },
  ];

  function openAction(mode: ActionMode) {
    setMenu(false);
    setAction(mode);
    setPickMember(mode === "reviewer" ? (task.reviewerId ?? "") : (task.assigneeId ?? ""));
    setPickSprint(task.sprintId ?? "");
    setSubtaskText("");
  }

  function applyMention(member: TeamMemberInfo) {
    if (!mentionHit) return;
    const label = memberDisplayName(members, member.accountId);
    const next = `${comment.slice(0, mentionHit.start)}@${label} ${comment.slice(caret)}`;
    onComment(next);
    setMentionIds((ids) => (ids.includes(member.accountId) ? ids : [...ids, member.accountId]));
    setCaret(mentionHit.start + label.length + 2);
    setMentionIdx(0);
  }

  function submitComment() {
    onSend(mentionIds);
    setMentionIds([]);
  }

  const depFoot =
    deps.length > 0 || dependents.length > 0
      ? [
          deps.length > 0 ? t("teamTask.detail.deps", { deps: deps.map((d) => `#${d.shortId}`).join(", ") }) : "",
          dependents.length > 0 ? t("teamTask.detail.blocks", { deps: dependents.map((d) => `#${d.shortId}`).join(", ") }) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : t("teamTask.detail.noDeps");

  const allInTerritory = changes ? changes.files.length > 0 && changes.files.every((f) => f.inTerritory) : false;
  const pathsHidden = Boolean(changes && changes.totalFiles > 0 && changes.files.length === 0 && !shareFilePaths);

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
                <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openAction("reassign")}>
                  {t("teamTask.detail.action.reassign")}
                </button>
                <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openAction("reviewer")}>
                  {t("teamTask.detail.action.changeReviewer")}
                </button>
                <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openAction("sprint")}>
                  {t("teamTask.detail.action.moveSprint")}
                </button>
                {onDuplicate ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onDuplicate(); }}>
                    {t("teamTask.detail.action.duplicate")}
                  </button>
                ) : null}
                <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openAction("subtasks")}>
                  {t("teamTask.detail.action.splitSubtasks")}
                </button>
                {onCopyLink ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onCopyLink(); }}>
                    {t("teamTask.detail.action.copyLink")}
                  </button>
                ) : null}
                <div className={styles.menuSep} />
                {onPause ? (
                  <button type="button" className={styles.menuItem} role="menuitem" onClick={() => { setMenu(false); onPause(); }}>
                    {t("teamTask.detail.action.pause")}
                  </button>
                ) : null}
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

      {action ? (
        <div className={styles.actionPanel}>
          {action === "reassign" || action === "reviewer" ? (
            <>
              <select className={styles.select} value={pickMember} onChange={(e) => setPickMember(e.target.value)} style={{ width: "100%" }}>
                <option value="">{action === "reviewer" ? t("teamTask.distribute.reviewerNone") : t("teamTask.board.idle")}</option>
                {(action === "reviewer" ? reviewers : members).map((m) => (
                  <option key={m.accountId} value={m.accountId}>
                    {memberDisplayName(members, m.accountId)}
                  </option>
                ))}
              </select>
              <div className={styles.rowEnd}>
                <button type="button" className={styles.btn} onClick={() => setAction(null)}>{t("teamTask.detail.close")}</button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy}
                  onClick={() => {
                    if (action === "reassign") {
                      if (pickMember) onAssign({ assignee_id: pickMember });
                      else onAssign({ unassign: true });
                    } else {
                      onUpdateFields({ reviewer_id: pickMember || null });
                    }
                    setAction(null);
                  }}
                >
                  {t("teamTask.detail.actionApply")}
                </button>
              </div>
            </>
          ) : null}
          {action === "sprint" ? (
            <>
              <select className={styles.select} value={pickSprint} onChange={(e) => setPickSprint(e.target.value)} style={{ width: "100%" }}>
                <option value="">{t("teamTask.detail.sprintNone")}</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <div className={styles.rowEnd}>
                <button type="button" className={styles.btn} onClick={() => setAction(null)}>{t("teamTask.detail.close")}</button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy}
                  onClick={() => {
                    onUpdateFields({ sprint_id: pickSprint || null });
                    setAction(null);
                  }}
                >
                  {t("teamTask.detail.actionApply")}
                </button>
              </div>
            </>
          ) : null}
          {action === "subtasks" ? (
            <>
              <div className={styles.fieldLabel}>{t("teamTask.detail.subtasksLabel")}</div>
              <textarea className={styles.commentArea} value={subtaskText} onChange={(e) => setSubtaskText(e.target.value)} />
              <div className={styles.rowEnd}>
                <button type="button" className={styles.btn} onClick={() => setAction(null)}>{t("teamTask.detail.close")}</button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || subtaskText.trim() === ""}
                  onClick={() => {
                    const lines = subtaskText
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean);
                    if (lines.length === 0) return;
                    onCreateSubtasks(lines.map((title) => ({ title, kind: task.kind, priority: task.priority })));
                    setAction(null);
                  }}
                >
                  {t("teamTask.detail.subtasksSubmit")}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

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
              <div className={styles.commentWrap}>
                {mentionMatches.length > 0 ? (
                  <div className={styles.mentionMenu} role="listbox">
                    {mentionMatches.map((m, i) => (
                      <button
                        key={m.accountId}
                        type="button"
                        role="option"
                        aria-selected={i === mentionIdx}
                        className={`${styles.mentionItem}${i === mentionIdx ? ` ${styles.mentionItemOn}` : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyMention(m);
                        }}
                      >
                        @{memberDisplayName(members, m.accountId)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  className={styles.commentArea}
                  placeholder={t("teamTask.detail.commentPlaceholder")}
                  value={comment}
                  onChange={(e) => {
                    onComment(e.target.value);
                    setCaret(e.target.selectionStart);
                  }}
                  onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                  onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                  onKeyDown={(e) => {
                    if (mentionMatches.length === 0) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIdx((i) => (i + 1) % mentionMatches.length);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const m = mentionMatches[mentionIdx];
                      if (m) applyMention(m);
                    } else if (e.key === "Escape") {
                      setCaret(0);
                    }
                  }}
                />
              </div>
              <div className={styles.rowEnd}>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || comment.trim() === ""} onClick={submitComment}>
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
          <div className={styles.diffTab}>
            {isAdmin ? (
              <label className={styles.sharePathsRow} data-part="share-file-paths">
                <input
                  className={styles.switch}
                  type="checkbox"
                  checked={shareFilePaths}
                  disabled={busy}
                  aria-label={t("teamTask.detail.sharePaths")}
                  onChange={(e) => onPatchSharePaths(e.target.checked)}
                />
                <span className={styles.sharePathsText}>
                  <span>{t("teamTask.detail.sharePaths")}</span>
                  <span className={styles.sharePathsHint} data-part="share-file-paths-hint">
                    {t("teamTask.detail.sharePathsHint")}
                  </span>
                </span>
              </label>
            ) : null}
            {!changes || (changes.totalFiles === 0 && changes.files.length === 0) ? (
              <div className={styles.placeholder}>
                {t("teamTask.detail.diffHint")} · {t("teamTask.detail.diffEmpty")}
              </div>
            ) : (
              <div className={styles.diffList}>
                <div className={styles.diffSummary}>
                  {t("teamTask.detail.diffHint")} ·{" "}
                  {t("teamTask.detail.diffSummary", {
                    n: String(changes.totalFiles),
                    extra: allInTerritory ? t("teamTask.detail.diffInTerritory") : "",
                  })}
                  {` · +${changes.additions} / −${changes.deletions}`}
                </div>
                {pathsHidden ? <div className={styles.placeholder}>{t("teamTask.detail.diffPathsHidden")}</div> : null}
                {changes.files.map((f) => (
                  <div key={`${f.status}:${f.path}`} className={styles.diffFile} data-part="diff-file" data-status={f.status}>
                    <span>
                      {f.status} {f.path || "—"}
                    </span>
                    <span>
                      {f.additions > 0 ? <span className={styles.diffAdd}>+{f.additions}</span> : null}{" "}
                      {f.deletions > 0 ? <span className={styles.diffDel}>-{f.deletions}</span> : null}
                    </span>
                  </div>
                ))}
                {changes.truncated ? (
                  <div className={styles.diffSummary}>
                    {t("teamTask.detail.diffTruncated", { total: String(changes.totalFiles) })}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {tab === "reports" ? (
          reports.length === 0 ? (
            <div className={styles.placeholder}>{t("teamTask.detail.reportsEmpty")}</div>
          ) : (
            <div className={styles.diffList} style={{ fontFamily: "inherit" }}>
              {reports.map((r) => (
                <div key={r.id} className={styles.reportCard}>
                  <div className={styles.reportHead}>
                    <span>
                      {t("teamTask.detail.reportRound", {
                        n: String(r.round),
                        role: t(r.role === "reviewer" ? "teamTask.detail.reportRole.reviewer" : "teamTask.detail.reportRole.implementer"),
                      })}
                    </span>
                    <span className={styles.headerSpacer} />
                    {r.gatesTotal !== null ? (
                      <span>{t("teamTask.detail.reportGates", { passed: String(r.gatesPassed ?? 0), total: String(r.gatesTotal) })}</span>
                    ) : null}
                    {r.verdict ? (
                      <span>
                        {t(r.verdict === "aprovado" ? "teamTask.detail.reportVerdict.aprovado" : "teamTask.detail.reportVerdict.reprovado")}
                      </span>
                    ) : null}
                    <span>{ageLabel(r.createdAt)}</span>
                  </div>
                  {r.summary.decisao ? (
                    <>
                      <div className={styles.reportLabel}>{t("teamTask.detail.reportDecisao")}</div>
                      <div>{r.summary.decisao}</div>
                    </>
                  ) : null}
                  {r.summary.evidencia ? (
                    <>
                      <div className={styles.reportLabel}>{t("teamTask.detail.reportEvidencia")}</div>
                      <div>{r.summary.evidencia}</div>
                    </>
                  ) : null}
                  {r.summary.oQueNaoFez ? (
                    <>
                      <div className={styles.reportLabel}>{t("teamTask.detail.reportOQueNaoFez")}</div>
                      <div>{r.summary.oQueNaoFez}</div>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>

      <div className={styles.detailFoot}>
        <span className={styles.muted}>{depFoot}</span>
        <span className={styles.headerSpacer} />
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled>
          {t("teamTask.detail.approve")}
        </button>
      </div>
    </div>
  );
}
