import { describe, expect, it } from "vitest";
import { createCloudSessionsApi, parseRemoteSession } from "../../src/main/cloud-sessions-api";
import type { SessionSnapshot } from "../../src/main/cloud-sessions-decision";

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(reply: (seen: Seen) => { status: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      method: String(init.method),
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const r = reply(s);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const snapshot: SessionSnapshot = { schema_version: 1, board: { name: "a", project: "", autonomous: false }, cards: [], connectors: [], tasks: [] };

describe("cloud sessions api", () => {
  it("lists with the token and the install id, and parses the rows", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({
      status: 200,
      body: {
        sessions: [
          { id: "s1", name: "app", project: "app", project_ref: { kind: "git", remote: "github.com/e/app", name: "app" }, revision: 4, card_count: 7, task_count: 12, size_bytes: 9, updated_at: "2026-01-01T00:00:00Z", updated_by_device: "Notebook", archived_at: null },
          { nope: true },
        ],
        total: 1,
      },
    }));
    const api = createCloudSessionsApi({ baseUrl: "https://api.example/", fetchImpl });
    const res = await api.list("tok", "p 1", { installId: "inst", limit: 100 });
    expect(seen[0]).toMatchObject({ method: "GET", url: "https://api.example/v1/profiles/p%201/sessions?limit=100" });
    expect(seen[0]!.headers).toMatchObject({ Authorization: "Bearer tok", "X-Install-Id": "inst" });
    expect(res).toEqual({
      ok: true,
      value: {
        total: 1,
        sessions: [
          { id: "s1", name: "app", project: "app", projectRef: { kind: "git", remote: "github.com/e/app", name: "app" }, revision: 4, cardCount: 7, taskCount: 12, sizeBytes: 9, updatedAt: "2026-01-01T00:00:00Z", updatedByDevice: "Notebook", archivedAt: null },
        ],
      },
    });
  });

  it("puts with a quoted If-Match and the snapshot only", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({ status: 200, body: { revision: 5, updated_at: "t" } }));
    const api = createCloudSessionsApi({ baseUrl: "https://api.example", fetchImpl });
    const res = await api.put("tok", "p", "s1", { revision: 4, snapshot, installId: "inst" });
    expect(seen[0]!.headers["If-Match"]).toBe('"4"');
    expect(seen[0]!.body).toEqual({ snapshot });
    expect(res).toEqual({ ok: true, value: { revision: 5, updatedAt: "t" } });
  });

  it("returns what the account has now on a revision conflict", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: "revision_conflict", message: "m" }, current_revision: 5, current_updated_at: "t", current_updated_by_device: "Notebook", current_summary: { card_count: 11, task_count: 14 } },
    }));
    const res = await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl }).put("tok", "p", "s1", { revision: 4, snapshot });
    expect(res).toEqual({ ok: false, kind: "conflict", currentRevision: 5, currentUpdatedAt: "t", currentDevice: "Notebook", currentSummary: { cardCount: 11, taskCount: 14 } });
  });

  it("creates with the client ref and the project reference, and reads the repeated create", async () => {
    const { fetchImpl, seen } = fakeFetch((s) =>
      (s.body as { client_ref: string }).client_ref === "dup"
        ? { status: 409, body: { error: { code: "session_exists", message: "m" }, id: "s9", revision: 3 } }
        : { status: 201, body: { id: "s1", revision: 1, updated_at: "t" } },
    );
    const api = createCloudSessionsApi({ baseUrl: "https://a", fetchImpl });
    const ok = await api.create("tok", "p", { clientRef: "new", name: "app", project: "app", projectRef: { kind: "folder", name: "app" }, snapshot });
    expect(ok).toEqual({ ok: true, value: { id: "s1", revision: 1 } });
    expect(seen[0]!.body).toMatchObject({ client_ref: "new", name: "app", project_ref: { kind: "folder", name: "app" }, snapshot });
    const dup = await api.create("tok", "p", { clientRef: "dup", name: "app", project: "", projectRef: null, snapshot });
    expect(dup).toEqual({ ok: false, kind: "exists", id: "s9", revision: 3 });
    expect(seen[1]!.body).not.toHaveProperty("project_ref");
  });

  it("reads a session with its snapshot, and refuses one without", async () => {
    const good = fakeFetch(() => ({ status: 200, body: { id: "s1", name: "app", revision: 2, snapshot } }));
    const res = await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl: good.fetchImpl }).get("tok", "p", "s1", { revision: 2 });
    expect(good.seen[0]!.url).toContain("/sessions/s1?revision=2");
    expect(res).toMatchObject({ ok: true, value: { id: "s1", revision: 2, snapshot } });
    const bad = fakeFetch(() => ({ status: 200, body: { id: "s1", name: "app", revision: 2 } }));
    expect(await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl: bad.fetchImpl }).get("tok", "p", "s1")).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });

  it("carries the plan refusal and the retry-after of a rate limit", async () => {
    const plan = fakeFetch(() => ({ status: 402, body: { error: { code: "plan_required", message: "m", feature: "sync", plan: "free" } } }));
    expect(await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl: plan.fetchImpl }).list("tok", "p")).toMatchObject({ ok: false, error: { status: 402, code: "plan_required", feature: "sync" } });
    const limited = fakeFetch(() => ({ status: 429, body: { error: { code: "rate_limited", message: "m" } }, headers: { "Retry-After": "12" } }));
    expect(await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl: limited.fetchImpl }).put("tok", "p", "s", { revision: 1, snapshot })).toMatchObject({ ok: false, retryAfterSec: 12 });
  });

  it("a dropped connection is status 0, never a throw", async () => {
    const { fetchImpl } = fakeFetch(() => new TypeError("fetch failed"));
    expect(await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl }).list("tok", "p")).toMatchObject({ ok: false, error: { status: 0, code: "network" } });
  });

  it("patches the archive flag with the contract's field name", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({ status: 200, body: { id: "s1", name: "app", revision: 1 } }));
    await createCloudSessionsApi({ baseUrl: "https://a", fetchImpl }).patch("tok", "p", "s1", { archivedAt: "2026-01-01T00:00:00Z" });
    expect(seen[0]).toMatchObject({ method: "PATCH", body: { archived_at: "2026-01-01T00:00:00Z" } });
  });

  it("parseRemoteSession ignores rows without an id", () => {
    expect(parseRemoteSession({ name: "x" })).toBeNull();
    expect(parseRemoteSession(null)).toBeNull();
  });
});
