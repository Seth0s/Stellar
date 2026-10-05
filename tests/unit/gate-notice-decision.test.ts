import { describe, expect, it } from "vitest";
import {
  describeGateContradiction,
  describeGateIsolationMode,
  describeGateResultSuffix,
  gateRunSummaryFromEvidence,
  lastNonEmptyLines,
  taskGateViewFromResult,
} from "../../src/main/gate-notice-decision";
import type { GateRunEvidence } from "../../src/main/gate-runner";

/**
 * The gate MESSAGES: the report notice carries the result on the SAME line,
 * the contradiction is the ONLY self-standing message, and the slice the Fila
 * draws. Pure — no process, no database.
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

describe("describeGateResultSuffix", () => {
  it("verde: só N/N; vermelho: N/M + comando que falhou; null: ainda rodando", () => {
    expect(describeGateResultSuffix({ ok: true, passed: 2, total: 2, failedCommand: null })).toBe(" — gates 2/2");
    expect(describeGateResultSuffix({ ok: false, passed: 1, total: 2, failedCommand: "npm run check:types" })).toBe(
      " — gates 1/2 — failed: npm run check:types",
    );
    expect(describeGateResultSuffix(null)).toBe(" — gates ainda rodando");
  });
});

describe("gateRunSummaryFromEvidence", () => {
  it("conta verdes e nomeia o primeiro que falhou", () => {
    const s = gateRunSummaryFromEvidence(evidence([cmd({ exitCode: 0 }), cmd({ command: "tsc", exitCode: 2 })]));
    expect(s).toEqual({ ok: false, passed: 1, total: 2, failedCommand: "tsc" });
  });
});

describe("describeGateContradiction", () => {
  it("report ok:true + gate vermelho → mensagem própria com id curto, comando, modo e final da saída", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "faz X",
      reportOk: true,
      evidence: evidence(
        [cmd({ exitCode: 2, stdout: "linha1\nlinha2\nERRO: tipo inválido\n" })],
        { mode: "shared", appliedFiles: [], disputed: [], undeclaredInTerritory: [], worktree: null, reason: null, note: "" },
      ),
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("gate contradiction");
    expect(out!).toContain("abcdef12");
    expect(out!).toContain("faz X");
    expect(out!).toContain("SUCCESS (ok:true)");
    expect(out!).toContain("npm run check:types");
    expect(out!).toContain("shared tree");
    expect(out!).toContain("ERRO: tipo inválido");
  });

  it("report ok:false + gate verde → a contradição simétrica", () => {
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "faz X",
      reportOk: false,
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
    expect(out!).toContain("FAILURE (ok:false)");
    expect(out!).toContain("isolated worktree");
    expect(out!).not.toContain("Last output:");
  });

  it("concordância (sucesso+verde, falha+vermelho) → null: nada a dizer", () => {
    expect(
      describeGateContradiction({
        taskId: "abcdef12-3456-7890-0000-000000000000",
        title: "x",
        reportOk: true,
        evidence: evidence([cmd({ exitCode: 0 })]),
      }),
    ).toBeNull();
    expect(
      describeGateContradiction({
        taskId: "abcdef12-3456-7890-0000-000000000000",
        title: "x",
        reportOk: false,
        evidence: evidence([cmd({ exitCode: 1, stdout: "boom" })]),
      }),
    ).toBeNull();
  });

  it("a saída final carrega no MÁXIMO 10 linhas", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `linha-${i + 1}`).join("\n");
    const out = describeGateContradiction({
      taskId: "abcdef12-3456-7890-0000-000000000000",
      title: "x",
      reportOk: true,
      evidence: evidence([cmd({ exitCode: 1, stdout })]),
    });
    const tail = out!.split("Last output:\n")[1]!.split("\n");
    expect(tail).toHaveLength(10);
    expect(tail[0]).toBe("linha-21");
    expect(tail[9]).toBe("linha-30");
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
