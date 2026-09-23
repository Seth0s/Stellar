import { describe, it, expect, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeSandboxUnavailable, runTaskGates } from "../../src/main/gate-runner";

/**
 * ITEM 3 (decisão do dono, 2026-09-21) — DOCUMENTAR E TRAVAR o limite que já
 * existe na execução. `gates` são shell de autoria de agente; a contenção
 * real é o `bubblewrap`, a recusa POR COMANDO quando não há `bwrap`, e a
 * ausência de QUALQUER fallback para shell do host.
 *
 * O que estes testes prendem:
 *   1. o cwd do gate também é confinado à declared root (item 1, na
 *      EXECUÇÃO — vale também para uma linha que já está no banco);
 *   2. uma string de gate com forma de injeção continua sendo argv, nunca
 *      shell: o processo do host é SEMPRE o binário do sandbox;
 *   3. um edit futuro que reintroduza `shell: true` (ou `execSync`) neste
 *      módulo nasce VERMELHO — leitura da fonte, o mesmo gate de fiação de
 *      `providers-config-seed.test.ts`.
 */

describe("gate-runner: o cwd do gate é confinado à declared root", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  it("cwd OUTSIDE the board's declared root: nenhum spawn, recusa POR COMANDO nomeando `cwd`", async () => {
    const root = tempDir("stellar-gate-declared-root-");
    const outside = tempDir("stellar-gate-declared-outside-");
    let spawnCalls = 0;
    const spawnSpy = (() => {
      spawnCalls += 1;
      return new EventEmitter() as never;
    }) as never;

    const evidence = await runTaskGates({
      taskId: "t-cwd-out",
      cwd: outside,
      declaredRoot: root,
      gates: ["echo hi", "echo bye"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spawnSpy,
    });

    expect(spawnCalls).toBe(0);
    expect(evidence.ok).toBe(false);
    expect(evidence.commands).toHaveLength(2);
    for (const c of evidence.commands) {
      expect(c.exitCode).toBeNull();
      expect(c.stderr).toContain("`cwd`");
      expect(c.stderr).toContain(resolve(root));
    }
  });

  it("cwd DENTRO da declared root: roda normalmente, no binário do sandbox", async () => {
    const root = tempDir("stellar-gate-declared-inside-");
    const inside = join(root, "sub");
    mkdirSync(inside);
    const seen: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnSpy = ((file: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ file, args, options });
      const child: any = new EventEmitter();
      child.pid = 999_998;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    }) as never;

    const evidence = await runTaskGates({
      taskId: "t-cwd-in",
      cwd: inside,
      declaredRoot: root,
      gates: ["echo hi"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spawnSpy,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe("/usr/bin/bwrap");
    expect(evidence.ok).toBe(true);
  });

  it("SEM declared root o gate NÃO executa — 'rodar sem limite' deixou de existir", async () => {
    // DECISÃO DO DONO (2026-09-21), e ela é CONTRA a simetria que o Revisor A
    // havia validado: "ausência de raiz = ausência de limite" estava certa
    // quando a alternativa era brickar fluxo que funciona. A medição destruiu
    // a premissa: das 33 tasks sem board NENHUMA é despachável, as 3 não
    // terminais estão dormentes (sem card e sem vínculo), e task sem board não
    // é mais criável; nenhum board ficou sem `cwd`. O raio é dormente/terminal.
    // Manter um buraco conhecido em EXECUÇÃO de gate por elegância de simetria
    // é a troca errada. Agora não existe caminho para rodar shell de agente
    // sem uma declared root.
    const dir = tempDir("stellar-gate-no-root-");
    let spawnCalls = 0;
    const spawnSpy = (() => {
      spawnCalls += 1;
      return new EventEmitter() as never;
    }) as never;

    const evidence = await runTaskGates({
      taskId: "t-no-root",
      cwd: dir,
      gates: ["echo hi", "echo bye"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spawnSpy,
    });

    expect(spawnCalls).toBe(0);
    expect(evidence.ok).toBe(false);
    expect(evidence.commands).toHaveLength(2);
    for (const c of evidence.commands) {
      expect(c.exitCode).toBeNull();
      expect(c.stderr).toContain("declared root");
      expect(c.stderr).toContain("Nothing was executed");
    }
  });
});

describe("GATE: nunca existe caminho para shell do host", () => {
  it("string de gate com forma de injeção continua ARGV — o host só vê o sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stellar-gate-hostile-"));
    const seen: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnSpy = ((file: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ file, args, options });
      const child: any = new EventEmitter();
      child.pid = 999_996;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit("close", 0, null), 0);
      return child;
    }) as never;
    const hostile = `'; touch /tmp/stellar-pwned; echo '`;

    try {
      await runTaskGates({
        taskId: "t-hostile",
        cwd: dir,
        declaredRoot: dir,
        gates: [hostile],
        timeoutMs: 5_000,
        sandboxBinary: "/usr/bin/bwrap",
        spawnFn: spawnSpy,
      });

      expect(seen).toHaveLength(1);
      // O processo do host É o sandbox — nunca um shell.
      expect(seen[0].file).toBe("/usr/bin/bwrap");
      expect(seen[0].file).not.toMatch(/sh$|bash$/);
      // A string crua só existe como ARGV de `bash -lc` DENTRO do sandbox.
      expect(seen[0].args.slice(-3)).toEqual(["bash", "-lc", hostile]);
      // Sem shell no host: não há onde enfiar a string crua.
      expect(seen[0].options.shell).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem bwrap a recusa é por comando e nomeia o sandbox (nunca fallback silencioso)", () => {
    const reason = describeSandboxUnavailable();
    expect(reason).toContain("bubblewrap");
    expect(reason).toContain("do not run without confinement");
    expect(reason).toContain("Nothing was executed");
  });

  it("a FONTE do gate-runner não reintroduz shell do host", () => {
    const source = readFileSync(new URL("../../src/main/gate-runner.ts", import.meta.url), "utf8");
    // Sem comentários: este arquivo CITA `shell: true` no cabeçalho para
    // explicar por que ele saiu; o gate procura CÓDIGO.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/shell\s*:\s*true/);
    expect(code).not.toMatch(/execSync\s*\(/);
    expect(code).not.toMatch(/\bexec\s*\(/);
    // O comando do agente só entra como argv; `spawnFn` recebe o binário do
    // sandbox como primeiro argumento.
    expect(code).toMatch(/buildSandboxedBashArgs\(/);
    expect(code).toMatch(/opts\.spawnFn\(opts\.sandboxBinary/);
  });
});
