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
import { parseRemoteManifestEntry, type RemoteManifestEntry } from "./work-home-manifest";
import {
  parseTeamDetail,
  parseTeamInvite,
  parseTeamListView,
  type TeamDetailView,
  type TeamInviteView,
  type TeamListView,
  type TeamMemberView,
  type TeamRole,
  type TeamSummary,
} from "./team-decision";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: CloudApiError };

/** Resultado do PUT da casa: sucesso, CONFLITO (409 com o manifesto atual) ou erro. */
export type PutHouseResult =
  | { ok: true; value: { revision: number; manifest: RemoteManifestEntry[] } }
  | { ok: false; conflict: true; currentRevision: number; currentManifest: RemoteManifestEntry[] }
  | { ok: false; conflict: false; error: CloudApiError };

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

    async health(): Promise<boolean> {
      const res = await request("GET", "/v1/healthz");
      return res.ok;
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

    /** POST /v1/invites/{token}/accept — the signed-in account must match the target. */
    async acceptInvite(token: string, rawToken: string): Promise<ApiResult<{ team: TeamSummary; membership: TeamMemberView }>> {
      const res = await request("POST", `/v1/invites/${encodeURIComponent(rawToken)}/accept`, { token });
      if (!res.ok) return res;
      const body = (res.value ?? {}) as Record<string, unknown>;
      const team = parseTeamDetail(body)?.team ?? null;
      const membershipRaw = typeof body.membership === "object" && body.membership !== null ? (body.membership as Record<string, unknown>) : null;
      const membership =
        membershipRaw && typeof membershipRaw.account_id === "string" && typeof membershipRaw.role === "string"
          ? { accountId: membershipRaw.account_id, role: membershipRaw.role as TeamRole, joinedAt: typeof membershipRaw.joined_at === "string" ? membershipRaw.joined_at : null }
          : null;
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
      const rec = (res.value ?? {}) as Record<string, unknown>;
      if (typeof rec.account_id !== "string" || typeof rec.role !== "string") {
        return { ok: false, error: { status: 0, code: "invalid_response", message: "member response missing fields" } };
      }
      return {
        ok: true,
        value: { accountId: rec.account_id, role: rec.role as TeamRole, joinedAt: typeof rec.joined_at === "string" ? rec.joined_at : null },
      };
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
  };
}

export type CloudApi = ReturnType<typeof createCloudApi>;
