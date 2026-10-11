/**
 * Integrations page UI decisions — role gates, status lines and B9c config
 * defaults (missing key → default below).
 */

export type TeamRoleLite = "owner" | "admin" | "member" | null;

export type IntegrationInfo = {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  connectedBy: string | null;
};

/** Slack connector config after applying B9c defaults for absent keys. */
export type SlackConfigView = {
  slash_command: boolean;
  reaction: string;
  mention_to_task: boolean;
  notify_channel: boolean;
  notify_review: boolean;
  notify_gate_failed: boolean;
  notify_done: boolean;
  dm_assignee: boolean;
  channel_id: string;
  channel_name: string;
};

/** GitHub connector config after applying B9c defaults for absent keys. */
export type GithubConfigView = {
  repo: string;
  label: string;
  link_pr: boolean;
  close_on_done: boolean;
};

export function canManageIntegrations(role: TeamRoleLite): boolean {
  return role === "owner" || role === "admin";
}

export function isConnected(integ: IntegrationInfo | null | undefined): boolean {
  return integ != null && integ.status === "connected";
}

export function findByKind(list: readonly IntegrationInfo[], kind: string): IntegrationInfo | null {
  return list.find((i) => i.kind === kind) ?? null;
}

function hasKey(config: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

export function configBool(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (!hasKey(config, key)) return fallback;
  return config[key] === true;
}

export function configString(config: Record<string, unknown>, key: string, fallback: string): string {
  if (!hasKey(config, key)) return fallback;
  return typeof config[key] === "string" ? (config[key] as string) : fallback;
}

/** Resolve Slack config: absent keys use B9c defaults. */
export function resolveSlackConfig(config: Record<string, unknown>): SlackConfigView {
  return {
    slash_command: configBool(config, "slash_command", true),
    reaction: configString(config, "reaction", "ticket"),
    mention_to_task: configBool(config, "mention_to_task", false),
    notify_channel: configBool(config, "notify_channel", true),
    notify_review: configBool(config, "notify_review", true),
    notify_gate_failed: configBool(config, "notify_gate_failed", true),
    notify_done: configBool(config, "notify_done", false),
    dm_assignee: configBool(config, "dm_assignee", true),
    channel_id: configString(config, "channel_id", ""),
    channel_name: configString(config, "channel_name", ""),
  };
}

/** Resolve GitHub config: absent keys use B9c defaults. */
export function resolveGithubConfig(config: Record<string, unknown>): GithubConfigView {
  return {
    repo: configString(config, "repo", ""),
    label: configString(config, "label", "stellar"),
    link_pr: configBool(config, "link_pr", true),
    close_on_done: configBool(config, "close_on_done", false),
  };
}

export function reactionEnabled(slack: SlackConfigView): boolean {
  return slack.reaction !== "";
}

/**
 * PATCH body for one outbound aviso. notify_channel has no prototype switch:
 * turning any child ON also sets notify_channel true in the same PATCH so the
 * admin can re-enable after a master-off state. Turning a child off only
 * writes that key.
 */
export function nextNotifyPatch(input: {
  current: SlackConfigView;
  key: "notify_review" | "notify_gate_failed" | "notify_done";
  value: boolean;
}): Record<string, boolean> {
  const patch: Record<string, boolean> = { [input.key]: input.value };
  if (input.value && !input.current.notify_channel) {
    patch.notify_channel = true;
  }
  return patch;
}

/** Slack card subtitle matching the prototype. */
export function slackDetail(integ: IntegrationInfo | null, connectedByName: string | null): string {
  if (!isConnected(integ)) return "não conectado";
  const workspace = configString(integ!.config, "workspace_name", "");
  const parts = ["conectado"];
  if (workspace) parts.push(`workspace ${workspace}`);
  if (connectedByName) parts.push(`por ${connectedByName}`);
  return parts.join(" · ");
}

export function githubDetail(integ: IntegrationInfo | null): string {
  if (!isConnected(integ)) return "não conectado";
  const repo = configString(integ!.config, "repo", "");
  const org = repo.split("/")[0];
  return org ? `conectado · org ${org}` : "conectado";
}

export function webhookActiveCount(webhooks: readonly { status: string }[]): number {
  return webhooks.filter((w) => w.status === "active").length;
}
