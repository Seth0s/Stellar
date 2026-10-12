import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_LIMITS,
  buildCwdRef,
  buildProjectRef,
  buildSnapshot,
  decideSessionFailure,
  matchProjectRef,
  normalizeGitRemote,
  planRestore,
  resolveCwdRef,
  truncateBytes,
  type BuildSnapshotInput,
  type SessionSnapshot,
} from "../../src/main/cloud-sessions-decision";
import type { CardRow } from "../../src/main/store";

const card = (over: Partial<CardRow>): CardRow => ({
  id: "1",
  board_id: "b",
  kind: "terminal",
  provider: "claude",
  cwd: "/home/ana/dev/app",
  x: 10,
  y: 20,
  w: 300,
  h: 200,
  resume_id: null,
  model: null,
  effort: null,
  system_prompt: null,
  group_id: null,
  label: null,
  updated_at: 1,
  messages_json: null,
  archived_at: null,
  ...over,
});

const board = { name: "app", project: "app", autonomous: false, concurrency_cap: null, orchestrator_card_id: null };

function input(over: Partial<BuildSnapshotInput> = {}): BuildSnapshotInput {
  return { board, cards: [], connectors: [], tasks: [], taskCards: [], root: "/home/ana/dev/app", ...over };
}

describe("normalizeGitRemote", () => {
  it.each([
    ["https://github.com/exemplo/app.git", "github.com/exemplo/app"],
    ["https://user:secret-token@github.com/exemplo/app", "github.com/exemplo/app"],
    ["git@github.com:exemplo/app.git", "github.com/exemplo/app"],
    ["ssh://git@GitHub.com:22/exemplo/app.git", "github.com/exemplo/app"],
    ["https://git.example.com:8443/team/sub/app/", "git.example.com/team/sub/app"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeGitRemote(raw)).toBe(expected);
  });

  it("is the same repository over https and ssh", () => {
    expect(normalizeGitRemote("https://github.com/exemplo/app.git")).toBe(normalizeGitRemote("git@github.com:exemplo/app"));
  });

  it("refuses what is not a remote", () => {
    for (const bad of ["", "   ", "/home/ana/dev/app", "C:\\dev\\app", "not a url", null, undefined]) {
      expect(normalizeGitRemote(bad as string | null)).toBeNull();
    }
  });
});

describe("project reference", () => {
  it("is git when there is an origin, a folder otherwise", () => {
    expect(buildProjectRef({ remoteUrl: "git@github.com:exemplo/app.git", root: "/home/ana/dev/app" })).toEqual({
      kind: "git",
      remote: "github.com/exemplo/app",
      name: "app",
    });
    expect(buildProjectRef({ remoteUrl: null, root: "/home/ana/docs-site/" })).toEqual({ kind: "folder", name: "docs-site" });
    expect(buildProjectRef({ remoteUrl: null, root: "" })).toBeNull();
  });

  it("matches by remote first, then by folder name", () => {
    const ref = { kind: "git", remote: "github.com/exemplo/app", name: "app" } as const;
    expect(matchProjectRef(ref, { path: "/x/anything", remoteUrl: "https://github.com/exemplo/app.git" })).toBe("remote");
    expect(matchProjectRef(ref, { path: "/x/app", remoteUrl: "https://github.com/outro/app" })).toBe("name");
    expect(matchProjectRef(ref, { path: "/x/other", remoteUrl: null })).toBeNull();
  });
});

describe("cwd reference", () => {
  it("is relative to the project root, with / always", () => {
    expect(buildCwdRef("/home/ana/dev/app/src/renderer", "/home/ana/dev/app")).toEqual({ rel: "src/renderer" });
    expect(buildCwdRef("C:\\dev\\app\\src\\main", "C:\\dev\\app")).toEqual({ rel: "src/main" });
  });

  it("is null for the root itself and outside for anything else", () => {
    expect(buildCwdRef("/home/ana/dev/app", "/home/ana/dev/app/")).toBeNull();
    expect(buildCwdRef("/home/ana/other", "/home/ana/dev/app")).toEqual({ outside: true });
    expect(buildCwdRef("/home/ana/dev/app-copy", "/home/ana/dev/app")).toEqual({ outside: true });
    expect(buildCwdRef("", "/home/ana/dev/app")).toEqual({ outside: true });
  });

  it("resolves back under the root chosen on another machine", () => {
    expect(resolveCwdRef({ rel: "src/main" }, "/Users/bo/code/app/")).toBe("/Users/bo/code/app/src/main");
    expect(resolveCwdRef(null, "/Users/bo/code/app")).toBe("/Users/bo/code/app");
    expect(resolveCwdRef({ outside: true }, "/Users/bo/code/app")).toBe("/Users/bo/code/app");
    expect(resolveCwdRef({ rel: "src/main" }, "D:\\code\\app")).toBe("D:\\code\\app\\src\\main");
  });
});

describe("buildSnapshot", () => {
  it("carries a terminal without a path, a prompt or a scrollback", () => {
    const { snapshot } = buildSnapshot(
      input({
        cards: [
          card({
            id: "t1",
            cwd: "/home/ana/dev/app/src",
            model: "sonnet",
            effort: "high",
            resume_id: "abc-123",
            system_prompt: "SECRET PROMPT",
            label: "IMPL",
          }),
        ],
      }),
    );
    const c = snapshot.cards[0]!;
    expect(c).toMatchObject({ ref: "t1", kind: "terminal", provider: "claude", model: "sonnet", effort: "high", resume_id: "abc-123", label: "IMPL", cwd_ref: { rel: "src" } });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET PROMPT");
    expect(JSON.stringify(snapshot)).not.toContain("/home/ana");
  });

  it("keeps the chat's configuration but never its history", () => {
    const { snapshot } = buildSnapshot(
      input({ cards: [card({ id: "c1", kind: "chat", provider: "anthropic", model: "m", messages_json: '[{"role":"user","content":"hi"}]', system_prompt: "x" })] }),
    );
    expect(snapshot.cards[0]).toMatchObject({ kind: "chat", provider: "anthropic", model: "m" });
    expect(JSON.stringify(snapshot)).not.toContain("hi");
    expect(snapshot.cards[0]).not.toHaveProperty("messages_json");
  });

  it("maps sticky, browser and stroke from their reused columns", () => {
    const { snapshot } = buildSnapshot(
      input({
        cards: [
          card({ id: "s", kind: "sticky", cwd: "line1\nline2", provider: "yellow", model: "edit", system_prompt: "18" }),
          card({ id: "w", kind: "browser", cwd: "https://example.com/a", model: "persistent", provider: "7" }),
          card({ id: "d", kind: "stroke", cwd: JSON.stringify({ points: [[0, 0], [1, 1]], width: 4, style: "marker" }), provider: "#ff0000" }),
        ],
      }),
    );
    expect(snapshot.cards[0]).toMatchObject({ kind: "sticky", content: "line1\nline2", color: "yellow", mode: "edit", font_size: 18 });
    expect(snapshot.cards[1]).toMatchObject({ kind: "browser", url: "https://example.com/a", persistent: true });
    expect(snapshot.cards[2]).toMatchObject({ kind: "stroke", points: [[0, 0], [1, 1]], width: 4, style: "marker" });
    expect(snapshot.cards[2]).not.toHaveProperty("color");
  });

  it("drops a browser url the server would refuse", () => {
    for (const url of ["file:///etc/passwd", "https://user:pw@example.com/", "about:blank", ""]) {
      const { snapshot } = buildSnapshot(input({ cards: [card({ id: "w", kind: "browser", cwd: url })] }));
      expect(snapshot.cards[0]).not.toHaveProperty("url");
    }
  });

  it("leaves media and archived cards out and counts the media", () => {
    const built = buildSnapshot(
      input({
        cards: [card({ id: "m1", kind: "media" }), card({ id: "m2", kind: "media" }), card({ id: "a", archived_at: 5 }), card({ id: "ok" })],
      }),
    );
    expect(built.snapshot.cards.map((c) => c.ref)).toEqual(["ok"]);
    expect(built.omitted).toBe(2);
    expect(built.summary).toEqual({ cardCount: 1, taskCount: 0 });
  });

  it("drops connectors whose end stayed behind", () => {
    const { snapshot } = buildSnapshot(
      input({
        cards: [card({ id: "1" }), card({ id: "2" }), card({ id: "m", kind: "media" })],
        connectors: [
          { id: "k1", board_id: "b", from_card_id: "1", to_card_id: "2", updated_at: 0, kind: "depends", label: "a\nb" },
          { id: "k2", board_id: "b", from_card_id: "1", to_card_id: "m", updated_at: 0, kind: null, label: null },
        ],
      }),
    );
    expect(snapshot.connectors).toEqual([{ from_ref: "1", to_ref: "2", kind: "depends", label: "a b" }]);
  });

  it("normalizes tasks: running becomes pending, no result, deps only inside", () => {
    const t = (id: string, status: string, deps: string[] | null) => ({
      id,
      prompt: `do ${id}`,
      provider: "claude",
      status,
      card_id: "1",
      board_id: "b",
      cwd: "/home/ana/dev/app",
      spawn_profile: null,
      result_json: '{"summary":"secret result"}',
      deps_json: deps ? JSON.stringify(deps) : null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: 2,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: 1,
      updated_at: 1,
    });
    const { snapshot } = buildSnapshot(
      input({
        cards: [card({ id: "1" })],
        tasks: [t("a", "running", null), t("b", "superseded", ["a", "ghost"]), t("c", "done", ["b"])],
        taskCards: [
          { task_id: "a", card_id: "1", role: "implementer", released_at: null },
          { task_id: "a", card_id: "9", role: "implementer", released_at: null },
          { task_id: "b", card_id: "1", role: "reviewer", released_at: 7 },
        ],
      }),
    );
    expect(snapshot.tasks.map((x) => [x.ref, x.status])).toEqual([["a", "pending"], ["b", "cancelled"], ["c", "done"]]);
    expect(snapshot.tasks[1]!.deps).toEqual(["a"]);
    expect(snapshot.tasks[0]!.card_links).toEqual([{ card_ref: "1", role: "implementer" }]);
    expect(snapshot.tasks[1]).not.toHaveProperty("card_links");
    expect(JSON.stringify(snapshot)).not.toContain("secret result");
    expect(JSON.stringify(snapshot)).not.toContain("/home/ana");
    expect(snapshot.tasks[0]).toMatchObject({ order: 2 });
  });

  it("makes unsafe ids into valid, unique refs", () => {
    const { snapshot } = buildSnapshot(input({ cards: [card({ id: "a b/c" }), card({ id: "a_b_c" })] }));
    expect(snapshot.cards.map((c) => c.ref)).toEqual(["a_b_c", "a_b_c-1"]);
    for (const c of snapshot.cards) expect(c.ref).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("caps the cards and says how many were left", () => {
    const cards = Array.from({ length: SNAPSHOT_LIMITS.cards + 3 }, (_, i) => card({ id: `c${i}` }));
    const built = buildSnapshot(input({ cards }));
    expect(built.snapshot.cards).toHaveLength(SNAPSHOT_LIMITS.cards);
    expect(built.overLimit).toBe(3);
  });

  it("thins a stroke over the point limit and keeps the end", () => {
    const points = Array.from({ length: SNAPSHOT_LIMITS.strokePoints + 500 }, (_, i) => [i, i]);
    const { snapshot } = buildSnapshot(input({ cards: [card({ id: "d", kind: "stroke", cwd: JSON.stringify({ points }) })] }));
    const out = snapshot.cards[0]!.points!;
    expect(out).toHaveLength(SNAPSHOT_LIMITS.strokePoints);
    expect(out[out.length - 1]).toEqual([SNAPSHOT_LIMITS.strokePoints + 499, SNAPSHOT_LIMITS.strokePoints + 499]);
  });

  it("keeps the orchestrator and the group refs consistent", () => {
    const { snapshot } = buildSnapshot(
      input({
        board: { ...board, orchestrator_card_id: "1", concurrency_cap: 3, autonomous: true },
        cards: [card({ id: "1", group_id: "g 1" }), card({ id: "2", group_id: "g 1" })],
      }),
    );
    expect(snapshot.board).toMatchObject({ orchestrator_card_ref: "1", concurrency_cap: 3, autonomous: true });
    expect(snapshot.cards[0]!.group_ref).toBe(snapshot.cards[1]!.group_ref);
    expect(snapshot.cards[0]!.group_ref).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("never emits a field outside the allowlist", () => {
    const { snapshot } = buildSnapshot(input({ cards: [card({ id: "t" }), card({ id: "f", kind: "files" }), card({ id: "k", kind: "task" })] }));
    const common = ["ref", "kind", "x", "y", "w", "h", "label", "group_ref"];
    const perKind: Record<string, string[]> = {
      terminal: ["provider", "model", "effort", "cwd_ref", "resume_id"],
      files: ["cwd_ref"],
      task: [],
    };
    for (const c of snapshot.cards) {
      for (const key of Object.keys(c)) expect([...common, ...(perKind[c.kind] ?? [])]).toContain(key);
    }
  });
});

describe("truncateBytes", () => {
  it("cuts on bytes without splitting a character", () => {
    expect(truncateBytes("áé", 3)).toBe("á");
    expect(truncateBytes("abc", 10)).toBe("abc");
  });
});

describe("planRestore", () => {
  const snapshot: SessionSnapshot = {
    schema_version: 1,
    board: { name: "app", project: "app", autonomous: true, concurrency_cap: 2, orchestrator_card_ref: "t1" },
    cards: [
      { ref: "t1", kind: "terminal", x: 0, y: 0, w: 100, h: 100, provider: "claude", model: "sonnet", cwd_ref: { rel: "src" }, resume_id: "r-1", group_ref: "g1" },
      { ref: "t2", kind: "terminal", x: 0, y: 0, w: 100, h: 100, provider: "codex", resume_id: "r-2" },
      { ref: "n", kind: "sticky", x: 5, y: 5, w: 50, h: 50, content: "hi", color: "blue", mode: "edit", font_size: 18 },
      { ref: "c", kind: "chat", x: 0, y: 0, w: 50, h: 50, provider: "anthropic", model: "m" },
      { ref: "w", kind: "browser", x: 0, y: 0, w: 50, h: 50, url: "https://example.com", persistent: true },
      { ref: "d", kind: "stroke", x: 0, y: 0, w: 50, h: 50, points: [[0, 0]], width: 3, style: "solid" },
    ],
    connectors: [{ from_ref: "t1", to_ref: "t2", kind: "depends", label: "x" }],
    tasks: [
      { ref: "a", prompt: "first", status: "pending", card_links: [{ card_ref: "t1", role: "implementer" }] },
      { ref: "b", prompt: "second", status: "blocked", deps: ["a"], order: 4 },
    ],
  };
  let n = 0;
  const base = {
    snapshot,
    root: "/Users/bo/code/app",
    fallbackCwd: "/Users/bo",
    profileId: "prof-1",
    newId: () => `id-${++n}`,
    now: 1000,
    resumeExists: (c: { resumeId: string }) => c.resumeId === "r-1",
  };

  it("builds a new board for the profile with new ids everywhere", () => {
    n = 0;
    const plan = planRestore(base);
    expect(plan.board).toMatchObject({ name: "app", cwd: "/Users/bo/code/app", account_profile_id: "prof-1", autonomous: true, concurrency_cap: 2 });
    const ids = [plan.board.id, ...plan.cards.map((c) => c.id), ...plan.connectors.map((c) => c.id), ...plan.tasks.map((t) => t.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.cards.every((c) => c.board_id === plan.board.id)).toBe(true);
    expect(plan.board.orchestrator_card_id).toBe(plan.cards[0]!.id);
    expect(plan.connectors[0]).toMatchObject({ from_card_id: plan.cards[0]!.id, to_card_id: plan.cards[1]!.id, kind: "depends" });
  });

  it("resolves folders under the chosen root and opens a terminal clean when its conversation is missing", () => {
    n = 0;
    const plan = planRestore(base);
    expect(plan.cards[0]).toMatchObject({ cwd: "/Users/bo/code/app/src", resume_id: "r-1", provider: "claude", model: "sonnet" });
    expect(plan.cards[1]).toMatchObject({ cwd: "/Users/bo/code/app", resume_id: null, provider: "codex" });
    expect(plan.cleanTerminals).toBe(1);
  });

  it("puts each kind back into the columns the app reads", () => {
    n = 0;
    const [, , sticky, chat, browser, stroke] = planRestore(base).cards;
    expect(sticky).toMatchObject({ cwd: "hi", provider: "blue", model: "edit", system_prompt: "18" });
    expect(chat).toMatchObject({ provider: "anthropic", messages_json: "[]" });
    expect(browser).toMatchObject({ cwd: "https://example.com", model: "persistent" });
    expect(JSON.parse(stroke!.cwd)).toEqual({ points: [[0, 0]], width: 3, style: "solid" });
  });

  it("links tasks and cards with the new ids and keeps order and deps", () => {
    n = 0;
    const plan = planRestore(base);
    const [a, b] = plan.tasks;
    expect(JSON.parse(b!.deps_json!)).toEqual([a!.id]);
    expect(b).toMatchObject({ order: 4, status: "blocked", board_id: plan.board.id });
    expect(plan.taskCards).toEqual([{ task_id: a!.id, card_id: plan.cards[0]!.id, role: "implementer", linked_at: 1000 }]);
  });

  it("opens without a folder: every card falls back to the given directory", () => {
    n = 0;
    const plan = planRestore({ ...base, root: null });
    expect(plan.board.cwd).toBe("/Users/bo");
    expect(plan.cards[0]!.cwd).toBe("/Users/bo");
  });

  it("keeps the cards of one group in one new group", () => {
    n = 0;
    const plan = planRestore({ ...base, snapshot: { ...snapshot, cards: snapshot.cards.map((c) => ({ ...c, group_ref: "g1" })) } });
    expect(new Set(plan.cards.map((c) => c.group_id)).size).toBe(1);
    expect(plan.cards[0]!.group_id).toContain(plan.board.id);
  });
});

describe("decideSessionFailure", () => {
  it("maps the contract's errors to the screen's states", () => {
    expect(decideSessionFailure({ status: 0, code: "network", message: "x" })).toEqual({ state: "offline" });
    expect(decideSessionFailure({ status: 0, code: "timeout", message: "x" })).toEqual({ state: "offline" });
    expect(decideSessionFailure({ status: 402, code: "plan_required", message: "x" })).toEqual({ state: "plan", expired: false });
    expect(decideSessionFailure({ status: 402, code: "plan_expired", message: "x" })).toEqual({ state: "plan", expired: true });
    expect(decideSessionFailure({ status: 422, code: "session_limit_reached", message: "x" })).toEqual({ state: "limit" });
    expect(decideSessionFailure({ status: 413, code: "payload_too_large", message: "x" })).toEqual({ state: "too-large" });
    expect(decideSessionFailure({ status: 422, code: "snapshot_too_large", message: "x" })).toEqual({ state: "too-large" });
    expect(decideSessionFailure({ status: 429, code: "rate_limited", message: "x" }, 12)).toEqual({ state: "rate-limited", retryAfterSec: 12 });
    expect(decideSessionFailure({ status: 410, code: "revision_gone", message: "x" })).toEqual({ state: "gone" });
    expect(decideSessionFailure({ status: 400, code: "snapshot_invalid", message: "x" })).toEqual({ state: "invalid", code: "snapshot_invalid" });
    expect(decideSessionFailure({ status: 401, code: "unauthorized", message: "x" })).toEqual({ state: "login" });
    expect(decideSessionFailure({ status: 500, code: "internal", message: "boom" })).toEqual({ state: "error", code: "internal", message: "boom" });
  });
});
