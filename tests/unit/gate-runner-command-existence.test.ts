import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyGateFailure,
  extractExecutable,
  gateVisiblePathDirs,
  isExecutableReachable,
  normalizeGateCommand,
  runTaskGates,
} from "../../src/main/gate-runner";

/**
 * Task 17d96ade — GATES QUE NÃO EXISTEM SÃO VERDES-MENTIROSOS.
 *
 * O fato medido: a task d4f2b5ca declarava `rtk proxy npx tsc --noEmit` e a
 * evidência registrou `exitCode:127, "bash: rtk: comando não encontrado"`. O
 * `ok` virou `false` por um BINÁRIO ausente, não por defeito no código — e os
 * dois casos eram indistinguíveis. Estes testes travam as duas metades da
 * correção: a CLASSIFICAÇÃO (127 nomeia o comando; nunca vira verde) e a
 * NORMALIZAÇÃO do wrapper morto.
 */

describe("gate-runner: existência do comando (task 17d96ade)", () => {
  it("extractExecutable pega o 1º token, pulando env e atribuições", () => {
    expect(extractExecutable("npx tsc --noEmit")).toBe("npx");
    expect(extractExecutable("NODE_ENV=test npm test")).toBe("npm");
    expect(extractExecutable("env FOO=bar python3 x.py")).toBe("python3");
    expect(extractExecutable("cd vhosts/Admin && npm run build")).toBe("cd");
    expect(extractExecutable("rtk proxy npx tsc --noEmit")).toBe("rtk");
    expect(extractExecutable("comando-que-nao-existe --x")).toBe("comando-que-nao-existe");
    expect(extractExecutable("")).toBeNull();
  });

  it("gateVisiblePathDirs: $HOME é ocultado pelo bwrap, fora da raiz re-bindada", () => {
    const home = "/home/u";
    const root = "/home/u/proj";
    const dirs = gateVisiblePathDirs(["/usr/bin", "/home/u/.local/bin", "/home/u/.cargo/bin", "/home/u/proj/tools", "/opt/x"].join(":"), home, root);
    expect(dirs).toContain("/usr/bin");
    expect(dirs).toContain("/opt/x");
    expect(dirs).toContain("/home/u/proj/tools"); // sob $HOME mas sob a raiz: visível
    expect(dirs).not.toContain("/home/u/.local/bin"); // sob $HOME, fora da raiz: OCULTO
    expect(dirs).not.toContain("/home/u/.cargo/bin");
  });

  it("isExecutableReachable resolve nome no PATH visível, e `/path` direto", () => {
    const probe = (p: string) => p === "/usr/bin/node" || p === "/opt/x/tool";
    expect(isExecutableReachable("node", ["/usr/bin"], probe)).toBe(true);
    expect(isExecutableReachable("node", ["/empty"], probe)).toBe(false);
    expect(isExecutableReachable("/usr/bin/node", ["/empty"], probe)).toBe(true);
    expect(isExecutableReachable(null, ["/usr/bin"], probe)).toBe(false);
  });

  it("classifyGateFailure: 127 é command-not-found, NUNCA verde nem teste-falhou", () => {
    expect(classifyGateFailure({ exitCode: 0, timedOut: false })).toBe("ok");
    expect(classifyGateFailure({ exitCode: 127, timedOut: false })).toBe("command-not-found");
    expect(classifyGateFailure({ exitCode: 126, timedOut: false })).toBe("not-executable");
    expect(classifyGateFailure({ exitCode: 1, timedOut: false })).toBe("test-failed");
    expect(classifyGateFailure({ exitCode: null, timedOut: false })).toBe("not-run");
    expect(classifyGateFailure({ exitCode: 0, timedOut: true })).toBe("timeout");
    expect(classifyGateFailure({ exitCode: null, timedOut: false, notRun: true })).toBe("not-run");
  });

  it("normalizeGateCommand remove o wrapper MORTO só quando ele é inalcançável", () => {
    const unreachable = () => false;
    const reachable = () => true;
    expect(normalizeGateCommand("rtk proxy npx tsc --noEmit", unreachable)).toEqual({
      command: "npx tsc --noEmit",
      stripped: "rtk",
    });
    // wrapper VIVO: a declaração é respeitada ao pé da letra.
    expect(normalizeGateCommand("rtk proxy npx tsc --noEmit", reachable)).toEqual({
      command: "rtk proxy npx tsc --noEmit",
      stripped: null,
    });
    // comando sem wrapper: intocado.
    expect(normalizeGateCommand("npx vitest run", unreachable)).toEqual({ command: "npx vitest run", stripped: null });
  });
});

describe("gate-runner: PROVA — o veredito NOMEIA o comando ausente (task 17d96ade)", () => {
  const dir = mkdtempSync(join(tmpdir(), "stellar-gate-name-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const nodeOk = `node -e ${JSON.stringify("process.exit(0)")}`;

  it("gate `comando-que-nao-existe` => failureKind command-not-found com o NOME", async () => {
    const evidence = await runTaskGates({
      taskId: "t-name-missing",
      cwd: dir,
      declaredRoot: dir,
      gates: ["comando-que-nao-existe --flag", nodeOk],
      timeoutMs: 30_000,
    });
    const [bad, good] = evidence.commands;
    expect(evidence.ok).toBe(false); // 127 NUNCA vira verde
    expect(bad.failureKind).toBe("command-not-found");
    expect(bad.missingExecutable).toBe("comando-que-nao-existe"); // NOMEIA
    expect(bad.exitCode).toBe(127);
    expect(good.failureKind).toBe("ok");
    expect(good.missingExecutable).toBeNull();
  });

  it("`rtk proxy <cmd>` é normalizado quando rtk não é alcançável, e o roda", async () => {
    const evidence = await runTaskGates({
      taskId: "t-normalize-rtk",
      cwd: dir,
      declaredRoot: dir,
      gates: [`rtk proxy ${nodeOk}`],
      timeoutMs: 30_000,
    });
    const c = evidence.commands[0];
    expect(c.normalizedCommand).toBe(nodeOk);
    expect(c.command).toBe(`rtk proxy ${nodeOk}`);
    expect(c.failureKind).toBe("ok");
  });
});
