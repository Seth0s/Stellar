import { describe, it, expect } from "vitest";
import {
  columnForStatus,
  compareTasks,
  taskSortKey,
  groupTasksByColumn,
  originBadge,
  deriveStage,
  shouldProposeCompletion,
  shortTaskId,
  formatTaskAge,
  waitingOnDep,
  describeWaitingOn,
  resolveConcurrencyCap,
  DEFAULT_CONCURRENCY_CAP,
  computeBoardScope,
  computeCycleTime,
  msToHours,
  COLUMN_ORDER,
  COLUMN_TO_STATUS,
  computeColumnDrop,
  describeHumanMove,
  isTaskCardLive,
  computeMetaPills,
  describeTransitionTrail,
  describeHumanMoveNotice,
  type TaskOrderable,
  type MetaPillKind,
} from "../../src/renderer/src/task-board-model";

describe("columnForStatus", () => {
  // RODADA 2 (review) — a antiga "mapeia os quatro status conhecidos pras
  // quatro colunas certas" foi cortada aqui: era tautológica, só repetia o
  // dicionário STATUS_TO_COLUMN da implementação com outras palavras.
  // `groupTasksByColumn`'s teste abaixo já exercita os quatro mapeamentos
  // de verdade, como efeito observável (quais tasks caem em qual coluna),
  // não como espelho do dicionário.
  it("um status desconhecido (update_task aceita qualquer string) cai em 'todo', nunca some do quadro", () => {
    expect(columnForStatus("blocked-on-external-review")).toBe("todo");
    expect(columnForStatus("")).toBe("todo");
  });
});

describe("compareTasks / taskSortKey — os dois donos da prioridade", () => {
  const base: TaskOrderable = { order: null, suggestedOrder: null, implicitOrder: null, createdAt: 0 };

  it("order (humano) manda mesmo quando suggestedOrder (agente) discorda", () => {
    const humanFirst = { ...base, order: 5, suggestedOrder: 99, createdAt: 100 };
    const humanSecond = { ...base, order: 6, suggestedOrder: 1, createdAt: 1 };
    // Sem o `order` humano, a ordenação por suggestedOrder inverteria isto
    // (1 antes de 99) — é exatamente essa inversão que a decisão 6 proíbe.
    expect(compareTasks(humanFirst, humanSecond)).toBeLessThan(0);
  });

  it("sem order humano, cai pro suggestedOrder do agente", () => {
    const a = { ...base, suggestedOrder: 1 };
    const b = { ...base, suggestedOrder: 2 };
    expect(compareTasks(a, b)).toBeLessThan(0);
    expect(compareTasks(b, a)).toBeGreaterThan(0);
  });

  it("sem nenhum dos dois, cai pro createdAt (mais antiga primeiro)", () => {
    const older = { ...base, createdAt: 10 };
    const newer = { ...base, createdAt: 20 };
    expect(compareTasks(older, newer)).toBeLessThan(0);
  });

  it("a comparação ENTRE tasks é por valor numérico puro — 'humano vence' vale dentro da MESMA task (order sobre suggestedOrder dela), não como um tier que sempre sobrepõe qualquer suggestedOrder de outra task", () => {
    const humanOrdered = { ...base, order: 5, suggestedOrder: null };
    const onlySuggested = { ...base, order: null, suggestedOrder: 1 };
    // 1 < 5: a task só com sugestão do agente fica ANTES, porque seu único
    // número disponível é menor — não existe hierarquia "humano sempre
    // primeiro" entre tasks diferentes, só "o campo do humano vence o do
    // agente quando os dois existem na MESMA task" (teste acima).
    expect(compareTasks(onlySuggested, humanOrdered)).toBeLessThan(0);
  });

  // ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1, ALTO) — `implicitOrder`
  // é o TERCEIRO nível (nem decisão humana, nem opinião do agente — só uma
  // posição que o app materializou pra uma task caber num drop, ver
  // `computeColumnDrop`). Tem que ficar ABAIXO de `suggestedOrder` na
  // precedência: senão, uma vizinha materializada ficaria imune a um
  // `suggestedOrder` real do agente — exatamente o defeito que motivou
  // parar de escrever `order` nela.
  it("suggestedOrder do agente vence implicitOrder do app, mesmo com um número maior", () => {
    const appPositioned = { ...base, implicitOrder: 1000 };
    const agentSuggested = { ...base, suggestedOrder: 1 }; // número BEM menor, mas vindo do agente
    expect(compareTasks(agentSuggested, appPositioned)).toBeLessThan(0);
  });

  it("implicitOrder só entra em jogo quando NEM order NEM suggestedOrder existem", () => {
    const a = { ...base, implicitOrder: 500 };
    const b = { ...base, implicitOrder: 1500 };
    expect(compareTasks(a, b)).toBeLessThan(0);
  });

  it("sem NENHUM dos três, ainda cai pro createdAt — implicitOrder não é obrigatório existir", () => {
    const older = { ...base, createdAt: 10 };
    const newer = { ...base, createdAt: 20 };
    expect(compareTasks(older, newer)).toBeLessThan(0);
  });
});

describe("groupTasksByColumn", () => {
  it("separa por status E ordena cada coluna internamente por compareTasks", () => {
    const tasks = [
      { id: "a", status: "running", order: 2, suggestedOrder: null, implicitOrder: null, createdAt: 1 },
      { id: "b", status: "pending", order: null, suggestedOrder: null, implicitOrder: null, createdAt: 5 },
      { id: "c", status: "running", order: 1, suggestedOrder: null, implicitOrder: null, createdAt: 2 },
      { id: "d", status: "failed", order: null, suggestedOrder: null, implicitOrder: null, createdAt: 3 },
      { id: "e", status: "pending", order: null, suggestedOrder: null, implicitOrder: null, createdAt: 1 },
      { id: "f", status: "done", order: null, suggestedOrder: null, implicitOrder: null, createdAt: 1 },
    ];
    const groups = groupTasksByColumn(tasks);
    expect(groups.doing.map((t) => t.id)).toEqual(["c", "a"]); // order 1 antes de order 2
    expect(groups.todo.map((t) => t.id)).toEqual(["e", "b"]); // sem order nenhum: mais antiga primeiro
    expect(groups.failed.map((t) => t.id)).toEqual(["d"]);
    expect(groups.done.map((t) => t.id)).toEqual(["f"]);
  });

  it("toda coluna de COLUMN_ORDER existe no resultado mesmo sem nenhuma task nela", () => {
    const groups = groupTasksByColumn([]);
    for (const col of COLUMN_ORDER) expect(groups[col]).toEqual([]);
  });
});

describe("originBadge", () => {
  // RODADA 2 (review) — a antiga "mapeia os três atores pros três selos do
  // protótipo" foi cortada: tautológica, só repetia ACTOR_BADGE da
  // implementação. O que resta é a única decisão real desta função — o
  // que fazer quando NÃO há ator (nunca inventar um selo).
  it("null (task sem nenhuma transição gravada) não inventa um selo", () => {
    expect(originBadge(null)).toBeNull();
  });
});

describe("deriveStage", () => {
  it("só existe pra uma task 'running' — qualquer outro status não tem etapa", () => {
    expect(deriveStage("pending", false)).toBeNull();
    expect(deriveStage("done", true)).toBeNull();
    expect(deriveStage("failed", true)).toBeNull();
  });

  it("running sem relatório ainda é 'implementar'; com relatório (aprovado OU reprovado) é 'review'", () => {
    expect(deriveStage("running", false)).toBe("implementar");
    expect(deriveStage("running", true)).toBe("review");
  });
});

describe("shouldProposeCompletion", () => {
  it("só propõe com a task ainda running E verdict exatamente 'aprovado'", () => {
    expect(shouldProposeCompletion("running", "aprovado")).toBe(true);
  });

  it("nunca propõe pra reprovado, verdict ausente, ou task que não está mais running", () => {
    expect(shouldProposeCompletion("running", "reprovado")).toBe(false);
    expect(shouldProposeCompletion("running", null)).toBe(false);
    expect(shouldProposeCompletion("running", undefined)).toBe(false);
    // Já concluída (por qualquer caminho) — propor de novo seria ruído,
    // não decisão pendente.
    expect(shouldProposeCompletion("done", "aprovado")).toBe(false);
    expect(shouldProposeCompletion("failed", "aprovado")).toBe(false);
  });
});

describe("shortTaskId", () => {
  it("corta pros 8 primeiros chars, mesmo formato do a54269c1 do protótipo", () => {
    expect(shortTaskId("a54269c1-dead-beef-0000-111122223333")).toBe("a54269c1");
  });

  it("um id mais curto que 8 chars (não deveria acontecer com UUID, mas não deve explodir) volta inteiro", () => {
    expect(shortTaskId("abc")).toBe("abc");
  });
});

describe("formatTaskAge", () => {
  const T0 = 1_000_000_000_000; // época arbitrária fixa, só pra ter um "agora" determinístico

  it("abaixo de 1min é 'agora', não '0min'", () => {
    expect(formatTaskAge(T0 - 30_000, T0)).toBe("agora");
    expect(formatTaskAge(T0, T0)).toBe("agora");
  });

  it("entre 1min e 1h usa minutos", () => {
    expect(formatTaskAge(T0 - 5 * 60_000, T0)).toBe("5min");
  });

  it("entre 1h e 1d usa horas — o exemplo '18h' do protótipo", () => {
    expect(formatTaskAge(T0 - 18 * 3_600_000, T0)).toBe("18h");
  });

  it("1d ou mais usa dias — o exemplo '2d' do protótipo", () => {
    expect(formatTaskAge(T0 - 2 * 86_400_000, T0)).toBe("2d");
  });

  it("nunca combina duas unidades (ex.: '1d 3h') — só a mais grosseira que ainda cabe", () => {
    const age = formatTaskAge(T0 - (25 * 3_600_000 + 30 * 60_000), T0); // 1 dia, 1h30 e pouco
    expect(age).toBe("1d");
    expect(age).not.toContain(" ");
  });
});

describe("waitingOnDep", () => {
  it("retorna a PRIMEIRA dependência (na ordem de deps) que não está 'done'", () => {
    expect(waitingOnDep(["dep-a", "dep-b"], { "dep-a": "running", "dep-b": "done" })).toEqual({ depId: "dep-a", status: "running" });
  });

  it("todas as deps done: não espera nada", () => {
    expect(waitingOnDep(["dep-a", "dep-b"], { "dep-a": "done", "dep-b": "done" })).toBeNull();
  });

  it("sem deps: não espera nada", () => {
    expect(waitingOnDep([], {})).toBeNull();
  });

  // RODADA 3 (review adversarial da rodada 2, achado B, alto) — a rodada 2
  // tratava dep sem status conhecido como NÃO bloqueante. Errado: o motor
  // de verdade (message-bus.ts's onTaskDone, `allDone = deps.every(id =>
  // find(id)?.status === "done")`) trata qualquer dep que não resolva a
  // NENHUMA task como bloqueante — `undefined === "done"` é `false`, igual
  // a uma dependência real ainda rodando. Estes três testes substituem os
  // que afirmavam o comportamento oposto.
  it("dep sem status conhecido (outro board, id inválido) BLOQUEIA — mesmo comportamento do motor autônomo, nunca 'não sei, deixa passar'", () => {
    expect(waitingOnDep(["dep-desconhecida"], {})).toEqual({ depId: "dep-desconhecida", status: undefined });
  });

  it("uma dep desconhecida no MEIO da lista já bloqueia ali — nunca pula pra achar uma 'de verdade' mais adiante (mesma ordem que o .every do motor usa)", () => {
    expect(waitingOnDep(["dep-desconhecida", "dep-b"], { "dep-b": "pending" })).toEqual({ depId: "dep-desconhecida", status: undefined });
  });

  it("status igual a 'done' de verdade nunca bloqueia, mesmo sendo string parecida", () => {
    expect(waitingOnDep(["dep-a"], { "dep-a": "done" })).toBeNull();
  });
});

describe("describeWaitingOn", () => {
  it("dependência com status conhecido: pílula simples 'espera <id>'", () => {
    expect(describeWaitingOn({ depId: "a54269c1-dead-beef", status: "running" })).toBe("espera a54269c1");
  });

  it("status desconhecido: a pílula PRECISA dizer isso, não pode ler como uma dependência normal ainda em andamento", () => {
    const text = describeWaitingOn({ depId: "a54269c1-dead-beef", status: undefined });
    expect(text).toContain("a54269c1");
    expect(text).toContain("desconhecida");
  });
});

describe("resolveConcurrencyCap", () => {
  it("null (nunca configurado) cai no default", () => {
    expect(resolveConcurrencyCap(null)).toBe(DEFAULT_CONCURRENCY_CAP);
  });

  it("0 explícito é uma escolha real (board pausado) — NÃO cai no default", () => {
    expect(resolveConcurrencyCap(0)).toBe(0);
  });

  it("qualquer outro número passa direto", () => {
    expect(resolveConcurrencyCap(7)).toBe(7);
  });
});

describe("computeBoardScope", () => {
  // Fixture que espelha o achado real desta rodada: board 238 aberto,
  // board 118 real com 1 task, e um board "1" que TEM tasks (6) mas NÃO
  // aparece em boardNames — porque foi deletado e `deleteBoard` nunca
  // limpou `tasks.board_id` (nenhum `deleteTask`/cascade existe).
  const counts = { "238": 2, "118": 1, "1": 6 };
  const names = { "238": "sdadsasd", "118": "Idyplatform" };

  it("ownCount é a contagem do board ATIVO", () => {
    expect(computeBoardScope("238", counts, names).ownCount).toBe(2);
  });

  it("board ativo sem NENHUMA task ainda (não aparece em counts) dá ownCount 0, não undefined/NaN", () => {
    expect(computeBoardScope("999", counts, names).ownCount).toBe(0);
  });

  it("otherBoards exclui o board ativo e soma certo em otherTotal", () => {
    const scope = computeBoardScope("238", counts, names);
    expect(scope.otherBoards.map((b) => b.boardId)).toEqual(["1", "118"]); // ordenado por contagem desc
    expect(scope.otherTotal).toBe(7); // 6 + 1
  });

  it("ordena por contagem decrescente, não pela ordem de inserção do mapa", () => {
    const scope = computeBoardScope("238", counts, names);
    expect(scope.otherBoards[0].count).toBeGreaterThanOrEqual(scope.otherBoards[1].count);
  });

  it("um board sem entrada em boardNames (o caso órfão real) vem com name:null — nunca um palpite de nome, nunca omitido da contagem", () => {
    const scope = computeBoardScope("238", counts, names);
    const orphan = scope.otherBoards.find((b) => b.boardId === "1");
    expect(orphan).toEqual({ boardId: "1", name: null, count: 6 });
  });

  it("board conhecido vem com o nome real", () => {
    const scope = computeBoardScope("238", counts, names);
    const known = scope.otherBoards.find((b) => b.boardId === "118");
    expect(known?.name).toBe("Idyplatform");
  });
});

describe("computeCycleTime", () => {
  const H = 3_600_000;

  it("a fazer 19:00 -> em andamento 21:00 -> concluído 22:00, medido às 23:00: 2h em fila, 1h em andamento", () => {
    const t0 = 1_000_000_000_000;
    const transitions = [
      { toValue: "pending", at: t0 },
      { toValue: "running", at: t0 + 2 * H },
      { toValue: "done", at: t0 + 3 * H },
    ];
    const cycle = computeCycleTime(transitions, t0 + 4 * H);
    expect(cycle.queuedMs).toBe(2 * H);
    expect(cycle.runningMs).toBe(1 * H);
  });

  it("task ainda running (sem transição final) conta o tempo até 'now', não para no último transition.at", () => {
    const t0 = 1_000_000_000_000;
    const transitions = [
      { toValue: "pending", at: t0 },
      { toValue: "running", at: t0 + H },
    ];
    const cycle = computeCycleTime(transitions, t0 + 3 * H);
    expect(cycle.queuedMs).toBe(1 * H);
    expect(cycle.runningMs).toBe(2 * H); // de t0+1h até t0+3h ("now"), ainda em aberto
  });

  it("tempo em 'done'/'failed' NUNCA soma em queued nem running — são estados terminais, não fila nem execução", () => {
    const t0 = 1_000_000_000_000;
    const transitions = [
      { toValue: "running", at: t0 },
      { toValue: "done", at: t0 + H },
    ];
    // Medido bem depois: se "done" contasse pra algum lado, running teria
    // 100h em vez de 1h.
    const cycle = computeCycleTime(transitions, t0 + 100 * H);
    expect(cycle.runningMs).toBe(H);
    expect(cycle.queuedMs).toBe(0);
  });

  it("sem nenhuma transição: zero nos dois, nunca NaN", () => {
    const cycle = computeCycleTime([], Date.now());
    expect(cycle.queuedMs).toBe(0);
    expect(cycle.runningMs).toBe(0);
  });

  it("um status desconhecido no meio da trilha não quebra a soma — só não entra em nenhum dos dois totais", () => {
    const t0 = 1_000_000_000_000;
    const transitions = [
      { toValue: "pending", at: t0 },
      { toValue: "blocked-on-external-review", at: t0 + H }, // cai em "todo" via columnForStatus, ver seu próprio teste
      { toValue: "running", at: t0 + 2 * H },
    ];
    const cycle = computeCycleTime(transitions, t0 + 3 * H);
    // "blocked-on-external-review" cai em "todo" (fallback de columnForStatus)
    expect(cycle.queuedMs).toBe(2 * H);
    expect(cycle.runningMs).toBe(H);
  });
});

describe("msToHours", () => {
  it("converte sem arredondar pra inteiro — uma task de 20min não pode sumir do gráfico como '0h'", () => {
    expect(msToHours(20 * 60_000)).toBeCloseTo(0.333, 2);
  });

  it("1h exata vira 1", () => {
    expect(msToHours(3_600_000)).toBe(1);
  });
});

describe("COLUMN_TO_STATUS — inverso de columnForStatus", () => {
  it("as 4 colunas reais voltam pro status que columnForStatus leria de volta pra elas mesmas", () => {
    for (const col of COLUMN_ORDER) expect(columnForStatus(COLUMN_TO_STATUS[col])).toBe(col);
  });
});

describe("computeColumnDrop — peça 3 (arrastar), técnica de gap", () => {
  type Fixture = TaskOrderable & { id: string };
  const untouched = (id: string, createdAt: number): Fixture => ({ id, order: null, suggestedOrder: null, implicitOrder: null, createdAt });
  const withOrder = (id: string, order: number): Fixture => ({ id, order, suggestedOrder: null, implicitOrder: null, createdAt: 0 });
  // `siblingImplicitOrders` é a única lista de escrita pra vizinhos —
  // `implicitOf` lê de lá, nunca de `result.order` (que é só da
  // arrastada). Uma task ausente da lista significa "não foi tocada".
  const implicitOf = (result: { siblingImplicitOrders: { id: string; implicitOrder: number }[] }, id: string): number =>
    result.siblingImplicitOrders.find((w) => w.id === id)!.implicitOrder;

  it("coluna vazia: a task arrastada recebe o primeiro valor da sequência, não um palpite arbitrário — e NENHUM vizinho (não há nenhum)", () => {
    const result = computeColumnDrop([], 0);
    expect(Number.isFinite(result.order)).toBe(true);
    expect(result.siblingImplicitOrders).toEqual([]);
  });

  it("solta no INÍCIO entre duas já ordenadas: só a arrastada recebe `order`, NENHUM vizinho é tocado", () => {
    const dest = [withOrder("a", 100), withOrder("b", 200)];
    const result = computeColumnDrop(dest, 0);
    expect(result.siblingImplicitOrders).toEqual([]); // as duas já tinham chave finita — ninguém precisa materializar
    expect(result.order).toBeLessThan(100);
  });

  it("solta no FIM entre duas já ordenadas: fica acima da última, sem tocar nenhuma das duas", () => {
    const dest = [withOrder("a", 100), withOrder("b", 200)];
    const result = computeColumnDrop(dest, 2);
    expect(result.siblingImplicitOrders).toEqual([]);
    expect(result.order).toBeGreaterThan(200);
  });

  it("solta NO MEIO entre duas já ordenadas: fica estritamente entre as duas, sem tocar nenhuma", () => {
    const dest = [withOrder("a", 100), withOrder("b", 200)];
    const result = computeColumnDrop(dest, 1);
    expect(result.siblingImplicitOrders).toEqual([]);
    expect(result.order).toBeGreaterThan(100);
    expect(result.order).toBeLessThan(200);
  });

  // ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 1, ALTO) — reprodução
  // EXATA do cenário que o review apontou: 3 tasks nunca tocadas (sort key
  // Infinity as 3), soltar entre a 2ª e a 3ª. A versão da rodada 1
  // devolvia sempre o mesmo valor aqui — e como um finito qualquer é
  // sempre `< Infinity`, a task solta saltava pro TOPO da coluna no
  // próximo render, ignorando onde o mouse soltou. Isto não é caso de
  // borda: é o estado NORMAL de um board novo, onde ninguém ordenou nada
  // ainda.
  //
  // ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1, ALTO) — a correção
  // da rodada 2 escrevia `order` (não `implicitOrder`) nos 3 vizinhos,
  // tornando-os imunes a `suggestedOrder` pra sempre. Este teste agora
  // afirma a coisa CERTA: os vizinhos aparecem em `siblingImplicitOrders`
  // (nunca ganham `order`), só a arrastada aparece em `result.order`.
  it("[achados 1×2] 3 tasks intocadas, solta ENTRE a 2ª e a 3ª: fica exatamente ali (nunca no topo), e os vizinhos ganham implicitOrder — NUNCA order", () => {
    const dest = [untouched("a", 1), untouched("b", 2), untouched("c", 3)];
    const result = computeColumnDrop(dest, 2);
    // As 3 vizinhas precisam materializar (nenhuma tinha chave finita) —
    // a arrastada NUNCA aparece nesta lista (ela é `result.order`).
    expect(result.siblingImplicitOrders.map((w) => w.id).sort()).toEqual(["a", "b", "c"]);
    // A ORDEM relativa das 3 intocadas é preservada (createdAt, a mesma
    // que compareTasks já usava pra desempatá-las) — a arrastada entra
    // exatamente onde foi solta, nunca no topo.
    expect(implicitOf(result, "a")).toBeLessThan(implicitOf(result, "b"));
    expect(implicitOf(result, "b")).toBeLessThan(result.order); // depois da 2ª...
    expect(result.order).toBeLessThan(implicitOf(result, "c")); // ...e antes da 3ª
  });

  it("[achados 1×2, pontas] mesmas 3 intocadas, solta ANTES de tudo (índice 0): fica em primeiro de verdade", () => {
    const dest = [untouched("a", 1), untouched("b", 2), untouched("c", 3)];
    const result = computeColumnDrop(dest, 0);
    expect(result.order).toBeLessThan(implicitOf(result, "a"));
    expect(implicitOf(result, "a")).toBeLessThan(implicitOf(result, "b"));
    expect(implicitOf(result, "b")).toBeLessThan(implicitOf(result, "c"));
  });

  it("[achados 1×2, pontas] mesmas 3 intocadas, solta DEPOIS de tudo (índice 3): fica em último de verdade", () => {
    const dest = [untouched("a", 1), untouched("b", 2), untouched("c", 3)];
    const result = computeColumnDrop(dest, 3);
    expect(implicitOf(result, "a")).toBeLessThan(implicitOf(result, "b"));
    expect(implicitOf(result, "b")).toBeLessThan(implicitOf(result, "c"));
    expect(implicitOf(result, "c")).toBeLessThan(result.order);
  });

  it("mistura: uma já ordenada + uma intocada — só a intocada materializa implicitOrder, a já ordenada NUNCA é tocada", () => {
    const dest = [withOrder("a", 100), untouched("b", 5)]; // b nunca foi tocada
    const result = computeColumnDrop(dest, 1); // solta entre a e b
    expect(result.siblingImplicitOrders.map((w) => w.id)).toEqual(["b"]); // "a" NUNCA aparece — seu valor não muda
    expect(result.order).toBeGreaterThan(100); // depois de "a"
    expect(result.order).toBeLessThan(implicitOf(result, "b")); // antes de "b", que continua depois
  });

  it("duas intocadas, solta entre elas: as duas materializam implicitOrder (nunca order), a arrastada fica no meio — mesmo bug dos achados 1×2, coluna de 2", () => {
    const result = computeColumnDrop([untouched("u1", 1), untouched("u2", 2)], 1);
    expect(result.siblingImplicitOrders.map((w) => w.id).sort()).toEqual(["u1", "u2"]);
    expect(implicitOf(result, "u1")).toBeLessThan(result.order);
    expect(result.order).toBeLessThan(implicitOf(result, "u2"));
  });

  // ACHADO DE REVIEW ADVERSARIAL (RODADA 3, achado 1) — a RESTRIÇÃO
  // INEGOCIÁVEL do master, verificada diretamente: depois de materializar
  // 3 vizinhas intocadas, um `suggestedOrder` real do agente pra QUALQUER
  // uma delas ainda vence o `implicitOrder` que o app inventou — nenhuma
  // imunidade. Ver o teste de `compareTasks`/`taskSortKey` acima pro
  // mecanismo; este teste é o elo entre o RESULTADO desta função e essa
  // garantia (não basta a precedência existir — o valor materializado
  // aqui precisa realmente ser sobreponível).
  it("depois de materializar, um suggestedOrder real do agente ainda vence o implicitOrder materializado — sem imunidade", () => {
    const dest = [untouched("a", 1), untouched("b", 2), untouched("c", 3)];
    const result = computeColumnDrop(dest, 2);
    const bImplicit = implicitOf(result, "b");
    // Simula o que a leitura faria depois de um agente chamar
    // update_task({taskId:"b", suggestedOrder:1}): "b" agora tem AMBOS
    // implicitOrder (da materialização) e suggestedOrder (do agente) —
    // taskSortKey precisa ler o suggestedOrder, não o implicitOrder.
    const bAfterAgentSuggestion: Fixture = { id: "b", order: null, suggestedOrder: 1, implicitOrder: bImplicit, createdAt: 2 };
    expect(taskSortKey(bAfterAgentSuggestion)).toBe(1);
    expect(taskSortKey(bAfterAgentSuggestion)).not.toBe(bImplicit);
  });
});

describe("describeHumanMove", () => {
  it("nomeia a coluna de destino pelo título real (COLUMN_TITLE), prefixo '[de: você]' como todo aviso de typeAndSubmit", () => {
    const msg = describeHumanMove("doing");
    expect(msg).toContain("em andamento");
    expect(msg.startsWith("[de: você]")).toBe(true);
  });
});

// Fidelidade visual ao protótipo v5 — delta 4 (varredura de atividade).
describe("isTaskCardLive", () => {
  it("só é viva quando a task está running E o card por trás está vivo — as duas, nunca uma só", () => {
    expect(isTaskCardLive("running", true)).toBe(true);
    expect(isTaskCardLive("running", false)).toBe(false); // running mas o processo já morreu (janela antes do Sinal 2 derrubar)
    expect(isTaskCardLive("done", true)).toBe(false); // card ainda vivo, mas a task já não está mais em andamento
    expect(isTaskCardLive("pending", false)).toBe(false);
  });
});

// Delta 5 — pílulas de meta coloridas.
describe("computeMetaPills", () => {
  it("sem dependência pendente e sem divergência de prioridade: nenhuma pílula", () => {
    expect(computeMetaPills(null, null, null)).toEqual([]);
    expect(computeMetaPills(null, 5, 5)).toEqual([]); // order === suggestedOrder: sem divergência
  });

  it("dependência normal vira pílula 'wait'; dependência quebrada (status desconhecido) vira 'wait-broken'", () => {
    expect(computeMetaPills({ depId: "a54269c1", status: "running" }, null, null)).toEqual([{ kind: "wait", text: "espera a54269c1" }]);
    const broken = computeMetaPills({ depId: "a54269c1", status: undefined }, null, null);
    expect(broken[0].kind).toBe("wait-broken");
  });

  it("order e suggestedOrder divergindo (decisão 6) vira pílula 'suggestion', SEMPRE visível ao lado, nunca engolida", () => {
    expect(computeMetaPills(null, 5, 99)).toEqual([{ kind: "suggestion", text: "sugestão: prioridade 99" }]);
  });

  it("as duas juntas: dependência pendente E divergência de prioridade — duas pílulas, dependência primeiro", () => {
    const pills = computeMetaPills({ depId: "dep-1", status: "pending" }, 5, 1);
    expect(pills).toHaveLength(2);
    expect(pills[0].kind).toBe("wait");
    expect(pills[1].kind).toBe("suggestion");
  });

  it("[deliberadamente fora] não existe pílula 'rodada N'/'reprovada N×'/'fase X adiada' — sem histórico de veredito pra sustentar", () => {
    // Nenhuma combinação de entrada produz um MetaPillKind fora dos 3
    // documentados — este teste existe só pra tornar essa omissão
    // deliberada visível na suíte, não pra testar comportamento novo.
    const allKinds: MetaPillKind[] = ["wait", "wait-broken", "suggestion"];
    const pills = computeMetaPills({ depId: "d", status: "running" }, 1, 2);
    for (const p of pills) expect(allKinds).toContain(p.kind);
  });
});

// Delta 6 — trilha de transição com horários.
describe("describeTransitionTrail", () => {
  it("sem nenhuma transição: null, nunca uma trilha vazia com seta solta", () => {
    expect(describeTransitionTrail([])).toBeNull();
  });

  it("junta status real + horário (HH:MM) com seta, na ordem em que chegaram", () => {
    const d = new Date();
    d.setHours(19, 2, 0, 0);
    const t0 = d.getTime();
    const transitions = [
      { toValue: "pending", at: t0 },
      { toValue: "running", at: t0 + 3 * 60_000 },
      { toValue: "done", at: t0 + 3 * 3_600_000 },
    ];
    const trail = describeTransitionTrail(transitions);
    expect(trail).toBe("a fazer 19:02 → em andamento 19:05 → concluído 22:02");
  });

  it("nunca inclui um ponto de 'review' — task_transitions não grava kind:'stage' ainda, não inventa o que não existe", () => {
    const trail = describeTransitionTrail([{ toValue: "running", at: Date.now() }]);
    expect(trail).not.toContain("review");
  });
});

// Delta 8 — marca de movimento humano.
describe("describeHumanMoveNotice", () => {
  it("só aparece quando o ÚLTIMO ator foi humano E o card vinculado ainda está vivo — as duas condições", () => {
    expect(describeHumanMoveNotice("human", true, "288")).toBe("Movida à mão com o card 288 ainda rodando. O card foi avisado.");
  });

  it("último ator agente ou app: nunca aparece, mesmo com o card vivo", () => {
    expect(describeHumanMoveNotice("agent", true, "288")).toBeNull();
    expect(describeHumanMoveNotice("app", true, "288")).toBeNull();
    expect(describeHumanMoveNotice(null, true, "288")).toBeNull();
  });

  it("humano moveu, mas o card já não está mais vivo: some — 'ainda rodando' deixou de ser verdade", () => {
    expect(describeHumanMoveNotice("human", false, "288")).toBeNull();
  });

  it("sem card vinculado (cardId null): nunca aparece, não há o que descrever como 'ainda rodando'", () => {
    expect(describeHumanMoveNotice("human", true, null)).toBeNull();
  });

  it("não trava no status da task — o protótipo mostra isto sob uma task já 'concluído', card ainda rodando por conta própria", () => {
    // A própria assinatura da função não recebe `status` — reforça que a
    // decisão é sobre o CARD, não sobre em que coluna a task está.
    expect(describeHumanMoveNotice("human", true, "288")).not.toBeNull();
  });
});
