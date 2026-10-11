/**
 * Screen 19 — team integrations. Owner/admin connect; members read-only.
 * Follows docs/design/app-v2/prototipo/Integrations.dc.html.
 * Slack/GitHub switches map to B9c config keys (exact names on PATCH).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamIntegrationInfo, TeamMemberInfo, TeamRole, TeamWebhookInfo } from "../../preload/index";
import { t } from "../../shared/i18n";
import {
  canManageIntegrations,
  findByKind,
  githubDetail,
  isConnected,
  nextNotifyPatch,
  reactionEnabled,
  resolveGithubConfig,
  resolveSlackConfig,
  slackDetail,
  webhookActiveCount,
} from "./integration-decisions";
import styles from "./IntegrationsPage.module.css";

export type IntegrationsPageProps = {
  teamId: string;
  teamName: string;
  role: TeamRole | null;
  members: TeamMemberInfo[];
  onBack: () => void;
};

export function IntegrationsPage({ teamId, teamName, role, members, onBack }: IntegrationsPageProps) {
  const canManage = canManageIntegrations(role);
  const [integrations, setIntegrations] = useState<TeamIntegrationInfo[]>([]);
  const [webhooks, setWebhooks] = useState<TeamWebhookInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectKind, setConnectKind] = useState<"github" | "linear" | "jira" | null>(null);
  const [connectForm, setConnectForm] = useState({ repo: "Seth0s/demo", label: "stellar", projectId: "", baseUrl: "", email: "", jql: "", token: "" });
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [webhookForm, setWebhookForm] = useState({ url: "", secret: "", events: "task.updated" });

  const load = useCallback(async () => {
    const [integ, wh] = await Promise.all([window.team.listIntegrations(teamId), window.team.listWebhooks(teamId)]);
    if (integ.ok) setIntegrations(integ.integrations);
    if (wh.ok) setWebhooks(wh.webhooks);
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return window.team.onIntegrationOAuth((payload) => {
      if (payload.status === "connected") void load();
      else setError(t("teamIntegrations.oauthError"));
    });
  }, [load]);

  const slack = findByKind(integrations, "slack");
  const github = findByKind(integrations, "github");
  const linear = findByKind(integrations, "linear");
  const jira = findByKind(integrations, "jira");

  const slackCfg = resolveSlackConfig(slack?.config ?? {});
  const githubCfg = resolveGithubConfig(github?.config ?? {});

  const slackByName = useMemo(() => {
    if (!slack?.connectedBy) return null;
    const m = members.find((x) => x.accountId === slack.connectedBy);
    return m?.displayName ?? null;
  }, [slack, members]);

  const patchSlack = async (patch: Record<string, unknown>) => {
    if (!canManage || !isConnected(slack)) return;
    setBusy(true);
    setError(null);
    const res = await window.team.updateIntegration(teamId, "slack", { config: patch });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else await load();
  };

  const patchGithub = async (patch: Record<string, unknown>) => {
    if (!canManage || !isConnected(github)) return;
    setBusy(true);
    setError(null);
    const res = await window.team.updateIntegration(teamId, "github", { config: patch });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else await load();
  };

  const startOAuth = async (kind: string) => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    const res = await window.team.startIntegrationOAuth(teamId, kind);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  const disconnect = async (kind: string) => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    const res = await window.team.disconnectIntegration(teamId, kind);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else await load();
  };

  const submitConnect = async () => {
    if (!canManage || !connectKind) return;
    setBusy(true);
    setError(null);
    let body: { config: Record<string, unknown>; secrets: Record<string, string> };
    if (connectKind === "github") {
      body = {
        config: { repo: connectForm.repo, label: connectForm.label, link_pr: true, close_on_done: false },
        secrets: { access_token: connectForm.token, webhook_secret: "whsec" },
      };
    } else if (connectKind === "linear") {
      body = {
        config: { project_id: connectForm.projectId },
        secrets: { api_key: connectForm.token, webhook_secret: "whsec" },
      };
    } else {
      body = {
        config: { base_url: connectForm.baseUrl, email: connectForm.email, jql: connectForm.jql },
        secrets: { api_token: connectForm.token },
      };
    }
    const res = await window.team.connectIntegration(teamId, connectKind, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setConnectKind(null);
      await load();
    }
  };

  const exportBoard = async (format: "csv" | "json") => {
    setBusy(true);
    setError(null);
    const res = await window.team.exportBoard(teamId, format);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const blob = new Blob([res.body], { type: res.contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stellar-board.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const createWebhook = async () => {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    const res = await window.team.createWebhook(teamId, {
      url: webhookForm.url,
      secret: webhookForm.secret,
      events: webhookForm.events.split(",").map((e) => e.trim()).filter(Boolean),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setWebhookOpen(false);
      await load();
    }
  };

  const slackReady = canManage && isConnected(slack);
  const githubReady = canManage && isConnected(github);

  return (
    <div className={styles.page} data-part="integrations-page">
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <button type="button" className={styles.back} data-part="integrations-back" onClick={onBack}>
            ← {teamName}
          </button>
          <h1 className={styles.title}>{t("teamIntegrations.title")}</h1>
          <div className={styles.subtitle}>{t("teamIntegrations.subtitle")}</div>
          {!canManage ? <div className={styles.readonly}>{t("teamIntegrations.memberReadonly")}</div> : null}
          {error ? <div className={styles.error}>{error}</div> : null}
        </div>
      </div>

      <div className={styles.grid}>
        <section className={`${styles.card} ${styles.cardWide}`} aria-labelledby="sl" data-part="integ-slack">
          <div className={styles.cardHead}>
            <span className={`${styles.logo} ${styles.logoSlack}`}>S</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <h2 id="sl" className={styles.cardTitle}>
                Slack
              </h2>
              <span className={`${styles.cardStatus} ${isConnected(slack) ? styles.cardStatusOn : ""}`}>
                {slackDetail(slack, slackByName)}
              </span>
            </div>
            {isConnected(slack) && canManage ? (
              <button type="button" className={styles.ghost} data-part="slack-disconnect" disabled={busy} onClick={() => void disconnect("slack")}>
                {t("teamIntegrations.disconnect")}
              </button>
            ) : null}
            {!isConnected(slack) && canManage ? (
              <button type="button" className={styles.primary} data-part="slack-connect" disabled={busy} onClick={() => void startOAuth("slack")}>
                {t("teamIntegrations.connect")}
              </button>
            ) : null}
          </div>
          <div className={styles.cols}>
            <div className={styles.col}>
              <span className={styles.colLabel}>{t("teamIntegrations.slack.in")}</span>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-slash_command"
                  checked={slackCfg.slash_command}
                  disabled={!slackReady}
                  onChange={(e) => void patchSlack({ slash_command: e.target.checked })}
                />
                {t("teamIntegrations.slack.slash")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-reaction"
                  checked={reactionEnabled(slackCfg)}
                  disabled={!slackReady}
                  onChange={(e) => void patchSlack({ reaction: e.target.checked ? "ticket" : "" })}
                />
                {t("teamIntegrations.slack.reaction")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-mention_to_task"
                  checked={slackCfg.mention_to_task}
                  disabled={!slackReady}
                  onChange={(e) => void patchSlack({ mention_to_task: e.target.checked })}
                />
                {t("teamIntegrations.slack.mention")}
              </label>
              {isConnected(slack) ? (
                <span className={styles.desc} data-part="slack-mention-note">
                  {t("teamIntegrations.slack.mentionNote")}
                </span>
              ) : null}
            </div>
            <div className={styles.col}>
              <span className={styles.colLabel}>{t("teamIntegrations.slack.out")}</span>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-notify_review"
                  checked={slackCfg.notify_channel && slackCfg.notify_review}
                  disabled={!slackReady}
                  onChange={(e) =>
                    void patchSlack(nextNotifyPatch({ current: slackCfg, key: "notify_review", value: e.target.checked }))
                  }
                />
                {t("teamIntegrations.slack.notifyReview")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-notify_gate_failed"
                  checked={slackCfg.notify_channel && slackCfg.notify_gate_failed}
                  disabled={!slackReady}
                  onChange={(e) =>
                    void patchSlack(nextNotifyPatch({ current: slackCfg, key: "notify_gate_failed", value: e.target.checked }))
                  }
                />
                {t("teamIntegrations.slack.notifyGate")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-notify_done"
                  checked={slackCfg.notify_channel && slackCfg.notify_done}
                  disabled={!slackReady}
                  onChange={(e) =>
                    void patchSlack(nextNotifyPatch({ current: slackCfg, key: "notify_done", value: e.target.checked }))
                  }
                />
                {t("teamIntegrations.slack.notifyDone")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="slack-dm_assignee"
                  checked={slackCfg.dm_assignee}
                  disabled={!slackReady}
                  onChange={(e) => void patchSlack({ dm_assignee: e.target.checked })}
                />
                {t("teamIntegrations.slack.dm")}
              </label>
            </div>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="gh" data-part="integ-github">
          <div className={styles.cardHead}>
            <span className={`${styles.logo} ${styles.logoGithub}`}>G</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <h2 id="gh" className={styles.cardTitle}>
                GitHub
              </h2>
              <span className={`${styles.cardStatus} ${isConnected(github) ? styles.cardStatusOn : ""}`}>{githubDetail(github)}</span>
            </div>
          </div>
          {isConnected(github) ? (
            <>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="github-label"
                  checked={githubCfg.label !== ""}
                  disabled={!githubReady}
                  onChange={(e) => void patchGithub({ label: e.target.checked ? githubCfg.label || "stellar" : "" })}
                />
                {t("teamIntegrations.github.label")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="github-link_pr"
                  checked={githubCfg.link_pr}
                  disabled={!githubReady}
                  onChange={(e) => void patchGithub({ link_pr: e.target.checked })}
                />
                {t("teamIntegrations.github.pr")}
              </label>
              <label className={styles.opt}>
                <input
                  className={styles.sw}
                  type="checkbox"
                  data-part="github-close_on_done"
                  checked={githubCfg.close_on_done}
                  disabled={!githubReady}
                  onChange={(e) => void patchGithub({ close_on_done: e.target.checked })}
                />
                {t("teamIntegrations.github.close")}
              </label>
            </>
          ) : (
            <>
              <span className={styles.desc}>{t("teamIntegrations.github.desc")}</span>
              {canManage ? (
                <button type="button" className={styles.primary} data-part="github-connect" disabled={busy} onClick={() => setConnectKind("github")}>
                  {t("teamIntegrations.connect")}
                </button>
              ) : null}
            </>
          )}
        </section>

        <section className={styles.card} aria-labelledby="ln" data-part="integ-linear">
          <div className={styles.cardHead}>
            <span className={`${styles.logo} ${styles.logoLinear}`}>L</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <h2 id="ln" className={styles.cardTitle}>
                Linear
              </h2>
              <span className={`${styles.cardStatus} ${isConnected(linear) ? styles.cardStatusOn : ""}`}>
                {isConnected(linear) ? t("teamIntegrations.connected") : t("teamIntegrations.notConnected")}
              </span>
            </div>
          </div>
          <span className={styles.desc}>{t("teamIntegrations.linear.desc")}</span>
          {!isConnected(linear) && canManage ? (
            <button type="button" className={styles.primary} data-part="linear-connect" disabled={busy} onClick={() => setConnectKind("linear")}>
              {t("teamIntegrations.connect")}
            </button>
          ) : null}
        </section>

        <section className={styles.card} aria-labelledby="jr" data-part="integ-jira">
          <div className={styles.cardHead}>
            <span className={`${styles.logo} ${styles.logoJira}`}>J</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <h2 id="jr" className={styles.cardTitle}>
                Jira
              </h2>
              <span className={`${styles.cardStatus} ${isConnected(jira) ? styles.cardStatusOn : ""}`}>
                {isConnected(jira) ? t("teamIntegrations.connected") : t("teamIntegrations.notConnected")}
              </span>
            </div>
          </div>
          <span className={styles.desc}>{t("teamIntegrations.jira.desc")}</span>
          {!isConnected(jira) && canManage ? (
            <button type="button" className={styles.primary} data-part="jira-connect" disabled={busy} onClick={() => setConnectKind("jira")}>
              {t("teamIntegrations.connect")}
            </button>
          ) : null}
        </section>

        <section className={styles.card} aria-labelledby="wh" data-part="integ-webhooks">
          <div className={styles.cardHead}>
            <span className={`${styles.logo} ${styles.logoWh}`}>{"{ }"}</span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <h2 id="wh" className={styles.cardTitle}>
                {t("teamIntegrations.webhooks.title")}
              </h2>
              <span className={styles.cardStatus}>{t("teamIntegrations.webhooks.count", { n: String(webhookActiveCount(webhooks)) })}</span>
            </div>
          </div>
          <span className={styles.desc}>{t("teamIntegrations.webhooks.desc")}</span>
          <div className={styles.rowBtns}>
            <button type="button" className={styles.ghost} data-part="webhooks-manage" disabled={!canManage} onClick={() => setWebhookOpen(true)}>
              {t("teamIntegrations.webhooks.manage")}
            </button>
            <button type="button" className={styles.ghost} data-part="export-csv" disabled={busy} onClick={() => void exportBoard("csv")}>
              {t("teamIntegrations.export")}
            </button>
          </div>
        </section>
      </div>

      {connectKind ? (
        <div className={styles.modal} role="dialog" aria-modal="true" data-part="connect-modal">
          <div className={styles.modalCard}>
            <h2 className={styles.cardTitle}>{t("teamIntegrations.connectKind", { kind: connectKind })}</h2>
            {connectKind === "github" ? (
              <>
                <input className={styles.input} placeholder="org/repo" value={connectForm.repo} onChange={(e) => setConnectForm({ ...connectForm, repo: e.target.value })} />
                <input className={styles.input} placeholder="label" value={connectForm.label} onChange={(e) => setConnectForm({ ...connectForm, label: e.target.value })} />
              </>
            ) : null}
            {connectKind === "linear" ? (
              <input className={styles.input} placeholder="project_id" value={connectForm.projectId} onChange={(e) => setConnectForm({ ...connectForm, projectId: e.target.value })} />
            ) : null}
            {connectKind === "jira" ? (
              <>
                <input className={styles.input} placeholder="base_url" value={connectForm.baseUrl} onChange={(e) => setConnectForm({ ...connectForm, baseUrl: e.target.value })} />
                <input className={styles.input} placeholder="email" value={connectForm.email} onChange={(e) => setConnectForm({ ...connectForm, email: e.target.value })} />
                <input className={styles.input} placeholder="jql" value={connectForm.jql} onChange={(e) => setConnectForm({ ...connectForm, jql: e.target.value })} />
              </>
            ) : null}
            <input
              className={styles.input}
              type="password"
              placeholder="token / api key"
              value={connectForm.token}
              onChange={(e) => setConnectForm({ ...connectForm, token: e.target.value })}
              data-part="connect-token"
            />
            <div className={styles.rowBtns}>
              <button type="button" className={styles.ghost} onClick={() => setConnectKind(null)}>
                {t("teamIntegrations.cancel")}
              </button>
              <button type="button" className={styles.primary} data-part="connect-submit" disabled={busy || connectForm.token === ""} onClick={() => void submitConnect()}>
                {t("teamIntegrations.connect")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {webhookOpen ? (
        <div className={styles.modal} role="dialog" aria-modal="true" data-part="webhook-modal">
          <div className={styles.modalCard}>
            <h2 className={styles.cardTitle}>{t("teamIntegrations.webhooks.manage")}</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#a3aabb" }}>
              {webhooks.map((w) => (
                <li key={w.id}>
                  {w.url} · {w.status}{" "}
                  {canManage ? (
                    <button type="button" className={styles.ghost} onClick={() => void window.team.deleteWebhook(teamId, w.id).then(() => load())}>
                      {t("teamIntegrations.disconnect")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canManage ? (
              <>
                <input className={styles.input} placeholder="https://…" value={webhookForm.url} onChange={(e) => setWebhookForm({ ...webhookForm, url: e.target.value })} />
                <input className={styles.input} placeholder="secret" value={webhookForm.secret} onChange={(e) => setWebhookForm({ ...webhookForm, secret: e.target.value })} />
                <input className={styles.input} placeholder="events" value={webhookForm.events} onChange={(e) => setWebhookForm({ ...webhookForm, events: e.target.value })} />
                <button type="button" className={styles.primary} data-part="webhook-create" disabled={busy} onClick={() => void createWebhook()}>
                  {t("teamIntegrations.webhooks.add")}
                </button>
              </>
            ) : null}
            <button type="button" className={styles.ghost} onClick={() => setWebhookOpen(false)}>
              {t("teamIntegrations.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
