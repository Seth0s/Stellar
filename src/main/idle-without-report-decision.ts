import type { CardDeliveryState } from "./type-and-submit-decision";

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
 * A SEGUNDA PERGUNTA, que faltava (task 14b8b224): não basta "este card devia
 * um report?" — é preciso "ALGUÉM podia ter reportado?". Medido no board em
 * 2026-09-22: quatro cards `provider: bash` VAZIOS, vinculados a tasks pelo
 * orquestrador, foram acusados de "idle sem chamar report" minutos depois. Não
 * houve falha nenhuma: não havia agente. E a âncora não separa os dois casos —
 * `lastWorkGrantedAtMs` NASCE com a entry (`pty-registry.ts`, no spawn), então
 * TODO card vivo carrega âncora desde o berço e "não houve report desde o
 * trabalho" é vacuamente verdadeiro para quem nunca recebeu trabalho nenhum. A
 * resposta mora em `hasAgentReadingLine` (`card-status-decision.ts`), a fonte
 * única da pergunta "tem agente lendo esta linha?" — e o portão abaixo só
 * silencia com a prova EXPLÍCITA (`hasAgentReader === false`), nunca por fato
 * ausente: um alarme que some é pior que um alarme errado.
 *
 * A VERDADE VAZIA — e a hipótese ERRADA que ela substituiu (2026-09-22, a
 * lição que mais vale desta task). O diagnóstico inicial do defeito foi "o
 * vínculo conta como receber trabalho". MEDIDO: NÃO CONTA.
 * `lastWorkGrantedAtMs` NASCE com a entry, no spawn (`pty-registry.ts:953`), e
 * só é renovado por write com origin `human`/`delivery` (`grantsWork`,
 * 1324-1326) — e o vínculo de um card `bash` não escreve nada, porque
 * `notifyLinkedCard` (`message-bus.ts`) retorna ANTES de qualquer entrega.
 * O que disparou nos quatro cards foi o PISO: `reportedSinceWorkGranted ===
 * false` era VACUAMENTE verdadeiro (âncora desde o berço + nenhum trabalho
 * concedido jamais), e "não houve report desde o trabalho" virou "DEVIA um
 * report" para quem nunca pôde reportar.
 *
 * QUEM LER ISTO DAQUI A UM MÊS: não reconstrua a hipótese do vínculo — ela foi
 * medida e recusada, com o caminho do código acima. O defeito é a VERDADE VAZIA
 * TRATADA COMO FATO, que é a mesma classe que este módulo já pagou uma vez (o
 * `hasReport` por vida do card) e a razão pela qual a pergunta "alguém podia
 * ter reportado?" teve de virar um fato explícito (`hasAgentReader`).
 *
 * A TERCEIRA FRASE — SILÊNCIO INFERIDO x SILÊNCIO DECLARADO (task 14b8b224,
 * caso (b)). O SEGUNDO falso positivo, medido no próprio board: o alarme
 * disparou para um card COM agente que estava parado PORQUE o orquestrador
 * mandou parar (esperando o conserto de outra task). "Esperando instrução" e
 * "morreu calado" são idênticos OLHANDO PARA O CARD — e a pergunta que o
 * orquestrador propôs para separá-los não tem resposta neste app:
 *
 *   - o STORE não guarda mensagem recebida por card. MEDIDO: as tabelas são
 *     cards/connectors/boards/tasks/task_transitions/task_cards/reports/
 *     task_verdicts/sprints/browser_favorites/spawns/local_identity — não há
 *     `deliveries`/`messages`; as entregas vivem num índice EM MEMÓRIA (o
 *     próprio `list_deliveries` se descreve assim), e `cards.messages_json` é
 *     histórico de card `kind='chat'` (medido: 0 bytes num card terminal).
 *   - o FATO que existe em memória (`getCardLastWorkGrantedAt`, o último
 *     trabalho concedido) NÃO separa — ele é a condição que ARMA o watchdog.
 *     Quem está trabalhando e quem abandonou têm, os dois, "houve entrega
 *     depois do último report". Usá-lo como skip silenciaria todo card que já
 *     recebeu trabalho, que é o mecanismo inteiro.
 *
 * O QUE SEPARA é o FATO DE TURNO: `declaredIdle`. Com ele, o card DECLAROU o
 * fim do turno e não reportou — a acusação está sustentada pelo que o próprio
 * card emitiu (hoje o único produtor é o hook `Stop` do claude, `providers.ts`;
 * `acbridge turn-complete` existe no PATH de todo card, mas nenhum outro CLI o
 * chama). Sem ele — cline, commandcode, e qualquer agente parado no composer —
 * o que o app tem é um RELÓGIO DE BYTES, grandeza que este repo já desqualificou
 * como evidência de trabalho (ver `card-status-decision.ts`: sem fato de turno,
 * o estado honesto é `unknown`, "não inventamos").
 *
 * Por isso a ação `notify_unproven`: o mesmo sinal, a frase do tamanho da
 * prova. O texto diz o que sabe ("sem chamar report há Nmin") e pede a
 * conferência — em vez de afirmar um abandono que o app não pode ver.
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
  /** O card respondeu a quem o dirige — pelo único canal de quem não pode
   *  chamar `report` — DEPOIS de receber o trabalho deste episódio. Ver o
   *  campo `answeredDirectorSinceWorkGranted`: não é report, não é julgamento,
   *  e não silencia saída nem boot silencioso. */
  | "answered_director_this_episode"
  | "no_linked_running_task"
  | "already_notified"
  | "activity_unknown"
  | "not_idle_long_enough";

export type IdleWithoutReportDecision =
  | { action: "notify" }
  /** SILÊNCIO INFERIDO, sem fato de turno (task 14b8b224, caso (b)): o card
   *  está quieto além do piso e nada declarou o fim do turno. Aqui o app NÃO
   *  sabe distinguir "terminou e não reportou" de "está trabalhando" nem de
   *  "está à espera de instrução" — e é por isso que a frase desta ação é
   *  factual ("sem report há X"), nunca a acusação. Ver o bloco A TERCEIRA
   *  FRASE no cabeçalho do módulo para a medição que separa os dois casos. */
  | { action: "notify_unproven" }
  /** O card está ocioso e vinculado, mas NÃO há agente lendo a linha: não é
   *  "não reportou" (ninguém poderia ter reportado), é "o vínculo existe e
   *  ninguém o executa". Mesma pergunta, resposta DIFERENTE — e por isso uma
   *  frase diferente, nunca a acusação (task 14b8b224). */
  | { action: "notify_no_agent" }
  | { action: "skip"; reason: IdleWithoutReportSkipReason };

/**
 * O que conta como "o card respondeu a quem o dirige" (task fc68f565).
 *
 * Dois estados, e o resto é ausência honesta:
 *   - `delivered` — o texto foi digitado e o agente leu (o caso feliz);
 *   - `parked` — o texto foi digitado e ficou na fila mid-turn do DESTINO, ou
 *     seja, está no card de quem dirige e vai ser lido quando o turno terminar.
 *     O autor já fez a parte dele; cobrar a resposta dele seria cobrar o que já
 *     foi entregue (ver `send-settle-decision.ts`, que chama isso de "já está
 *     lá, não reenvie").
 *
 * Fora: `queued` (não foi digitado ainda), `failed` e `cancelled` (não chegou),
 * e `unconfirmed` — sem evidência não se afirma resposta, do mesmo jeito que
 * este módulo se recusa a afirmar abandono sem prova.
 */
export function isAnswerLanded(state: CardDeliveryState): boolean {
  return state === "delivered" || state === "parked";
}

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
   * O card JÁ RESPONDEU a quem o DIRIGE neste episódio — por `send_to_card`
   * para o mesmo card que receberia este aviso, depois da última vez que
   * recebeu trabalho?
   *
   * Task fc68f565, e a medição que a abriu (2026-09-23, banco copiado + os
   * stores de sessão, janela de 48h): 53 avisos de ociosidade entregues. 44
   * eram de cards `cline` — a população que NÃO CONSEGUE chamar `report`
   * (identidade compartilhada do daemon; ver `declared-card-existence-decision.ts`),
   * cujo único canal é `send_to_card` para quem os dirige. Em 8 deles o card já
   * tinha falado com o diretor pelo canal correto antes do aviso; em 37 (70%)
   * a entrega existia mas chegou rotulada `card #<id-que-não-existe>`, ou seja,
   * o app não conseguiu atribuí-la a ninguém. Nos dois casos o aviso cobrava de
   * quem já havia respondido — o fato que faltava era só "esta resposta conta".
   *
   * O QUE ESTE FATO *NÃO* É, e é a parte que importa para quem vier depois:
   * NÃO é um report. Nada é gravado em `reports`, nenhum veredito nasce dele e
   * nenhuma task muda de status por causa dele (a decisão do dono, medida na
   * mesma janela: o `report` daqueles cards foi RECUSADO justamente por vir de
   * uma identidade que não existe — um julgamento que nasce de um texto livre
   * seria pior que o aviso que ele silencia).
   *
   * NÃO SUPRIME os outros dois sinais: `exit_without_report` e o boot silencioso
   * continuam inteiros — eles são fatos do PROCESSO (morreu, nunca falou), e um
   * send do card não é prova de nenhum dos dois.
   *
   * E NÃO É UM FATO DE CONFIANÇA CEGA: quem o calcula é o bus, que só o liga
   * quando a resposta foi para o MESMO card que receberia este aviso
   * (`resolveNotifyTarget`, a mesma função que escolhe o destinatário) e depois
   * da âncora do episódio. Se a direção mudou, o novo destinatário não sabe de
   * nada e o aviso segue.
   */
  answeredDirectorSinceWorkGranted: boolean;
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
  /**
   * TEM agente lendo a linha deste card? A resposta vem de
   * `hasAgentReadingLine` (`card-status-decision.ts`) — a fonte ÚNICA dessa
   * pergunta, a mesma que o aviso de vínculo faz.
   *
   * OBRIGATÓRIO de propósito, e o silêncio exige `=== false` EXPLÍCITO: um
   * fato AUSENTE (call site que esqueceu) NÃO silencia o watchdog — ele volta
   * ao comportamento antigo (acusar). Trocar um alarme errado por um alarme que
   * some seria pior: um watchdog que não vigia entrega menos que watchdog
   * nenhum, que é a lição que este módulo já pagou uma vez.
   */
  hasAgentReader: boolean;
  /** Override for tests; production uses IDLE_WITHOUT_REPORT_MS. */
  idleWithoutReportMs?: number;
}): IdleWithoutReportDecision {
  if (!input.alive) return { action: "skip", reason: "not_alive" };
  if (input.waitingOnConsent) return { action: "skip", reason: "waiting_consent" };
  // "Houve report NESTE episódio?" — a pergunta do mecanismo, e a única que
  // ele faz sobre report. Não existe mais o fato absoluto por vida que
  // desarmava o watchdog no primeiro report de um card.
  if (input.reportedSinceWorkGranted) return { action: "skip", reason: "reported_this_episode" };
  // A OUTRA forma de cumprir o episódio, para quem NÃO pode chamar `report`
  // (task fc68f565). Vem logo depois do report de propósito: as duas respondem
  // a MESMA pergunta — "o card já cumpriu o que este episódio pede?" — e é por
  // isso que a segunda também é `skip`, e não uma frase nova. O que ela NÃO faz
  // está no doc do campo: nada é gravado, nada é julgado.
  if (input.answeredDirectorSinceWorkGranted) return { action: "skip", reason: "answered_director_this_episode" };
  if (!input.hasLinkedRunningTask) return { action: "skip", reason: "no_linked_running_task" };
  if (input.alreadyNotified) return { action: "skip", reason: "already_notified" };
  // A FRASE segue o leitor e a PROVA, não o relógio (task 14b8b224). Três
  // respostas, cada uma do tamanho do que o app sabe:
  //   - sem leitor  → não é "não reportou" (ninguém podia reportar);
  //   - turno DECLARADO encerrado + nenhum report → a acusação está sustentada
  //     por um fato que o próprio card emitiu;
  //   - só silêncio (sem fato de turno) → INFERIDO: frase factual, sem acusar.
  const due = (): IdleWithoutReportDecision => {
    if (input.hasAgentReader === false) return { action: "notify_no_agent" };
    return input.declaredIdle ? { action: "notify" } : { action: "notify_unproven" };
  };
  // Fato declarado de fim de turno: não espera piso nenhum — esperar 3min
  // para reagir a algo que o card DECLAROU seria arbitrário.
  if (input.declaredIdle) return due();
  // Sem fato de turno (bash/commandcode à mão), o silêncio é o único sinal.
  if (input.msSinceLastActivity === null) return { action: "skip", reason: "activity_unknown" };
  const floor = input.idleWithoutReportMs ?? IDLE_WITHOUT_REPORT_MS;
  if (input.msSinceLastActivity < floor) {
    return { action: "skip", reason: "not_idle_long_enough" };
  }
  return due();
}
