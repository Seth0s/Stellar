/**
 * Cliente HTTP do backend da conta Stellar (StellarCloud B2). Casca fina sobre
 * `fetch`, com o envelope de erro do backend traduzido para um resultado
 * tipado — nunca lança por status HTTP (rede cai como `status: 0`).
 */

import {
  parseCloudApiError,
  parseMe,
  parseTokenPair,
  type CloudAccount,
  type CloudApiError,
  type ParsedTokenPair,
} from "./cloud-auth-decision";
import { isOpaqueId } from "./local-identity-decision";
import { parseCloudPlan, type CloudPlan } from "./plan-decision";
import {
  parseCloudProfile,
  parseCloudProfileList,
  type CloudProfileRef,
} from "./profiles-cloud-decision";
import { parseRemoteManifestEntry, type RemoteManifestEntry } from "./work-home-manifest";
import {
  parseTeamDetail,
  parseTeamInvite,
  parseTeamInviteList,
  parseTeamListView,
  parseTeamMember,
  type TeamDetailView,
  type TeamInviteView,
  type TeamListView,
  type TeamMemberView,
  type TeamRole,
  type TeamSummary,
} from "./team-decision";
import {
  parseTeamSprint,
  parseTeamSprintList,
  parseTeamTaskDetail,
  parseTeamTaskList,
  type TeamSprintView,
  type TeamTaskDetail,
  type TeamTaskList,
  type TeamTaskView,
} from "./team-task-decision";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: CloudApiError };

/** `GET /v1/me` carries the account AND the effective plan/rights. `plan` is
 *  null when the server sent no plan block (an older backend): UNKNOWN, not
 *  Free — the app leaves the gates open and lets the server be the authority. */
export type CloudMe = { account: CloudAccount; plan: CloudPlan | null };

/** Result of a team-task mutation: success, CONFLICT (409 carrying the current
 *  task) or error — the B7 `If-Match`/`409`, same shape as the house PUT. */
export type TeamTaskMutationResult =
  | { ok: true; value: TeamTaskView }
  | { ok: false; conflict: true; current: TeamTaskView | null }
  | { ok: false; conflict: false; error: CloudApiError };

/** Resultado do PUT da casa: sucesso, CONFLITO (409 com o manifesto atual) ou erro. */
export type PutHouseResult =
  | { ok: true; value: { revision: number; manifest: RemoteManifestEntry[] } }
  | { ok: false; conflict: true; currentRevision: number; currentManifest: RemoteManifestEntry[] }
  | { ok: false; conflict: false; error: CloudApiError };

/** One machine of the account (`GET /v1/devices`). `installId` says whether it
 *  is THIS machine; `lastSeenAt` may be null (never seen since it registered). */
export type CloudDevice = {
  id: string;
  installId: string;
  label: string;
  lastSeenAt: string | null;
};

export function createCloudApi(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(method: string, path: string, opts2: { body?: unknown; token?: string } = {}): Promise<
    ApiResult<unknown>
  > {
    const headers: Record<string, string> = {};
    if (opts2.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts2.token) headers["Authorization"] = `Bearer ${opts2.token}`;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts2.body === undefined ? undefined : JSON.stringify(opts2.body),
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
  }

  /** RAW request (bytes): used by blobs (octet-stream) and by the house PUT
   *  (the `If-Match`/`X-Install-Id` headers the JSON `request` does not carry).
   *  It does not throw on an HTTP status. */
  async function requestRaw(
    method: string,
    path: string,
    opts2: { body?: Uint8Array; token?: string; headers?: Record<string, string>; contentType?: string } = {},
  ): Promise<{ ok: boolean; status: number; bytes: Uint8Array; text: string }> {
    const headers: Record<string, string> = { ...(opts2.headers ?? {}) };
    if (opts2.token) headers["Authorization"] = `Bearer ${opts2.token}`;
    if (opts2.body !== undefined && opts2.contentType) headers["Content-Type"] = opts2.contentType;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts2.body === undefined ? undefined : (opts2.body as unknown as BodyInit),
      });
    } catch {
      return { ok: false, status: 0, bytes: new Uint8Array(), text: "" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    return { ok: response.ok, status: response.status, bytes, text: new TextDecoder().decode(bytes) };
  }

  function parseJson(text: string): unknown {
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Shared POST for the B7 task sub-actions that answer a task view. A local
   *  function (not a method) so it never depends on `this` binding. */
  async function teamTaskAction(
    token: string,
    teamId: string,
    taskId: string,
    action: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResult<TeamTaskView>> {
    const path = `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/${action}`;
    const res = await request("POST", path, { token, body });
    if (!res.ok) return res;
    const task = parseTeamTaskDetail({ task: res.value })?.task ?? null;
    if (!task) return { ok: false, error: { status: 0, code: "invalid_response", message: `task action ${action} missing task` } };
    return { ok: true, value: task };
  }

  return {
    baseUrl,

    /** POST /v1/auth/email — pede o link de uso único. */
    async startEmail(body: Record<string, string>): Promise<ApiResult<null>> {
      const res = await request("POST", "/v1/auth/email", { body });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** POST /v1/auth/token (authorization_code). */
    async exchange(body: Record<string, string>): Promise<ApiResult<ParsedTokenPair>> {
      const res = await request("POST", "/v1/auth/token", { body });
      if (!res.ok) return res;
      const pair = parseTokenPair(res.value);
      if (!pair) return { ok: false, error: { status: 0, code: "invalid_response", message: "token response missing fields" } };
      return { ok: true, value: pair };
    },

    /** POST /v1/auth/token (refresh_token). */
    async refresh(body: Record<string, string>): Promise<ApiResult<ParsedTokenPair>> {
      const res = await request("POST", "/v1/auth/token", { body });
      if (!res.ok) return res;
      const pair = parseTokenPair(res.value);
      if (!pair) return { ok: false, error: { status: 0, code: "invalid_response", message: "refresh response missing fields" } };
      return { ok: true, value: pair };
    },

    /** POST /v1/auth/logout — idempotente; sem token ainda devolve 204. */
    async logout(refreshToken: string): Promise<ApiResult<null>> {
      const res = await request("POST", "/v1/auth/logout", { body: { refresh_token: refreshToken } });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** GET /v1/me (Bearer) → conta/identidades. */
    async me(accessToken: string): Promise<ApiResult<CloudAccount>> {
      const res = await request("GET", "/v1/me", { token: accessToken });
      if (!res.ok) return res;
      const account = parseMe(res.value);
      if (!account) return { ok: false, error: { status: 0, code: "invalid_response", message: "/me response missing account" } };
      return { ok: true, value: account };
    },

    /** GET /v1/me (Bearer) with the effective PLAN and rights — one read backs
     *  both the account line and the paid-feature gates. */
    async meWithPlan(accessToken: string): Promise<ApiResult<CloudMe>> {
      const res = await request("GET", "/v1/me", { token: accessToken });
      if (!res.ok) return res;
      const account = parseMe(res.value);
      if (!account) return { ok: false, error: { status: 0, code: "invalid_response", message: "/me response missing account" } };
      // No plan block stays null (unknown) — never substituted with Free.
      const plan = parseCloudPlan(res.value);
      return { ok: true, value: { account, plan } };
    },

    async health(): Promise<boolean> {
      const res = await request("GET", "/v1/healthz");
      return res.ok;
    },

    // ---- ACCOUNT PROFILES ---------------------------------------------------

    /** GET /v1/profiles -> the account's server profiles. */
    async listProfiles(token: string): Promise<ApiResult<CloudProfileRef[]>> {
      const res = await request("GET", "/v1/profiles", { token });
      if (!res.ok) return res;
      return { ok: true, value: parseCloudProfileList(res.value) };
    },

    /** POST /v1/profiles -> create the PERSONAL profile of the account. The
     *  backend refuses `kind:"team"` (that profile comes from the invite flow). */
    async createProfile(
      token: string,
      body: { kind: "personal"; name: string },
    ): Promise<ApiResult<CloudProfileRef>> {
      const res = await request("POST", "/v1/profiles", { token, body });
      if (!res.ok) return res;
      const ref = parseCloudProfile(res.value);
      if (!ref) return { ok: false, error: { status: 0, code: "invalid_response", message: "create profile response missing id" } };
      return { ok: true, value: ref };
    },

    // ---- DEVICES ------------------------------------------------------------

    /** GET /v1/devices -> the machines of the account. */
    async listDevices(token: string): Promise<ApiResult<CloudDevice[]>> {
      const res = await request("GET", "/v1/devices", { token });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(body.devices) ? body.devices : [];
      const devices: CloudDevice[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (!isOpaqueId(rec.id) || typeof rec.install_id !== "string" || rec.install_id === "") continue;
        devices.push({
          id: rec.id,
          installId: rec.install_id,
          label: typeof rec.label === "string" ? rec.label : "",
          lastSeenAt: typeof rec.last_seen_at === "string" && rec.last_seen_at !== "" ? rec.last_seen_at : null,
        });
      }
      return { ok: true, value: devices };
    },

    /** DELETE /v1/devices/{id} -> revoke that machine's session (204). */
    async deleteDevice(token: string, id: string): Promise<ApiResult<null>> {
      const res = await request("DELETE", `/v1/devices/${encodeURIComponent(id)}`, { token });
      return res.ok ? { ok: true, value: null } : res;
    },

    // ---- HOUSE v2: manifest + blobs by sha256 -------------------------------

    /** GET /v1/profiles/{id}/house -> revision + current manifest. */
    async getHouseManifest(token: string, profileId: string): Promise<ApiResult<{ revision: number; manifest: RemoteManifestEntry[] }>> {
      const res = await request("GET", `/v1/profiles/${encodeURIComponent(profileId)}/house`, { token });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const revision = typeof body.revision === "number" ? body.revision : 0;
      const rawManifest = Array.isArray(body.manifest) ? body.manifest : [];
      const manifest: RemoteManifestEntry[] = [];
      for (const entry of rawManifest) {
        const parsed = parseRemoteManifestEntry(entry);
        if (parsed) manifest.push(parsed);
      }
      return { ok: true, value: { revision, manifest } };
    },

    /**
     * PUT /v1/profiles/{id}/house with `If-Match: <revision>` and `X-Install-Id`.
     * A 409 returns the CURRENT manifest for the merge (not a generic error).
     */
    async putHouseManifest(
      token: string,
      profileId: string,
      input: { revision: number; manifest: RemoteManifestEntry[]; installId: string },
    ): Promise<PutHouseResult> {
      const raw = await requestRaw("PUT", `/v1/profiles/${encodeURIComponent(profileId)}/house`, {
        token,
        body: new TextEncoder().encode(JSON.stringify({ manifest: input.manifest })),
        contentType: "application/json",
        headers: { "If-Match": String(input.revision), "X-Install-Id": input.installId },
      });
      if (raw.ok) {
        const body = parseJson(raw.text) as Record<string, unknown> | null;
        const revision = body && typeof body.revision === "number" ? body.revision : input.revision + 1;
        const rawManifest = body && Array.isArray(body.manifest) ? body.manifest : input.manifest;
        const manifest: RemoteManifestEntry[] = [];
        for (const entry of rawManifest) {
          const parsed = parseRemoteManifestEntry(entry);
          if (parsed) manifest.push(parsed);
        }
        return { ok: true, value: { revision, manifest } };
      }
      if (raw.status === 409) {
        const body = parseJson(raw.text) as Record<string, unknown> | null;
        const currentRevision = body && typeof body.current_revision === "number" ? body.current_revision : 0;
        const rawManifest = body && Array.isArray(body.current_manifest) ? body.current_manifest : [];
        const currentManifest: RemoteManifestEntry[] = [];
        for (const entry of rawManifest) {
          const parsed = parseRemoteManifestEntry(entry);
          if (parsed) currentManifest.push(parsed);
        }
        return { ok: false, conflict: true, currentRevision, currentManifest };
      }
      return { ok: false, conflict: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `PUT house failed (${raw.status})`) };
    },

    /** POST /v1/blobs/check -> shas the ACCOUNT does not have yet. */
    async checkBlobs(token: string, sha256: string[]): Promise<ApiResult<string[]>> {
      const res = await request("POST", "/v1/blobs/check", { token, body: { sha256 } });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const missing = Array.isArray(body.missing) ? body.missing.filter((s): s is string => typeof s === "string") : [];
      return { ok: true, value: missing };
    },

    /** PUT /v1/blobs/{sha} — corpo cru (octet-stream), idempotente. */
    async putBlob(token: string, sha: string, bytes: Uint8Array): Promise<ApiResult<{ created: boolean }>> {
      const raw = await requestRaw("PUT", `/v1/blobs/${encodeURIComponent(sha)}`, {
        token,
        body: bytes,
        contentType: "application/octet-stream",
      });
      if (!raw.ok) {
        return { ok: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `PUT blob failed (${raw.status})`) };
      }
      const body = parseJson(raw.text) as Record<string, unknown> | null;
      return { ok: true, value: { created: body?.created === true } };
    },

    /** GET /v1/blobs/{sha} → bytes crus. */
    async getBlob(token: string, sha: string): Promise<ApiResult<Uint8Array>> {
      const raw = await requestRaw("GET", `/v1/blobs/${encodeURIComponent(sha)}`, { token });
      if (!raw.ok) {
        return { ok: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `GET blob failed (${raw.status})`) };
      }
      return { ok: true, value: raw.bytes };
    },

    // ---- TEAMS --------------------------------------------------------------

    /** GET /v1/me -> account, identities, profiles and TEAMS of the account. */
    async meFull(token: string): Promise<ApiResult<TeamListView>> {
      const res = await request("GET", "/v1/me", { token });
      if (!res.ok) return res;
      const view = parseTeamListView(res.value);
      if (!view) return { ok: false, error: { status: 0, code: "invalid_response", message: "/me response missing account" } };
      return { ok: true, value: view };
    },

    /** POST /v1/teams — the creator becomes owner. */
    async createTeam(token: string, body: { name: string; slug?: string }): Promise<ApiResult<TeamSummary>> {
      const res = await request("POST", "/v1/teams", { token, body });
      if (!res.ok) return res;
      const team = parseTeamDetail({ team: res.value, members: [] })?.team ?? null;
      if (!team) return { ok: false, error: { status: 0, code: "invalid_response", message: "create team response missing team" } };
      return { ok: true, value: team };
    },

    /** GET /v1/teams/{id} -> team + members (members only). */
    async getTeam(token: string, teamId: string): Promise<ApiResult<TeamDetailView>> {
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}`, { token });
      if (!res.ok) return res;
      const detail = parseTeamDetail(res.value);
      if (!detail) return { ok: false, error: { status: 0, code: "invalid_response", message: "team detail missing team" } };
      return { ok: true, value: detail };
    },

    /** POST /v1/teams/{id}/invites — admin/owner; target is an email or GitHub login. */
    async createInvite(token: string, teamId: string, body: { target: string; role: TeamRole }): Promise<ApiResult<TeamInviteView>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/invites`, { token, body });
      if (!res.ok) return res;
      const invite = parseTeamInvite(res.value);
      if (!invite) return { ok: false, error: { status: 0, code: "invalid_response", message: "invite response missing fields" } };
      return { ok: true, value: invite };
    },

    /** DELETE /v1/teams/{id}/invites/{inviteId} — 204. */
    async revokeInvite(token: string, teamId: string, inviteId: string): Promise<ApiResult<null>> {
      const res = await request("DELETE", `/v1/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`, { token });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** GET /v1/teams/{id}/invites — pending invites (owner/admin). */
    async listInvites(token: string, teamId: string): Promise<ApiResult<TeamInviteView[]>> {
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}/invites`, { token });
      if (!res.ok) return res;
      return { ok: true, value: parseTeamInviteList(res.value) };
    },

    /** POST /v1/invites/{token}/accept — the signed-in account must match the target. */
    async acceptInvite(token: string, rawToken: string): Promise<ApiResult<{ team: TeamSummary; membership: TeamMemberView }>> {
      const res = await request("POST", `/v1/invites/${encodeURIComponent(rawToken)}/accept`, { token });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const team = parseTeamDetail(body)?.team ?? null;
      const membershipRaw = typeof body.membership === "object" && body.membership !== null ? body.membership : null;
      const membership = parseTeamMember(membershipRaw);
      if (!team || !membership) {
        return { ok: false, error: { status: 0, code: "invalid_response", message: "accept response missing team/membership" } };
      }
      return { ok: true, value: { team, membership } };
    },

    /** PATCH /v1/teams/{id}/members/{account}/role -> updated member. */
    async changeRole(token: string, teamId: string, accountId: string, role: TeamRole): Promise<ApiResult<TeamMemberView>> {
      const res = await request("PATCH", `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(accountId)}/role`, {
        token,
        body: { role },
      });
      if (!res.ok) return res;
      const member = parseTeamMember(res.value);
      if (!member) {
        return { ok: false, error: { status: 0, code: "invalid_response", message: "member response missing fields" } };
      }
      return { ok: true, value: member };
    },

    /** DELETE /v1/teams/{id}/members/{account} — 204 (remove or leave). */
    async removeMember(token: string, teamId: string, accountId: string): Promise<ApiResult<null>> {
      const res = await request("DELETE", `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(accountId)}`, { token });
      return res.ok ? { ok: true, value: null } : res;
    },

    // ---- TEAM HOUSE ---------------------------------------------------------

    /** GET /v1/teams/{id}/house -> revision + base manifest (members only). */
    async getTeamHouse(token: string, teamId: string): Promise<ApiResult<{ revision: number; manifest: RemoteManifestEntry[] }>> {
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}/house`, { token });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const revision = typeof body.revision === "number" ? body.revision : 0;
      const rawManifest = Array.isArray(body.manifest) ? body.manifest : [];
      const manifest: RemoteManifestEntry[] = [];
      for (const entry of rawManifest) {
        const parsed = parseRemoteManifestEntry(entry);
        if (parsed) manifest.push(parsed);
      }
      return { ok: true, value: { revision, manifest } };
    },

    /** PUT /v1/teams/{id}/house with `If-Match` (admin/owner). 409 = revision conflict. */
    async putTeamHouse(
      token: string,
      teamId: string,
      input: { revision: number; manifest: RemoteManifestEntry[] },
    ): Promise<PutHouseResult> {
      const raw = await requestRaw("PUT", `/v1/teams/${encodeURIComponent(teamId)}/house`, {
        token,
        body: new TextEncoder().encode(JSON.stringify({ manifest: input.manifest })),
        contentType: "application/json",
        headers: { "If-Match": String(input.revision) },
      });
      if (raw.ok) {
        const body = parseJson(raw.text) as Record<string, unknown> | null;
        const revision = body && typeof body.revision === "number" ? body.revision : input.revision + 1;
        const rawManifest = body && Array.isArray(body.manifest) ? body.manifest : input.manifest;
        const manifest: RemoteManifestEntry[] = [];
        for (const entry of rawManifest) {
          const parsed = parseRemoteManifestEntry(entry);
          if (parsed) manifest.push(parsed);
        }
        return { ok: true, value: { revision, manifest } };
      }
      if (raw.status === 409) {
        const body = parseJson(raw.text) as Record<string, unknown> | null;
        const currentRevision = body && typeof body.current_revision === "number" ? body.current_revision : 0;
        const rawManifest = body && Array.isArray(body.current_manifest) ? body.current_manifest : [];
        const currentManifest: RemoteManifestEntry[] = [];
        for (const entry of rawManifest) {
          const parsed = parseRemoteManifestEntry(entry);
          if (parsed) currentManifest.push(parsed);
        }
        return { ok: false, conflict: true, currentRevision, currentManifest };
      }
      return { ok: false, conflict: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `PUT team house failed (${raw.status})`) };
    },

    // ---- TEAM TASKS (B7) ----------------------------------------------------

    /** GET /v1/teams/{id}/tasks — board with filters and pagination. */
    async listTeamTasks(
      token: string,
      teamId: string,
      filter: {
        state?: string;
        assignee?: string;
        sprint?: string;
        project?: string;
        unassigned?: boolean;
        includeArchived?: boolean;
        q?: string;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<ApiResult<TeamTaskList>> {
      const params = new URLSearchParams();
      if (filter.state) params.set("state", filter.state);
      if (filter.assignee) params.set("assignee", filter.assignee);
      if (filter.sprint) params.set("sprint", filter.sprint);
      if (filter.project) params.set("project", filter.project);
      if (filter.unassigned) params.set("unassigned", "true");
      if (filter.includeArchived) params.set("include_archived", "true");
      if (filter.q) params.set("q", filter.q);
      if (filter.limit !== undefined) params.set("limit", String(filter.limit));
      if (filter.offset !== undefined) params.set("offset", String(filter.offset));
      const qs = params.toString();
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}/tasks${qs ? `?${qs}` : ""}`, { token });
      if (!res.ok) return res;
      const list = parseTeamTaskList(res.value);
      if (!list) return { ok: false, error: { status: 0, code: "invalid_response", message: "task list missing tasks" } };
      return { ok: true, value: list };
    },

    /** GET /v1/teams/{id}/tasks/{taskId} — task + contract + timeline + claims. */
    async getTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<TeamTaskDetail>> {
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}`, { token });
      if (!res.ok) return res;
      const detail = parseTeamTaskDetail(res.value);
      if (!detail) return { ok: false, error: { status: 0, code: "invalid_response", message: "task detail missing task" } };
      return { ok: true, value: detail };
    },

    /** POST /v1/teams/{id}/tasks — owner/admin creates a task. */
    async createTeamTask(token: string, teamId: string, body: Record<string, unknown>): Promise<ApiResult<TeamTaskView>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/tasks`, { token, body });
      if (!res.ok) return res;
      const detail = parseTeamTaskDetail({ task: res.value });
      const task = detail?.task ?? null;
      if (!task) return { ok: false, error: { status: 0, code: "invalid_response", message: "create task response missing task" } };
      return { ok: true, value: task };
    },

    /** PATCH /v1/teams/{id}/tasks/{taskId} — partial edit with `If-Match`; a 409
     *  returns the CURRENT task so the caller can reapply. */
    async updateTeamTask(
      token: string,
      teamId: string,
      taskId: string,
      body: Record<string, unknown>,
      version: number,
    ): Promise<TeamTaskMutationResult> {
      const raw = await requestRaw("PATCH", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}`, {
        token,
        body: new TextEncoder().encode(JSON.stringify(body)),
        contentType: "application/json",
        headers: { "If-Match": String(version) },
      });
      if (raw.ok) {
        const task = parseTeamTaskDetail({ task: parseJson(raw.text) })?.task ?? null;
        if (!task) return { ok: false, conflict: false, error: { status: 0, code: "invalid_response", message: "update task response missing task" } };
        return { ok: true, value: task };
      }
      if (raw.status === 409) {
        const bodyRec = parseJson(raw.text) as Record<string, unknown> | null;
        const current = parseTeamTaskDetail({ task: bodyRec?.current })?.task ?? null;
        return { ok: false, conflict: true, current };
      }
      return { ok: false, conflict: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `PATCH task failed (${raw.status})`) };
    },

    /** POST /v1/teams/{id}/tasks/{taskId}/assign — distribute or unassign. */
    async assignTeamTask(
      token: string,
      teamId: string,
      taskId: string,
      body: { assignee_id?: string; session_label?: string; unassign?: boolean },
    ): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "assign", body);
    },

    async acceptTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "accept");
    },

    async returnTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "return");
    },

    /** POST …/claims — a member asks to take an unowned task. The row is opaque. */
    async claimTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<null>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/claims`, { token });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** POST …/claims/{claimId}/approve|reject — owner/admin decides a claim. */
    async decideTeamClaim(
      token: string,
      teamId: string,
      taskId: string,
      claimId: string,
      approve: boolean,
    ): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, `claims/${encodeURIComponent(claimId)}/${approve ? "approve" : "reject"}`);
    },

    async autoDispatchTeamTask(token: string, teamId: string, taskId: string, enabled: boolean): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "auto-dispatch", { enabled });
    },

    async moveTeamTaskState(token: string, teamId: string, taskId: string, state: string): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "state", { state });
    },

    /** POST …/comments — body + mentions (account ids). */
    async commentTeamTask(
      token: string,
      teamId: string,
      taskId: string,
      body: string,
      mentions: string[] = [],
    ): Promise<ApiResult<null>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/comments`, {
        token,
        body: { body, mentions },
      });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** POST …/archive — refuses pending claims; returns the owner/state before. */
    async archiveTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<{ dependents: unknown }>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}/archive`, { token });
      if (!res.ok) return res;
      const rec = (res.value ?? {}) as Record<string, unknown>;
      return { ok: true, value: { dependents: rec.dependents ?? [] } };
    },

    async restoreTeamTask(token: string, teamId: string, taskId: string): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "restore");
    },

    /** DELETE …/{taskId} — the body carries the typed `#id` confirmation. */
    async deleteTeamTask(
      token: string,
      teamId: string,
      taskId: string,
      confirm: string,
    ): Promise<ApiResult<{ dependents: unknown }>> {
      const raw = await requestRaw("DELETE", `/v1/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}`, {
        token,
        body: new TextEncoder().encode(JSON.stringify({ confirm })),
        contentType: "application/json",
      });
      if (!raw.ok) return { ok: false, error: parseCloudApiError(raw.status, parseJson(raw.text), `DELETE task failed (${raw.status})`) };
      const rec = (parseJson(raw.text) ?? {}) as Record<string, unknown>;
      return { ok: true, value: { dependents: rec.dependents ?? [] } };
    },

    /** POST …/report — the CLOSED state schema from the app (never code). */
    async reportTeamTaskState(
      token: string,
      teamId: string,
      taskId: string,
      report: { state?: string; report_delivered?: boolean; gates_passed?: number; gates_total?: number; verdict?: string },
    ): Promise<ApiResult<TeamTaskView>> {
      return teamTaskAction(token, teamId, taskId, "report", report);
    },

    // ---- TEAM SPRINTS -------------------------------------------------------

    /** GET /v1/teams/{id}/sprints */
    async listTeamSprints(token: string, teamId: string): Promise<ApiResult<TeamSprintView[]>> {
      const res = await request("GET", `/v1/teams/${encodeURIComponent(teamId)}/sprints`, { token });
      if (!res.ok) return res;
      return { ok: true, value: parseTeamSprintList(res.value) };
    },

    /** POST /v1/teams/{id}/sprints — owner/admin. */
    async createTeamSprint(token: string, teamId: string, body: Record<string, unknown>): Promise<ApiResult<TeamSprintView>> {
      const res = await request("POST", `/v1/teams/${encodeURIComponent(teamId)}/sprints`, { token, body });
      if (!res.ok) return res;
      const sprint = parseTeamSprint(res.value);
      if (!sprint) return { ok: false, error: { status: 0, code: "invalid_response", message: "create sprint response missing sprint" } };
      return { ok: true, value: sprint };
    },

    /** PATCH /v1/teams/{id}/sprints/{sprintId} */
    async updateTeamSprint(
      token: string,
      teamId: string,
      sprintId: string,
      body: Record<string, unknown>,
    ): Promise<ApiResult<TeamSprintView>> {
      const res = await request("PATCH", `/v1/teams/${encodeURIComponent(teamId)}/sprints/${encodeURIComponent(sprintId)}`, { token, body });
      if (!res.ok) return res;
      const sprint = parseTeamSprint(res.value);
      if (!sprint) return { ok: false, error: { status: 0, code: "invalid_response", message: "update sprint response missing sprint" } };
      return { ok: true, value: sprint };
    },

    /** DELETE /v1/teams/{id}/sprints/{sprintId} — 204. */
    async deleteTeamSprint(token: string, teamId: string, sprintId: string): Promise<ApiResult<null>> {
      const res = await request("DELETE", `/v1/teams/${encodeURIComponent(teamId)}/sprints/${encodeURIComponent(sprintId)}`, { token });
      return res.ok ? { ok: true, value: null } : res;
    },
  };
}

export type CloudApi = ReturnType<typeof createCloudApi>;
