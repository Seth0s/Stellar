import { describe, expect, it } from "vitest";
import { worktreeLeftoverNotice } from "../../src/main/message-bus";

/**
 * Item 16 do sticky — FIM DE TASK em um passo.
 *
 * Medido: a worktree de um card isolado só é removida no caminho de FALHA de
 * spawn (`message-bus.ts`), NUNCA quando a task dá certo — ela some da vista.
 * A parte SEGURA é NOMEAR o que sobrou; a remoção (`--force`, apaga trabalho
 * não commitado) e o prune de branch são decisão do dono, não deste caminho.
 */
describe("worktreeLeftoverNotice (item 16)", () => {
  const ROOT = "/tmp/stellar-wt";

  it("cwd dentro da raiz de worktree → NOMEIA o que sobrou (e diz por que não remove)", () => {
    const got = worktreeLeftoverNotice("/tmp/stellar-wt/ab12cd34", ROOT);
    expect(got).toContain("/tmp/stellar-wt/ab12cd34");
    expect(got).toContain("was NOT removed");
    expect(got).toContain("--force");
  });

  it("cwd normal (árvore principal) → nada (sem ruído)", () => {
    expect(worktreeLeftoverNotice("/home/u/projects/repo", ROOT)).toBeNull();
    // Prefixo PARECIDO mas não dentro: `/tmp/stellar-wt-other` NÃO conta.
    expect(worktreeLeftoverNotice("/tmp/stellar-wt-other/x", ROOT)).toBeNull();
  });

  it("sem cwd → nada (ausência é dado)", () => {
    expect(worktreeLeftoverNotice(null, ROOT)).toBeNull();
    expect(worktreeLeftoverNotice(undefined, ROOT)).toBeNull();
    expect(worktreeLeftoverNotice("", ROOT)).toBeNull();
  });
});
