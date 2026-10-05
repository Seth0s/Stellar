import { afterAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskGates } from "../../src/main/gate-runner";
import { findSandboxBinary } from "../../src/main/sandbox";

/**
 * A board may declare a tool directory its gates read OUTSIDE the repository.
 * The runner validates it and mounts it READ-ONLY in the sandbox, both in the
 * shared tree and in the isolated worktree.
 *
 * These tests measure the real sandbox: the declared directory is invisible
 * under bwrap's `--tmpfs /tmp` until it is bound, and visible only as a read
 * mount after.
 */

const BWRAP = findSandboxBinary();
const GIT_AVAILABLE = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Test seam: records the bwrap argv and reports success without running it. */
function fakeSpawn(seen: Array<{ file: string; args: string[] }>) {
  return ((file: string, args: string[]) => {
    seen.push({ file, args });
    const child: any = new EventEmitter();
    child.pid = 999_111;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit("close", 0, null), 0);
    return child;
  }) as never;
}

describe("gate tool paths: the sandbox argv", () => {
  it("mounts a declared tool dir as an extra READ-ONLY bind", async () => {
    const cwd = tempDir("stellar-gtp-cwd-");
    const tool = tempDir("stellar-gtp-tool-");
    const seen: Array<{ file: string; args: string[] }> = [];
    const evidence = await runTaskGates({
      taskId: "gtp-bind",
      cwd,
      declaredRoot: cwd,
      gates: ["echo hi"],
      gateToolPaths: [tool],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: fakeSpawn(seen),
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.gateToolPaths?.accepted).toEqual([tool]);
    const args = seen[0]!.args;
    const at = args.indexOf(tool);
    expect(at).toBeGreaterThan(-1);
    expect(args[at - 1]).toBe("--ro-bind");
    expect(args[at + 1]).toBe(tool);
  });

  it.skipIf(!GIT_AVAILABLE)("the isolated gate also receives the same bind", async () => {
    const repo = tempDir("stellar-gtp-iso-");
    const worktreeRoot = tempDir("stellar-gtp-isowt-");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, ".stellar"), { recursive: true });
    writeFileSync(join(repo, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");

    const tool = tempDir("stellar-gtp-isotool-");
    const seen: Array<{ file: string; args: string[] }> = [];
    const evidence = await runTaskGates({
      taskId: "gtp-iso",
      cardId: "A",
      cwd: repo,
      declaredRoot: repo,
      gates: ["echo hi"],
      declaredFiles: [{ cardId: "A", paths: ["a.ts"] }],
      gateToolPaths: [tool],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: fakeSpawn(seen),
    });

    expect(evidence.isolation?.mode).toBe("isolated");
    const args = seen[0]!.args;
    const at = args.indexOf(tool);
    expect(at).toBeGreaterThan(-1);
    expect(args[at - 1]).toBe("--ro-bind");
  });
});

describe.skipIf(!BWRAP)("gate tool paths: real sandbox", () => {
  it("fails without the declaration and passes with it", async () => {
    const repo = tempDir("stellar-gtp-realrepo-");
    const tool = tempDir("stellar-gtp-realtool-");
    writeFileSync(join(tool, "tool.sh"), "#!/bin/sh\necho GATE_TOOL_RAN\n");
    const command = `sh ${join(tool, "tool.sh")}`;

    const without = await runTaskGates({
      taskId: "gtp-without",
      cwd: repo,
      declaredRoot: repo,
      gates: [command],
      timeoutMs: 20_000,
      sandboxBinary: BWRAP,
    });
    expect(without.ok).toBe(false);
    expect(without.commands[0]!.exitCode).not.toBe(0);
    expect(without.gateToolPaths?.accepted).toEqual([]);

    const withPath = await runTaskGates({
      taskId: "gtp-with",
      cwd: repo,
      declaredRoot: repo,
      gates: [command],
      gateToolPaths: [tool],
      timeoutMs: 20_000,
      sandboxBinary: BWRAP,
    });
    expect(withPath.ok).toBe(true);
    expect(withPath.commands[0]!.stdout).toContain("GATE_TOOL_RAN");
    expect(withPath.gateToolPaths?.accepted).toEqual([tool]);
  });

  it("refuses a relative, an absent and a broad-home path, and mounts none", async () => {
    const repo = tempDir("stellar-gtp-refuserepo-");
    const absent = join(repo, "does-not-exist");
    const evidence = await runTaskGates({
      taskId: "gtp-refuse",
      cwd: repo,
      declaredRoot: repo,
      gates: ["echo hi"],
      gateToolPaths: ["relative/dir", absent, homedir()],
      timeoutMs: 20_000,
      sandboxBinary: BWRAP,
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.gateToolPaths?.accepted).toEqual([]);
    const rejected = evidence.gateToolPaths?.rejected ?? [];
    expect(rejected.map((r) => r.reason).sort()).toEqual(["home-root", "not-found", "relative"]);
    for (const r of rejected) expect(r.message.length).toBeGreaterThan(0);
  });
});
