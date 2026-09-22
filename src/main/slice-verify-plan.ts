/**
 * O PLANO DE VERIFICAÇÃO DE UMA FATIA — puro, para o shell só executar
 * (task 56604aca, fase 1: "esta fatia compila sozinha?").
 *
 * POR QUE ISTO EXISTE: `git diff HEAD -- <arquivos>` produz um patch SÓ de
 * arquivos TRACKED, e a árvore do dono tem untracked em quantidade (medido:
 * metade do que foi commitado num dia nasceu untracked). Sem tratar a via, a
 * fatia perde o arquivo novo EM SILÊNCIO e a resposta vira "não compila" por um
 * motivo que a própria verificação escondeu. Por isso CADA ARQUIVO carrega a
 * SUA VIA no plano, e o resultado diz por qual delas ele entrou:
 *
 *   tracked   → `git diff HEAD -- <paths>` no repo, aplicado no worktree
 *   untracked → o ARQUIVO é copiado para o worktree (+ `add -N` lá dentro, para
 *               um `git status`/`git diff` de gate também enxergá-lo)
 *
 * O `add -N` RODA DENTRO DO WORKTREE, NUNCA NO DONO: medido, ele toca o ÍNDICE
 * (` A arquivo`), e o índice do worktree é próprio — dentro dele o dono fica
 * com ZERO rastro (verificado por grep), na árvore dele não fica nenhum. E é POR
 * ARQUIVO, nunca curinga: o `node_modules` que o passo do symlink cria aparece
 * como `??` no worktree, e um `add -N` curinga arrastaria infraestrutura para
 * dentro da fatia.
 *
 * O `node_modules` é passo OBRIGATÓRIO e não é invenção minha: está no
 * procedimento do repo (docs/ORCHESTRATION.md, "Precisa de árvore limpa para um
 * gate?" e §11 passo 3). Medido: sem ele `node_modules/.bin/tsc` não existe no
 * worktree e os dois comandos que sustentam a fase 1 não rodam.
 *
 * E A LIMPEZA É SEMPRE O ÚLTIMO PASSO, inclusive quando um gate falha: worktree
 * órfão numa máquina com seis streams é dor.
 */

/** Uma entrada da fatia, já com o que o `git status` sabe dela. */
export type SliceEntry = {
  path: string;
  /** `false` = untracked (`??`): o patch do git não o carrega. */
  tracked: boolean;
};

export type SliceStepKind =
  | "worktree-add"
  | "node-modules-symlink"
  | "collect-patch"
  | "apply-patch"
  | "copy-untracked"
  | "intent-to-add"
  | "gate"
  | "cleanup";

export type SliceStep = {
  kind: SliceStepKind;
  /** `file` = a linha da fatia a que este passo pertence (a VIA é por arquivo;
   * `null` nos passos de infraestrutura). */
  file: string | null;
  argv: string[];
  /** `cwd` do processo. Os passos que mexem no worktree rodam LÁ. */
  cwd: string;
  /** Só no `collect-patch`: onde o patch é gravado. */
  outFile?: string;
  /** Só no `gate`: o comando como a task o declarou. */
  command?: string;
};

export type SlicePlan = {
  repoRoot: string;
  worktree: string;
  patchFile: string;
  /** A via de cada arquivo, na ordem — o que a tela diz. */
  routes: { path: string; route: "tracked-patch" | "untracked-copy" }[];
  steps: SliceStep[];
};

export type SlicePlanInput = {
  repoRoot: string;
  /** Onde o worktree temporário nasce (o chamador decide; sempre fora do repo). */
  worktree: string;
  /** Onde o patch dos tracked é gravado. */
  patchFile: string;
  entries: readonly SliceEntry[];
  /** Os gates DECLARADOS da task, na ordem. Vazio = nada a rodar (e a fase 1
   * vira só "montou a fatia"). */
  gates: readonly string[];
};

export function planSliceVerification(input: SlicePlanInput): SlicePlan {
  const tracked = input.entries.filter((e) => e.tracked);
  const untracked = input.entries.filter((e) => !e.tracked);
  const steps: SliceStep[] = [];

  steps.push({
    kind: "worktree-add",
    file: null,
    argv: ["git", "-C", input.repoRoot, "worktree", "add", input.worktree, "HEAD"],
    cwd: input.repoRoot,
  });
  steps.push({
    kind: "node-modules-symlink",
    file: null,
    // O procedimento do repo: dependência por SYMLINK, porque `node_modules`
    // está no .gitignore e o worktree nasce sem ela.
    argv: ["ln", "-s", `${input.repoRoot}/node_modules`, `${input.worktree}/node_modules`],
    cwd: input.worktree,
  });

  if (tracked.length > 0) {
    steps.push({
      kind: "collect-patch",
      file: null,
      argv: [
        "git",
        "-C",
        input.repoRoot,
        "diff",
        "--binary",
        "HEAD",
        "--",
        ...tracked.map((e) => e.path),
      ],
      cwd: input.repoRoot,
      outFile: input.patchFile,
    });
    steps.push({
      kind: "apply-patch",
      file: null,
      argv: ["git", "-C", input.worktree, "apply", input.patchFile],
      cwd: input.worktree,
    });
  }

  for (const entry of untracked) {
    steps.push({
      kind: "copy-untracked",
      file: entry.path,
      // `--parents` com caminho RELATIVO e `cwd` na raiz: assim a árvore de
      // diretórios nasce dentro do worktree. Com o caminho absoluto, o `cp`
      // recriaria `/home/...` inteiro lá dentro — medido, não suposto.
      argv: ["cp", "--parents", entry.path, input.worktree],
      cwd: input.repoRoot,
    });
    // `add -N` DENTRO do worktree: o índice é dele, e um diff de gate também
    // precisa enxergar o arquivo novo. Medido que não deixa rastro no dono.
    steps.push({
      kind: "intent-to-add",
      file: entry.path,
      argv: ["git", "-C", input.worktree, "add", "-N", "--", entry.path],
      cwd: input.worktree,
    });
  }

  for (const command of input.gates) {
    steps.push({
      kind: "gate",
      file: null,
      // Mesma forma do gate-runner: argv por array com `bash -lc`, nunca uma
      // string de shell montada por concatenação.
      argv: ["bash", "-lc", command],
      cwd: input.worktree,
      command,
    });
  }

  steps.push({
    kind: "cleanup",
    file: null,
    argv: ["git", "-C", input.repoRoot, "worktree", "remove", "--force", input.worktree],
    cwd: input.repoRoot,
  });

  return {
    repoRoot: input.repoRoot,
    worktree: input.worktree,
    patchFile: input.patchFile,
    routes: input.entries.map((e) => ({
      path: e.path,
      route: e.tracked ? "tracked-patch" : "untracked-copy",
    })),
    steps,
  };
}
