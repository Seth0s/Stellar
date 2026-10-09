import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runTaskGates } from "../../src/main/gate-runner";
import { findSandboxBinary } from "../../src/main/sandbox";

const sandboxBinary = findSandboxBinary();
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function runGit(args: string[]) {
  await execFileAsync("git", args);
}

async function makeWorkspace() {
  const temp = mkdtempSync(join(tmpdir(), "stellar-gate-env-"));
  roots.push(temp);
  const workspace = join(temp, "workspace");
  const boardRoot = join(workspace, "ai");
  const repo = join(boardRoot, "IdyPlatform");
  const nested = join(repo, "vhosts", "Conecta");
  const scripts = join(boardRoot, "scripts");
  const worktreeRoot = join(temp, "worktrees");
  mkdirSync(nested, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(repo, ".stellar"), { recursive: true });
  writeFileSync(
    join(boardRoot, "workspace.yaml"),
    JSON.stringify({ schema_version: 1, projects: [] }),
  );
  writeFileSync(join(scripts, "check_comment_markers.py"), "print('marker check passed')\n");
  writeFileSync(join(repo, ".gitignore"), "vhosts/Conecta\n");
  writeFileSync(join(repo, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  await runGit(["-C", repo, "init", "-q"]);
  await runGit(["-C", repo, "config", "user.email", "test@example.com"]);
  await runGit(["-C", repo, "config", "user.name", "Gate Test"]);
  await runGit(["-C", repo, "add", "-A"]);
  await runGit(["-C", repo, "commit", "-qm", "outer repository"]);

  await runGit(["-C", nested, "init", "-q"]);
  await runGit(["-C", nested, "config", "user.email", "test@example.com"]);
  await runGit(["-C", nested, "config", "user.name", "Nested Test"]);
  writeFileSync(join(nested, "app.txt"), "nested project\n");
  await runGit(["-C", nested, "add", "app.txt"]);
  await runGit(["-C", nested, "commit", "-qm", "nested repository"]);
  writeFileSync(join(repo, "tracked.txt"), "changed\n");

  return { workspace, boardRoot, repo, scripts };
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.skipIf(!sandboxBinary || !hasGit)("gate runner environment regressions", () => {
  it("keeps nested repositories and board-approved absolute workspace paths available", async () => {
    const { workspace, boardRoot, repo, scripts } = await makeWorkspace();
    const script = join(scripts, "check_comment_markers.py");
    const evidence = await runTaskGates({
      taskId: "gate-env-nested-repository",
      cardId: "implementer",
      cwd: repo,
      declaredRoot: boardRoot,
      territory: ["vhosts/**"],
      declaredFiles: [{ cardId: "implementer", paths: ["tracked.txt"] }],
      gates: [`python3 ${JSON.stringify(script)}`, "cd vhosts/Conecta && test -f app.txt"],
      timeoutMs: 30_000,
      sandboxBinary,
    });
    expect(evidence.ok).toBe(true);
    expect(evidence.isolation?.mode).toBe("shared");
    expect(evidence.isolation?.reason).toMatch(/nested git repositor/i);
    expect(evidence.gateToolPaths?.accepted).toContain(boardRoot);
    expect(evidence.gateToolPaths?.accepted).toContain(workspace);
    expect(evidence.commands.map((command) => command.exitCode)).toEqual([0, 0]);
    expect(evidence.commands[0]?.stdout).toContain("marker check passed");
  });
});
