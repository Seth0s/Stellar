import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSlicePlan } from "../../src/main/git-tools";
import { planSliceVerification, type SliceEntry } from "../../src/main/slice-verify-plan";

/**
 * O SHELL DA VERIFICAÇÃO (task 56604aca, fase 1) — o que ele faz com o plano.
 *
 * O que estes testes travam, e por que importam mais que o caminho feliz:
 *   - A LIMPEZA RODA SEMPRE, inclusive quando um gate falha ou um passo
 *     explode no meio: worktree órfão numa máquina com seis streams é dor;
 *   - "não montou" NÃO é "não compila": falha de worktree/symlink/apply é dita
 *     como não-montou, para ninguém ler o resultado como veredito de código;
 *   - WORKTREE DENTRO DO REPO é recusado ANTES de executar nada.
 */

const REPO = "/repo";
const WT = "/tmp/wt";

const entry = (path: string, tracked: boolean): SliceEntry => ({ path, tracked });

function plan(entries: SliceEntry[], gates: string[] = ["npx tsc --noEmit"]) {
  return planSliceVerification({
    repoRoot: REPO,
    worktree: WT,
    patchFile: "/tmp/fatia.patch",
    entries,
    gates,
  });
}

/** Spawn falso: casa por argv e devolve o que a tabela disser. Registra tudo. */
function fakeSpawn(
  table: (argv: string[]) => { exitCode: number | null; stdout?: string; stderr?: string },
) {
  const calls: string[][] = [];
  const fn = async (argv: string[]) => {
    calls.push(argv);
    const res = table(argv);
    return { exitCode: res.exitCode, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  return { fn, calls };
}

describe("runSlicePlan — o veredito e a limpeza", () => {
  it("tudo verde: veredito 'compila' e o worktree é removido", async () => {
    const { fn, calls } = fakeSpawn(() => ({ exitCode: 0 }));

    const out = await runSlicePlan(plan([entry("src/a.ts", true)]), { spawnFn: fn });

    expect(out.verdict).toBe("compila");
    expect(out.cleaned).toBe(true);
    expect(out.cleanupError).toBeNull();
    // A limpeza é a ÚLTIMA coisa executada, e roda uma vez só.
    const cleanups = calls.filter((c) => c.includes("remove"));
    expect(cleanups).toHaveLength(1);
    expect(calls[calls.length - 1]).toEqual(cleanups[0]);
  });

  it("gate vermelho: veredito 'nao-compila' — e a LIMPEZA ACONTECE ASSIM MESMO", async () => {
    const { fn, calls } = fakeSpawn((argv) => ({ exitCode: argv.includes("bash") ? 2 : 0 }));

    const out = await runSlicePlan(plan([entry("src/a.ts", true)]), { spawnFn: fn });

    expect(out.verdict).toBe("nao-compila");
    expect(out.cleaned).toBe(true);
    expect(calls.some((c) => c.includes("remove"))).toBe(true);
    expect(out.steps.find((s) => s.kind === "gate")?.exitCode).toBe(2);
  });

  it("a fatia NÃO montou (worktree falhou): é 'nao-montou', nunca 'nao-compila'", async () => {
    const { fn } = fakeSpawn((argv) => ({ exitCode: argv.includes("worktree") ? 128 : 0 }));

    const out = await runSlicePlan(plan([entry("src/a.ts", true)]), { spawnFn: fn });

    expect(out.verdict).toBe("nao-montou");
    // E os gates nem tentaram: não se roda gate em worktree pela metade.
    expect(out.steps.some((s) => s.kind === "gate")).toBe(false);
  });

  it("sem gate declarado: 'nao-montou' — ausência de gate não é aprovação", async () => {
    const { fn } = fakeSpawn(() => ({ exitCode: 0 }));

    const out = await runSlicePlan(plan([entry("src/a.ts", true)], []), { spawnFn: fn });

    expect(out.verdict).toBe("nao-montou");
  });

  it("falha na LIMPEZA é REPORTADA, nunca engolida", async () => {
    const { fn } = fakeSpawn((argv) => ({
      exitCode: argv.includes("remove") ? 1 : 0,
      stderr: "remove falhou",
    }));

    const out = await runSlicePlan(plan([entry("src/a.ts", true)]), { spawnFn: fn });

    expect(out.cleaned).toBe(false);
    // O motivo cru continua no campo, e o desfecho da REDE vem dito ao lado —
    // `cleaned: false` é a verdade (o `worktree remove` falhou), e o operador
    // precisa saber se sobrou lixo no disco ou não.
    expect(out.cleanupError).toContain("remove falhou");
    expect(out.cleanupError).toContain("diretório removido à força");
  });

  it("worktree DENTRO do repositório é recusado antes de executar qualquer coisa", async () => {
    const spy = vi.fn();
    const inner = planSliceVerification({
      repoRoot: REPO,
      worktree: `${REPO}/.tmp-wt`,
      patchFile: "/tmp/fatia.patch",
      entries: [entry("src/a.ts", true)],
      gates: ["npx tsc --noEmit"],
    });

    const out = await runSlicePlan(inner, { spawnFn: spy as never });

    expect(out.refused).toContain("worktree dentro do repositorio");
    expect(out.steps).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * O FURO MEDIDO NA 2ª RODADA (reviewer reprovou por isto): a rede de
   * segurança do `rmSync` vivia DENTRO do `catch` — e `defaultSliceSpawn` não
   * LANÇA no caminho real de falha (`git worktree remove` saindo 128): ele
   * RESOLVE com o exit code. O `catch` era código morto no caminho de produção,
   * e o diretório do worktree ficava no disco.
   *
   * A asserção que pega isso não é a mensagem (o teste antigo já a via, e
   * passava com o vazamento acontecendo): é o DIRETÓRIO NÃO EXISTIR MAIS. Com um
   * spawn que RESOLVE com exit != 0 — exatamente a forma do spawn de produção —
   * o diretório tem de sumir do disco.
   */
  it("limpeza que FALHA (exit != 0, sem lançar) não deixa o diretório órfão no disco", async () => {
    const wt = mkdtempSync(join(tmpdir(), "fatia-wt-"));
    try {
      const inner = planSliceVerification({
        repoRoot: REPO,
        worktree: wt,
        patchFile: join(tmpdir(), "fatia.patch"),
        entries: [entry("src/a.ts", true)],
        gates: ["npx tsc --noEmit"],
      });
      // A FORMA DO SPAWN DE PRODUÇÃO: resolve, nunca lança.
      const { fn } = fakeSpawn((argv) => ({
        exitCode: argv.includes("remove") ? 128 : 0,
        stderr: "fatal: could not remove worktree",
      }));

      const out = await runSlicePlan(inner, { spawnFn: fn });

      expect(out.cleaned).toBe(false);
      expect(out.cleanupError).toContain("fatal");
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  /**
   * A PROVA SEM NENHUM FALSO — e ela existe por causa da armadilha que o dono
   * avisou: "a suíte inteira passa um `gitFn` falso", e teste que passa tudo
   * falso pode passar por vacuidade igual ao smoke que ele reprovou. Este aqui
   * NÃO recebe spawn nenhum: usa o `defaultSliceSpawn` DE PRODUÇÃO, um
   * repositório git DE VERDADE e falhas DE VERDADE do git (exit 128 nas duas).
   * O diretório do worktree existe no disco ANTES (assertado) e a asserção é
   * sobre ele não existir depois.
   *
   * O caminho exercitado é o real: o `worktree add` do plano falha porque o
   * caminho já existe; o `finally` roda o `worktree remove --force`, que falha
   * porque aquele caminho não é um worktree REGISTRADO ("is not a working
   * tree"). É o mesmo formato de falha do vazamento relatado — o spawn RESOLVE
   * com exit != 0, nunca lança —, então o `catch` que abrigava o `rmSync` era
   * código morto e a pasta ficava no disco.
   */
  it("git REAL, sem spawn falso: `worktree remove` falhando (128) não deixa a pasta no disco", async () => {
    const root = mkdtempSync(join(tmpdir(), "fatia-real-"));
    const repoRoot = join(root, "repo");
    const wt = join(root, "wt");
    try {
      mkdirSync(repoRoot, { recursive: true });
      const g = (args: string[]) =>
        execFileSync("git", ["-C", repoRoot, ...args], { stdio: "pipe" });
      execFileSync("git", ["init", "-q", repoRoot]);
      writeFileSync(join(repoRoot, "a.txt"), "a\n");
      g(["add", "-A"]);
      g(["-c", "user.email=smoke@local", "-c", "user.name=Smoke", "commit", "-qm", "init"]);
      // O caminho do worktree JÁ EXISTE e não é registrado: as duas falhas do
      // git abaixo são reais, não simuladas.
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "ja-existe.txt"), "x\n");
      expect(existsSync(wt)).toBe(true); // pré-condição: há o que vazar

      const p = planSliceVerification({
        repoRoot,
        worktree: wt,
        patchFile: join(root, "p.diff"),
        entries: [entry("a.txt", true)],
        gates: [],
      });

      const out = await runSlicePlan(p); // ← sem spawnFn: o spawn de produção

      expect(out.cleaned).toBe(false);
      expect(out.cleanupError).toContain("is not a working tree");
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
