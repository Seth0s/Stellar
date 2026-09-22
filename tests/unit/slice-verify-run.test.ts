import { describe, it, expect, vi } from "vitest";
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
    expect(out.cleanupError).toBe("remove falhou");
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
});
