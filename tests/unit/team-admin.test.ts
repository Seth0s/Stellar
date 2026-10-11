import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTeamInviteWithDelivery,
  deleteTeamOp,
  previewTeamInvite,
  renameTeamOp,
} from "../../src/main/team-admin";
import {
  extractInviteToken,
  inviteTokenForAccept,
  maskInviteTarget,
  parseInvitePreview,
  parseTeamDetail,
  parseTeamInvite,
  parseTeamInviteCreated,
} from "../../src/main/team-decision";
import type { TeamContext } from "../../src/main/team";

const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVITE_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "ex_tok_7f3a9c2e1b4d5e6f";

type Call = { method: string; url: string; auth: string | null; body: unknown };

function fakeFetch(reply: (call: Call) => { status: number; body?: unknown }): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status, body } = reply(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

function ctx(): TeamContext {
  return {
    api: { baseUrl: "https://api.example.test" },
    token: "tok",
    baseUserDataDir: mkdtempSync(join(tmpdir(), "team-admin-")),
  } as unknown as TeamContext;
}

const inviteBody = {
  id: INVITE_ID,
  team_id: TEAM_ID,
  target: "kai@example.com",
  role: "member",
  expires_at: "2026-10-18T00:00:00Z",
  delivery: "link",
  invite_url: `https://stellar.example.test/invite#t=${TOKEN}`,
};

describe("createTeamInviteWithDelivery", () => {
  it("link: sends delivery and returns the one-time URL", async () => {
    const f = fakeFetch(() => ({ status: 201, body: inviteBody }));
    const res = await createTeamInviteWithDelivery(ctx(), TEAM_ID, { target: " kai@example.com ", role: "member", delivery: "link" }, f.impl);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.invite.delivery).toBe("link");
    expect(res.invite.inviteUrl).toBe(`https://stellar.example.test/invite#t=${TOKEN}`);
    expect(f.calls[0]).toMatchObject({
      method: "POST",
      url: `https://api.example.test/v1/teams/${TEAM_ID}/invites`,
      auth: "Bearer tok",
      body: { target: "kai@example.com", role: "member", delivery: "link" },
    });
  });

  it("email is the default delivery and carries no URL", async () => {
    const f = fakeFetch(() => ({ status: 201, body: { ...inviteBody, delivery: "email", invite_url: undefined } }));
    const res = await createTeamInviteWithDelivery(ctx(), TEAM_ID, { target: "kai@example.com", role: "admin" }, f.impl);
    expect(res.ok && res.invite.delivery).toBe("email");
    expect(res.ok && res.invite.inviteUrl).toBeNull();
    expect((f.calls[0].body as { delivery: string }).delivery).toBe("email");
  });

  it("maps seats_exceeded, email_unavailable (503) and forbidden", async () => {
    const reasons: Record<string, string> = {};
    for (const [status, code] of [
      [402, "seats_exceeded"],
      [503, "email_unavailable"],
      [403, "forbidden"],
      [500, "boom"],
    ] as const) {
      const f = fakeFetch(() => ({ status, body: { error: { code, message: `msg ${code}` } } }));
      const res = await createTeamInviteWithDelivery(ctx(), TEAM_ID, { target: "kai@example.com", role: "member" }, f.impl);
      reasons[code] = res.ok ? "ok" : `${res.reason}|${res.error}`;
    }
    expect(reasons).toEqual({
      seats_exceeded: "seats-exceeded|msg seats_exceeded",
      email_unavailable: "email-unavailable|msg email_unavailable",
      forbidden: "forbidden|msg forbidden",
      boom: "error|msg boom",
    });
  });

  it("rejects an invalid target without calling the server", async () => {
    const f = fakeFetch(() => ({ status: 201, body: inviteBody }));
    const res = await createTeamInviteWithDelivery(ctx(), TEAM_ID, { target: "not an id!", role: "member" }, f.impl);
    expect(res).toMatchObject({ ok: false, reason: "invalid-target" });
    expect(f.calls).toHaveLength(0);
  });

  it("a network failure is an error, not a throw", async () => {
    const impl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const res = await createTeamInviteWithDelivery(ctx(), TEAM_ID, { target: "kai@example.com", role: "member" }, impl);
    expect(res).toMatchObject({ ok: false, reason: "error", error: "down" });
  });
});

describe("previewTeamInvite", () => {
  it("reads the public preview without a token header", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: { team_name: "Nebula Labs", invited_by_name: "Maya Chen", role: "member", target_masked: "k***@example.com", expires_at: "2026-10-18T00:00:00Z" },
    }));
    const res = await previewTeamInvite("https://api.example.test/", TOKEN, f.impl);
    expect(res).toEqual({
      ok: true,
      preview: { teamName: "Nebula Labs", invitedByName: "Maya Chen", role: "member", targetMasked: "k***@example.com", expiresAt: "2026-10-18T00:00:00Z" },
    });
    expect(f.calls[0]).toMatchObject({ method: "GET", url: `https://api.example.test/v1/invites/${TOKEN}/preview`, auth: null });
  });

  it("every invalid state is the same not-found", async () => {
    const f = fakeFetch(() => ({ status: 404, body: { error: { code: "not_found", message: "not found" } } }));
    expect(await previewTeamInvite("https://api.example.test", TOKEN, f.impl)).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("a server failure is an error, not not-found", async () => {
    const f = fakeFetch(() => ({ status: 500 }));
    expect(await previewTeamInvite("https://api.example.test", TOKEN, f.impl)).toMatchObject({ ok: false, reason: "error" });
  });
});

describe("renameTeamOp / deleteTeamOp", () => {
  it("renames with the trimmed name and returns the unchanged slug", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { id: TEAM_ID, name: "Nebula", slug: "nebula-labs", share_file_paths: false } }));
    const res = await renameTeamOp(ctx(), TEAM_ID, "  Nebula  ", f.impl);
    expect(res).toEqual({ ok: true, team: { id: TEAM_ID, name: "Nebula", slug: "nebula-labs" } });
    expect(f.calls[0]).toMatchObject({ method: "PATCH", url: `https://api.example.test/v1/teams/${TEAM_ID}`, body: { name: "Nebula" } });
  });

  it("refuses an empty or too long name before the network", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    expect(await renameTeamOp(ctx(), TEAM_ID, "   ", f.impl)).toMatchObject({ ok: false });
    expect(await renameTeamOp(ctx(), TEAM_ID, "x".repeat(81), f.impl)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it("delete sends the confirm slug; a 403 comes back as an error", async () => {
    const ok = fakeFetch(() => ({ status: 204 }));
    expect(await deleteTeamOp(ctx(), TEAM_ID, " nebula-labs ", ok.impl)).toEqual({ ok: true });
    expect(ok.calls[0]).toMatchObject({ method: "DELETE", body: { confirm: "nebula-labs" } });

    const denied = fakeFetch(() => ({ status: 403, body: { error: { code: "forbidden", message: "only the owner" } } }));
    expect(await deleteTeamOp(ctx(), TEAM_ID, "nebula-labs", denied.impl)).toEqual({ ok: false, error: "only the owner" });
    expect(await deleteTeamOp(ctx(), TEAM_ID, "  ", denied.impl)).toMatchObject({ ok: false });
  });
});

describe("invite token and preview reading", () => {
  it("extracts the raw token and the #t= fragment of a pasted link", () => {
    expect(extractInviteToken(TOKEN)).toBe(TOKEN);
    expect(extractInviteToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(extractInviteToken(`https://stellar.idyplatform.com/invite#t=${TOKEN}`)).toBe(TOKEN);
    expect(extractInviteToken(`https://stellar.idyplatform.com/invite#t=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(extractInviteToken(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(extractInviteToken(`t=${TOKEN}`)).toBe(TOKEN);
  });

  it("applies the same token rule: too short, too long, odd characters or no fragment are null", () => {
    expect(extractInviteToken("short")).toBeNull();
    expect(extractInviteToken("a".repeat(201))).toBeNull();
    expect(extractInviteToken("has space in the middle of it")).toBeNull();
    expect(extractInviteToken(`https://stellar.idyplatform.com/invite?t=${TOKEN}`)).toBeNull();
    expect(extractInviteToken("https://stellar.idyplatform.com/invite")).toBeNull();
    expect(extractInviteToken("https://stellar.idyplatform.com/invite#t=short")).toBeNull();
    expect(extractInviteToken("")).toBeNull();
  });

  it("accepting keeps an old short deep-link token but never reads a link loosely", () => {
    expect(inviteTokenForAccept("invite-token-1")).toBe("invite-token-1");
    expect(inviteTokenForAccept(`https://x.test/invite#t=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenForAccept("https://x.test/invite")).toBeNull();
    expect(inviteTokenForAccept("   ")).toBeNull();
  });

  it("masks like the server: first letter only", () => {
    expect(maskInviteTarget("kai@example.com")).toBe("k***@example.com");
    expect(maskInviteTarget("octocat")).toBe("o***");
    expect(maskInviteTarget("")).toBe("");
  });

  it("parseInvitePreview requires a team name and a role", () => {
    expect(parseInvitePreview({ team_name: "T", role: "admin" })).toMatchObject({ teamName: "T", role: "admin", invitedByName: "", targetMasked: "" });
    expect(parseInvitePreview({ role: "admin" })).toBeNull();
    expect(parseInvitePreview({ team_name: "T", role: "root" })).toBeNull();
  });

  it("invites keep their expiry; the created reply carries delivery and URL", () => {
    expect(parseTeamInvite(inviteBody)).toMatchObject({ expiresAt: "2026-10-18T00:00:00Z" });
    expect(parseTeamInvite({ ...inviteBody, expires_at: null })).toMatchObject({ expiresAt: null });
    expect(parseTeamInviteCreated(inviteBody, "email")).toMatchObject({ delivery: "link", inviteUrl: inviteBody.invite_url });
    expect(parseTeamInviteCreated({ ...inviteBody, delivery: undefined, invite_url: undefined }, "email")).toMatchObject({ delivery: "email", inviteUrl: null });
  });
});

describe("seats on the team detail", () => {
  const team = { id: TEAM_ID, name: "Nebula Labs", slug: "nebula-labs" };

  it("reads used/total/expires_at; a team with no plan has null seats", () => {
    expect(parseTeamDetail({ team, members: [], seats: { used: 3, total: 5, expires_at: "2027-01-01T00:00:00Z" } })?.seats).toEqual({
      used: 3,
      total: 5,
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parseTeamDetail({ team, members: [], seats: { used: 3, total: 5, expires_at: null } })?.seats?.expiresAt).toBeNull();
    expect(parseTeamDetail({ team, members: [], seats: null })?.seats).toBeNull();
    expect(parseTeamDetail({ team, members: [] })?.seats).toBeNull();
  });

  it("drops a malformed seats block instead of inventing numbers", () => {
    expect(parseTeamDetail({ team, members: [], seats: { used: "3", total: 5 } })?.seats).toBeNull();
    expect(parseTeamDetail({ team, members: [], seats: { used: -1, total: 5 } })?.seats).toBeNull();
  });
});
