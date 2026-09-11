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
 * independently testable with plain object literals.
 *
 * `implicitOrder` — DESIGN-BACKLOG.md §2.1 Fase 2, peça 3, review
 * adversarial (rodada 3, achado 1, ALTO): o TERCEIRO nível que faltava.
 * Nem "decisão humana" (`order`) nem "opinião do agente"
 * (`suggestedOrder`) — uma posição que existe só porque uma task VIZINHA
 * foi arrastada e precisou de alguém comparável do lado (ver o comentário
 * grande de `computeColumnDrop` mais abaixo pro porquê isto é necessário).
 * Nunca escrito por um humano nem por um agente, só pelo próprio app —
 * `store.ts`'s `TaskRow.implicit_order` tem o comentário completo do
 * modelo de 3 níveis. */
export type TaskOrderable = { order: number | null; suggestedOrder: number | null; implicitOrder: number | null; createdAt: number };

/** DESIGN-BACKLOG.md §2.1, decisão 6 — DOIS DONOS deliberadamente
 * separados: `order` só um humano arrastando escreve, `suggestedOrder` só
 * um agente. O humano VENCE na leitura — mas só quando ele de fato
 * decidiu algo; uma task que nenhum humano tocou ainda cai pro palpite do
 * agente. `implicitOrder` (peça 3, review adversarial rodada 3) fica
 * ABAIXO de `suggestedOrder` na precedência de propósito: é só posição,
 * nunca decisão de ninguém, então um palpite REAL do agente sempre vence
 * um número que o app só materializou pra uma vizinha caber num drop —
 * sem isso, essa vizinha ficaria PERMANENTEMENTE imune a um
 * `suggestedOrder` futuro (seria o mesmo defeito que motivou nunca
 * escrever `order` nela). Uma task que NADA dos três tocou ainda vai pro
 * fim, ordenada só por `createdAt` (nunca as prioridades disputando o
 * mesmo número). */
export function taskSortKey(t: TaskOrderable): number {
  if (t.order !== null) return t.order;
  if (t.suggestedOrder !== null) return t.suggestedOrder;
  if (t.implicitOrder !== null) return t.implicitOrder;
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

/**
 * FASE 2, peça 3 — arrastar entre colunas e dentro da coluna
 * (DESIGN-BACKLOG.md §2.1, decisões 5/6/8). Inverso de `STATUS_TO_COLUMN`:
 * a coluna onde a task foi SOLTA é que decide o novo `status` — nunca o
 * contrário. Só as 4 colunas reais têm um status conhecido de volta (o
 * fallback de `columnForStatus` pra um status externo/estranho é só de
 * LEITURA, uma coluna nunca recebe esse status de volta ao ser arrastada
 * pra ela). */
export const COLUMN_TO_STATUS: Record<TaskColumn, string> = { todo: "pending", doing: "running", done: "done", failed: "failed" };

/** Espaço deixado entre a sort key do vizinho e o novo valor quando não há
 * vizinho de um dos lados (ponta da coluna) — dá folga pra inserções
 * futuras na MESMA ponta sem colidir já na próxima vez. Mesmo valor nos
 * dois lados, sem significado especial além de "grande o bastante pra não
 * colidir com o próximo drop nessa ponta". */
const ORDER_GAP = 1000;

/** Um vizinho que precisou ganhar uma posição REAL (`implicit_order`,
 * NUNCA `order`) pra a task arrastada conseguir se encaixar entre
 * tasks que antes empatavam em `Infinity` — ver o comentário grande de
 * `computeColumnDrop` logo abaixo pro porquê a distinção entre este
 * campo e `order` é o próprio ponto do achado que motivou esta função. */
export type ColumnDropWrite = { id: string; implicitOrder: number };

export type ColumnDropResult = {
  /** O `order` real — SÓ da task arrastada. É o único jeito de "um
   * humano decidiu isto" ser gravado (decisões 6/8); nenhum vizinho
   * jamais aparece aqui. */
  order: number;
  /** Vizinhos intocados que precisaram materializar uma posição — ver
   * `ColumnDropWrite`. Lista vazia é o caso comum (drop entre duas tasks
   * que já tinham chave finita, ou numa coluna vazia): nada precisa
   * materializar, só a arrastada escreve. */
  siblingImplicitOrders: ColumnDropWrite[];
};

/**
 * ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 1, ALTO) — a versão
 * anterior desta função (`computeDropOrder`, interpolava só entre os DOIS
 * vizinhos imediatos usando `taskSortKey`) tinha um bug real, não um caso
 * de borda: numa coluna onde NENHUMA task tem `order`/`suggestedOrder`
 * ainda (o estado normal de um board novo), toda task tem sort key
 * `Infinity` — soltar em QUALQUER índice fazia `before`/`after` caírem em
 * `null` do mesmo jeito, sempre devolvendo o mesmo valor, e como um
 * finito qualquer é sempre `< Infinity`, a task solta saltava pro TOPO da
 * coluna, não importa se foi solta no início, no meio ou no fim.
 *
 * ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1, ALTO) — a 1ª correção
 * (materializar `order` real nos vizinhos intocados, não só na
 * arrastada) resolvia o visual mas quebrava a semântica: `order` significa
 * "um humano DECIDIU isto", e uma vez setado vence QUALQUER
 * `suggestedOrder` futuro do agente, pra sempre (`taskSortKey` olha
 * `order` primeiro, sem exceção). Escrever `order` num vizinho que o
 * humano nunca tocou o tornava PERMANENTEMENTE imune à repriorização do
 * agente — exatamente o poder que a decisão 6 nunca concedeu a esta
 * função. O teste da rodada 2 provava isso sem perceber: afirmava como
 * certo que vizinhos intocados recebessem `order`.
 *
 * A raiz (confirmada nas duas rodadas): um escalar só, onde `Infinity`
 * significa "sem ordem nenhuma", não consegue exprimir um TERCEIRO
 * estado — "posicionada, mas ninguém decidiu nada sobre ela". Fix desta
 * rodada: o modelo ganha esse terceiro estado (`implicit_order`,
 * `TaskRow`/`TaskOrderable`) — abaixo de `suggestedOrder` na precedência
 * de leitura, então um agente sempre recupera o direito de opinar. Esta
 * função passa a devolver DOIS tipos de escrita: `order` (SÓ a
 * arrastada — a decisão humana em si) e `siblingImplicitOrders`
 * (vizinhos que precisaram virar comparáveis, escrevem `implicit_order`,
 * nunca `order`).
 *
 * O ALGORITMO em si não mudou (mesmo trecho contíguo de tasks intocadas
 * ao redor do ponto de solta, mesmo gap/interpolação) — só PRA ONDE cada
 * valor calculado vai: o slot da arrastada vira `order`; os outros slots
 * do trecho viram `implicitOrder` de cada vizinho, mapeados de volta pro
 * `id` deles. A ORDEM relativa de todo mundo no trecho continua
 * preservada por construção (o array já chegava nessa ordem); nenhuma
 * task que já tinha `order`/`suggestedOrder` (dentro ou fora do trecho) é
 * tocada. */
export function computeColumnDrop<T extends TaskOrderable & { id: string }>(
  destinationTasks: readonly T[],
  dropIndex: number,
): ColumnDropResult {
  let start = dropIndex;
  while (start > 0 && !Number.isFinite(taskSortKey(destinationTasks[start - 1]))) start--;
  let end = dropIndex;
  while (end < destinationTasks.length && !Number.isFinite(taskSortKey(destinationTasks[end]))) end++;

  // O trecho intocado, SEM a arrastada (ela nunca esteve neste array —
  // `destinationTasks` é sempre "a coluna de destino menos a task que
  // está sendo solta", responsabilidade de quem chama). `insertAt` é a
  // posição dela DENTRO do trecho.
  const runTasks = destinationTasks.slice(start, end);
  const insertAt = dropIndex - start;
  const n = runTasks.length + 1; // vizinhos do trecho + a arrastada

  const beforeKey = start > 0 ? taskSortKey(destinationTasks[start - 1]) : null;
  const afterKey = end < destinationTasks.length ? taskSortKey(destinationTasks[end]) : null;
  const before = beforeKey !== null && Number.isFinite(beforeKey) ? beforeKey : null;
  const after = afterKey !== null && Number.isFinite(afterKey) ? afterKey : null;

  let base: number;
  let step: number;
  if (before !== null && after !== null) {
    // Os dois limites são reais (finitos) — divide o espaço entre eles em
    // partes iguais, mesma técnica de gap de sempre, só que agora pro
    // trecho inteiro em vez de uma task só.
    step = (after - before) / (n + 1);
    base = before;
  } else if (before !== null) {
    step = ORDER_GAP;
    base = before;
  } else if (after !== null) {
    step = ORDER_GAP;
    base = after - step * (n + 1);
  } else {
    // Coluna inteira intocada (o cenário dos dois achados) — sem limite
    // nenhum dos dois lados, começa de 0 com o mesmo espaçamento de
    // sempre.
    step = ORDER_GAP;
    base = 0;
  }

  let order = 0;
  const siblingImplicitOrders: ColumnDropWrite[] = [];
  for (let i = 0; i < n; i++) {
    const value = base + step * (i + 1);
    if (i === insertAt) {
      order = value;
    } else {
      // Mapeia o índice do slot de volta pro índice em `runTasks` — o
      // slot da arrastada "ocupa" uma posição no meio, então tudo DEPOIS
      // dela desloca um índice pra trás.
      const taskIndex = i < insertAt ? i : i - 1;
      siblingImplicitOrders.push({ id: runTasks[taskIndex].id, implicitOrder: value });
    }
  }
  return { order, siblingImplicitOrders };
}

/** Decisão 5, textual: "arrastar a mão SEMPRE vale, e AVISA o agente" — o
 * aviso em si (SE mandar ou não) não é uma decisão condicional desta fase,
 * é incondicional a todo drop que de fato moveu a task; só o TEXTO do
 * aviso precisa de uma decisão (qual coluna virou o destino). Separado do
 * mecanismo de entrega (`typeAndSubmit`, message-bus.ts, main process) pra
 * manter mensagem e transporte testáveis em separado — mesma divisão que
 * `describeWaitingOn`/`waitingOnDep` já usa acima. */
export function describeHumanMove(column: TaskColumn): string {
  return `[de: você] moveu esta task para "${COLUMN_TITLE[column]}".`;
}

/**
 * FIDELIDADE VISUAL AO PROTÓTIPO v5 (DESIGN-BACKLOG.md §2.1, comparação
 * lado a lado pedida pelo dono do repo) — a fase 2 ficou funcional antes
 * de ficar fiel; este bloco fecha a distância de anatomia/destaque/
 * animação. Toda DECISÃO (qual selo, qual cor, quando mostrar o quê) vive
 * aqui, pura e testável — só o CSS/DOM em si fica sem cobertura
 * automatizada (`vitest` roda `environment: "node"`, sem jsdom).
 */

/** Varredura de atividade (delta 4) — o protótipo anima a task cujo CARD
 * está VIVO, não cuja task está `running`: uma task pode continuar
 * `running` por um instante depois do processo do card já ter morrido
 * (entre o crash e o Sinal 2 derrubar pra `failed`), e a varredura nesse
 * intervalo mentiria "isto está acontecendo agora". `cardAlive` chega
 * pronto do main process (`registry.isAlive`, já síncrono/O(1), sem custo
 * de N chamadas — ver `buildTaskBoard`, main/index.ts). */
export function isTaskCardLive(status: string, cardAlive: boolean): boolean {
  return status === "running" && cardAlive;
}

/** Pílulas de meta (delta 5) — a cor é que carrega o significado no
 * protótipo (espera em foam, sugestão do agente tracejada), então cada
 * pílula sai com um `kind` que a camada de apresentação (TaskCard.tsx)
 * traduz em token de cor — nunca uma string de estilo aqui (este módulo
 * não conhece CSS).
 *
 * DELIBERADAMENTE NÃO INCLUÍDO: as pílulas `rodada N`/`reprovada N×`/
 * `fase X adiada` que o protótipo também mostra. As duas primeiras
 * dependem do histórico de veredito que este modelo não tem (`reports` é
 * slot único por card, `ON CONFLICT DO UPDATE` sempre sobrescreve — a
 * MESMA lacuna já documentada pros gráficos 1/2, `EmptyChart` em
 * TaskCard.tsx); a terceira ("fase C adiada") é texto livre de um board
 * real específico, não um conceito do modelo. Inventar qualquer uma
 * violaria o mesmo princípio de "vazio honesto, nunca número inventado"
 * já estabelecido pros gráficos — aqui não há nem "vazio" pra declarar,
 * a pílula inteira só não existe. */
export type MetaPillKind = "wait" | "wait-broken" | "suggestion";
export type MetaPill = { kind: MetaPillKind; text: string };

export function computeMetaPills(waitingOn: WaitingOn | null, order: number | null, suggestedOrder: number | null): MetaPill[] {
  const pills: MetaPill[] = [];
  if (waitingOn) {
    pills.push({ kind: waitingOn.status === undefined ? "wait-broken" : "wait", text: describeWaitingOn(waitingOn) });
  }
  if (suggestedOrder !== null && order !== null && suggestedOrder !== order) {
    // Decisão 6 — a sugestão do agente nunca some, só perde a disputa:
    // fica visível ao lado do que o humano decidiu.
    pills.push({ kind: "suggestion", text: `sugestão: prioridade ${suggestedOrder}` });
  }
  return pills;
}

/** Trilha de transição com horários (delta 6) — `a fazer 19:02 → em
 * andamento 19:05 → concluído 22:39`. Dado já existe em
 * `task_transitions` desde a Fase 1; só nunca tinha chegado até o board
 * normal (só o gráfico 3, atrás do toggle). `transitions` chega ORDENADA
 * por `at` (mesma garantia que `computeCycleTime` já depende — ver seu
 * doc comment), então basta mapear e juntar.
 *
 * Rótulo de cada ponto usa `COLUMN_TITLE` (o mesmo nome que a coluna já
 * exibe), não uma abreviação nova — o protótipo abrevia "andamento" sem
 * o "em", mas introduzir uma 2ª lista de rótulos só pra isto divergiria
 * da UI real por nenhum ganho. `null` quando não há NENHUMA transição
 * (não deveria acontecer — `upsertTask` sempre grava a primeira na
 * criação — mas o tipo não impede), pra `TaskItem` decidir não renderizar
 * a trilha nenhuma, nunca uma trilha vazia com "→" solto.
 *
 * LIMITAÇÃO CONHECIDA, documentada — `task_transitions.kind` distingue
 * `status` de `stage`, mas NADA escreve `stage` ainda (reservado, ver
 * `TaskTransitionRow` em store.ts): o ponto "review 21:40" que o
 * protótipo mostra não é derivável hoje — só os pontos de STATUS real
 * aparecem (a fazer/andamento/concluído/falhou), nunca a entrada na
 * etapa de review. */
export function describeTransitionTrail(transitions: readonly StatusTransitionPoint[]): string | null {
  if (transitions.length === 0) return null;
  return transitions.map((t) => `${COLUMN_TITLE[columnForStatus(t.toValue)]} ${formatClockTime(t.at)}`).join(" → ");
}

function formatClockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Marca de movimento humano (delta 8) — "Movida à mão com o card 288
 * ainda rodando. O card foi avisado." Só aparece quando as DUAS coisas
 * são verdade: a ÚLTIMA transição foi de um humano (`lastActor`, já
 * gravado por `upsertTask`/decisão 5), E o card vinculado ainda está
 * vivo (`cardAlive`, mesmo dado que `isTaskCardLive` usa acima) — as
 * duas evidências independentes de que "o aviso que a decisão 5 manda
 * pelo `typeAndSubmit` foi de fato entregue a um processo que ainda
 * existe", não uma suposição.
 *
 * Deliberadamente NÃO travado ao status atual da task: o protótipo
 * mostra isto sob uma task já em "concluído" — um humano pode arrastar a
 * task pra `done` enquanto o card que a implementava segue rodando por
 * conta própria (ex.: fazendo outra coisa, ou ainda escrevendo o
 * report). "Ainda rodando" descreve o CARD, não a task. */
export function describeHumanMoveNotice(lastActor: TaskActor | null, cardAlive: boolean, cardId: string | null): string | null {
  if (lastActor !== "human" || !cardAlive || cardId === null) return null;
  return `Movida à mão com o card ${cardId} ainda rodando. O card foi avisado.`;
}
