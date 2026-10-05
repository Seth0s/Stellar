import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type {
  TeamDetailInfo,
  TeamInviteInfo,
  TeamMemberInfo,
  TeamOverviewInfo,
  TeamRole,
  WorkHomeConflictChoice,
  WorkHomePlanInfo,
} from "../../preload/index";
import styles from "./TeamPanel.module.css";

/**
 * Teams on the Home screen. MINIMAL, functional UI: what matters here is the
 * LOGIC and the IPC (create/manage a team, accept an invite through
 * `stellar://invite`, publish/pull the team base). Visual polish ships on its
 * own tasks.
 *
 * Absence is stated: without a login the panel says so; an insufficient role
 * disables the action and says why (the server remains the authority).
 */

const ROLE_RANK: Record<TeamRole, number> = { owner: 3, admin: 2, member: 1 };
const ACCEPT_REASON_KEYS: Record<string, MessageKey> = {
  "identity-mismatch": "team.accept.identity-mismatch",
  expired: "team.accept.expired",
  used: "team.accept.used",
  revoked: "team.accept.revoked",
  "not-found": "team.accept.not-found",
  "already-member": "team.accept.already-member",
  error: "team.accept.error",
};

function roleLabel(role: TeamRole): string {
  return t(role === "owner" ? "team.role.owner" : role === "admin" ? "team.role.admin" : "team.role.member");
}

function actionLabel(action: string): string {
  const keys: Record<string, MessageKey> = {
    add: "workhome.action.add",
    update: "workhome.action.update",
    unchanged: "workhome.action.unchanged",
    "keep-local": "workhome.action.keep-local",
    conflict: "workhome.action.conflict",
    pending: "workhome.action.pending",
    remove: "workhome.action.remove",
  };
  return t(keys[action] ?? "workhome.action.unchanged");
}

type PendingInvite = { token: string };

export function TeamPanel({ inline = false }: { inline?: boolean } = {}) {
  const [overview, setOverview] = useState<TeamOverviewInfo | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetailInfo | null>(null);
  const [open, setOpen] = useState(inline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [inviteTarget, setInviteTarget] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [invites, setInvites] = useState<TeamInviteInfo[]>([]);
  const [publishPreview, setPublishPreview] = useState<{ entries: { path: string }[]; dropped: string[] } | null>(null);
  const [pullPlan, setPullPlan] = useState<{ plan: WorkHomePlanInfo; slug: string; revision: number } | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.team.overview();
      if (res.ok) {
        setOverview(res.view);
        setOverviewError(null);
      } else {
        setOverview(null);
        setOverviewError(res.error);
      }
    } catch {
      setOverview(null);
      setOverviewError(t("team.error.generic"));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void window.team.pendingInvite().then((r) => {
      if (r.token) setPendingInvite({ token: r.token });
    });
    return window.team.onInvite((payload) => setPendingInvite({ token: payload.token }));
  }, [refresh]);

  const loadDetail = useCallback(async (teamId: string) => {
    setDetail(null);
    setInvites([]);
    setPublishPreview(null);
    setPullPlan(null);
    try {
      const res = await window.team.detail(teamId);
      if (res.ok) setDetail(res.detail);
      else setError(res.error);
    } catch {
      setError(t("team.error.generic"));
    }
  }, []);

  useEffect(() => {
    if (!open || inline) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, inline]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch {
      setError(t("team.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const teams = overview?.teams ?? [];
  const accountId = overview?.accountId ?? null;
  const myRole: TeamRole | null = detail && accountId ? detail.members.find((m) => m.accountId === accountId)?.role ?? null : null;
  const canManage = myRole !== null && ROLE_RANK[myRole] >= ROLE_RANK.admin;

  async function handleCreate() {
    await run(async () => {
      const res = await window.team.create({ name: name.trim(), slug: slug.trim() || undefined });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setName("");
      setSlug("");
      setNote(t("team.profileCreated", { name: res.value.profile.name }));
      await refresh();
      setSelected(res.value.team.id);
    });
  }

  async function handleInvite() {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.invite(selected, { target: inviteTarget.trim(), role: inviteRole });
      if (!res.ok) {
        setError(res.reason === "forbidden" ? t("team.onlyAdmin") : res.error);
        return;
      }
      setInvites((prev) => [...prev, res.invite]);
      setInviteTarget("");
      setNote(t("team.invited", { target: res.invite.target }));
    });
  }

  async function handleRevoke(inviteId: string) {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.revokeInvite(selected, inviteId);
      if (!res.ok) {
        setError(res.error ?? t("team.error.generic"));
        return;
      }
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    });
  }

  async function handleChangeRole(member: TeamMemberInfo, role: TeamRole) {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.changeRole(selected, member.accountId, role);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await loadDetail(selected);
    });
  }

  async function handleRemove(member: TeamMemberInfo) {
    if (!selected) return;
    const label = member.accountId === accountId ? t("team.you") : member.accountId.slice(0, 8);
    if (!window.confirm(t("team.removeConfirm", { who: label }))) return;
    await run(async () => {
      const res = member.accountId === accountId ? await window.team.leave(selected) : await window.team.removeMember(selected, member.accountId);
      if (!res.ok) {
        setError(res.error ?? t("team.error.generic"));
        return;
      }
      await loadDetail(selected);
    });
  }

  async function handlePublishPreview() {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.publishPreview(selected);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPublishPreview(res.preview);
    });
  }

  async function handlePublish() {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.publish(selected);
      if (!res.ok) {
        setError(res.conflict ? `${t("team.error.generic")} (revisão ${res.currentRevision})` : res.error);
        return;
      }
      setPublishPreview(null);
      setNote(
        `${t("team.published", { revision: String(res.revision), n: String(res.count) })}${
          res.dropped.length > 0 ? ` · ${t("team.dropped", { n: String(res.dropped.length) })}` : ""
        }`,
      );
    });
  }

  async function handlePullPreview() {
    if (!selected) return;
    await run(async () => {
      const res = await window.team.pullPreview(selected);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPullPlan({ plan: res.value.plan, slug: res.value.slug, revision: res.value.revision });
    });
  }

  async function handlePullApply() {
    if (!selected) return;
    await run(async () => {
      const choices: Record<string, WorkHomeConflictChoice> = {};
      const res = await window.team.pullApply(selected, choices);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPullPlan(null);
      setNote(t("team.applied", { n: String(res.result.written.length) }));
    });
  }

  async function handleAcceptInvite() {
    if (!pendingInvite) return;
    await run(async () => {
      const res = await window.team.acceptInvite(pendingInvite.token);
      if (!res.ok) {
        setError(t(ACCEPT_REASON_KEYS[res.reason] ?? "team.accept.error"));
        return;
      }
      setPendingInvite(null);
      setNote(t("team.accepted", { name: res.value.team.name }));
      await refresh();
      setSelected(res.value.team.id);
    });
  }

  const triggerLabel = t("team.title");
  const loggedIn = overview !== null;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {!inline && (
        <button type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {triggerLabel}
          {pendingInvite ? <span className={styles.dot} aria-hidden="true" /> : null}
          <span aria-hidden="true">▾</span>
        </button>
      )}

      {open && (
        <div className={styles.panel} role="dialog" aria-label={t("team.title")}>
          {!loggedIn ? (
            <div className={styles.muted}>{overviewError ?? t("team.notLoggedIn")}</div>
          ) : (
            <>
              {pendingInvite && (
                <div className={styles.inviteBanner}>
                  <div>{t("team.inviteBanner")}</div>
                  <div className={styles.row}>
                    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void handleAcceptInvite()}>
                      {t("team.accept")}
                    </button>
                    <button type="button" className={styles.btn} disabled={busy} onClick={() => setPendingInvite(null)}>
                      {t("team.dismiss")}
                    </button>
                  </div>
                </div>
              )}

              <div className={styles.section}>
                <div className={styles.head}>{t("team.yourTeams")}</div>
                {teams.length === 0 ? (
                  <div className={styles.muted}>{t("team.none")}</div>
                ) : (
                  <ul className={styles.list}>
                    {teams.map((team) => (
                      <li key={team.id} className={styles.item}>
                        <button
                          type="button"
                          className={`${styles.teamBtn}${selected === team.id ? ` ${styles.teamBtnOn}` : ""}`}
                          onClick={() => {
                            setSelected(team.id);
                            void loadDetail(team.id);
                          }}
                        >
                          {team.name} <span className={styles.muted}>#{team.slug}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className={styles.section}>
                <div className={styles.head}>{t("team.createTitle")}</div>
                <div className={styles.row}>
                  <input className={styles.input} placeholder={t("team.name")} value={name} onChange={(e) => setName(e.target.value)} />
                  <input className={styles.input} placeholder={t("team.slug")} value={slug} onChange={(e) => setSlug(e.target.value)} />
                  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || name.trim() === ""} onClick={() => void handleCreate()}>
                    {t("team.create")}
                  </button>
                </div>
              </div>

              {detail && selected && (
                <>
                  <div className={styles.section}>
                    <div className={styles.head}>
                      {t("team.members")} {myRole ? <span className={styles.badge}>{t("team.you")}: {roleLabel(myRole)}</span> : null}
                    </div>
                    <ul className={styles.list}>
                      {detail.members.map((m) => {
                        const isSelf = m.accountId === accountId;
                        const canEdit = canManage && !isSelf && (myRole !== "admin" || ROLE_RANK[m.role] < ROLE_RANK.admin);
                        return (
                          <li key={m.accountId} className={styles.item}>
                            <span className={styles.path} title={m.accountId}>
                              {m.accountId.slice(0, 8)}
                              {isSelf ? ` (${t("team.you")})` : ""}
                            </span>
                            <span className={styles.badge}>{roleLabel(m.role)}</span>
                            {canEdit && (
                              <>
                                <select
                                  className={styles.select}
                                  value={m.role}
                                  disabled={busy}
                                  onChange={(e) => void handleChangeRole(m, e.target.value as TeamRole)}
                                >
                                  <option value="member">{roleLabel("member")}</option>
                                  <option value="admin">{roleLabel("admin")}</option>
                                  {myRole === "owner" && <option value="owner">{roleLabel("owner")}</option>}
                                </select>
                                <button type="button" className={styles.btn} disabled={busy} onClick={() => void handleRemove(m)}>
                                  {t("team.remove")}
                                </button>
                              </>
                            )}
                            {isSelf && (
                              <button type="button" className={styles.btn} disabled={busy} onClick={() => void handleRemove(m)}>
                                {t("team.leave")}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className={styles.section}>
                    <div className={styles.head}>{t("team.inviteTitle")}</div>
                    {canManage ? (
                      <div className={styles.row}>
                        <input
                          className={styles.input}
                          placeholder={t("team.inviteTarget")}
                          value={inviteTarget}
                          onChange={(e) => setInviteTarget(e.target.value)}
                        />
                        <select className={styles.select} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as TeamRole)}>
                          <option value="member">{roleLabel("member")}</option>
                          <option value="admin">{roleLabel("admin")}</option>
                          {myRole === "owner" && <option value="owner">{roleLabel("owner")}</option>}
                        </select>
                        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || inviteTarget.trim() === ""} onClick={() => void handleInvite()}>
                          {t("team.invite")}
                        </button>
                      </div>
                    ) : (
                      <div className={styles.muted}>{t("team.onlyAdmin")}</div>
                    )}
                    {invites.length > 0 && (
                      <ul className={styles.list}>
                        {invites.map((inv) => (
                          <li key={inv.id} className={styles.item}>
                            <span className={styles.path}>{inv.target}</span>
                            <span className={styles.badge}>{roleLabel(inv.role)}</span>
                            <button type="button" className={styles.btn} disabled={busy} onClick={() => void handleRevoke(inv.id)}>
                              {t("team.revoke")}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className={styles.section}>
                    <div className={styles.head}>{t("team.house")}</div>
                    <div className={styles.row}>
                      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !canManage} title={canManage ? undefined : t("team.onlyAdmin")} onClick={() => void handlePublish()}>
                        {t("team.publish")}
                      </button>
                      <button type="button" className={styles.btn} disabled={busy || !canManage} onClick={() => void handlePublishPreview()}>
                        {t("team.publishPreview")}
                      </button>
                      <button type="button" className={styles.btn} disabled={busy} onClick={() => void handlePullPreview()}>
                        {t("team.pullPreview")}
                      </button>
                      <button type="button" className={styles.btn} disabled={busy} onClick={() => void handlePullApply()}>
                        {t("team.pull")}
                      </button>
                    </div>
                    {!canManage && <div className={styles.muted}>{t("team.readOnly")}</div>}

                    {publishPreview && (
                      <ul className={styles.list}>
                        {publishPreview.entries.map((e) => (
                          <li key={e.path} className={styles.item}>
                            <span className={styles.tag}>{actionLabel("add")}</span>
                            <span className={styles.path}>{e.path}</span>
                          </li>
                        ))}
                        {publishPreview.dropped.length > 0 && (
                          <li className={styles.item}>
                            <span className={styles.muted}>{t("team.dropped", { n: String(publishPreview.dropped.length) })}</span>
                          </li>
                        )}
                      </ul>
                    )}

                    {pullPlan && (
                      <ul className={styles.list}>
                        <li className={styles.item}>
                          <span className={styles.muted}>{t("team.prefix", { prefix: `team-${pullPlan.slug}-` })}</span>
                        </li>
                        {pullPlan.plan.items.map((i) => (
                          <li key={i.path} className={styles.item}>
                            <span className={`${styles.tag}`}>{actionLabel(i.action)}</span>
                            <span className={styles.path} title={i.targetPath ?? i.path}>
                              {i.path}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              {note ? <div className={styles.note}>{note}</div> : null}
              {error ? <div className={styles.error}>{error}</div> : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
