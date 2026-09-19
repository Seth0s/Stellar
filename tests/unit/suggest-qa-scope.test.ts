import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyArea, suggestQAScope } from "../../src/main/suggest-qa-scope";

const execP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execP("git", args, { cwd });
  return stdout;
}

describe("classifyArea", () => {
  it("classifies monorepo subfolders correctly", () => {
    expect(classifyArea("vhosts/Backend/app/Models/User.php")).toBe("vhosts/Backend");
    expect(classifyArea("vhosts/Mobile/src/screens/Home.tsx")).toBe("vhosts/Mobile");
    expect(classifyArea("packages/ui/src/Button.tsx")).toBe("packages/ui");
  });

  it("classifies standard repo folders correctly", () => {
    expect(classifyArea("src/main/mcp-server.ts")).toBe("src/main");
    expect(classifyArea("src/renderer/src/App.tsx")).toBe("src/renderer");
    expect(classifyArea("tests/unit/some.test.ts")).toBe("tests");
    expect(classifyArea("docs/ORCHESTRATION.md")).toBe("docs");
  });

  it("falls back to root for top-level files", () => {
    expect(classifyArea("package.json")).toBe("root");
    expect(classifyArea("README.md")).toBe("root");
  });
});

describe("suggestQAScope", () => {
  it("returns error for non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "non-git-"));
    try {
      const res = await suggestQAScope({ cwd: nonGit });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("not inside a git repository");
      }
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("returns error for invalid baseRef", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "qa-scope-test-"));
    try {
      await git(tempRepo, ["init", "-b", "main"]);
      await git(tempRepo, ["config", "user.name", "Test User"]);
      await git(tempRepo, ["config", "user.email", "test@example.com"]);
      await writeFile(join(tempRepo, "initial.txt"), "hello");
      await git(tempRepo, ["add", "initial.txt"]);
      await git(tempRepo, ["commit", "-m", "initial commit"]);

      const res = await suggestQAScope({ cwd: tempRepo, baseRef: "non-existent-branch" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("is not valid in repository");
      }
    } finally {
      await rm(tempRepo, { recursive: true, force: true });
    }
  });

  it("extracts commits, files changed, and generates QA checklist from a branch batch", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "qa-scope-batch-"));
    try {
      // 1. Initialize repo and create main branch
      await git(tempRepo, ["init", "-b", "main"]);
      await git(tempRepo, ["config", "user.name", "Tester"]);
      await git(tempRepo, ["config", "user.email", "tester@example.com"]);

      await writeFile(join(tempRepo, "base.txt"), "base content\n");
      await git(tempRepo, ["add", "base.txt"]);
      await git(tempRepo, ["commit", "-m", "chore: initial base commit"]);

      // 2. Create feature branch and make 2 commits in batch
      await git(tempRepo, ["checkout", "-b", "feature/qa-scope"]);

      await writeFile(join(tempRepo, "base.txt"), "base content\nupdated line\n");
      await mkdir(join(tempRepo, "docs"), { recursive: true });
      await writeFile(join(tempRepo, "docs/ADMIN_API_CONTRACT.md"), "# Contract\nmutation window updated\n");
      await git(tempRepo, ["add", "base.txt", "docs/ADMIN_API_CONTRACT.md"]);
      await git(tempRepo, ["commit", "-m", "feat(contract): update mutation window rules"]);

      await mkdir(join(tempRepo, "vhosts/Mobile"), { recursive: true });
      await writeFile(join(tempRepo, "vhosts/Mobile/screen.tsx"), "export const Screen = () => null;\n");
      await git(tempRepo, ["add", "vhosts/Mobile/screen.tsx"]);
      await git(tempRepo, ["commit", "-m", "fix(mobile): prevent ghost removed volunteers"]);

      // 3. Add an uncommitted working tree change
      await writeFile(join(tempRepo, "vhosts/Mobile/screen.tsx"), "export const Screen = () => <View />;\n");

      // 4. Run suggestQAScope comparing with baseRef "main"
      const res = await suggestQAScope({ cwd: tempRepo, baseRef: "main" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.currentBranch).toBe("feature/qa-scope");
        expect(res.baseRef).toBe("main");

        // Verify commits captured
        expect(res.commits.length).toBe(2);
        expect(res.commits.some((c) => c.subject.includes("feat(contract)"))).toBe(true);
        expect(res.commits.some((c) => c.subject.includes("fix(mobile)"))).toBe(true);

        // Verify files changed
        const paths = res.filesChanged.map((f) => f.path);
        expect(paths).toContain("base.txt");
        expect(paths).toContain("docs/ADMIN_API_CONTRACT.md");
        expect(paths).toContain("vhosts/Mobile/screen.tsx");

        // Verify area grouping
        const areas = res.areasTouched.map((a) => a.area);
        expect(areas).toContain("vhosts/Mobile");
        expect(areas).toContain("docs");

        // Verify suggested checklist
        expect(res.suggestedChecklist.some((item) => item.includes("feat(contract)"))).toBe(true);
        expect(res.suggestedChecklist.some((item) => item.includes("fix(mobile)"))).toBe(true);
        expect(res.suggestedChecklist.some((item) => item.includes("Contratos/API"))).toBe(true);

        // Verify markdown summary format
        expect(res.summary).toContain("### Roteiro Sugerido de QA — Lote de Trabalho");
        expect(res.summary).toContain("**Total de Commits no Lote**: 2");
        expect(res.summary).toContain("**Total de Arquivos Tocados**: 3");
      }
    } finally {
      await rm(tempRepo, { recursive: true, force: true });
    }
  });
});
