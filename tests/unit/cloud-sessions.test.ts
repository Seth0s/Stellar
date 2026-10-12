import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudSessions, type CloudSessionsDeps } from "../../src/main/cloud-sessions";
import { createSessionLinks } from "../../src/main/cloud-sessions-links";
import type { CloudSessionsApi, RemoteSession, RemoteSessionDetail } from "../../src/main/cloud-sessions-api";
import type { SessionSnapshot } from "../../src/main/cloud-sessions-decision";
import { openStore, type BoardRow, type CardRow, type TaskRow } from "../../src/main/store";

/** The account, as far as the app can tell: revisions, the revision check, and nothing else. */
function fakeAccount() {
  const sessions = new Map<string, { meta: Omit<RemoteSession, "revision" | "cardCount" | "taskCount">; revisions: SessionSnapshot[]; clientRef: string }>();
  const calls: string[] = [];
  let n = 0;
  let failWith: { status: number; code: string } | null = null;
  const summary = (s: SessionSnapshot) => ({ cardCount: s.cards.length, taskCount: s.tasks.length });
  const view = (id: string): RemoteSession => {
    const s = sessions.get(id)!;
    const cur = s.revisions[s.revisions.length - 1]!;
    return { ...s.meta, id, revision: s.revisions.length, ...summary(cur) };
  };
  const err = () => ({ ok: false as const, kind: "error" as const, error: { status: failWith!.status, code: failWith!.code, message: "x" }, retryAfterSec: null });
  const api = {
    async list() {
      calls.push("list");
      if (failWith) return err();
      return { ok: true as const, value: { sessions: [...sessions.keys()].map(view), total: sessions.size } };
    },
    async create(_t: string, _p: string, input: { clientRef: string; name: string; project: string; projectRef: RemoteSession["projectRef"]; snapshot: SessionSnapshot }) {
      calls.push("create");
      if (failWith) return err();
      for (const [id, s] of sessions) {
        if (s.clientRef === input.clientRef) return { ok: false as const, kind: "exists" as const, id, revision: s.revisions.length };
      }
      const id = `sess-${++n}`;
      sessions.set(id, {
        clientRef: input.clientRef,
        revisions: [input.snapshot],
        meta: { id, name: input.name, project: input.project, projectRef: input.projectRef, sizeBytes: 1, updatedAt: "2026-01-01T00:00:00Z", updatedByDevice: null, archivedAt: null },
      });
      return { ok: true as const, value: { id, revision: 1 } };
    },
    async get(_t: string, _p: string, id: string): Promise<{ ok: true; value: RemoteSessionDetail } | { ok: false; kind: "error"; error: { status: number; code: string; message: string }; retryAfterSec: null }> {
      calls.push("get");
      if (failWith) return err();
      const s = sessions.get(id);
      if (!s) return { ok: false, kind: "error", error: { status: 404, code: "not_found", message: "x" }, retryAfterSec: null };
      return { ok: true, value: { ...view(id), snapshot: s.revisions[s.revisions.length - 1]! } };
    },
    async put(_t: string, _p: string, id: string, input: { revision: number; snapshot: SessionSnapshot }) {
      calls.push(`put@${input.revision}`);
      if (failWith) return err();
      const s = sessions.get(id)!;
      if (input.revision !== s.revisions.length) {
        return {
          ok: false as const,
          kind: "conflict" as const,
          currentRevision: s.revisions.length,
          currentUpdatedAt: "2026-01-02T00:00:00Z",
          currentDevice: "Notebook",
          currentSummary: summary(s.revisions[s.revisions.length - 1]!),
        };
      }
      s.revisions.push(input.snapshot);
      return { ok: true as const, value: { revision: s.revisions.length, updatedAt: "2026-01-03T00:00:00Z" } };
    },
    async patch(_t: string, _p: string, id: string) {
      calls.push("patch");
      if (failWith) return err();
      sessions.get(id)!.meta.archivedAt = "2026-01-04T00:00:00Z";
      return { ok: true as const, value: view(id) };
    },
  } as unknown as CloudSessionsApi;
  return {
    api,
    sessions,
    calls,
    fail: (f: { status: number; code: string } | null) => (failWith = f),
    /** Another machine saved a new revision. */
    otherMachineSaves(id: string, snapshot: SessionSnapshot) {
      sessions.get(id)!.revisions.push(snapshot);
    },
  };
}

let dir: string;
let store: ReturnType<typeof openStore>;
let account: ReturnType<typeof fakeAccount>;
let idSeq = 0;
let token: string | null;
let folders: Set<string>;
let remotes: Record<string, string | null>;
let resumes: Set<string>;

const PROFILE = "prof-1";
const now = 1_000_000;

function board(id: string, cwd: string, extra: Partial<BoardRow> = {}): BoardRow {
  return { id, name: `Board ${id}`, project: "app", cwd, created_at: now, updated_at: now, last_accessed_at: null, autonomous: false, concurrency_cap: null, orchestrator_card_id: null, account_profile_id: PROFILE, ...extra };
}

function card(id: string, boardId: string, over: Partial<CardRow> = {}): CardRow {
  return { id, board_id: boardId, kind: "terminal", provider: "claude", cwd: "/home/ana/dev/app", x: 0, y: 0, w: 100, h: 100, resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null, updated_at: now, messages_json: null, archived_at: null, ...over };
}

function task(id: string, boardId: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id, prompt: `do ${id}`, provider: "claude", status: "pending", card_id: null, board_id: boardId, cwd: null, spawn_profile: null, result_json: null, deps_json: null,
    retry_count: 0, attempted_providers_json: null, max_retries: null, fallback_providers_json: null, order: null, suggested_order: null, implicit_order: null,
    diverged_status: null, diverged_actor: null, created_at: now, updated_at: now, ...over,
  };
}

function service(over: Partial<CloudSessionsDeps> = {}) {
  return createCloudSessions({
    api: account.api,
    links: createSessionLinks(dir),
    store,
    ensureToken: async () => token,
    installId: () => "install-1",
    now: () => now,
    newId: () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`,
    fallbackCwd: () => "/home/bo",
    gitRemote: async (root) => remotes[root] ?? null,
    folderExists: async (p) => folders.has(p),
    resumeExists: (c) => resumes.has(c.resumeId),
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cloud-sessions-"));
  store = openStore(dir);
  account = fakeAccount();
  idSeq = 0;
  token = "tok";
  folders = new Set(["/home/ana/dev/app", "/Users/bo/code/app"]);
  remotes = { "/home/ana/dev/app": "git@github.com:exemplo/app.git", "/Users/bo/code/app": "https://github.com/exemplo/app" };
  resumes = new Set();
  store.upsertBoard(board("b1", "/home/ana/dev/app"));
  store.upsertCard(card("c1", "b1", { resume_id: "conv-1", model: "sonnet", cwd: "/home/ana/dev/app/src" }));
  store.upsertCard(card("c2", "b1", { kind: "sticky", cwd: "note", provider: "yellow" }));
  store.upsertCard(card("m1", "b1", { kind: "media" }));
  store.upsertConnector({ id: "k1", board_id: "b1", from_card_id: "c1", to_card_id: "c2", updated_at: now, kind: null, label: null });
  store.upsertTask(task("t1", "b1", { status: "running" }));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("save", () => {
  it("creates the session the first time and updates it after, with the revision it saw", async () => {
    const svc = service();
    const first = await svc.save("b1", PROFILE);
    expect(first).toMatchObject({ ok: true, created: true, revision: 1, summary: { cardCount: 2, taskCount: 1 }, omitted: 1 });
    const second = await svc.save("b1", PROFILE);
    expect(second).toMatchObject({ ok: true, created: false, revision: 2 });
    expect(account.calls.filter((c) => c !== "list")).toEqual(["create", "put@1"]);
    expect(svc.link("b1")).toMatchObject({ profileId: PROFILE, revision: 2 });
  });

  it("sends the project as a reference and no absolute path", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    const stored = [...account.sessions.values()][0]!;
    expect(stored.meta.projectRef).toEqual({ kind: "git", remote: "github.com/exemplo/app", name: "app" });
    expect(JSON.stringify(stored.revisions[0])).not.toContain("/home/ana");
  });

  it("a board whose link and client ref were both forgotten starts a new session", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    createSessionLinks(dir).remove("b1");
    const again = await svc.save("b1", PROFILE);
    expect(again).toMatchObject({ ok: true, created: true });
    expect(account.sessions.size).toBe(2);
  });

  it("adopts the existing session when only the link was lost", async () => {
    const links = createSessionLinks(dir);
    const svc = service({ links });
    const first = await svc.save("b1", PROFILE);
    expect(first.ok).toBe(true);
    // Keep the client_ref, drop the link: what a crash between create and link would leave.
    const file = join(dir, "account-sessions.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.links = {};
    writeFileSync(file, JSON.stringify(raw));
    const again = await svc.save("b1", PROFILE);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(account.sessions.size).toBe(1);
  });

  it("reports a conflict with what both sides have, and does not write", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    const id = [...account.sessions.keys()][0]!;
    account.otherMachineSaves(id, { schema_version: 1, board: { name: "x", project: "", autonomous: false }, cards: [{ ref: "z", kind: "task", x: 0, y: 0, w: 1, h: 1 }], connectors: [], tasks: [] });
    store.upsertCard(card("c3", "b1", { kind: "files" }));
    const res = await svc.save("b1", PROFILE);
    expect(res).toMatchObject({
      ok: false,
      conflict: { currentRevision: 2, currentDevice: "Notebook", currentSummary: { cardCount: 1, taskCount: 0 }, mine: { cardCount: 3 }, baseRevision: 1 },
    });
    expect(account.sessions.get(id)!.revisions).toHaveLength(2);
    expect(svc.link("b1")!.revision).toBe(1);
  });

  it("refuses a board of another profile and a missing board", async () => {
    store.upsertBoard(board("b2", "/x", { account_profile_id: "other" }));
    const svc = service();
    expect(await svc.save("b2", PROFILE)).toMatchObject({ ok: false, failure: { state: "error", code: "other_profile" } });
    expect(await svc.save("nope", PROFILE)).toMatchObject({ ok: false, failure: { code: "no_board" } });
  });

  it.each([
    [{ status: 402, code: "plan_required" }, { state: "plan", expired: false }],
    [{ status: 402, code: "plan_expired" }, { state: "plan", expired: true }],
    [{ status: 0, code: "network" }, { state: "offline" }],
    [{ status: 422, code: "session_limit_reached" }, { state: "limit" }],
  ])("maps %j to %j and sends nothing again", async (api, failure) => {
    account.fail(api);
    const res = await service().save("b1", PROFILE);
    expect(res).toEqual({ ok: false, failure });
    expect(service().link("b1")).toBeNull();
  });

  it("asks for a login when there is no token", async () => {
    token = null;
    expect(await service().save("b1", PROFILE)).toEqual({ ok: false, failure: { state: "login" } });
    expect(account.calls).toEqual([]);
  });
});

describe("conflict", () => {
  async function conflicted() {
    const svc = service();
    await svc.save("b1", PROFILE);
    const id = [...account.sessions.keys()][0]!;
    account.otherMachineSaves(id, { schema_version: 1, board: { name: "From the account", project: "app", autonomous: false }, cards: [{ ref: "z", kind: "terminal", x: 1, y: 2, w: 3, h: 4, provider: "claude", resume_id: "gone" }], connectors: [], tasks: [] });
    store.upsertCard(card("c3", "b1", { kind: "files" }));
    return { svc, id };
  }

  it("keep mine saves again over the revision the account has now", async () => {
    const { svc, id } = await conflicted();
    const res = await svc.resolveConflict("b1", PROFILE, "mine");
    expect(res).toMatchObject({ ok: true, choice: "mine", revision: 3, summary: { cardCount: 3 } });
    expect(account.sessions.get(id)!.revisions).toHaveLength(3);
    expect(svc.link("b1")!.revision).toBe(3);
  });

  it("keep the account's opens that revision as a new board and moves the link", async () => {
    const { svc } = await conflicted();
    const before = store.listBoards().length;
    const res = await svc.resolveConflict("b1", PROFILE, "account");
    expect(res).toMatchObject({ ok: true, choice: "account", revision: 2, cleanTerminals: 1 });
    if (!res.ok || res.choice !== "account") throw new Error("expected account choice");
    expect(store.listBoards().length).toBe(before + 1);
    expect(store.getBoard(res.boardId)).toMatchObject({ name: "From the account", account_profile_id: PROFILE });
    expect(svc.link(res.boardId)).toMatchObject({ revision: 2 });
    expect(svc.link("b1")).toBeNull();
    // What this machine changed is still on the old board.
    expect(store.listCards("b1").map((c) => c.id)).toContain("c3");
  });

  it("needs a link to settle anything", async () => {
    expect(await service().resolveConflict("b1", PROFILE, "mine")).toMatchObject({ ok: false, failure: { code: "no_link" } });
  });
});

describe("open", () => {
  async function savedElsewhere() {
    const svc = service();
    await svc.save("b1", PROFILE);
    return [...account.sessions.keys()][0]!;
  }

  it("makes a new board of the profile with the clone found by its git remote", async () => {
    const id = await savedElsewhere();
    // Another machine: its own link file, its own database, its own folders.
    const dir2 = mkdtempSync(join(tmpdir(), "cloud-sessions-b-"));
    const store2 = openStore(dir2);
    try {
      store2.upsertBoard(board("local", "/Users/bo/code/app", { account_profile_id: null }));
      const svc2 = service({ store: store2, links: createSessionLinks(dir2), resumeExists: () => false });
      const res = await svc2.open(PROFILE, id);
      expect(res).toMatchObject({ ok: true, revision: 1, cleanTerminals: 1, cardCount: 2, folder: "/Users/bo/code/app" });
      if (!res.ok) throw new Error("not ok");
      const opened = store2.getBoard(res.boardId)!;
      expect(opened).toMatchObject({ cwd: "/Users/bo/code/app", account_profile_id: PROFILE, name: "Board b1" });
      const cards = store2.listCards(res.boardId);
      expect(cards).toHaveLength(2);
      const terminal = cards.find((c) => c.kind === "terminal")!;
      expect(terminal).toMatchObject({ cwd: "/Users/bo/code/app/src", resume_id: null, model: "sonnet" });
      expect(cards.find((c) => c.kind === "sticky")).toMatchObject({ cwd: "note", provider: "yellow" });
      expect(store2.listConnectors(res.boardId)).toHaveLength(1);
      const tasks = store2.listTasksByBoard(res.boardId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "pending", prompt: "do t1" });
    } finally {
      store2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("keeps the conversation when it exists here", async () => {
    const id = await savedElsewhere();
    resumes.add("conv-1");
    const res = await service().open(PROFILE, id, { kind: "path", path: "/Users/bo/code/app" });
    if (!res.ok) throw new Error("not ok");
    expect(res.cleanTerminals).toBe(0);
    expect(store.listCards(res.boardId).find((c) => c.kind === "terminal")!.resume_id).toBe("conv-1");
  });

  it("asks for a folder when no clone is found, listing what looks close", async () => {
    const id = await savedElsewhere();
    folders = new Set(["/Users/bo/other/app"]);
    remotes = { "/Users/bo/other/app": "https://github.com/outro/app" };
    store.upsertBoard(board("local", "/Users/bo/other/app", { account_profile_id: null }));
    // The saving board's own folder is gone on this machine.
    store.upsertBoard(board("b1", "/home/ana/dev/app"));
    const res = await service().open(PROFILE, id);
    expect(res).toMatchObject({ ok: false, needsFolder: { projectRef: { kind: "git", remote: "github.com/exemplo/app" }, candidates: [{ path: "/Users/bo/other/app", match: "name" }] } });
    expect(store.listBoards().filter((b) => b.id !== "b1" && b.id !== "local")).toHaveLength(0);
  });

  it("opens without a folder when asked, every card in the fallback directory", async () => {
    const id = await savedElsewhere();
    const res = await service().open(PROFILE, id, { kind: "none" });
    if (!res.ok) throw new Error("not ok");
    expect(res.folder).toBeNull();
    expect(store.getBoard(res.boardId)!.cwd).toBe("/home/bo");
    expect(store.listCards(res.boardId).find((c) => c.kind === "terminal")!.cwd).toBe("/home/bo");
  });

  it("a chosen folder that is missing asks again", async () => {
    const id = await savedElsewhere();
    const res = await service().open(PROFILE, id, { kind: "path", path: "/nope" });
    expect(res).toMatchObject({ ok: false, needsFolder: expect.anything() });
  });

  it("maps a failure to the screen's state and writes nothing", async () => {
    const id = await savedElsewhere();
    account.fail({ status: 0, code: "network" });
    const before = store.listBoards().length;
    expect(await service().open(PROFILE, id, { kind: "none" })).toEqual({ ok: false, failure: { state: "offline" } });
    expect(store.listBoards().length).toBe(before);
  });
});

describe("list", () => {
  it("marks the session a board here holds", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    const res = await svc.list(PROFILE);
    expect(res).toMatchObject({ ok: true, total: 1, sessions: [{ revision: 1, cardCount: 2, taskCount: 1, openHereBoardId: "b1" }] });
  });

  it("does not mark a board that no longer exists", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    store.deleteBoard("b1");
    const res = await svc.list(PROFILE);
    expect(res).toMatchObject({ ok: true, sessions: [{ openHereBoardId: null }] });
  });

  it("says why it could not list", async () => {
    account.fail({ status: 402, code: "plan_required" });
    expect(await service().list(PROFILE)).toEqual({ ok: false, failure: { state: "plan", expired: false } });
  });
});

describe("preview and archive", () => {
  it("shows what a save would send without calling the account", async () => {
    const res = await service().preview("b1");
    expect(res).toMatchObject({ ok: true, summary: { cardCount: 2, taskCount: 1 }, connectors: 1, omitted: 1, overLimit: 0, projectRef: { kind: "git" }, link: null });
    expect(account.calls).toEqual([]);
  });

  it("archives through the account", async () => {
    const svc = service();
    await svc.save("b1", PROFILE);
    const id = [...account.sessions.keys()][0]!;
    expect(await svc.archive(PROFILE, id)).toEqual({ ok: true });
    expect(account.sessions.get(id)!.meta.archivedAt).not.toBeNull();
  });
});
