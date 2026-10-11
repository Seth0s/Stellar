/**
 * TEAM ADMINISTRATION — invites with a delivery mode, the public invite
 * preview, rename and delete.
 *
 * These routes carry fields the shared `cloud-api` client does not read (the
 * `delivery` choice and the one-time `invite_url`, the preview, `name` on
 * PATCH, the confirm slug on DELETE), so they live here with their own thin
 * call. Same contract as the rest: the backend envelope becomes a typed result
 * and nothing throws on an HTTP status.
 */

import { parseCloudApiError, type CloudApiError } from "./cloud-auth-decision";
import { detachTeamProfile, findTeamProfile } from "./profiles";
import {
  classifyInviteTarget,
  parseInvitePreview,
  parseTeamInviteCreated,
  type InviteDelivery,
  type InvitePreviewView,
  type TeamInviteCreated,
  type TeamRole,
} from "./team-decision";
import type { TeamContext } from "./team";

type Call = (
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
) => Promise<{ ok: true; value: unknown } | { ok: false; error: CloudApiError }>;

function makeCall(baseUrl: string, fetchImpl: typeof fetch): Call {
  const base = baseUrl.replace(/\/+$/, "");
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      return { ok: false, error: { status: 0, code: "network", message: err instanceof Error ? err.message : String(err) } };
    }
    let parsed: unknown = null;
    const text = await response.text().catch(() => "");
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      return { ok: false, error: parseCloudApiError(response.status, parsed, `${method} ${path} failed (${response.status})`) };
    }
    return { ok: true, value: parsed };
  };
}

export type CreateInviteFailure = "invalid-target" | "forbidden" | "seats-exceeded" | "email-unavailable" | "error";

/**
 * `POST /v1/teams/{id}/invites`. `delivery: "email"` sends the mail; `"link"`
 * sends nothing and returns the nominal link ONCE (`inviteUrl`) for the owner to
 * copy. A mail that could not go out answers 503 `email_unavailable` — the
 * invite was not kept, and "copy the link" is the way forward.
 */
export async function createTeamInviteWithDelivery(
  ctx: TeamContext,
  teamId: string,
  input: { target: string; role: TeamRole; delivery?: InviteDelivery },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; invite: TeamInviteCreated } | { ok: false; reason: CreateInviteFailure; error: string }> {
  if (classifyInviteTarget(input.target) === "invalid") {
    return { ok: false, reason: "invalid-target", error: "informe um e-mail ou um login do GitHub válido" };
  }
  const delivery: InviteDelivery = input.delivery === "link" ? "link" : "email";
  const call = makeCall(ctx.api.baseUrl, fetchImpl);
  const res = await call("POST", `/v1/teams/${encodeURIComponent(teamId)}/invites`, {
    token: ctx.token,
    body: { target: input.target.trim(), role: input.role, delivery },
  });
  if (!res.ok) {
    const { status, code, message } = res.error;
    const reason: CreateInviteFailure =
      code === "seats_exceeded" ? "seats-exceeded" : code === "email_unavailable" ? "email-unavailable" : status === 403 ? "forbidden" : "error";
    return { ok: false, reason, error: message };
  }
  const invite = parseTeamInviteCreated(res.value, delivery);
  if (!invite) return { ok: false, reason: "error", error: "resposta do convite incompleta" };
  return { ok: true, invite };
}

export type InvitePreviewFailure = "not-found" | "error";

/**
 * `GET /v1/invites/{token}/preview` — public (no login). An unknown, expired,
 * used or revoked token all answer the same 404 on purpose, so they all read as
 * `not-found` here.
 */
export async function previewTeamInvite(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; preview: InvitePreviewView } | { ok: false; reason: InvitePreviewFailure; error: string }> {
  const call = makeCall(baseUrl, fetchImpl);
  const res = await call("GET", `/v1/invites/${encodeURIComponent(token)}/preview`);
  if (!res.ok) return { ok: false, reason: res.error.status === 404 ? "not-found" : "error", error: res.error.message };
  const preview = parseInvitePreview(res.value);
  if (!preview) return { ok: false, reason: "error", error: "prévia do convite incompleta" };
  return { ok: true, preview };
}

const MAX_TEAM_NAME_LEN = 80;

/** `PATCH /v1/teams/{id}` with `name` (admin+). The slug never changes. */
export async function renameTeamOp(
  ctx: TeamContext,
  teamId: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; team: { id: string; name: string; slug: string } } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, error: "informe um nome para o time" };
  if ([...trimmed].length > MAX_TEAM_NAME_LEN) return { ok: false, error: `o nome tem no máximo ${MAX_TEAM_NAME_LEN} caracteres` };
  const call = makeCall(ctx.api.baseUrl, fetchImpl);
  const res = await call("PATCH", `/v1/teams/${encodeURIComponent(teamId)}`, { token: ctx.token, body: { name: trimmed } });
  if (!res.ok) return { ok: false, error: res.error.message };
  const rec = (res.value ?? {}) as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string" || typeof rec.slug !== "string") {
    return { ok: false, error: "resposta de renomear incompleta" };
  }
  return { ok: true, team: { id: rec.id, name: rec.name, slug: rec.slug } };
}

/**
 * `DELETE /v1/teams/{id}` — owner only, `confirm` must be the team slug. On
 * success the local team profile is turned OFF (nothing on disk is deleted):
 * its team no longer exists.
 */
export async function deleteTeamOp(
  ctx: TeamContext,
  teamId: string,
  confirm: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (confirm.trim() === "") return { ok: false, error: "digite o slug do time para confirmar" };
  const call = makeCall(ctx.api.baseUrl, fetchImpl);
  const res = await call("DELETE", `/v1/teams/${encodeURIComponent(teamId)}`, { token: ctx.token, body: { confirm: confirm.trim() } });
  if (!res.ok) return { ok: false, error: res.error.message };
  const profile = findTeamProfile(ctx.baseUserDataDir, teamId);
  if (profile && profile.detached !== true) detachTeamProfile(ctx.baseUserDataDir, profile.id);
  return { ok: true };
}
