/**
 * Team integrations — I/O shell over cloud-api (list/patch/disconnect/oauth/connect,
 * webhooks, export). Opens the system browser for OAuth; the deep-link return
 * is handled in index.ts.
 */

import type { CloudApi } from "./cloud-api";
import {
  INTEGRATION_OAUTH_RETURN_URL,
  type IntegrationKind,
  type IntegrationView,
  type WebhookDeliveryView,
  type WebhookView,
} from "./integration-decision";

export type IntegrationContext = {
  api: CloudApi;
  token: string;
  /** Opens the authorize URL in the system browser (or logs it in smoke). */
  openUrl: (url: string) => void;
};

export async function listTeamIntegrations(
  ctx: IntegrationContext,
  teamId: string,
): Promise<{ ok: true; integrations: IntegrationView[] } | { ok: false; error: string }> {
  const res = await ctx.api.listIntegrations(ctx.token, teamId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, integrations: res.value };
}

export async function updateTeamIntegration(
  ctx: IntegrationContext,
  teamId: string,
  kind: string,
  body: { config?: Record<string, unknown>; status?: string },
): Promise<{ ok: true; integration: IntegrationView } | { ok: false; error: string }> {
  const res = await ctx.api.updateIntegration(ctx.token, teamId, kind, body);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, integration: res.value };
}

export async function disconnectTeamIntegration(
  ctx: IntegrationContext,
  teamId: string,
  kind: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.disconnectIntegration(ctx.token, teamId, kind);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true };
}

/** Starts OAuth and opens the authorize URL. Return URL is the stellar:// deep link. */
export async function startTeamIntegrationOAuth(
  ctx: IntegrationContext,
  teamId: string,
  kind: IntegrationKind | string,
  returnUrl: string = INTEGRATION_OAUTH_RETURN_URL,
): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> {
  const res = await ctx.api.startIntegrationOAuth(ctx.token, teamId, kind, returnUrl);
  if (!res.ok) return { ok: false, error: res.error.message };
  ctx.openUrl(res.value.authorizeUrl);
  return { ok: true, authorizeUrl: res.value.authorizeUrl };
}

export async function connectTeamIntegration(
  ctx: IntegrationContext,
  teamId: string,
  kind: string,
  body: { config: Record<string, unknown>; secrets: Record<string, string> },
): Promise<{ ok: true; integration: IntegrationView } | { ok: false; error: string }> {
  const res = await ctx.api.connectIntegration(ctx.token, teamId, kind, body);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, integration: res.value };
}

export async function listTeamWebhooks(
  ctx: IntegrationContext,
  teamId: string,
): Promise<{ ok: true; webhooks: WebhookView[] } | { ok: false; error: string }> {
  const res = await ctx.api.listWebhooks(ctx.token, teamId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, webhooks: res.value };
}

export async function createTeamWebhook(
  ctx: IntegrationContext,
  teamId: string,
  body: { url: string; secret: string; events: string[] },
): Promise<{ ok: true; webhook: WebhookView } | { ok: false; error: string }> {
  const res = await ctx.api.createWebhook(ctx.token, teamId, body);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, webhook: res.value };
}

export async function deleteTeamWebhook(
  ctx: IntegrationContext,
  teamId: string,
  webhookId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await ctx.api.deleteWebhook(ctx.token, teamId, webhookId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true };
}

export async function listTeamWebhookDeliveries(
  ctx: IntegrationContext,
  teamId: string,
  webhookId: string,
): Promise<{ ok: true; deliveries: WebhookDeliveryView[] } | { ok: false; error: string }> {
  const res = await ctx.api.listWebhookDeliveries(ctx.token, teamId, webhookId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, deliveries: res.value };
}

export async function exportTeamBoardOp(
  ctx: IntegrationContext,
  teamId: string,
  format: "csv" | "json",
): Promise<{ ok: true; body: string; contentType: string } | { ok: false; error: string }> {
  const res = await ctx.api.exportTeamBoard(ctx.token, teamId, format);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, body: res.value.body, contentType: res.value.contentType };
}
