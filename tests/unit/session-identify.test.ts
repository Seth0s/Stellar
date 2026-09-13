import { describe, it, expect } from "vitest";
import {
  cursorChatsHash,
  decideIdentifyFromIds,
  identifyCurrentSession,
  parseClaudeAgentsJson,
  parseOpenCodeSessionListJson,
} from "../../src/main/session-identify";

describe("session-identify helpers", () => {
  it("cursorChatsHash is md5 of the cwd (measured: 8/8 cases)", () => {
    expect(cursorChatsHash("/home/lucas/Workplace/Projects/Stellar")).toBe(
      "1fab55d0f492f6123344e375ae05b2aa",
    );
  });

  it("decideIdentifyFromIds is unique / ambiguous / none — never picks by order", () => {
    expect(decideIdentifyFromIds(["a"], "src")).toEqual({ status: "found", ids: ["a"], source: "src" });
    expect(decideIdentifyFromIds(["a", "b"], "src")).toEqual({
      status: "ambiguous",
      ids: ["a", "b"],
      source: "src",
    });
    expect(decideIdentifyFromIds([], "src")).toEqual({ status: "none", ids: [], source: "src" });
  });

  it("parseClaudeAgentsJson reads sessionId + cwd + pid from a JSON array", () => {
    const rows = parseClaudeAgentsJson(
      JSON.stringify([
        { sessionId: "s1", cwd: "/tmp/a", pid: 11 },
        { session_id: "s2", directory: "/tmp/b", PID: "22" },
      ]),
    );
    expect(rows).toEqual([
      { sessionId: "s1", cwd: "/tmp/a", pid: 11 },
      { sessionId: "s2", cwd: "/tmp/b", pid: 22 },
    ]);
  });

  it("parseOpenCodeSessionListJson filters by directory at the caller", () => {
    const rows = parseOpenCodeSessionListJson(
      JSON.stringify([
        { id: "oc1", directory: "/tmp/a" },
        { id: "oc2", directory: "/tmp/b" },
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(["oc1", "oc2"]);
  });
});

describe("identifyCurrentSession — injected I/O", () => {
  it("claude: agents --json matching cwd+pid wins over lastSessionId", async () => {
    const result = await identifyCurrentSession("claude", "/tmp/proj", { pid: 99 }, {
      execFile: async () => ({
        stdout: JSON.stringify([{ sessionId: "live-id", cwd: "/tmp/proj", pid: 99 }]),
      }),
      readUtf8: async () => JSON.stringify({ projects: { "/tmp/proj": { lastSessionId: "stale" } } }),
    });
    expect(result).toEqual({ status: "found", ids: ["live-id"], source: "claude agents --json" });
  });

  it("claude: agents fail => lastSessionId in ~/.claude.json[projects][cwd]", async () => {
    const result = await identifyCurrentSession("claude", "/tmp/proj", {}, {
      homedir: () => "/fake-home",
      execFile: async () => {
        throw new Error("not running");
      },
      readUtf8: async (path) => {
        expect(path).toBe("/fake-home/.claude.json");
        return JSON.stringify({ projects: { "/tmp/proj": { lastSessionId: "last-one" } } });
      },
    });
    expect(result.status).toBe("found");
    expect(result.ids).toEqual(["last-one"]);
  });

  it("cursor: two meta.json for the same cwd => ambiguous", async () => {
    const result = await identifyCurrentSession("cursor", "/tmp/proj", {}, {
      homedir: () => "/fake-home",
      listDir: async () => ["aaa", "bbb"],
      readUtf8: async () => JSON.stringify({ cwd: "/tmp/proj" }),
    });
    expect(result.status).toBe("ambiguous");
    expect(result.ids).toEqual(["aaa", "bbb"]);
  });

  it("opencode: session list filtered by directory", async () => {
    const result = await identifyCurrentSession("opencode", "/tmp/proj", {}, {
      execFile: async (file, args) => {
        expect(file).toBe("opencode");
        expect(args).toEqual(["session", "list", "--format", "json"]);
        return {
          stdout: JSON.stringify([
            { id: "mine", directory: "/tmp/proj" },
            { id: "other", directory: "/elsewhere" },
          ]),
        };
      },
    });
    expect(result).toEqual({
      status: "found",
      ids: ["mine"],
      source: "opencode session list --format json",
    });
  });
});
