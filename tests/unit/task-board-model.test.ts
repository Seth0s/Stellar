import { describe, it, expect } from "vitest";
import {
  columnForStatus,
  compareTasks,
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
  type TaskOrderable,
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
  const base: TaskOrderable = { order: null, suggestedOrder: null, createdAt: 0 };

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
});

describe("groupTasksByColumn", () => {
  it("separa por status E ordena cada coluna internamente por compareTasks", () => {
    const tasks = [
      { id: "a", status: "running", order: 2, suggestedOrder: null, createdAt: 1 },
      { id: "b", status: "pending", order: null, suggestedOrder: null, createdAt: 5 },
      { id: "c", status: "running", order: 1, suggestedOrder: null, createdAt: 2 },
      { id: "d", status: "failed", order: null, suggestedOrder: null, createdAt: 3 },
      { id: "e", status: "pending", order: null, suggestedOrder: null, createdAt: 1 },
      { id: "f", status: "done", order: null, suggestedOrder: null, createdAt: 1 },
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
