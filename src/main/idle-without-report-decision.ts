/**
 * DESIGN-BACKLOG.md §2.1 SINAL 3 — watchdog for the gap between
 * `card_status: idle` and `exit_without_report`.
 *
 * Exit without report (SINAL 2) already notifies the spawner when the
 * card DIES. Report (SINAL 1) notifies when a row lands. Nobody covered
 * the middle: card ALIVE, quiet, task still expecting a report, no row
 * in `reports`.
 *
 * O DEFEITO QUE ESTE MÓDULO TINHA (medido 2026-09-20, task a1201078):
 * `hasReport` era POR VIDA DO CARD. O PRIMEIRO report que um card dava
 * desarmava o watchdog para sempre — e o mecanismo se chama "termina o TURNO
 * sem reportar". Medido no board real: um card que reportou em seq 444
 * (13:50) e 448 (14:03) passou batido em DUAS falhas DEPOIS disso (uma de
 * 4m59s, outra de 40s), porque `!!getReport(cardId)` era true desde o
 * primeiro. O nome prometia turno; o portão entregava vida. Seis ocorrências
 * no mesmo dia passaram pelo orquestrador lendo scrollback, não por aqui.
 *
 * A JANELA CORRETA — e por que ela NÃO pode ser o fato de turno: o recorte
 * tem de ser "não existe report NESTE EPISÓDIO", nunca "não existe report na
 * vida". EPISÓDIO = desde a última vez que o card RECEBEU TRABALHO (input
 * humano ou entrega), que é o instante que cria a obrigação de reportar.
 * Isso é independente de `turnEndedAt`, e tem de ser: medido, `turnEndedAt`
 * só existe para quem injeta o hook Stop, e quem injeta é o buildArgs do
 * PRÓPRIO CLAUDE (`providers.ts:704`, ocorrência única no repo, sem
 * instalação global). Os cards `bash`+`commandcode` abertos à mão — que é
 * onde as falhas acontecem neste board — NUNCA declaram turno. Ancorar o
 * conserto em `turnEndedAt` o faria morrer exatamente onde o defeito vive.
 *
 * O FATO DE TURNO CONTINUA ÚTIL como PRECISÃO onde existe: turno declarado
 * encerrado e nenhuma saída depois é o `idle` de `card-status-decision.ts`
 * (fato declarado, não silêncio) e DISPENSA o piso — o `declaredIdle` abaixo.
 * Sem ele, o piso de atividade responde, porque é o único sinal que sobra, e
 * é o único capaz de ver um card que TRAVA sem nunca encerrar turno.
 *
 * O QUE ESTE MÓDULO NÃO RESOLVE, dito por inteiro (o "de menos" honesto): um
 * card que nunca declara turno e NUNCA fica quieto (TUI que repinta) não é
 * visto por ninguém — o relógio de bytes não envelhece e não há fato de
 * turno. Cutucar ali exigiria decidir por uma grandeza que este repo já
 * desqualificou (`card-status-decision.ts`: `lastActivityAt` mede BYTES, e
 * bytes não são evidência de trabalho em TUI nenhum), e um cutucão baseado
 * numa grandeza que virou `unknown` é pior que nenhum.
 *
 * O PISO DE 180s FICA, e só para o caminho SEM fato de turno.
 * `IDLE_WITHOUT_REPORT_MS = 180_000` é o mesmo teto de "silêncio ≠ trabalho"
 * já usado na barra de atividade (`ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS` em
 * terminal-activity-decision.ts), com folga sobre um máximo medido de tool
 * MCP de 122,7s. Para turno DECLARADO ele seria arbitrário — o fato é
 * declarado, não inferido — e é por isso que `declaredIdle` não o espera.
 *
 * O TIMER DE 5s (`IDLE_WITHOUT_REPORT_POLL_MS`) É MECANISMO, NÃO SOBRA — não
 * reabra este corte achando que é resíduo de um desenho antigo. Com a âncora
 * em EPISÓDIO não existe evento equivalente para esta população: o que se
 * procura é a AUSÊNCIA de um report depois que o card recebeu trabalho, e
 * ausência não emite evento — só uma varredura a observa. O que existe como
 * evento é o INÍCIO do episódio (a entrega/input, que passa por
 * `registry.write` com origem `human`/`delivery`), e ele pode um dia baratear
 * a varredura para "só cards com episódio aberto" — mas não substitui o poll,
 * porque a condição do cutucão continua sendo algo que NÃO aconteceu.
 *
 * A FORMA CURTA DISSO, para quem chegar depois e achar que o poll é resíduo:
 * EVENTO ARMA, POLL CONFERE. Armar tem evento (a entrega); conferir não tem
 * (não existe evento para o report que não veio). Por isso o desenho
 * declarado — "só varrer cards com episódio aberto" — é OTIMIZAÇÃO, não
 * substituição, e é para depois: nesta task o poll fica como está.
 *
 * E O QUE ESTE CAMINHO NÃO VÊ — medido ao vivo em 2026-09-20, e é
 * contraintuitivo: um card `bash` com TUI DENTRO nunca fica quieto. Três
 * amostras de `card_status` (build antigo, cujo limiar era 5s em
 * `lastActivityAt`) em cards que eu não toquei leram `running` nas três, ao
 * longo de ~105s: bytes chegam continuamente enquanto a TUI está parada no
 * prompt (repintura de cursor/linha de status). Para essa população o piso de
 * 180s NUNCA vence e esta varredura nunca dispara — "silêncio" simplesmente
 * não é um sinal disponível ali. O que fecha o caso deles é o FATO DE TURNO
 * (`declaredIdle`), que hoje só existe para cards do claude porque quem
 * injeta o hook Stop é o buildArgs do claude (ver o parágrafo acima).
 *
 * `reportedSinceWorkGranted` é o fato que substitui o `hasReport` absoluto:
 * "o report mais recente do card é POSTERIOR à última vez que ele recebeu
 * trabalho". Quem o calcula é o chamador (o bus), comparando o
 * `updated_at`/`seq` do último report (`ReportRow`, store.ts) com o instante
 * da última entrega/input (`pty-registry.ts`'s `getLastWorkGrantedAt`, já
 * ligado ao bus por uma linha em `index.ts`). O `hasReport` deprecado que
 * existiu durante a janela daquela fiação FOI REMOVIDO quando ela entrou:
 * fallback permanente reabriria a pergunta errada, e um watchdog que parece
 * vigiar e não vigia é pior que um watchdog ausente.
 *
 * Once-only state lives in the caller (`Set`/`Map` of card ids), por episódio
 * e não por vida: re-armar é o que faz a SEGUNDA falha do mesmo card ser
 * visível. Reset quando um report é aceito ou o card sai (exit path takes
 * over). Do NOT reset on transient PTY chatter — a spinner would re-arm spam.
 */

/** Same ceiling as ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS — silence-as-work bound.
 *  Vale para o caminho SEM fato de turno (`declaredIdle` falso). */
export const IDLE_WITHOUT_REPORT_MS = 180_000;

/** How often the bus rescans alive cards. Cheap; aligns with card_status idle. */
export const IDLE_WITHOUT_REPORT_POLL_MS = 5_000;

export type IdleWithoutReportSkipReason =
  | "not_alive"
  | "waiting_consent"
  /** Já existe report NESTE episódio (desde a última vez que o card recebeu
   *  trabalho) — o guard de falso positivo. */
  | "reported_this_episode"
  | "no_linked_running_task"
  | "already_notified"
  | "activity_unknown"
  | "not_idle_long_enough";

export type IdleWithoutReportDecision =
  | { action: "notify" }
  | { action: "skip"; reason: IdleWithoutReportSkipReason };

/**
 * Decide whether this card's idle-without-report episode should notify
 * the spawner. Pure — no I/O, no mutation of the once-set.
 */
export function decideIdleWithoutReport(input: {
  alive: boolean;
  waitingOnConsent: boolean;
  /**
   * O report mais recente do card é POSTERIOR à última vez que ele recebeu
   * trabalho (input humano ou entrega)? `false` = este episódio ainda não tem
   * report, MESMO que o card já tenha reportado antes na vida — é a diferença
   * que faz a segunda falha do mesmo card ser visível.
   *
   * OBRIGATÓRIO: substituiu o `hasReport` absoluto (por VIDA do card), que era
   * o defeito desta task. O fallback que existiu por uma janela datada — o
   * repasse da âncora em `message-bus.ts` antes de a linha entrar no
   * `index.ts` — foi removido quando a janela fechou, porque um watchdog que
   * parece vigiar e não vigia entrega pior que um watchdog ausente.
   */
  reportedSinceWorkGranted: boolean;
  /**
   * Turno DECLARADO encerrado sem nenhuma saída depois — o `idle` de
   * `card-status-decision.ts`. Onde existe (hoje: cards do claude, via hook
   * Stop), o fato é declarado e dispensa o piso. Onde não existe
   * (bash/commandcode, ou `unknown`), ausente/false e o piso decide.
   */
  declaredIdle?: boolean;
  /** Principal implementer link (`tasks.card_id`) on a non-judgment task. */
  hasLinkedRunningTask: boolean;
  alreadyNotified: boolean;
  /** `null` when the PTY registry has no activity clock for this card. */
  msSinceLastActivity: number | null;
  /** Override for tests; production uses IDLE_WITHOUT_REPORT_MS. */
  idleWithoutReportMs?: number;
}): IdleWithoutReportDecision {
  if (!input.alive) return { action: "skip", reason: "not_alive" };
  if (input.waitingOnConsent) return { action: "skip", reason: "waiting_consent" };
  // "Houve report NESTE episódio?" — a pergunta do mecanismo, e a única que
  // ele faz sobre report. Não existe mais o fato absoluto por vida que
  // desarmava o watchdog no primeiro report de um card.
  if (input.reportedSinceWorkGranted) return { action: "skip", reason: "reported_this_episode" };
  if (!input.hasLinkedRunningTask) return { action: "skip", reason: "no_linked_running_task" };
  if (input.alreadyNotified) return { action: "skip", reason: "already_notified" };
  // Fato declarado de fim de turno: não espera piso nenhum — esperar 3min
  // para reagir a algo que o card DECLAROU seria arbitrário.
  if (input.declaredIdle) return { action: "notify" };
  // Sem fato de turno (bash/commandcode à mão), o silêncio é o único sinal.
  if (input.msSinceLastActivity === null) return { action: "skip", reason: "activity_unknown" };
  const floor = input.idleWithoutReportMs ?? IDLE_WITHOUT_REPORT_MS;
  if (input.msSinceLastActivity < floor) {
    return { action: "skip", reason: "not_idle_long_enough" };
  }
  return { action: "notify" };
}
