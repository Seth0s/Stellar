/**
 * Pure decision for auto-dispatch spawn params.
 *
 * Provider: NEVER invent a constant (`?? "claude"` bit five tasks on
 * 2026-09-13). Undeclared → refuse with a visible reason; the orchestrator
 * declares. Inheritance of provider is deliberately NOT here — multiprovider
 * routing is by task shape, not lineage (owner 2026-09-13).
 *
 * Cwd: own declaration wins; else the dependency chain (parent task cwd,
 * then grandparent, …). Repo does not change down a deps edge. Divergent
 * parent cwds → refuse. Nobody has one → `undefined` so the renderer keeps
 * `activeBoardCwd` (declared board-root fallback, not a hardcoded path).
 */

import { resolve, sep } from "node:path";

/** Non-empty trimmed cwd, or null if absent. Whitespace-only is absent. */
export function normalizeTaskCwd(cwd: string | null | undefined): string | null {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Non-empty task cwd wins; otherwise `undefined` so the renderer keeps
 * using `activeBoardCwd`. */
export function resolveTaskDispatchCwd(taskCwd: string | null | undefined): string | undefined {
  return normalizeTaskCwd(taskCwd) ?? undefined;
}

/** Label that ties the spawned card to the task — without this the card
 * is born with the provider's ordinal name and looks "from nowhere". */
export function resolveTaskDispatchLabel(task: { id: string; prompt: string | null }): string {
  const prompt = task.prompt?.trim();
  if (prompt) {
    // Same spirit as connector-label truncation — short pill, not a novel.
    return prompt.length > 48 ? `${prompt.slice(0, 45)}…` : prompt;
  }
  return `task ${task.id.slice(0, 8)}`;
}

export const PROVIDER_UNDECLARED_REASON = "provider não declarado";

export type TaskDispatchProviderDecision =
  | { action: "dispatch"; provider: string }
  | { action: "refuse"; reason: string };

/** Only an explicit non-empty provider dispatches. No default, no inherit. */
export function decideTaskDispatchProvider(provider: string | null | undefined): TaskDispatchProviderDecision {
  const trimmed = typeof provider === "string" ? provider.trim() : "";
  if (!trimmed) return { action: "refuse", reason: PROVIDER_UNDECLARED_REASON };
  return { action: "dispatch", provider: trimmed };
}

/** One ancestor row for cwd inheritance — filled by the bus from `getTask`. */
export type AncestorCwdNode = {
  id: string;
  cwd: string | null | undefined;
  depIds: string[];
};

export type TaskDispatchCwdDecision =
  | { action: "ok"; cwd: string | undefined }
  | { action: "refuse"; reason: string };

/**
 * Own cwd wins. Else unique cwd from the dependency chain (BFS: parent
 * declaration, else that parent's deps). Divergent resolved cwds → refuse
 * with an actionable reason. Empty chain → `undefined` (board root).
 */
export function decideTaskDispatchCwd(
  taskCwd: string | null | undefined,
  ancestors: AncestorCwdNode[],
  rootDepIds: string[],
): TaskDispatchCwdDecision {
  const own = normalizeTaskCwd(taskCwd);
  if (own) return { action: "ok", cwd: own };

  const byId = new Map(ancestors.map((node) => [node.id, node]));
  const resolved: string[] = [];
  const seen = new Set<string>();

  function walk(depIds: string[]) {
    for (const id of depIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (!node) continue;
      const cwd = normalizeTaskCwd(node.cwd);
      if (cwd) {
        resolved.push(cwd);
        continue;
      }
      walk(node.depIds);
    }
  }
  walk(rootDepIds);

  const unique = [...new Set(resolved)];
  if (unique.length === 1) return { action: "ok", cwd: unique[0] };
  if (unique.length > 1) {
    return { action: "refuse", reason: `pais divergem em cwd: ${unique.join(", ")}` };
  }
  return { action: "ok", cwd: undefined };
}

/**
 * ============ CONFINAMENTO DO `cwd` (decisão do dono, 2026-09-21) ============
 *
 * O `cwd` de uma task é EXECUTÁVEL: decide onde o GATE roda
 * (`gate-runner.ts`) e onde um card AUTO-DESPACHADO abre. Até esta data ele
 * só passava por `trim` — o caminho era escolhido por quem chamava.
 *
 * Medido no banco real antes de escrever isto: 171 tasks com gates, 6 cards
 * distintos autorando gates; e 14 tasks cujo `cwd` estava FORA da raiz do
 * board (`/home/lucas/wt/idy-*`, hoje todas `done`) — um padrão NÃO
 * declarado, que é exatamente o que esta regra passa a recusar.
 *
 * A RAIZ É DECLARADA, NÃO DERIVADA: `boards.cwd` (a sessão real escolhida no
 * PathPicker; `store.ts` → BoardRow.cwd). Ausência de raiz (board legado sem
 * cwd, task sem board) NÃO vira recusa: ausência de raiz é ausência de
 * limite, e inventar uma recusa onde não há raiz é o outro modo de falhar —
 * brickar o que hoje funciona (o mesmo motivo que fez a regra de autoria de
 * gates depender da MARCA do board, medido: 64 e Estudos com marca NULL).
 *
 * Comparação LEXICAL e por FRONTEIRA de diretório: `/a/bc` NÃO está dentro de
 * `/a/b` (um `startsWith` cru diria que sim).
 *
 * DOIS RESÍDUOS DECLARADOS (aceitos no review de 2026-09-21, registrados
 * aqui em vez de corrigidos — não são silenciosos):
 *   - `realpath` NÃO é resolvido: um symlink DENTRO da raiz apontando para
 *     fora passa por aqui. Limite real, contido pelo `bwrap` na execução
 *     (`gate-runner.ts`), que é onde o custo cairia;
 *   - caminho RELATIVO resolve contra o `process.cwd()` do APP (é o que
 *     `resolve` faz), não contra a raiz do board. Borda não testada, baixo
 *     impacto: a porta MCP recebe caminho absoluto na prática.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const c = resolve(candidate);
  const r = resolve(root);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/**
 * A RAIZ DECLARADA que se aplica a UMA task. Sem board (ou board legado sem
 * `cwd`), a resposta é `undefined` — e `undefined` significa RECUSA, não
 * permissão: o `gate-runner.ts` NÃO executa nada sem raiz declarada (decisão
 * do dono, 2026-09-21).
 *
 * O NÚMERO que sustenta a decisão, medido no banco real em 2026-09-21: **33
 * tasks sem board, 22 delas COM gates** — e nenhuma delas é despachável (o
 * auto-dispatch exige `board_id`); as 3 não terminais estão DORMENTES (sem
 * card e sem vínculo, logo nenhum report as alcança) e as outras 30 são
 * terminais. Nenhum board ficou sem `cwd`. Task sem board também não é mais
 * criável (`create_task` recusa `boardId` nulo desde 2026-09-19) e nenhum cmd
 * do bus nem tool MCP escreve `boards.cwd`.
 *
 * Isto CONTRARIA a simetria que o Revisor A havia avalizado ("ausência de raiz
 * = ausência de limite") e é escolha declarada do dono, com o raio medido:
 * fechar custa linhas dormentes; deixar aberto custava um caminho de execução
 * de shell sem lugar autorizado.
 */
export function declaredRootForTask(
  boardId: string | null | undefined,
  boardCwd: string | null | undefined,
): string | undefined {
  if (!boardId) return undefined;
  return normalizeTaskCwd(boardCwd ?? null) ?? undefined;
}

export type TaskCwdRootDecision =
  | { action: "ok"; cwd: string | null }
  | { action: "refuse"; field: "cwd"; error: string };

/**
 * Decide o `cwd` de uma escrita. `ok` devolve o valor NORMALIZADO (trim,
 * vazio → `null`) para o chamador gravar exatamente o que foi validado.
 */
export function decideTaskCwdWithinRoot(input: {
  tool: string;
  cwd: unknown;
  root: string | null | undefined;
}): TaskCwdRootDecision {
  const cwd = normalizeTaskCwd(typeof input.cwd === "string" ? input.cwd : null);
  // Ausente/vazio: o fallback da raiz do board, declarado — nada a validar.
  if (!cwd) return { action: "ok", cwd: null };
  const root = normalizeTaskCwd(input.root ?? null);
  // Sem raiz declarada não há limite a aplicar — e não se inventa recusa.
  if (!root) return { action: "ok", cwd };
  if (isPathInsideRoot(cwd, root)) return { action: "ok", cwd };
  return {
    action: "refuse",
    field: "cwd",
    error: describeTaskCwdOutsideRoot({ tool: input.tool, cwd, root }),
  };
}

/** A recusa da ESCRITA — nomeia o campo, no idioma de `fieldRefusal`. */
export function describeTaskCwdOutsideRoot(input: { tool: string; cwd: string; root: string }): string {
  return (
    `[de: stellar] ${input.tool} recusado: \`cwd\` deve ser um caminho DENTRO da raiz declarada do board ` +
    `(${input.root}) — recebido: "${input.cwd}". O cwd decide onde o gate roda e onde um card auto-despachado abre; ` +
    `fora da raiz o app estaria executando num diretório que o board não declarou. ` +
    `Passe um caminho sob ${input.root}, ou omita o \`cwd\` para cair na raiz do board. Nada foi gravado.`
  );
}

/**
 * A MESMA recusa dita no ponto de EXECUÇÃO (auto-dispatch / gate) — aqui não
 * houve escrita a desfazer, então o texto diz "não executado" em vez de
 * "nada foi gravado". Vale para uma linha que JÁ está no banco, escrita antes
 * desta regra: o confinamento não depende de quando o valor entrou.
 */
export function describeTaskCwdOutsideRootExecution(input: {
  where: string;
  cwd: string;
  root: string;
}): string {
  return (
    `[de: stellar] ${input.where}: \`cwd\` "${input.cwd}" está FORA da raiz declarada do board (${input.root}) — ` +
    `não executado. O cwd de uma task decide onde o gate roda e onde um card auto-despachado abre; fora da raiz ` +
    `o app estaria executando num diretório que o board não declarou. Nada foi executado.`
  );
}
