/**
 * DESIGN-BACKLOG.md §2.1 "Card `task`" — pure, React-free view-model logic
 * for the kanban board (Fase 2, peças 2 e 4). Extracted for the same reason
 * board-model.ts/radial-ring-geometry.ts already are: `vitest` here runs
 * `environment: "node"` (no jsdom), so TaskCard.tsx itself is never
 * mountable in this suite — everything worth asserting about "which column
 * a task lands in", "what order it renders in", "what badge it wears",
 * "what stage it's in" and "when to show the conclusion proposal" has to
 * live somewhere a plain `describe`/`it` can reach without a DOM.
 *
 * Kept independent of `preload/index.ts`'s `TaskBoardItem` on purpose (only
 * the narrow structural shape each function needs, via generics/local
 * types) — this module has zero Electron-adjacent imports, same posture as
 * `board-model.ts`.
 */

/** DESIGN-BACKLOG.md §2.1, decisão 2 — quatro colunas, não três: `failed` é
 * um status real do modelo (`retryCount`/`attemptedProviders` vivem lá), e
 * escondê-la apagaria exatamente as tasks que um humano mais precisa ver.
 * Decisão 3 — "review é ETAPA, não coluna": uma task em review continua
 * `doing`, ver `deriveStage` mais abaixo. */
export type TaskColumn = "todo" | "doing" | "done" | "failed";

export const COLUMN_ORDER: readonly TaskColumn[] = ["todo", "doing", "done", "failed"];

export const COLUMN_TITLE: Record<TaskColumn, string> = {
  todo: "a fazer",
  doing: "em andamento",
  done: "concluído",
  failed: "falhou",
};

const STATUS_TO_COLUMN: Record<string, TaskColumn> = {
  pending: "todo",
  running: "doing",
  done: "done",
  failed: "failed",
};

/** `update_task`'s own MCP schema (`mcp-server.ts`) takes `status` as a
 * plain `z.string()`, no enforced enum — an external orchestrator COULD
 * write a status this board has never seen. Falls back to "todo" (the
 * column that best matches "hasn't started yet") instead of silently
 * dropping the task off the board — an unrecognized status is a real
 * anomaly worth surfacing, not one worth hiding. */
export function columnForStatus(status: string): TaskColumn {
  return STATUS_TO_COLUMN[status] ?? "todo";
}

/** Minimal shape `taskSortKey`/`compareTasks`/`groupTasksByColumn` need —
 * kept local (not imported from `preload/index.ts`) so this module stays
 * independently testable with plain object literals. */
export type TaskOrderable = { order: number | null; suggestedOrder: number | null; createdAt: number };

/** DESIGN-BACKLOG.md §2.1, decisão 6 — DOIS DONOS deliberadamente
 * separados: `order` só um humano arrastando escreve, `suggestedOrder` só
 * um agente. O humano VENCE na leitura — mas só quando ele de fato
 * decidiu algo; uma task que nenhum humano tocou ainda cai pro palpite do
 * agente, e uma que nenhum dos dois tocou vai pro fim, ordenada só por
 * `createdAt` (nunca as duas prioridades disputando o mesmo número). */
export function taskSortKey(t: TaskOrderable): number {
  if (t.order !== null) return t.order;
  if (t.suggestedOrder !== null) return t.suggestedOrder;
  return Number.POSITIVE_INFINITY;
}

export function compareTasks(a: TaskOrderable, b: TaskOrderable): number {
  const ka = taskSortKey(a);
  const kb = taskSortKey(b);
  if (ka !== kb) return ka - kb;
  return a.createdAt - b.createdAt;
}

export function groupTasksByColumn<T extends TaskOrderable & { status: string }>(tasks: readonly T[]): Record<TaskColumn, T[]> {
  const groups: Record<TaskColumn, T[]> = { todo: [], doing: [], done: [], failed: [] };
  for (const t of tasks) groups[columnForStatus(t.status)].push(t);
  for (const col of COLUMN_ORDER) groups[col].sort(compareTasks);
  return groups;
}

/** `actor` de `task_transitions` (store.ts) — replicado aqui em vez de
 * importado (ver o doc comment do módulo) pra manter isto livre de
 * qualquer dependência do lado Electron. */
export type TaskActor = "app" | "agent" | "human";

const ACTOR_BADGE: Record<TaskActor, string> = { app: "auto", agent: "agente", human: "você" };

/** Selo de origem (DESIGN-BACKLOG.md §2.1, "lido da última linha do log de
 * transição") — `lastActor` já chega pronto do main process (uma
 * subquery correlacionada por board inteiro, não um `getTask` por task —
 * ver `store.ts`'s `listLastActorsForBoard`). `null` cobre tanto uma task
 * sem NENHUMA transição gravada (predata `task_transitions` — decisão
 * explícita de não inventar passado) quanto qualquer ator desconhecido:
 * os dois casos rendem "sem selo", nunca um palpite. */
export function originBadge(lastActor: TaskActor | null): string | null {
  return lastActor ? ACTOR_BADGE[lastActor] : null;
}

export type TaskStage = "implementar" | "review";

/** Trilha de etapa implementar→review (decisão 3 — etapa, não coluna). Sem
 * uma coluna `stage` no banco ainda (reservada, nunca escrita — ver
 * `TaskTransitionRow`'s doc comment em store.ts), a etapa é DERIVADA do
 * relatório do card principal: nenhum relatório ainda = implementando;
 * QUALQUER relatório (aprovado ou reprovado) = já foi entregue pra
 * revisão pelo menos uma vez.
 *
 * LIMITAÇÃO CONHECIDA, documentada em vez de escondida: sem um "round id"
 * no relatório, isto não distingue "revisando a primeira entrega" de
 * "revisando a quinta depois de 4 reprovações" — só sabe dizer que alguma
 * entrega já aconteceu para a rodada atual. Só se aplica a uma task
 * `running` (`doing`); qualquer outro status não tem etapa. */
export function deriveStage(status: string, hasReport: boolean): TaskStage | null {
  if (status !== "running") return null;
  return hasReport ? "review" : "implementar";
}

/** Barra de proposta de conclusão (decisão 9) — só APARECE, nunca decide:
 * "o app nunca marca concluído sozinho" (decisão 8) é a UI nunca chamando
 * `approveCompletion` sozinha, só o humano clicando o botão que esta
 * função manda mostrar. `verdict` vem do MESMO relatório que
 * `deriveStage` acima consome. */
export function shouldProposeCompletion(status: string, verdict: string | null | undefined): boolean {
  return status === "running" && verdict === "aprovado";
}

/** RODADA 2 (review de fidelidade ao protótipo v5) — id curto pro topo do
 * item: o protótipo mostra `a54269c1` (8 chars), e hoje o item só é
 * identificável pelo `prompt` cru clampado em 3 linhas — os prompts reais
 * deste board têm parágrafos inteiros, então três linhas truncadas não
 * identificam task nenhuma. `slice` puro, sem hífen/formatação — mesma
 * convenção que os ids de card já usam crus no resto do app. */
export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Idade relativa (`18h`, `2d`, `agora`) — `now` é parâmetro explícito (nunca
 * `Date.now()` lido aqui dentro) pra ficar testável sem mockar relógio,
 * mesma convenção que `evaluateRebindCandidate`/`shortcut-config.ts` já
 * usa pra qualquer função que dependeria da hora atual. Granularidade
 * decrescente: minutos abaixo de 1h, horas abaixo de 1d, dias daí em
 * diante — nunca combina duas unidades ("1d 3h"), o protótipo só mostra
 * uma. */
export function formatTaskAge(createdAt: number, now: number): string {
  const diff = Math.max(0, now - createdAt);
  if (diff < MINUTE_MS) return "agora";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}min`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  return `${Math.floor(diff / DAY_MS)}d`;
}

/** RODADA 3 (review adversarial da rodada 2, achado B, alto) — a versão da
 * rodada 2 tratava um dep AUSENTE de `depStatuses` (status desconhecido)
 * como NÃO bloqueante, pra "não arriscar um falso positivo". Errado:
 * conferido contra o motor de verdade (`message-bus.ts`'s `onTaskDone`,
 * `allDone = deps.every(depId => allTasks.find(t => t.id === depId)
 * ?.status === "done")`) — uma dependência que não resolve a NENHUMA task
 * (`.find` retorna `undefined`, `?.status` também) faz `allDone` dar
 * `false` exatamente como uma dependência real ainda `running`. O motor
 * NUNCA despacha aquela task enquanto isso não mudar. A UI da rodada 2
 * mostrava a task como livre (sem pílula nenhuma) nesse caso — mentira
 * visual na pior direção: o humano via uma task pronta que o autônomo
 * nunca ia pegar, sem nenhum sinal do porquê. Esta versão espelha a MESMA
 * regra do motor: qualquer status que não seja exatamente `"done"`
 * (incluindo "não sei") bloqueia, e o resultado carrega esse status junto
 * (`undefined` = desconhecida) pra UI dizer QUAL dos dois casos é —
 * `describeWaitingOn` abaixo faz essa tradução. */
export type WaitingOn = { depId: string; status: string | undefined };

export function waitingOnDep(deps: readonly string[], depStatuses: Readonly<Record<string, string>>): WaitingOn | null {
  for (const depId of deps) {
    const status = depStatuses[depId];
    if (status !== "done") return { depId, status };
  }
  return null;
}

/** Texto da pílula — separado de `waitingOnDep` pra manter a DECISÃO
 * (o que bloqueia) e a APRESENTAÇÃO (como isso vira texto) testáveis em
 * separado. `status === undefined` é o caso que a rodada 2 escondia: uma
 * dependência que não resolve a task nenhuma (id errado, ou uma task de
 * outro board que sumiu) — dita como "desconhecida", nunca como se fosse
 * só mais uma dependência normal ainda rodando. */
export function describeWaitingOn(waiting: WaitingOn): string {
  const id = shortTaskId(waiting.depId);
  return waiting.status === undefined ? `espera ${id} (dependência desconhecida)` : `espera ${id}`;
}

/** RODADA 2 — badge de WIP da coluna "em andamento" (`WIP 2/5`). O
 * numerador é a contagem da própria coluna (já computada por
 * `groupTasksByColumn`, nenhum dado novo); o denominador é o cap de
 * concorrência do board — mesma constante que `message-bus.ts`'s
 * `DEFAULT_CONCURRENCY_CAP` (duplicada aqui de propósito, não importada:
 * main e renderer não compartilham módulos neste código, mesma convenção
 * de `TaskBoardItem` duplicado entre main/preload). `raw` é
 * `BoardRow.concurrency_cap`, já carregado no estado `boards` do App.tsx
 * — decisão explícita de reusar esse estado em vez de uma consulta nova
 * (`concurrency_status` já existe no bus, mas é pro agente/MCP, não pro
 * renderer, e chamar isso a cada render seria exatamente o tipo de custo
 * por render que essa peça pediu pra evitar). `null` (nunca configurado,
 * ou configurado como "usar o padrão") cai no default; `0` explícito
 * NÃO cai — é uma escolha real de alguém pausando o board. */
export const DEFAULT_CONCURRENCY_CAP = 3;
export function resolveConcurrencyCap(raw: number | null): number {
  return raw ?? DEFAULT_CONCURRENCY_CAP;
}

/** RODADA 3, peça 5 — rodapé de escopo (`board X · N tasks · M em outros
 * boards`), e o achado que a precedeu: `taskCountsByBoard` (GLOBAL, todo
 * board, main/index.ts's `store.taskCountsByBoard`) pode citar um
 * `boardId` que não existe mais em `boardNames` — literalmente o board
 * órfão `"1"` achado nesta rodada (seis tasks presas a um board deletado
 * há muito tempo, nenhum `deleteTask`/cascade nunca existiu pra limpar
 * isso). `name: null` é como esta função marca esse caso pro chamador:
 * decisão 7 já estabeleceu que só um board de verdade é alcançável
 * (`jumpToCard`/agora `switchBoard` só operam sobre o que existe) — a UI
 * mostra a contagem mesmo assim (é exatamente o dado que faltava pra não
 * ficar "quadro vazio" sem explicação), mas nunca oferece um botão de
 * troca pra um destino que não existe. Ordenado por contagem decrescente
 * — o board órfão com mais tasks aparece primeiro, não por acidente de
 * iteração de `Object.entries`. */
export type BoardTaskScope = {
  ownCount: number;
  otherTotal: number;
  otherBoards: { boardId: string; name: string | null; count: number }[];
};

export function computeBoardScope(
  activeBoardId: string,
  taskCountsByBoard: Readonly<Record<string, number>>,
  boardNames: Readonly<Record<string, string>>,
): BoardTaskScope {
  const otherBoards = Object.entries(taskCountsByBoard)
    .filter(([boardId]) => boardId !== activeBoardId)
    .map(([boardId, count]) => ({ boardId, name: boardNames[boardId] ?? null, count }))
    .sort((a, b) => b.count - a.count);
  return {
    ownCount: taskCountsByBoard[activeBoardId] ?? 0,
    otherTotal: otherBoards.reduce((sum, b) => sum + b.count, 0),
    otherBoards,
  };
}

/**
 * RODADA 3, peça 6 — gráficos atrás de toggle (DESIGN-BACKLOG.md §2.3,
 * "PARTES DOS GRÁFICOS"). Três gráficos no contrato; só o 3º (tempo em
 * cada estado) tem fonte de dado real hoje. Os outros dois (reprovações
 * por provider, rodadas até aprovar) dependem do MESMO histórico de
 * veredito que a rodada 2 já confirmou não existir (`reports` é slot
 * único por card, `ON CONFLICT DO UPDATE` sempre sobrescreve — sem tabela
 * de histórico append-only, não há "quantas vezes reprovou" nem "quantas
 * rodadas até aprovar" pra computar). Não há função pura pra eles aqui —
 * "vazio honesto" pra esses dois é a UI renderizar um estado declarado
 * sem NENHUM dado de entrada, não uma função que finge calcular algo de
 * uma fonte que não existe.
 */

/** Uma transição de status, na forma mínima que `computeCycleTime`
 * precisa — mesmo padrão de `TaskOrderable` acima (shape local, não
 * importado de `preload/index.ts`, pra manter o módulo sem dependência
 * Electron-adjacent). */
export type StatusTransitionPoint = { toValue: string; at: number };

export type CycleTime = { queuedMs: number; runningMs: number };

/** Tempo gasto em cada status, atribuído por COLUNA (`columnForStatus`,
 * não o status cru) — só "todo" (fila) e "doing" (executando) são
 * somados, exatamente os dois segmentos que o contrato pede (`--border`
 * pra fila, `--foam` pra executando); tempo em "done"/"failed" não entra
 * na conta (são estados terminais, não "tempo esperando" nem "tempo
 * trabalhando"). Transições vêm ORDENADAS por `at` (garantido pela
 * consulta em store.ts, `ORDER BY tt.at ASC, tt.rowid ASC` — mesmo
 * desempate que `getTaskTransitionsStmt` já usa) — cada intervalo vai do
 * `at` de uma transição até o `at` da PRÓXIMA, e o último intervalo (a
 * task ainda no status mais recente) vai até `now`, explícito por
 * parâmetro pelo mesmo motivo de `formatTaskAge`: testável sem mockar
 * relógio. Uma lista vazia (task sem nenhuma transição — não deveria
 * acontecer, `upsertTask` sempre grava a primeira na criação, mas o tipo
 * não impede) devolve zero pros dois, não `NaN`/exceção. */
export function computeCycleTime(transitions: readonly StatusTransitionPoint[], now: number): CycleTime {
  let queuedMs = 0;
  let runningMs = 0;
  for (let i = 0; i < transitions.length; i++) {
    const start = transitions[i].at;
    const end = i + 1 < transitions.length ? transitions[i + 1].at : now;
    const duration = Math.max(0, end - start);
    const col = columnForStatus(transitions[i].toValue);
    if (col === "todo") queuedMs += duration;
    else if (col === "doing") runningMs += duration;
  }
  return { queuedMs, runningMs };
}

const MS_PER_HOUR = 3_600_000;

/** Conversão de exibição — eixo do gráfico 3 é em horas (contrato). Não
 * arredonda pra inteiro: uma task de 20 minutos viraria "0h" nas duas
 * barras, some do gráfico sem nenhum aviso. */
export function msToHours(ms: number): number {
  return ms / MS_PER_HOUR;
}
