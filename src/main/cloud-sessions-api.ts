/**
 * ACCOUNT SESSIONS — the HTTP client for `/v1/profiles/{id}/sessions` (contract:
 * StellarCloud `docs/stellar/ACCOUNT_SESSIONS.md`, §3). Only the main process
 * builds one: the access token never reaches the renderer.
 *
 * Every call answers `{ ok: true, value }` or `{ ok: false, ... }`; none throws
 * on an HTTP status or a dropped connection. Two answers get their own shape
 * because the screen needs more than an error code from them: the revision
 * conflict (`409 revision_conflict`, with what the account has now) and the
 * repeated create (`409 session_exists`, with the session that already exists).
 */

import { parseCloudApiError, type CloudApiError } from "./cloud-auth-decision";
import type { ProjectRef, SessionSnapshot, SessionSummary } from "./cloud-sessions-decision";

/** A session as the list shows it: no snapshot. */
export type RemoteSession = {
  id: string;
  name: string;
  project: string;
  projectRef: ProjectRef | null;
  revision: number;
  cardCount: number;
  taskCount: number;
  sizeBytes: number;
  updatedAt: string;
  /** The machine that saved this revision ("Notebook"), when the account knows it. */
  updatedByDevice: string | null;
  archivedAt: string | null;
};

export type RemoteSessionDetail = RemoteSession & { snapshot: SessionSnapshot };

export type SessionsApiFailure = { ok: false; kind: "error"; error: CloudApiError; retryAfterSec: number | null };

export type SessionsConflict = {
  ok: false;
  kind: "conflict";
  currentRevision: number;
  currentUpdatedAt: string | null;
  currentDevice: string | null;
  currentSummary: SessionSummary | null;
};

export type SessionsExists = { ok: false; kind: "exists"; id: string; revision: number };

export type SessionsApiResult<T> = { ok: true; value: T } | SessionsApiFailure;

const TIMEOUT_MS = 20_000;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function parseProjectRef(raw: unknown): ProjectRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  if (o.kind === "git") {
    const remote = str(o.remote);
    return remote ? { kind: "git", remote, name } : null;
  }
  if (o.kind === "folder") return { kind: "folder", name };
  return null;
}

export function parseRemoteSession(raw: unknown): RemoteSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    name: str(o.name) ?? "",
    project: str(o.project) ?? "",
    projectRef: parseProjectRef(o.project_ref),
    revision: num(o.revision),
    cardCount: num(o.card_count),
    taskCount: num(o.task_count),
    sizeBytes: num(o.size_bytes),
    updatedAt: str(o.updated_at) ?? "",
    updatedByDevice: str(o.updated_by_device),
    archivedAt: str(o.archived_at),
  };
}

function parseSnapshot(raw: unknown): SessionSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== 1 || typeof o.board !== "object" || o.board === null) return null;
  return {
    schema_version: 1,
    board: o.board as SessionSnapshot["board"],
    cards: Array.isArray(o.cards) ? (o.cards as SessionSnapshot["cards"]) : [],
    connectors: Array.isArray(o.connectors) ? (o.connectors as SessionSnapshot["connectors"]) : [],
    tasks: Array.isArray(o.tasks) ? (o.tasks as SessionSnapshot["tasks"]) : [],
  };
}

export function createCloudSessionsApi(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(
    method: string,
    path: string,
    init: { token: string; installId?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; ok: boolean; json: unknown; headers: Headers | null }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${init.token}`, ...(init.headers ?? {}) };
    if (init.installId) headers["X-Install-Id"] = init.installId;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text().catch(() => "");
      let json: unknown = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: response.status, ok: response.ok, json, headers: response.headers };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        status: 0,
        ok: false,
        json: { error: { code: timedOut ? "timeout" : "network", message: err instanceof Error ? err.message : String(err) } },
        headers: null,
      };
    }
  }

  function failure(r: { status: number; json: unknown; headers: Headers | null }, what: string): SessionsApiFailure {
    const retry = Number(r.headers?.get("Retry-After") ?? "");
    return {
      ok: false,
      kind: "error",
      error: parseCloudApiError(r.status, r.json, `${what} failed (${r.status})`),
      retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null,
    };
  }

  const base = (profileId: string) => `/v1/profiles/${encodeURIComponent(profileId)}/sessions`;

  return {
    async list(
      token: string,
      profileId: string,
      q: { installId?: string; archived?: boolean; limit?: number; offset?: number } = {},
    ): Promise<SessionsApiResult<{ sessions: RemoteSession[]; total: number }>> {
      const params = new URLSearchParams();
      if (q.archived) params.set("archived", "true");
      if (q.limit) params.set("limit", String(q.limit));
      if (q.offset) params.set("offset", String(q.offset));
      const qs = params.toString();
      const r = await call("GET", `${base(profileId)}${qs ? `?${qs}` : ""}`, { token, installId: q.installId });
      if (!r.ok) return failure(r, "list sessions");
      const body = (r.json ?? {}) as Record<string, unknown>;
      const sessions = (Array.isArray(body.sessions) ? body.sessions : []).map(parseRemoteSession).filter((s): s is RemoteSession => s !== null);
      return { ok: true, value: { sessions, total: num(body.total) || sessions.length } };
    },

    async create(
      token: string,
      profileId: string,
      input: { clientRef: string; name: string; project: string; projectRef: ProjectRef | null; snapshot: SessionSnapshot; installId?: string },
    ): Promise<SessionsApiResult<{ id: string; revision: number }> | SessionsExists> {
      const body: Record<string, unknown> = {
        client_ref: input.clientRef,
        name: input.name,
        project: input.project,
        snapshot: input.snapshot,
      };
      if (input.projectRef) body.project_ref = input.projectRef;
      const r = await call("POST", base(profileId), { token, installId: input.installId, body });
      if (r.ok) {
        const o = (r.json ?? {}) as Record<string, unknown>;
        return { ok: true, value: { id: str(o.id) ?? "", revision: num(o.revision) || 1 } };
      }
      const e = parseCloudApiError(r.status, r.json, "create session failed");
      if (r.status === 409 && e.code === "session_exists") {
        const o = (r.json ?? {}) as Record<string, unknown>;
        const top = (typeof o.error === "object" && o.error !== null ? o.error : {}) as Record<string, unknown>;
        const id = str(o.id) ?? str(top.id);
        const revision = num(o.revision) || num(top.revision);
        if (id) return { ok: false, kind: "exists", id, revision };
      }
      return failure(r, "create session");
    },

    async get(
      token: string,
      profileId: string,
      sessionId: string,
      q: { revision?: number; installId?: string } = {},
    ): Promise<SessionsApiResult<RemoteSessionDetail>> {
      const qs = q.revision ? `?revision=${q.revision}` : "";
      const r = await call("GET", `${base(profileId)}/${encodeURIComponent(sessionId)}${qs}`, { token, installId: q.installId });
      if (!r.ok) return failure(r, "read session");
      const session = parseRemoteSession(r.json);
      const snapshot = parseSnapshot((r.json as Record<string, unknown> | null)?.snapshot);
      if (!session || !snapshot) {
        return { ok: false, kind: "error", error: { status: 0, code: "invalid_response", message: "session without a readable snapshot" }, retryAfterSec: null };
      }
      return { ok: true, value: { ...session, snapshot } };
    },

    async put(
      token: string,
      profileId: string,
      sessionId: string,
      input: { revision: number; snapshot: SessionSnapshot; installId?: string },
    ): Promise<SessionsApiResult<{ revision: number; updatedAt: string }> | SessionsConflict> {
      const r = await call("PUT", `${base(profileId)}/${encodeURIComponent(sessionId)}`, {
        token,
        installId: input.installId,
        body: { snapshot: input.snapshot },
        headers: { "If-Match": `"${input.revision}"` },
      });
      if (r.ok) {
        const o = (r.json ?? {}) as Record<string, unknown>;
        return { ok: true, value: { revision: num(o.revision) || input.revision + 1, updatedAt: str(o.updated_at) ?? "" } };
      }
      const e = parseCloudApiError(r.status, r.json, "save session failed");
      if (r.status === 409 && e.code === "revision_conflict") {
        const o = (r.json ?? {}) as Record<string, unknown>;
        const s = (typeof o.current_summary === "object" && o.current_summary !== null ? o.current_summary : null) as Record<string, unknown> | null;
        return {
          ok: false,
          kind: "conflict",
          currentRevision: num(o.current_revision),
          currentUpdatedAt: str(o.current_updated_at),
          currentDevice: str(o.current_updated_by_device),
          currentSummary: s ? { cardCount: num(s.card_count), taskCount: num(s.task_count) } : null,
        };
      }
      return failure(r, "save session");
    },

    /** PATCH metadata; `archivedAt: null` unarchives. */
    async patch(
      token: string,
      profileId: string,
      sessionId: string,
      body: { name?: string; project?: string; archivedAt?: string | null },
      installId?: string,
    ): Promise<SessionsApiResult<RemoteSession>> {
      const payload: Record<string, unknown> = {};
      if (body.name !== undefined) payload.name = body.name;
      if (body.project !== undefined) payload.project = body.project;
      if (body.archivedAt !== undefined) payload.archived_at = body.archivedAt;
      const r = await call("PATCH", `${base(profileId)}/${encodeURIComponent(sessionId)}`, { token, installId, body: payload });
      if (!r.ok) return failure(r, "update session");
      const session = parseRemoteSession(r.json);
      if (!session) return { ok: false, kind: "error", error: { status: 0, code: "invalid_response", message: "no session in the answer" }, retryAfterSec: null };
      return { ok: true, value: session };
    },
  };
}

export type CloudSessionsApi = ReturnType<typeof createCloudSessionsApi>;
