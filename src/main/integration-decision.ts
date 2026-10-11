/**
 * Team connectors (integrations) — pure parse/decision layer for B9a/B9b.
 * Tokens never appear here: the server omits secrets from every response.
 */

import { isOpaqueId } from "./local-identity-decision";

export type IntegrationKind = "slack" | "github" | "linear" | "jira";

export type IntegrationView = {
  id: string;
  kind: IntegrationKind;
  status: "connected" | "disabled" | string;
  config: Record<string, unknown>;
  connectedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WebhookView = {
  id: string;
  url: string;
  events: string[];
  status: string;
  consecutiveFailures: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WebhookDeliveryView = {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string;
  nextAttemptAt: string | null;
  createdAt: string | null;
};

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

const INTEGRATION_KINDS = new Set<string>(["slack", "github", "linear", "jira"]);

export function parseIntegration(raw: unknown): IntegrationView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const kind = asString(rec.kind);
  if (!id || !isOpaqueId(id) || !kind || !INTEGRATION_KINDS.has(kind)) return null;
  return {
    id,
    kind: kind as IntegrationKind,
    status: asString(rec.status) ?? "disabled",
    config: parseConfig(rec.config),
    connectedBy: isOpaqueId(rec.connected_by) ? String(rec.connected_by) : null,
    createdAt: asString(rec.created_at),
    updatedAt: asString(rec.updated_at),
  };
}

export function parseIntegrationList(raw: unknown): IntegrationView[] {
  const rec = asRecord(raw);
  const list = Array.isArray(raw) ? raw : rec && Array.isArray(rec.integrations) ? rec.integrations : [];
  const out: IntegrationView[] = [];
  for (const item of list) {
    const parsed = parseIntegration(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseWebhook(raw: unknown): WebhookView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const url = asString(rec.url);
  if (!id || !isOpaqueId(id) || !url) return null;
  return {
    id,
    url,
    events: asStringArray(rec.events),
    status: asString(rec.status) ?? "active",
    consecutiveFailures: typeof rec.consecutive_failures === "number" ? rec.consecutive_failures : 0,
    createdAt: asString(rec.created_at),
    updatedAt: asString(rec.updated_at),
  };
}

export function parseWebhookList(raw: unknown): WebhookView[] {
  const rec = asRecord(raw);
  const list = Array.isArray(raw) ? raw : rec && Array.isArray(rec.webhooks) ? rec.webhooks : [];
  const out: WebhookView[] = [];
  for (const item of list) {
    const parsed = parseWebhook(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseWebhookDelivery(raw: unknown): WebhookDeliveryView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  if (!id || !isOpaqueId(id)) return null;
  const responseStatus =
    typeof rec.response_status === "number"
      ? rec.response_status
      : asRecord(rec.response_status) && typeof (rec.response_status as { Int32?: number }).Int32 === "number"
        ? (rec.response_status as { Int32: number }).Int32
        : null;
  return {
    id,
    event: asString(rec.event) ?? "",
    status: asString(rec.status) ?? "",
    attempts: typeof rec.attempts === "number" ? rec.attempts : 0,
    responseStatus,
    error: typeof rec.error === "string" ? rec.error : "",
    nextAttemptAt: asString(rec.next_attempt_at),
    createdAt: asString(rec.created_at),
  };
}

export function parseWebhookDeliveryList(raw: unknown): WebhookDeliveryView[] {
  const rec = asRecord(raw);
  const list = Array.isArray(raw) ? raw : rec && Array.isArray(rec.deliveries) ? rec.deliveries : [];
  const out: WebhookDeliveryView[] = [];
  for (const item of list) {
    const parsed = parseWebhookDelivery(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Owner/admin may connect and edit; members only read. */
export function canManageIntegrations(role: "owner" | "admin" | "member" | null): boolean {
  return role === "owner" || role === "admin";
}

export function findIntegration(list: readonly IntegrationView[], kind: IntegrationKind): IntegrationView | null {
  return list.find((i) => i.kind === kind) ?? null;
}

export function isIntegrationConnected(integ: IntegrationView | null): boolean {
  return integ !== null && integ.status === "connected";
}

/** Slack status line shown on the integrations card (connected detail or offline). */
export function slackStatusLine(input: {
  integ: IntegrationView | null;
  connectedByName: string | null;
}): { connected: boolean; detail: string } {
  const { integ, connectedByName } = input;
  if (!isIntegrationConnected(integ)) return { connected: false, detail: "não conectado" };
  const workspace = typeof integ!.config.workspace_name === "string" ? integ!.config.workspace_name : null;
  const parts = ["conectado"];
  if (workspace) parts.push(`workspace ${workspace}`);
  if (connectedByName) parts.push(`por ${connectedByName}`);
  return { connected: true, detail: parts.join(" · ") };
}

export function githubStatusLine(integ: IntegrationView | null): { connected: boolean; detail: string } {
  if (!isIntegrationConnected(integ)) return { connected: false, detail: "não conectado" };
  const repo = typeof integ!.config.repo === "string" ? integ!.config.repo : null;
  const org = repo?.split("/")[0] ?? null;
  return { connected: true, detail: org ? `conectado · org ${org}` : "conectado" };
}

/** Deep link after OAuth: `stellar://integrations/oauth?status=connected|error`. */
export type IntegrationOAuthDeepLink = { kind: "integration-oauth"; status: "connected" | "error" };

export function parseIntegrationOAuthDeepLink(raw: string): IntegrationOAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "stellar:") return null;
  const host = url.host !== "" ? url.host : url.pathname.replace(/^\/+/, "").split("/")[0];
  const path = url.host !== "" ? url.pathname.replace(/^\/+/, "") : url.pathname.replace(/^\/+/, "").split("/").slice(1).join("/");
  if (host !== "integrations" || path !== "oauth") return null;
  const status = url.searchParams.get("status");
  if (status !== "connected" && status !== "error") return null;
  return { kind: "integration-oauth", status };
}

export const INTEGRATION_OAUTH_RETURN_URL = "stellar://integrations/oauth";
