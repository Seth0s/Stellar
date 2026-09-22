/**
 * O QUE UMA LINHA DE `task_verdicts` QUER DIZER — a regra de LEITURA do
 * passado, num lugar só (task 156e6d08; medido no banco vivo em 2026-09-22).
 *
 * O DEFEITO É DE ESCRITA, E JÁ FOI CONSERTADO (7315c53) — e é exatamente por
 * isso que esta regra existe. Até aquele commit, `recordParticipationRound`
 * (store.ts) iterava os vínculos VIVOS do card e gravava UMA LINHA POR
 * VÍNCULO com o mesmo veredito e o mesmo `at`: o `aprovado` que um revisor
 * deu ao trabalho A ficava registrado também como aprovado de B, C, D e de
 * mais catorze. Medido nesta máquina: **1965 linhas, 545 com veredito — 420
 * delas (77,1%) apontam para uma task que o report NUNCA declarou**.
 *
 * Aquelas 420 não são história a ser reescrita: são história a ser LIDA
 * direito. Nada aqui escreve — nenhum UPDATE, nenhuma migração, nenhum
 * backfill; a tabela continua dizendo exatamente o que sempre disse, e o que
 * muda é o que se conclui dela. Reconstruir o passado por escrita apagaria a
 * única prova de que a escrita um dia esteve errada.
 *
 * A REGRA, e por que cada parte dela:
 *
 *   - O `taskId` DECLARADO pelo report da rodada vence — é a mesma primazia
 *     que `decideReportTaskLink` já dá à declaração na ESCRITA (`resolve →
 *     source: "declared"`). A rodada é uma só: todas as linhas com o mesmo
 *     `(card_id, at)` foram gravadas pela MESMA chamada, com o mesmo
 *     veredito. Se o payload nomeia uma task, o veredito é daquela task e de
 *     nenhuma outra; a linha cujo `task_id` é a declarada é a verdadeira, e as
 *     outras são ARTEFATO do fan-out — o veredito não é delas.
 *   - SEM declaração, quem decide é o TAMANHO da rodada, e ele é um fato
 *     durável (mora em `task_verdicts`, não no payload sujeito a poda de
 *     `reports`): **um vínculo só** não tem como ter carimbado a task errada
 *     — não havia outra — e a linha é verdadeira; **N > 1** é indecidível por
 *     construção, porque exatamente UMA das N é a real e o payload não diz
 *     qual.
 *   - DECLARADO QUE NÃO É TASK (`declaredTaskId` presente, `declaredNamesTask`
 *     falso, 17 rodadas medidas — ids de 8 caracteres copiados de briefing,
 *     "30d858c5") **não é declaração**: um id que não nomeia task nenhuma não
 *     separa nada, e resolvê-lo por PREFIXO seria o palpite que esta fatia
 *     existe para não dar. A linha cai na regra do tamanho da rodada, como se
 *     não houvesse declaração — e o campo fica no registro para quem audita.
 *
 * "DESCONHECIDO" É ESTADO DE PRIMEIRA CLASSE, com nome próprio
 * (`undeclared_round`), não um vazio: é a resposta certa para uma linha em
 * que uma das N é real e não há como saber qual. Distribuir
 * proporcionalmente, pegar a primeira ou inferir pela ordem produziria
 * exatamente o dado falso que esta leitura existe para parar de afirmar.
 *
 * O QUE NÃO SE PERDE COM ISSO (medido, 509 rodadas com declaração): quando a
 * task declarada EXISTE, ela tem a própria linha no grupo em 492 de 492
 * casos — a linha verdadeira nunca é a que este módulo cala. As 17 rodadas em
 * que a task declarada não está no grupo são todas de id que não é task.
 */

export type TaskVerdictReadRule =
  /** A rodada declarou ESTA task: o veredito é dela. */
  | "declared_this_task"
  /** A rodada declarou OUTRA task: carimbo de fan-out, não é desta. */
  | "declared_other_task"
  /** Sem declaração e a rodada tinha UM vínculo: não havia outra candidata. */
  | "sole_link"
  /** Sem declaração utilizável e a rodada tinha N > 1 vínculos: indecidível. */
  | "undeclared_round"
  /** A rodada terminou sem veredito nenhum (saída sem report). Nada a reparar. */
  | "no_verdict";

/** O que a leitura conclui de UMA linha de `task_verdicts`. Nunca substitui a
 * linha: anda ao lado dela, porque quem lê precisa ver as duas coisas — o que
 * está gravado e o que se pode concluir. */
export type TaskVerdictReading = {
  /** O veredito que se pode ATRIBUIR a esta task. `null` quando não se pode —
   * e `null` aqui é resposta, não ausência de resposta (ver `rule`). */
  verdict: string | null;
  /** O que a COLUNA diz. Diferente de `verdict` só quando a linha é carimbo de
   * outra task — e é essa diferença que quem audita veio ver. */
  storedVerdict: string | null;
  rule: TaskVerdictReadRule;
  /** O `taskId` que o payload da rodada nomeou, cru (mesmo quando não é task
   * nenhuma — é o registro do que o report disse). */
  declaredTaskId: string | null;
  /** Esse id nomeia uma task que existe NESTE banco? Falso para id truncado. */
  declaredNamesTask: boolean;
  /** Quantas linhas a rodada carimbou (`(card_id, at)` iguais). O fato que
   * decide quando não há declaração — e que sobrevive à poda de `reports`. */
  roundLinks: number;
  /** O report daquela rodada ainda existe em `reports`? `reports` tem teto de
   * contagem (`MAX_STORED_REPORTS`) e poda as `seq` mais antigas: `false` quer
   * dizer que a declaração, se houve, JÁ NÃO É CONSULTÁVEL. A regra segue de
   * pé (o tamanho da rodada não se poda), mas o grau de certeza muda — e é por
   * isso que este campo viaja junto. */
  reportFound: boolean;
};


/** A rodada pode ser levada em conta como afirmação sobre ESTA task?
 *
 * É o predicado que os dois CONSUMIDORES de decisão compartilham — a proposta
 * de conclusão (renderer) e o efeito de fechar o card (`judgment-write-decision.ts`)
 * — e mora aqui, junto da regra, pra não existir uma terceira interpretação do
 * mesmo estado:
 *   - `declared_other_task` (carimbo de fan-out): NÃO. A rodada fala de outra
 *     task; contá-la como "este revisor já julgou esta task" é aceitar que um
 *     carimbo antigo assine por alguém que não assinou.
 *   - `undeclared_round` (uma das N é real, e não se sabe qual): NÃO. "Não
 *     sei" não sustenta proposta nem assinatura — as duas exigem afirmação.
 *   - todo o resto SIM: `declared_this_task`, `sole_link` (o veredito é desta
 *     task) e `no_verdict` (a rodada terminou sem veredito — um fato sobre
 *     esta task, e o que ela significa já está no próprio `verdict: null`).
 *   - `undefined` (linha vinda de um chamador/teste anterior à fatia): SIM —
 *     era o comportamento de antes, e mudá-lo aqui quebraria quem nem sabe da
 *     procedência. */
export function isRoundAttributableToTask(rule: TaskVerdictReadRule | undefined): boolean {
  return rule !== "declared_other_task" && rule !== "undeclared_round";
}

export function deriveTaskVerdictReading(input: {
  /** A task a que a LINHA pertence (`task_verdicts.task_id`). */
  taskId: string;
  /** `task_verdicts.verdict`, como está gravado. */
  storedVerdict: string | null;
  /** `taskId` do report da rodada (`normalizeDeclaredTaskId`), se declarou. */
  declaredTaskId?: string | null;
  /** Se esse `taskId` nomeia uma task existente. Sem `declaredTaskId`, irrelevante. */
  declaredNamesTask?: boolean;
  /** Linhas gravadas com o mesmo `(card_id, at)` desta. */
  roundLinks: number;
  /** O report da rodada ainda está em `reports`. */
  reportFound: boolean;
}): TaskVerdictReading {
  const declaredTaskId = input.declaredTaskId ?? null;
  const namesTask = declaredTaskId !== null && input.declaredNamesTask === true;
  const roundLinks = Number.isFinite(input.roundLinks) && input.roundLinks > 0 ? input.roundLinks : 1;

  const base = {
    storedVerdict: input.storedVerdict,
    declaredTaskId,
    declaredNamesTask: namesTask,
    roundLinks,
    reportFound: input.reportFound,
  };

  // Rodada sem veredito (saída sem report): não há veredito a atribuir nem a
  // recusar. `verdict` continua null e a rodada continua contando como
  // participação — é o estado que a tela já chama de "sem veredito".
  if (input.storedVerdict === null) {
    return { ...base, verdict: null, rule: "no_verdict" };
  }

  if (namesTask) {
    return declaredTaskId === input.taskId
      ? { ...base, verdict: input.storedVerdict, rule: "declared_this_task" }
      : { ...base, verdict: null, rule: "declared_other_task" };
  }

  return roundLinks === 1
    ? { ...base, verdict: input.storedVerdict, rule: "sole_link" }
    : { ...base, verdict: null, rule: "undeclared_round" };
}

