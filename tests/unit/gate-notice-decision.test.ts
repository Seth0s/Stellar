import { describe, expect, it } from "vitest";
import {
  classifyGateAttribution,
  describeGateContradiction,
  describeGateIsolationMode,
  gateRunSummaryFromEvidence,
  lastNonEmptyLines,
  parseGateErrorPaths,
  taskGateViewFromResult,
} from "../../src/main/gate-notice-decision";
import type { GateRunEvidence } from "../../src/main/gate-runner";

/**
 * The gate MESSAGES + path attribution. Pure — no process, no database.
 *
 * Acceptance (board 64): report filesChanged without FilesCard.tsx + tsc
 * errors only in FilesCard.tsx → gate_inconclusive, never contradiction;
 * error in a filesChanged path → task_failed.
 */

function cmd(overrides: Partial<GateRunEvidence["commands"][number]> = {}) {
  const stdout = overrides.stdout ?? "";
  return {
    command: "npm run check:types",
    normalizedCommand: null,
    failureKind: "ok" as const,
    missingExecutable: null,
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: 1,
    durationMs: 1,
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function evidence(commands: GateRunEvidence["commands"], isolation?: GateRunEvidence["isolation"]): GateRunEvidence {
  return {
    taskId: "abcdef12-0000-0000-0000-000000000000",
    requestedCwd: "/repo",
    gitRoot: "/repo",
    startedAt: 1,
    finishedAt: 2,
    ok: commands.every((c) => c.exitCode === 0),
    commands,
    isolation,
  };
}

describe("gateRunSummaryFromEvidence", () => {
  it("conta verdes e nomeia o primeiro que falhou", () => {
    const s = gateRunSummaryFromEvidence(evidence([cmd({ exitCode: 0 }), cmd({ command: "tsc", exitCode: 2 })]));
    expect(s).toEqual({ ok: false, passed: 1, total: 2, failedCommand: "tsc" });
  });
});

describe("parseGateErrorPaths", () => {
  it("parses tsc, vitest FAIL, and eslint path:line:col", () => {
    expect(
      parseGateErrorPaths(
        "src/renderer/src/FilesCard.tsx(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      ),
    ).toEqual(["src/renderer/src/FilesCard.tsx"]);
    expect(parseGateErrorPaths(" FAIL  tests/unit/foo.test.ts\n")).toEqual(["tests/unit/foo.test.ts"]);
    expect(parseGateErrorPaths("  src/main/x.ts:12:3  error  no-unused-vars\n")).toEqual(["src/main/x.ts"]);
  });
});

describe("classifyGateAttribution — real board-64 case", () => {
  const filesChanged = [
    "src/main/board-scope-decision.ts",
    "tests/unit/board-scope-decision.test.ts",
    "src/main/message-bus.ts",
  ];

  it("tsc errors only in FilesCard.tsx (not in filesChanged) → gate_inconclusive, never task_failed", () => {
    const ev = evidence(
      [
        cmd({
          exitCode: 2,
          failureKind: "test-failed",
          stdout:
            "src/renderer/src/FilesCard.tsx(40,1): error TS2304: Cannot find name 'HEADER_ICON'.\n",
        }),
      ],
      { mode: "shared", appliedFiles: [], disputed: [], undeclaredInTerritory: [], worktree: null, reason: null, note: "" },
    );
    const attr = classifyGateAttribution({ evidence: ev, filesChanged });
    expect(attr.class).toBe("gate_inconclusive");
    expect(attr.errorPaths).toEqual(["src/renderer/src/FilesCard.tsx"]);
  });

  it("error in a filesChanged path → task_failed", () => {
    const ev = evidence([
      cmd({
        exitCode: 2,
        failureKind: "test-failed",
        stdout: "src/main/message-bus.ts(10,1): error TS2322: Type 'x' is not assignable.\n",
      }),
    ]);
    const attr = classifyGateAttribution({ evidence: ev, filesChanged });
    expect(attr.class).toBe("task_failed");
    expect(attr.errorPaths).toContain("src/main/message-bus.ts");
  });

  it("no parseable path → gate_inconclusive (honest)", () => {
    const ev = evidence([
      cmd({ exitCode: 1, failureKind: "test-failed", stdout: "something broke with no file\n" }),
    ]);
    expect(classifyGateAttribution({ evidence: ev, filesChanged }).class).toBe("gate_inconclusive");
  });
});

describe("describeGateContradiction", () => {
  it("report ok:true + task_failed → one line with class task_failed, never 'contradiction'", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "faz X",
      reportOk: true,
      filesChanged: ["src/main/message-bus.ts"],
      evidence: evidence(
        [
          cmd({
            exitCode: 2,
            failureKind: "test-failed",
            stdout: "src/main/message-bus.ts(1,1): error TS2322: bad\n",
          }),
        ],
        { mode: "shared", appliedFiles: [], disputed: [], undeclaredInTerritory: [], worktree: null, reason: null, note: "" },
      ),
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("gate task_failed");
    expect(out!).not.toContain("contradiction");
    expect(out!).toContain("abcdef12");
    expect(out!).toContain("get_task");
    expect(out!).not.toMatch(/[\r\n]/);
  });

  it("report ok:true + foreign FilesCard.tsx errors → gate_inconclusive with 'outside this task's files'", () => {
    const out = describeGateContradiction({
      taskId: "1b3456c8-03c8-442f-830b-d3fd6d95dd7c",
      title: "Fase A",
      reportOk: true,
      filesChanged: ["src/main/board-scope-decision.ts", "src/main/message-bus.ts"],
      evidence: evidence(
        [
          cmd({
            exitCode: 2,
            failureKind: "test-failed",
            stdout: "src/renderer/src/FilesCard.tsx(10,5): error TS2304: Cannot find name 'X'.\n",
          }),
          cmd({ command: "npm run test:unit", exitCode: 0 }),
        ],
        { mode: "shared", appliedFiles: [], disputed: [], undeclaredInTerritory: [], worktree: null, reason: null, note: "" },
      ),
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("gate_inconclusive");
    expect(out!).toContain("errors look outside this task's files");
    expect(out!).not.toContain("no path parsed");
    expect(out!).not.toContain("contradiction");
    expect(out!).not.toContain("task_failed");
    expect(out!).toContain("get_task");
    expect(out!).toContain("1b3456c8");
    expect(out!).not.toMatch(/[\r\n]/);
  });

  it("no parseable path → gate_inconclusive with 'no path parsed', never 'outside this task's files'", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "x",
      reportOk: true,
      filesChanged: ["src/main/message-bus.ts"],
      evidence: evidence([
        cmd({ exitCode: 1, failureKind: "test-failed", stdout: "BOOM with no file path\n" }),
      ]),
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("gate_inconclusive");
    expect(out!).toContain("could not attribute the failure to any file (no path parsed)");
    expect(out!).not.toContain("errors look outside this task's files");
    expect(out!).toContain("get_task");
    expect(out!).not.toMatch(/[\r\n]/);
  });

  it("report ok:false + gate verde → named class ok (symmetric disagreement)", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "faz X",
      reportOk: false,
      filesChanged: ["src/a.ts"],
      evidence: evidence([cmd({ exitCode: 0 })], {
        mode: "isolated",
        appliedFiles: ["src/a.ts"],
        disputed: [],
        undeclaredInTerritory: [],
        worktree: "/tmp/wt",
        reason: null,
        note: "",
      }),
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("gate ok");
    expect(out!).toContain("report failure");
    expect(out!).toContain("gates passed");
    expect(out!).toContain("get_task");
    expect(out!).not.toMatch(/[\r\n]/);
  });

  it("concordância (sucesso+verde, falha+task_failed) → null: nada a dizer", () => {
    expect(
      describeGateContradiction({
        taskId: "abcdef12-3456-7890-0000-000000000000",
        title: "x",
        reportOk: true,
        filesChanged: [],
        evidence: evidence([cmd({ exitCode: 0 })]),
      }),
    ).toBeNull();
    expect(
      describeGateContradiction({
        taskId: "abcdef12-3456-7890-0000-000000000000",
        title: "x",
        reportOk: false,
        filesChanged: ["src/main/message-bus.ts"],
        evidence: evidence([
          cmd({
            exitCode: 1,
            failureKind: "test-failed",
            stdout: "src/main/message-bus.ts(1,1): error TS2322: bad\n",
          }),
        ]),
      }),
    ).toBeNull();
  });

  it("missing paths report gate_env_error instead of a contradiction", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "workspace gate",
      reportOk: true,
      filesChanged: [],
      evidence: evidence([
        cmd({
          exitCode: 2,
          failureKind: "gate_env_error",
          stderr:
            "python3: can't open file '/workspace/check.py': [Errno 2] No such file or directory",
        }),
      ]),
    });
    expect(out).toContain("gate_env_error");
    expect(out).not.toContain("contradiction");
    expect(out).toContain("get_task");
    expect(out).not.toContain("No such file or directory");
    expect(out).not.toMatch(/[\r\n]/);
  });
});

describe("describeGateIsolationMode", () => {
  it("isolado com sujos não declarados diz quantos entraram; shared diz o motivo", () => {
    expect(
      describeGateIsolationMode({
        mode: "isolated",
        reason: null,
        undeclaredInTerritory: ["src/b.ts"],
      }),
    ).toContain("1 file(s) of the territory not declared");
    expect(describeGateIsolationMode({ mode: "shared", reason: "sem card", undeclaredInTerritory: [] })).toContain(
      "sem card",
    );
  });
});

describe("taskGateViewFromResult", () => {
  it("extrai veredito, modo, não-declarados e o final da saída que falhou", () => {
    const resultJson = JSON.stringify({
      ok: true,
      gateRun: {
        ok: false,
        commands: [
          { command: "npm run check:types", exitCode: 2, stdout: "a\nb\nc", stderr: "erro fatal" },
        ],
        isolation: { mode: "isolated", reason: null, undeclaredInTerritory: ["src/b.ts"], appliedFiles: ["src/a.ts"] },
      },
    });
    const view = taskGateViewFromResult(resultJson);
    expect(view).not.toBeNull();
    expect(view!.ok).toBe(false);
    expect(view!.passed).toBe(0);
    expect(view!.total).toBe(1);
    expect(view!.failedCommand).toBe("npm run check:types");
    expect(view!.isolation).toEqual({ mode: "isolated", reason: null, undeclaredInTerritory: ["src/b.ts"] });
    expect(view!.failedOutput).toContain("erro fatal");
  });

  it("ausência/podre → null (a UI não desenha o chip)", () => {
    expect(taskGateViewFromResult(null)).toBeNull();
    expect(taskGateViewFromResult("{}")).toBeNull();
    expect(taskGateViewFromResult("not json")).toBeNull();
    expect(taskGateViewFromResult(JSON.stringify({ gateRun: { ok: true } }))).toBeNull();
  });
});

describe("lastNonEmptyLines", () => {
  it("pega as últimas n linhas não-vazias", () => {
    expect(lastNonEmptyLines("a\n\nb\nc\n", 2)).toBe("b\nc");
    expect(lastNonEmptyLines("", 3)).toBe("");
  });
});
