import { describe, expect, it } from "vitest";
import { createProcessIdentityAuthority, parseLinuxProcessStat, resolveProcessCardIdentity } from "../../src/main/process-identity";
import { peerPidFromSocket } from "../../src/main/peer-credentials";
import { StreamingSecretRedactor, redactSecretValues } from "../../src/main/secret-redaction";

function stat(pid: number, parentPid: number, startTime: bigint) {
  return { pid, parentPid, startTime };
}

describe("parseLinuxProcessStat", () => {
  it("parses the parent pid and field 22 even when the command contains spaces and parentheses", () => {
    const fields = ["S", "11", ...Array(17).fill("0"), "12345"];
    expect(parseLinuxProcessStat(`10 (cli (worker) x) ${fields.join(" ")}`)).toEqual({
      pid: 10,
      parentPid: 11,
      startTime: 12345n,
    });
  });

  it("rejects malformed and truncated records", () => {
    expect(parseLinuxProcessStat("bad")).toBeNull();
    expect(parseLinuxProcessStat("10 (x) S 1")).toBeNull();
  });
});

describe("resolveProcessCardIdentity", () => {
  it("resolves a live descendant to the recorded PTY root", () => {
    const table = new Map([[30, stat(30, 20, 300n)], [20, stat(20, 10, 200n)], [10, stat(10, 1, 100n)]]);
    expect(resolveProcessCardIdentity(30, [{ cardId: "card-a", boardId: "board-a", pid: 10, startTime: 100n }], (pid) => table.get(pid) ?? null)).toEqual({
      cardId: "card-a",
      boardId: "board-a",
    });
  });

  it("refuses a recycled PTY pid whose starttime changed", () => {
    const table = new Map([[10, stat(10, 1, 900n)]]);
    expect(resolveProcessCardIdentity(10, [{ cardId: "card-a", boardId: "board-a", pid: 10, startTime: 100n }], (pid) => table.get(pid) ?? null)).toBeNull();
  });

  it("refuses broken ancestry and cycles", () => {
    const table = new Map([[30, stat(30, 20, 300n)], [20, stat(20, 30, 200n)]]);
    expect(resolveProcessCardIdentity(30, [{ cardId: "card-a", boardId: "board-a", pid: 10, startTime: 100n }], (pid) => table.get(pid) ?? null)).toBeNull();
  });
});

describe("process identity authority", () => {
  it("issues opaque per-card tokens and removes them with the card", () => {
    const authority = createProcessIdentityAuthority(() => null);
    const authToken = authority.issueToken();
    expect(authToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    authority.register({ cardId: "card-a", boardId: "board-a", pid: 10, startTime: 100n, authToken });
    expect(authority.resolveToken(authToken)).toEqual({ cardId: "card-a", boardId: "board-a" });
    expect(authority.resolveToken("card-a")).toBeNull();
    authority.remove("card-a");
    expect(authority.resolveToken(authToken)).toBeNull();
  });

  it("heals a null startTime from readStat at register and on resolvePeer", () => {
    const table = new Map([[10, stat(10, 1, 100n)], [20, stat(20, 10, 200n)]]);
    const authority = createProcessIdentityAuthority((pid) => table.get(pid) ?? null);
    const authToken = authority.issueToken();
    authority.register({ cardId: "card-a", boardId: null, pid: 10, startTime: null, authToken });
    expect(authority.resolvePeer(20)).toEqual({ cardId: "card-a", boardId: null });
  });

  it("bindBoard patches a boardId that lost the upsert race", () => {
    const authority = createProcessIdentityAuthority(() => null);
    const authToken = authority.issueToken();
    authority.register({ cardId: "card-a", boardId: null, pid: 10, startTime: 100n, authToken });
    expect(authority.identityForCard("card-a")).toEqual({ cardId: "card-a", boardId: null });
    authority.bindBoard("card-a", "board-a");
    expect(authority.identityForCard("card-a")).toEqual({ cardId: "card-a", boardId: "board-a" });
  });
});

describe("peerPidFromSocket", () => {
  it("returns null when the internal socket descriptor is unavailable", () => {
    expect(peerPidFromSocket({} as never)).toBeNull();
  });
});

describe("StreamingSecretRedactor", () => {
  // Length 36 → exactly 35 single cut points (indices 1..35).
  const token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";

  it("redacts the token across every one of its 35 possible single cut points", () => {
    expect(token.length - 1).toBe(35);
    for (let cut = 1; cut < token.length; cut += 1) {
      const redactor = new StreamingSecretRedactor(token);
      const output = redactor.push(`prefix ${token.slice(0, cut)}`) + redactor.push(`${token.slice(cut)} suffix`) + redactor.flush();
      expect(output).toBe("prefix [REDACTED] suffix");
    }
  });

  it("removes a secret recursively from strings and report payload shapes", () => {
    expect(redactSecretValues({ report: ["leak token", { detail: token }] }, [token])).toEqual({
      report: ["leak token", { detail: "[REDACTED]" }],
    });
  });
});
