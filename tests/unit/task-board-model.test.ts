import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/shared/i18n";
import {
  columnForStatus,
  compareTasks,
  taskSortKey,
  groupTasksByColumn,
  originBadge,
  deriveStage,
  shouldShowStageTrail,
  derivePurposeChip,
  describePurposeChip,
  deriveCompletionProposal,
  shortTaskId,
  formatTaskAge,
  waitingOnDep,
  describeWaitingOn,
  resolveConcurrencyCap,
  DEFAULT_CONCURRENCY_CAP,
  computeBoardScope,
  computeCycleTime,
  msToHours,
  cycleAxisMarks,
  computeVerdictsByProvider,
  computeRoundsToApprove,
  roundsBarTone,
  isHumanCreatedTask,
  didHumanTaskGetClaimed,
  COLUMN_ORDER,
  COLUMN_TO_STATUS,
  computeColumnDrop,
  isTaskCardLive,
  computeMetaPills,
  describeTransitionTrail,
  describeHumanMoveNotice,
  describeStatusDivergence,
  describeStatusAskNotice,
  describeVerdictChip,
  describeVerdictProvenance,
  formatSprintTimestamp,
  formatSprintDuration,
  describeSprintCounts,
  shortSprintId,
  sprintLabel,
  snapshotTaskToBoardItem,
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

describe("shouldShowStageTrail", () => {
  it("some sem purpose e sem reviewer — não mente implementar→review", () => {
    expect(shouldShowStageTrail(null, ["implementer"])).toBe(false);
    expect(shouldShowStageTrail(null, [])).toBe(false);
    expect(shouldShowStageTrail("investigate", ["implementer"])).toBe(false);
    expect(shouldShowStageTrail("measure", [])).toBe(false);
  });

  it("aparece pra implement/fix, ou quando um card é reviewer de verdade", () => {
    expect(shouldShowStageTrail("implement", ["implementer"])).toBe(true);
    expect(shouldShowStageTrail("fix", [])).toBe(true);
    expect(shouldShowStageTrail("investigate", ["implementer", "reviewer"])).toBe(true);
    expect(shouldShowStageTrail(null, ["reviewer"])).toBe(true);
  });
});

describe("derivePurposeChip / describePurposeChip", () => {
  beforeEach(() => setLocale("pt-BR"));

  it("sem purpose (NORMAL) devolve null — chip vazio, sem palpite", () => {
    expect(derivePurposeChip(null, [], {}, ["implementer"])).toBeNull();
    expect(derivePurposeChip("INVESTIGAÇÃO", ["dep"], { dep: "investigate" }, [])).toBeNull();
  });

  it("purpose sozinho vira o chip; deps do mesmo propósito não inventam seta", () => {
    const chip = derivePurposeChip("investigate", ["d1"], { d1: "investigate" }, ["implementer"]);
    expect(chip).toEqual({ purpose: "investigate", fromPurpose: null, hasReviewer: false });
    expect(describePurposeChip(chip!)).toBe("investigação");
  });

  it("deps de propósito diferente derivam A → B", () => {
    const chip = derivePurposeChip("implement", ["inv"], { inv: "investigate" }, []);
    expect(chip).toEqual({ purpose: "implement", fromPurpose: "investigate", hasReviewer: false });
    expect(describePurposeChip(chip!)).toBe("investigação → implementação");
  });

  it("`integrate` (item 13 do sticky) nasce de graça: dep de implement vira \"implementação → integração\"", () => {
    // O NOME da etapa sai da derivação que já existia — nenhum mecanismo
    // novo, nenhum dispatch gateado: purpose é metadado write-once.
    const chip = derivePurposeChip("integrate", ["impl", "fix"], { impl: "implement", fix: "fix" }, []);
    expect(chip).toEqual({ purpose: "integrate", fromPurpose: "implement", hasReviewer: false });
    expect(describePurposeChip(chip!)).toBe("implementação → integração");
  });

  it("dep sem purpose (task antiga) não inventa seta", () => {
    const chip = derivePurposeChip("fix", ["old"], { old: null }, []);
    expect(chip?.fromPurpose).toBeNull();
    expect(describePurposeChip(chip!)).toBe("correção");
  });

  it("↔ review só com role reviewer de verdade — implementer sozinho não conta", () => {
    const without = derivePurposeChip("implement", [], {}, ["implementer", "implementer"]);
    expect(without?.hasReviewer).toBe(false);
    expect(describePurposeChip(without!)).toBe("implementação");
    const withReview = derivePurposeChip("implement", [], {}, ["implementer", "reviewer"]);
    expect(withReview?.hasReviewer).toBe(true);
    expect(describePurposeChip(withReview!)).toBe("implementação ↔ review");
  });
});

// Medido 2026-09-13: 156/156 `task_verdicts` e os 14 `aprovado` de
// `reports` eram do próprio implementador, e a barra de proposta reagia
// ao valor sem olhar quem mandou. A decisão agora lê o PAPEL de cada
// rodada. Os três casos exigidos pelo gate: implementer, reviewer, role
// desconhecido — mais a política pra task sem reviewer.
describe("deriveCompletionProposal", () => {
  const impl = (verdict: string | null, at: number, cardId = "impl-1") => ({ cardId, role: "implementer", verdict, at });
  const rev = (verdict: string | null, at: number, cardId = "rev-1") => ({ cardId, role: "reviewer", verdict, at });

  it("reviewer 'aprovado' propõe com origem reviewer", () => {
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [impl("aprovado", 1), rev("aprovado", 2)])).toEqual({
      verdict: "aprovado",
      origin: "reviewer",
      cardId: "rev-1",
      at: 2,
    });
  });

  it("com reviewer vinculado, 'aprovado' do implementer NÃO propõe — nem antes do reviewer falar, nem depois de um reprovado dele", () => {
    // Reviewer vinculado (task_cards) mas ainda sem rodada: review pendente.
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [impl("aprovado", 1)])).toBeNull();
    // Reviewer reprovou: o "aprovado" do implementer não sobrepõe.
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [impl("aprovado", 1), rev("reprovado", 2)])).toBeNull();
    // Reviewer que reportou sem veredito (ou saiu sem report): nada.
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [impl("aprovado", 1), rev(null, 2)])).toBeNull();
    // Implementer "aprova" DEPOIS do reprovado do reviewer: continua nada —
    // a última palavra do REVIEWER é o que conta, não a última rodada.
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [rev("reprovado", 1), impl("aprovado", 2)])).toBeNull();
  });

  it("rodada de reviewer no histórico basta pra impor a regra, mesmo se o papel atual em task_cards já não diz reviewer", () => {
    expect(deriveCompletionProposal("running", ["implementer"], [impl("aprovado", 1), rev("reprovado", 2)])).toBeNull();
    expect(deriveCompletionProposal("running", ["implementer"], [impl("aprovado", 1), rev("aprovado", 2)])?.origin).toBe("reviewer");
  });

  it("a ÚLTIMA rodada do reviewer é a que vale (reprovou, depois aprovou → propõe; aprovou, depois reprovou → não)", () => {
    expect(deriveCompletionProposal("running", ["reviewer"], [rev("reprovado", 1), rev("aprovado", 2)])).toMatchObject({ origin: "reviewer", at: 2 });
    expect(deriveCompletionProposal("running", ["reviewer"], [rev("aprovado", 1), rev("reprovado", 2)])).toBeNull();
    // Empate de `at`: a que veio depois na lista (rowid maior) vence.
    expect(deriveCompletionProposal("running", ["reviewer"], [rev("aprovado", 5), rev("reprovado", 5)])).toBeNull();
    expect(deriveCompletionProposal("running", ["reviewer"], [rev("reprovado", 5), rev("aprovado", 5)])?.origin).toBe("reviewer");
  });

  it("task SEM reviewer: 'aprovado' do implementer propõe com origem 'self' (auto-aprovado, marcado — nunca disfarçado de review)", () => {
    expect(deriveCompletionProposal("running", ["implementer"], [impl("aprovado", 1)])).toEqual({
      verdict: "aprovado",
      origin: "self",
      cardId: "impl-1",
      at: 1,
    });
    // Última rodada do implementer vale: reprovou a si mesmo depois → nada.
    expect(deriveCompletionProposal("running", ["implementer"], [impl("aprovado", 1), impl("reprovado", 2)])).toBeNull();
    expect(deriveCompletionProposal("running", ["implementer"], [impl("reprovado", 1), impl("aprovado", 2, "impl-2")])).toMatchObject({
      origin: "self",
      cardId: "impl-2",
    });
  });

  it("role desconhecido (fora de implementer/reviewer) nunca propõe, mesmo com 'aprovado'", () => {
    const unknown = { cardId: "x", role: "observer", verdict: "aprovado", at: 1 };
    expect(deriveCompletionProposal("running", ["observer"], [unknown])).toBeNull();
    // Nem sozinho, nem somado a um implementer que não aprovou.
    expect(deriveCompletionProposal("running", ["implementer", "observer"], [impl("reprovado", 1), unknown])).toBeNull();
    // E não conta como reviewer: um implementer aprovado numa task com só
    // "observer" continua sendo o caso sem reviewer (self), não reviewer.
    expect(deriveCompletionProposal("running", ["implementer", "observer"], [impl("aprovado", 1), { ...unknown, verdict: "reprovado" }])?.origin).toBe(
      "self",
    );
  });

  it("nunca propõe sem 'aprovado' de ninguém, sem rodada nenhuma, ou fora de running", () => {
    expect(deriveCompletionProposal("running", ["implementer"], [impl("reprovado", 1)])).toBeNull();
    expect(deriveCompletionProposal("running", ["implementer"], [impl(null, 1)])).toBeNull();
    expect(deriveCompletionProposal("running", ["implementer"], [])).toBeNull();
    expect(deriveCompletionProposal("running", [], [])).toBeNull();
    // Já concluída (por qualquer caminho) — propor de novo seria ruído,
    // não decisão pendente.
    expect(deriveCompletionProposal("done", ["reviewer"], [rev("aprovado", 1)])).toBeNull();
    expect(deriveCompletionProposal("failed", ["implementer"], [impl("aprovado", 1)])).toBeNull();
    expect(deriveCompletionProposal("pending", ["reviewer"], [rev("aprovado", 1)])).toBeNull();
  });

  // Task 156e6d08 — o consumidor que AGIA sobre o carimbo falso. Antes da
  // regra de leitura, o `aprovado` que o fan-out antigo carimbou em 15 tasks
  // chegava aqui como veredito real e a barra "concluir" aparecia na task
  // errada. Agora a rodada chega com o que se pode ATRIBUIR à task: o carimbo
  // chega `verdict: null` e não propõe nada.
  it("rodada carimbada em outra task não propõe conclusão — a procedência vem junto do veredito", () => {
    const artifact = {
      cardId: "rev-1",
      role: "reviewer",
      verdict: null,
      at: 2,
      storedVerdict: "aprovado",
      rule: "declared_other_task" as const,
      declaredTaskId: "outra-task",
      roundLinks: 6,
    };
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [artifact])).toBeNull();
    // E o carimbo não APAGA a rodada de verdade da mesma task: com o aprovado
    // real na lista (antes ou depois do carimbo), a barra continua vindo dele.
    const real = { cardId: "rev-1", role: "reviewer", verdict: "aprovado", at: 1, rule: "declared_this_task" as const };
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [real, artifact])?.at).toBe(1);
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [artifact, real])?.at).toBe(1);
  });

  it("rodada indecidível (N vínculos, sem nome) também não propõe — 'não sei' nunca vira barra verde", () => {
    const unknown = {
      cardId: "rev-1",
      role: "reviewer",
      verdict: null,
      at: 3,
      storedVerdict: "aprovado",
      rule: "undeclared_round" as const,
      roundLinks: 8,
    };
    expect(deriveCompletionProposal("running", ["implementer", "reviewer"], [unknown])).toBeNull();
    expect(deriveCompletionProposal("running", ["implementer"], [unknown])).toBeNull();
  });
});

// Chip honesty (2026-09-14): green APROVADO is reviewer-only. Implementer
// "aprovado" is a completion proposal (muted). Reprovado stays danger for
// any role (self-reject is confession). Null/empty stays neutral. Unknown
// role keeps the stored word and never paints green.
describe("describeVerdictChip", () => {
  beforeEach(() => setLocale("pt-BR"));

  it("reviewer + aprovado → rótulo 'aprovado', tom good (--good)", () => {
    expect(describeVerdictChip("reviewer", "aprovado")).toEqual({ label: "aprovado", tone: "good" });
  });

  it("implementer + aprovado → 'propõe concluir', tom muted (--muted)", () => {
    expect(describeVerdictChip("implementer", "aprovado")).toEqual({ label: "propõe concluir", tone: "muted" });
  });

  it("reprovado → 'reprovado', tom danger (--danger) para qualquer papel", () => {
    expect(describeVerdictChip("implementer", "reprovado")).toEqual({ label: "reprovado", tone: "danger" });
    expect(describeVerdictChip("reviewer", "reprovado")).toEqual({ label: "reprovado", tone: "danger" });
  });

  it("sem veredito → 'sem veredito', tom none (caso majoritário)", () => {
    expect(describeVerdictChip("implementer", null)).toEqual({ label: "sem veredito", tone: "none" });
    expect(describeVerdictChip("reviewer", "")).toEqual({ label: "sem veredito", tone: "none" });
    expect(describeVerdictChip(null, null)).toEqual({ label: "sem veredito", tone: "none" });
  });

  it("papel nulo/desconhecido + aprovado: mantém a palavra gravada, NÃO pinta de verde", () => {
    expect(describeVerdictChip(null, "aprovado")).toEqual({ label: "aprovado", tone: "muted" });
    expect(describeVerdictChip("observer", "aprovado")).toEqual({ label: "aprovado", tone: "muted" });
    expect(describeVerdictChip(undefined, "aprovado")).toEqual({ label: "aprovado", tone: "muted" });
  });

  it("em inglês troca o wording do chip, não só o tom", () => {
    setLocale("en");
    expect(describeVerdictChip("implementer", "aprovado")).toEqual({ label: "proposes done", tone: "muted" });
    expect(describeVerdictChip("reviewer", "aprovado")).toEqual({ label: "approved", tone: "good" });
  });

  // Task 156e6d08 — a PROCEDÊNCIA vence o valor: uma linha que o fan-out
  // antigo carimbou na task errada não pode aparecer como "sem veredito",
  // porque isso a tornaria indistinguível de uma rodada que legitimamente
  // terminou sem veredito. Sem `rule` (chamador antigo) o comportamento é o
  // de sempre — é o que os casos acima continuam prendendo.
  it("carimbo de outra task: rótulo próprio, tom neutro, mesmo com veredito nulo", () => {
    expect(describeVerdictChip("reviewer", null, "declared_other_task")).toEqual({
      label: "carimbo de outra task",
      tone: "none",
    });
    setLocale("en");
    expect(describeVerdictChip("reviewer", null, "declared_other_task")).toEqual({
      label: "stamped on another task",
      tone: "none",
    });
  });

  it("rodada indecidível: 'não sei de qual task' — o vazio não fica mudo", () => {
    expect(describeVerdictChip("reviewer", null, "undeclared_round")).toEqual({
      label: "não sei de qual task",
      tone: "none",
    });
  });

  it("procedência real não muda o chip (declared_this_task / sole_link / no_verdict)", () => {
    expect(describeVerdictChip("reviewer", "aprovado", "declared_this_task")).toEqual({
      label: "aprovado",
      tone: "good",
    });
    expect(describeVerdictChip("implementer", "aprovado", "sole_link")).toEqual({
      label: "propõe concluir",
      tone: "muted",
    });
    expect(describeVerdictChip("reviewer", null, "no_verdict")).toEqual({ label: "sem veredito", tone: "none" });
  });
});

describe("describeVerdictProvenance — o dado velho era o falso, e a tela diz isso", () => {
  beforeEach(() => setLocale("pt-BR"));

  it("carimbo de fan-out: diz o valor GRAVADO e a task que o report nomeou", () => {
    const note = describeVerdictProvenance({
      cardId: "c1",
      role: "reviewer",
      verdict: null,
      at: 1,
      storedVerdict: "aprovado",
      rule: "declared_other_task",
      declaredTaskId: "abcdef01-2345-6789-abcd-ef0123456789",
    });
    expect(note).toContain("gravado como aprovado");
    expect(note).toContain("abcdef01");
  });

  it("indecidível com N vínculos: nomeia o número, e não sugere qual é o real", () => {
    expect(describeVerdictProvenance({ cardId: "c1", role: "reviewer", verdict: null, at: 1, rule: "undeclared_round", roundLinks: 8 })).toContain("8 vínculos");
    // Nomeou um id que não é task: a nota diz isso, em vez de fingir que não nomeou nada.
    expect(
      describeVerdictProvenance({
        cardId: "c1",
        role: "reviewer",
        verdict: null,
        at: 1,
        rule: "undeclared_round",
        declaredTaskId: "30d858c5",
        roundLinks: 8,
      }),
    ).toContain("30d858c5");
  });

  it("rodada real e rodada sem veredito: explicação curta, ou nenhuma", () => {
    expect(describeVerdictProvenance({ cardId: "c1", role: "reviewer", verdict: "aprovado", at: 1, rule: "declared_this_task" })).toContain("nomeou esta task");
    expect(describeVerdictProvenance({ cardId: "c1", role: "reviewer", verdict: "reprovado", at: 1, rule: "sole_link" })).toContain("um vínculo só");
    expect(describeVerdictProvenance({ cardId: "c1", role: "reviewer", verdict: null, at: 1, rule: "no_verdict" })).toBeNull();
    // Sem `rule` (main e renderer de versões diferentes no meio de um reload).
    expect(describeVerdictProvenance({ cardId: "c1", role: "reviewer", verdict: "aprovado", at: 1 })).toBeNull();
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

  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("abaixo de 1min é 'agora' via Intl.RelativeTimeFormat", () => {
    expect(formatTaskAge(T0 - 30_000, T0)).toBe("agora");
    expect(formatTaskAge(T0, T0)).toBe("agora");
  });

  it("entre 1min e 1h usa minutos (locale-aware)", () => {
    expect(formatTaskAge(T0 - 5 * 60_000, T0)).toMatch(/5/);
  });

  it("entre 1h e 1d usa horas — o exemplo '18h' do protótipo, agora via Intl", () => {
    expect(formatTaskAge(T0 - 18 * 3_600_000, T0)).toMatch(/18/);
  });

  it("1d ou mais usa dias — o exemplo '2d' do protótipo, agora via Intl", () => {
    expect(formatTaskAge(T0 - 2 * 86_400_000, T0)).toMatch(/2|anteontem/);
  });

  it("nunca combina duas unidades (ex.: '1d 3h') — só a mais grosseira que ainda cabe", () => {
    const age = formatTaskAge(T0 - (25 * 3_600_000 + 30 * 60_000), T0); // 1 dia, 1h30 e pouco
    expect(age).toMatch(/1|ontem/);
    expect(age).not.toMatch(/\d+\D+\d+/);
  });

  it("em inglês troca o wording, não só o número", () => {
    setLocale("en");
    expect(formatTaskAge(T0 - 30_000, T0)).toBe("now");
    expect(formatTaskAge(T0 - 5 * 60_000, T0)).toMatch(/5/);
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
  beforeEach(() => {
    setLocale("pt-BR");
  });

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
  const counts = { "238": 29, "118": 1, "1": 6 };
  const names = { "238": "Maestro", "118": "Idyplatform" };

  it("ownCount é o sprint em foco — NÃO o total histórico do board (bug §0)", () => {
    // Quadro mostra 5 do sprint corrente; mapa global ainda tem 29.
    const scope = computeBoardScope("238", counts, names, 5);
    expect(scope.ownCount).toBe(5);
    expect(scope.boardTotal).toBe(29);
  });

  it("board ativo sem task no sprint em foco dá ownCount 0 mesmo com boardTotal > 0", () => {
    const scope = computeBoardScope("238", counts, names, 0);
    expect(scope.ownCount).toBe(0);
    expect(scope.boardTotal).toBe(29);
  });

  it("board sem entrada em counts dá boardTotal 0; ownCount segue o sprint passado", () => {
    const scope = computeBoardScope("999", counts, names, 3);
    expect(scope.ownCount).toBe(3);
    expect(scope.boardTotal).toBe(0);
  });

  it("sprint congelado: ownCount vem do tamanho do snapshot passado, nunca do mapa vivo", () => {
    // Snapshot fechado com 12 tasks; tabela viva do board ainda soma 29.
    const scope = computeBoardScope("238", counts, names, 12);
    expect(scope.ownCount).toBe(12);
    expect(scope.boardTotal).toBe(29);
  });

  it("otherBoards exclui o board ativo e soma certo em otherTotal (significado inalterado)", () => {
    const scope = computeBoardScope("238", counts, names, 5);
    expect(scope.otherBoards.map((b) => b.boardId)).toEqual(["1", "118"]); // ordenado por contagem desc
    expect(scope.otherTotal).toBe(7); // 6 + 1
  });

  it("ordena por contagem decrescente, não pela ordem de inserção do mapa", () => {
    const scope = computeBoardScope("238", counts, names, 5);
    expect(scope.otherBoards[0].count).toBeGreaterThanOrEqual(scope.otherBoards[1].count);
  });

  it("um board sem entrada em boardNames (o caso órfão real) vem com name:null — nunca um palpite de nome, nunca omitido da contagem", () => {
    const scope = computeBoardScope("238", counts, names, 5);
    const orphan = scope.otherBoards.find((b) => b.boardId === "1");
    expect(orphan).toEqual({ boardId: "1", name: null, count: 6 });
  });

  it("board conhecido vem com o nome real", () => {
    const scope = computeBoardScope("238", counts, names, 5);
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
  beforeEach(() => {
    setLocale("pt-BR");
  });

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

  it("verdicts → pílulas rodada N / reprovada N× (task_verdicts, rodada 4)", () => {
    const pills = computeMetaPills(null, null, null, [{ verdict: "reprovado" }, { verdict: null }, { verdict: "aprovado" }]);
    expect(pills).toEqual([
      { kind: "round", text: "rodada 3" },
      { kind: "rejection", text: "reprovada 1×" },
    ]);
  });

  it("sem verdicts: não inventa rodada/reprovação; 'fase X adiada' continua fora do modelo", () => {
    const allKinds: MetaPillKind[] = ["wait", "wait-broken", "suggestion", "round", "rejection"];
    const pills = computeMetaPills({ depId: "d", status: "running" }, 1, 2);
    for (const p of pills) expect(allKinds).toContain(p.kind);
    expect(pills.some((p) => p.kind === "round" || p.kind === "rejection")).toBe(false);
  });
});

describe("computeVerdictsByProvider / computeRoundsToApprove", () => {
  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("agrupa aprovado/reprovado por provider; null não conta", () => {
    const stats = computeVerdictsByProvider([
      { verdict: "aprovado", provider: "claude", at: 1 },
      { verdict: "reprovado", provider: "claude", at: 2 },
      { verdict: null, provider: "claude", at: 3 },
      { verdict: "aprovado", provider: null, at: 4 },
    ]);
    expect(stats).toEqual([
      { provider: "claude", approved: 1, rejected: 1 },
      { provider: "desconhecido", approved: 1, rejected: 0 },
    ]);
  });

  it("rodadas até o primeiro aprovado, inclusivo; task sem aprovado fica de fora", () => {
    const rows = computeRoundsToApprove([
      {
        taskId: "t1",
        label: "t1",
        verdicts: [
          { verdict: "reprovado", provider: "claude", at: 1 },
          { verdict: "aprovado", provider: "claude", at: 2 },
        ],
      },
      {
        taskId: "t2",
        label: "t2",
        verdicts: [{ verdict: "reprovado", provider: "codex", at: 1 }],
      },
    ]);
    expect(rows).toEqual([{ taskId: "t1", label: "t1", rounds: 2 }]);
    expect(roundsBarTone(4)).toBe("expensive");
    expect(roundsBarTone(3)).toBe("cheap");
  });
});

describe("cycleAxisMarks", () => {
  it("marca 0, meio e máximo em horas", () => {
    expect(cycleAxisMarks(18).map((m) => m.label)).toEqual(["0h", "9h", "18h"]);
  });
});

describe("isHumanCreatedTask / didHumanTaskGetClaimed", () => {
  it("só firstActor human conta como criada pela UI", () => {
    expect(isHumanCreatedTask("human")).toBe(true);
    expect(isHumanCreatedTask("agent")).toBe(false);
    expect(isHumanCreatedTask(null)).toBe(false);
  });

  it("pega = ganhou card OU virou running; primeiro snapshot não dispara", () => {
    expect(didHumanTaskGetClaimed(undefined, { cardId: "1", status: "pending" })).toBe(false);
    expect(didHumanTaskGetClaimed({ cardId: null, status: "pending" }, { cardId: "9", status: "pending" })).toBe(true);
    expect(didHumanTaskGetClaimed({ cardId: null, status: "pending" }, { cardId: null, status: "running" })).toBe(true);
    expect(didHumanTaskGetClaimed({ cardId: "9", status: "running" }, { cardId: "9", status: "running" })).toBe(false);
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
  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("só aparece quando o ÚLTIMO ator foi humano E o card vinculado ainda está vivo — as duas condições", () => {
    expect(describeHumanMoveNotice("human", true, "288")).toBe("Movida à mão com o card 288 ainda rodando.");
  });

  it("não afirma que o card foi avisado no PTY — drag não digita (2026-09-14)", () => {
    expect(describeHumanMoveNotice("human", true, "288")).not.toMatch(/avisado|notified/i);
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

// DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal legível no card Fila.
describe("describeStatusDivergence", () => {
  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("formata app e agente com o título da coluna, nunca o status cru", () => {
    expect(describeStatusDivergence("failed", "app")).toBe('o app declarou "falhou" — status humano mantido');
    expect(describeStatusDivergence("done", "agent")).toBe('o agente declarou "concluído" — status humano mantido');
  });

  it("null/ausente: sem sinal (divergência limpa ou inexistente)", () => {
    expect(describeStatusDivergence(null, null)).toBeNull();
    expect(describeStatusDivergence("failed", null)).toBeNull();
    expect(describeStatusDivergence(null, "app")).toBeNull();
    expect(describeStatusDivergence(undefined, undefined)).toBeNull();
  });
});

describe("describeStatusAskNotice", () => {
  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("formata o pedido com o título da coluna", () => {
    expect(describeStatusAskNotice("done")).toBe('agente pede "concluído"');
  });

  it("null/ausente: sem pedido", () => {
    expect(describeStatusAskNotice(null)).toBeNull();
    expect(describeStatusAskNotice(undefined)).toBeNull();
    expect(describeStatusAskNotice("")).toBeNull();
  });
});

describe("sprint history helpers (fechamento explícito)", () => {
  beforeEach(() => {
    setLocale("pt-BR");
  });

  it("shortSprintId corta em 8 chars", () => {
    expect(shortSprintId("abcdef0123456789")).toBe("abcdef01");
  });

  it("sprintLabel usa nome editável ou Sprint N", () => {
    expect(sprintLabel({ number: 3, name: null })).toBe("Sprint 3");
    expect(sprintLabel({ number: 3, name: "  " })).toBe("Sprint 3");
    expect(sprintLabel({ number: 3, name: "Alpha" })).toBe("Alpha");
  });

  it("formatSprintTimestamp documenta dia e hora locais", () => {
    const ms = Date.UTC(2026, 8, 11, 18, 5); // fixed instant
    // Result includes YYYY-MM-DD and HH:MM (local offset may shift the day).
    expect(formatSprintTimestamp(ms)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("formatSprintDuration cobre min/h/d", () => {
    const start = 1_000_000;
    expect(formatSprintDuration(start, start + 90_000, start)).toBe("2min");
    expect(formatSprintDuration(start, start + 3_600_000 * 2, start)).toBe("2.0h");
    expect(formatSprintDuration(start, start + 3_600_000 * 72, start)).toBe("3.0d");
  });

  it("describeSprintCounts inclui buckets e migração in/out", () => {
    expect(
      describeSprintCounts({
        countTodo: 1,
        countDoing: 2,
        countDone: 3,
        countFailed: 4,
        migratedIn: 5,
        migratedOut: 6,
      }),
    ).toBe("a fazer 1 · andamento 2 · concluído 3 · falhou 4 · migrou −6/+5");
  });

  it("snapshotTaskToBoardItem monta stub read-only", () => {
    const item = snapshotTaskToBoardItem(
      {
        id: "t1",
        prompt: "hello",
        status: "pending",
        order: 1,
        suggestedOrder: null,
        implicitOrder: null,
        createdAt: 10,
        updatedAt: 20,
      },
      "b1",
    );
    expect(item.id).toBe("t1");
    expect(item.boardId).toBe("b1");
    expect(item.cards).toEqual([]);
    expect(item.cardAlive).toBe(false);
    expect(item.purpose).toBeNull();
    expect(item.depPurposes).toEqual({});
  });
});
