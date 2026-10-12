import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLocale, t } from "../../src/shared/i18n";
import type { CloudPlanInfo, CloudStatusInfo, TeamMemberInfo } from "../../src/preload/index";
import { TeamPage } from "@renderer/TeamPage";
import { serializeCacheEntry, teamCacheKey } from "@renderer/team-load-decision";

/**
 * The Team page paints at once and every section fills in when ITS answer
 * arrives: a fake `window.team` whose calls are resolved by hand proves the
 * page is up (head, skeletons, Ctrl+K) before any answer, that each section
 * fills on its own, and that a failure or a cache is marked per section.
 */

const ME = "33333333-3333-4333-8333-333333333333";
const TEAM = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Nebula Labs", slug: "nebula-labs", shareFilePaths: false };
const MEMBERS: TeamMemberInfo[] = [{ accountId: ME, role: "owner", joinedAt: null, displayName: "Maya Chen", avatarInitials: "MC", email: "maya@example.com" }];
const PLAN: CloudPlanInfo = {
  accountPlan: "free",
  accountExpiresAt: null,
  rights: {
    sync: { granted: false, state: "none", plan: "pro", source: null, teamId: null, expiresAt: null },
    team: { granted: true, state: "active", plan: "team", source: "team", teamId: TEAM.id, expiresAt: null },
  },
};
const STATUS: CloudStatusInfo = { state: "logged-in", apiBaseUrl: "https://api.example.test", account: { displayName: "Maya", identities: [] }, plan: PLAN, expiresAtMs: Date.now() + 60000 };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake `window.team` whose five reads wait for the test to release them. */
function installSlow() {
  const gate = { overview: deferred<unknown>(), detail: deferred<unknown>(), sprints: deferred<unknown>(), invites: deferred<unknown>(), tasks: deferred<unknown>() };
  const team = {
    overview: vi.fn(() => gate.overview.promise),
    detail: vi.fn(() => gate.detail.promise),
    sprints: vi.fn(() => gate.sprints.promise),
    listInvites: vi.fn(() => gate.invites.promise),
    tasks: vi.fn(() => gate.tasks.promise),
  };
  const w = window as unknown as Record<string, unknown>;
  w.team = team;
  w.cloud = { status: async () => STATUS, onStatusChanged: () => () => {}, plansUrl: async () => "https://example.test/planos" };
  return { gate, team };
}

const OVERVIEW = { ok: true, view: { accountId: ME, displayName: "Maya", teams: [TEAM], profiles: [], identitySubjects: [] } };
const DETAIL = { ok: true, detail: { team: TEAM, members: MEMBERS, seats: { used: 1, total: 5, expiresAt: null } } };
const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null;
const skeletons = (section: string) => document.querySelectorAll(`[data-part="team-skeleton"][data-section="${section}"]`).length;
/** The notice that covers `section` (sections that say the same thing share one notice). */
const notice = (section: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-part="team-section-notice"]')).find((el) => (el.getAttribute("data-sections") ?? "").split(",").includes(section)) ?? null;

beforeEach(() => {
  setLocale("pt-BR");
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe("TeamPage loads asynchronously", () => {
  it("paints the head and the skeletons before any answer, and Ctrl+K already works", async () => {
    installSlow();
    render(<TeamPage boards={[]} />);
    expect(part("team-head")).toBeTruthy();
    expect(part("team-title")?.textContent).toBe("Time");
    expect(skeletons("detail")).toBeGreaterThan(0);
    expect(skeletons("tasks")).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(part("team-cmd-palette")).toBeTruthy());
  });

  it("each section fills when its own answer arrives, in any order", async () => {
    const { gate } = installSlow();
    render(<TeamPage boards={[]} />);
    await act(async () => gate.overview.resolve(OVERVIEW));
    await waitFor(() => expect(part("team-title")?.textContent).toBe("Nebula Labs"));
    // All four team calls start together — the tasks do not wait for the detail.
    await waitFor(() => expect((window.team.tasks as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));
    expect(skeletons("detail")).toBeGreaterThan(0);
    expect(skeletons("tasks")).toBeGreaterThan(0);

    await act(async () => gate.tasks.resolve({ ok: true, list: { tasks: [], total: 0, limit: 50, offset: 0 } }));
    await waitFor(() => expect(skeletons("tasks")).toBe(0));
    expect(skeletons("detail")).toBeGreaterThan(0);

    await act(async () => gate.detail.resolve(DETAIL));
    await waitFor(() => expect(skeletons("detail")).toBe(0));
    expect(part("seats-pill")?.textContent).toBe("1 de 5 assentos");
    expect(document.querySelectorAll('[data-part="member-row"]').length).toBe(1);
  });

  it("a section that fails shows its own error and retry; the others are untouched", async () => {
    const { gate, team } = installSlow();
    render(<TeamPage boards={[]} />);
    await act(async () => gate.overview.resolve(OVERVIEW));
    await act(async () => gate.detail.resolve(DETAIL));
    await act(async () => gate.tasks.resolve({ ok: true, list: { tasks: [], total: 0, limit: 50, offset: 0 } }));
    await act(async () => gate.invites.resolve({ ok: true, invites: [] }));
    await act(async () => gate.sprints.resolve({ ok: false, error: "falha em sprints" }));
    await waitFor(() => expect(notice("sprints")?.getAttribute("data-state")).toBe("error"));
    expect(notice("sprints")?.textContent).toContain("falha em sprints");
    expect(notice("detail")).toBeNull();
    expect(document.querySelectorAll('[data-part="member-row"]').length).toBe(1);

    team.sprints.mockImplementation(async () => ({ ok: true, sprints: [] }));
    fireEvent.click(document.querySelector('[data-part="team-section-retry"][data-section="sprints"]')!);
    await waitFor(() => expect(notice("sprints")).toBeNull());
  });

  it("with the backend down, the cache fills the page marked stale with its last-update time", async () => {
    const saved = Date.UTC(2026, 9, 12, 14, 32);
    localStorage.setItem(teamCacheKey("overview", "account"), serializeCacheEntry(OVERVIEW.view, saved, "Maya"));
    localStorage.setItem(teamCacheKey("detail", TEAM.id), serializeCacheEntry(DETAIL.detail, saved, null));
    const { gate } = installSlow();
    render(<TeamPage boards={[]} />);
    // The cached overview and detail paint with no backend answer at all.
    await waitFor(() => expect(part("team-title")?.textContent).toBe("Nebula Labs"));
    await waitFor(() => expect(document.querySelectorAll('[data-part="member-row"]').length).toBe(1));
    expect(notice("detail")?.getAttribute("data-state")).toBe("stale");
    expect(notice("detail")?.textContent).toMatch(/dados de \d{2}\/\d{2}/);
    expect(notice("overview")?.getAttribute("data-state")).toBe("stale");
    // Saved together, so they say it once.
    expect(notice("overview")).toBe(notice("detail"));
    expect(document.querySelectorAll('[data-part="team-section-notice"]').length).toBe(1);

    await act(async () => gate.overview.resolve({ ok: false, error: "sem conexão" }));
    await act(async () => gate.detail.resolve({ ok: false, error: "sem conexão" }));
    // Still on screen, still stale — never presented as confirmed.
    expect(document.querySelectorAll('[data-part="member-row"]').length).toBe(1);
    expect(notice("detail")?.getAttribute("data-state")).toBe("stale");
  });

  it("a cache of another account is not shown", async () => {
    localStorage.setItem(teamCacheKey("overview", "account"), serializeCacheEntry(OVERVIEW.view, Date.now(), "Outra Pessoa"));
    installSlow();
    render(<TeamPage boards={[]} />);
    await screen.findByText("Time");
    await new Promise((r) => setTimeout(r, 30));
    expect(part("team-title")?.textContent).toBe("Time");
    expect(notice("overview")).toBeNull();
  });

  it("does not render the member view while the role is unknown (board)", async () => {
    const { gate } = installSlow();
    render(<TeamPage boards={[]} />);
    await act(async () => gate.overview.resolve(OVERVIEW));
    await waitFor(() => expect(part("team-title")?.textContent).toBe("Nebula Labs"));
    // The board's sub-navigation lives in the sidebar, so the page is asked through the nav store.
    const { setTeamSub } = await import("@renderer/team-nav");
    await act(async () => setTeamSub("board"));
    await waitFor(() => expect(part("team-board")).toBeTruthy());
    expect(screen.queryByText(t("teamTask.member.banner"))).toBeNull();
    expect(skeletons("detail")).toBeGreaterThan(0);
  });
});
