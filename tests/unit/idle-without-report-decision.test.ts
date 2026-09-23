import { describe, it, expect } from "vitest";
import {
  IDLE_WITHOUT_REPORT_MS,
  IDLE_WITHOUT_REPORT_POLL_MS,
  decideIdleWithoutReport,
} from "../../src/main/idle-without-report-decision";
import { ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS } from "../../src/renderer/src/terminal-activity-decision";

/**
 * O PORTÃO DO SINAL 3 — "terminou e não reportou".
 *
 * Duas coisas mudaram aqui em 2026-09-20 (task a1201078) e os testes abaixo
 * existem para que elas não voltem:
 *
 *   1. o recorte deixou de ser POR VIDA do card (`hasReport`, que desarmava o
 *      watchdog no primeiro report que o card dava) e passou a ser POR
 *      EPISÓDIO (`reportedSinceWorkGranted`, desde a última vez que o card
 *      recebeu trabalho). A regressão está travada explicitamente.
 *   2. o FATO DE TURNO entra como precisão onde existe (`declaredIdle`), e o
 *      piso de atividade continua respondendo onde ele não existe — porque o
 *      fato de turno NÃO alcança os cards bash+commandcode, que é onde as
 *      falhas acontecem (ver o cabeçalho do módulo).
 */

describe("idle-without-report-decision — SINAL 3 gate", () => {
  it("floor matches the activity-bar silence-as-work ceiling (180s), not card_status's 5s", () => {
    expect(IDLE_WITHOUT_REPORT_MS).toBe(180_000);
    expect(IDLE_WITHOUT_REPORT_MS).toBe(ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS);
    expect(IDLE_WITHOUT_REPORT_POLL_MS).toBe(5_000);
  });

  // Sem NENHUM fato de report: cada teste monta o que quer provar (o
  // absoluto deprecado, o por-episódio, ou os dois para testar precedência).
  const base = {
    alive: true,
    waitingOnConsent: false,
    hasLinkedRunningTask: true,
    alreadyNotified: false,
    msSinceLastActivity: IDLE_WITHOUT_REPORT_MS,
  };

  it("notify only when alive, linked, no report this episode, past floor, not waiting, not yet notified", () => {
    // SEM fato de turno (`declaredIdle` ausente) e sem prova de leitor ausente:
    // o silêncio é INFERIDO, e a ação carrega isso (task 14b8b224, caso (b)).
    expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, hasAgentReader: true })).toEqual({
      action: "notify_unproven",
    });
  });

  it("turno DECLARADO encerrado + nenhum report → a acusação, sustentada pelo fato que o card emitiu", () => {
    // `declaredIdle` é o `turn_end` que o próprio card mandou (hoje: hook Stop do
    // claude). Aqui acusar não é palpite: o card DISSE que parou e não reportou.
    // E é o único caso em que a frase antiga ("idle without calling report.") vale.
    expect(
      decideIdleWithoutReport({
        ...base,
        reportedSinceWorkGranted: false,
        hasAgentReader: true,
        declaredIdle: true,
      }),
    ).toEqual({ action: "notify" });
  });

  it("o silêncio INFERIDO não é acusação: a mesma entrada sem fato de turno vira a frase factual", () => {
    // A distinção que o segundo falso positivo exigiu: o app não sabe separar
    // "esperando instrução" de "morreu calado" olhando o card — então não afirma.
    const comFato = decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, hasAgentReader: true, declaredIdle: true });
    const semFato = decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, hasAgentReader: true });
    expect(comFato).not.toEqual(semFato);
    expect(semFato).toEqual({ action: "notify_unproven" });
  });

  it("never notifies a card waiting on consent", () => {
    expect(decideIdleWithoutReport({ ...base, waitingOnConsent: true })).toEqual({
      action: "skip",
      reason: "waiting_consent",
    });
  });

  it("false positive guard: reported THIS episode + idle waiting for follow-up is skipped", () => {
    expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: true })).toEqual({
      action: "skip",
      reason: "reported_this_episode",
    });
  });

  /**
   * A REGRESSÃO QUE ABRIU A TASK, na forma que o portão conhece hoje: o
   * recorte é o EPISÓDIO, e o portão não tem (nem aceita) nenhum fato
   * "reportou na vida" que pudesse desarmá-lo. Um card que reportou antes e
   * recebeu trabalho NOVO sem reportar é notificado de novo — era exatamente
   * este caso que passava batido: seis vezes num dia, duas no card que
   * escreveu este arquivo.
   *
   * O fato absoluto (`hasReport`) existiu como ENTRADA DEPRECADA por uma
   * janela datada e foi REMOVIDO quando a fiação da âncora entrou; o teste
   * abaixo usa a entrada e não compila mais se alguém tentar ressuscitá-la.
   */
  it("episódio novo sem report → notifica, mesmo que o card já tenha reportado antes", () => {
    // Este teste é sobre a ÂNCORA (o episódio), não sobre a prova do silêncio:
    // fixo `declaredIdle` para exercitar o caminho em que a acusação é
    // sustentada por um fato de turno que o card emitiu. Sem esse fato, a
    // resposta do mesmo episódio é a factual (`notify_unproven`) — ver o bloco
    // do silêncio inferido.
    expect(
      decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, declaredIdle: true }),
    ).toEqual({ action: "notify" });
  });

  it("episódio COM report → skip, mesmo sem nenhum report anterior na vida do card", () => {
    expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: true })).toEqual({
      action: "skip",
      reason: "reported_this_episode",
    });
  });

  /**
   * O CAMINHO DO FATO DE TURNO (precisão onde ele existe): turno declarado
   * encerrado, sem saída depois → notifica SEM esperar o piso, e nem precisa
   * do relógio de bytes — o fato é declarado, não inferido.
   */
  it("turno DECLARADO (declaredIdle) notifica na hora, sem piso e sem relógio de bytes", () => {
    expect(decideIdleWithoutReport({ ...base, declaredIdle: true, msSinceLastActivity: 0 })).toEqual({
      action: "notify",
    });
    expect(decideIdleWithoutReport({ ...base, declaredIdle: true, msSinceLastActivity: null })).toEqual({
      action: "notify",
    });
  });

  it("sem fato de turno, o piso continua decidindo (é o único sinal que sobra)", () => {
    expect(decideIdleWithoutReport({ ...base, declaredIdle: false, msSinceLastActivity: 0 })).toEqual({
      action: "skip",
      reason: "not_idle_long_enough",
    });
  });

  it("só cards com task linkada não-julgamento qualificam", () => {
    expect(decideIdleWithoutReport({ ...base, hasLinkedRunningTask: false })).toEqual({
      action: "skip",
      reason: "no_linked_running_task",
    });
  });

  it("once-only: already notified this episode → skip", () => {
    expect(decideIdleWithoutReport({ ...base, alreadyNotified: true })).toEqual({
      action: "skip",
      reason: "already_notified",
    });
  });

  it("a ordem dos portões é estável: consentimento e report vêm antes de task/once e de qualquer relógio", () => {
    // Um card esperando consentimento não é cutucado nem com tudo o mais armado.
    expect(
      decideIdleWithoutReport({
        ...base,
        waitingOnConsent: true,
        declaredIdle: true,
        msSinceLastActivity: null,
      }),
    ).toEqual({ action: "skip", reason: "waiting_consent" });
    // Relato deste episódio vence o fato de turno: o card já cumpriu.
    expect(
      decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: true, declaredIdle: true }),
    ).toEqual({ action: "skip", reason: "reported_this_episode" });
  });

  it("below the floor (incl. card_status's 5s idle) → not yet", () => {
    for (const ms of [0, 5_000, 60_000, IDLE_WITHOUT_REPORT_MS - 1]) {
      expect(decideIdleWithoutReport({ ...base, msSinceLastActivity: ms })).toEqual({
        action: "skip",
        reason: "not_idle_long_enough",
      });
    }
  });

  it("dead card / unknown activity → skip (exit path owns death)", () => {
    expect(decideIdleWithoutReport({ ...base, alive: false })).toEqual({
      action: "skip",
      reason: "not_alive",
    });
    expect(decideIdleWithoutReport({ ...base, msSinceLastActivity: null })).toEqual({
      action: "skip",
      reason: "activity_unknown",
    });
  });

  /**
   * "CARD SEM AGENTE LENDO" NÃO É "CARD QUE NÃO REPORTOU" (task 14b8b224).
   *
   * Medido no board: quatro cards `bash` VAZIOS receberam vínculo de task e
   * foram acusados, minutos depois, de "idle without calling report" — enquanto o
   * aviso do MESMO vínculo respondia "skipped: bash has no agent reading the
   * line". A obrigação de reportar só existe para quem PODE reportar; acusar um
   * shell de não ter reportado é a contradição interna que esta task remove.
   *
   * A resposta não é "bash nunca alarma" (a saída fácil, e errada: o app
   * documenta que um TUI roda DENTRO de um card bash, e esse caso é alarme
   * legítimo) — é `hasAgentReader`, o fato que `hasAgentReadingLine`
   * (card-status-decision.ts) responde para os dois lados.
   */
  describe("sem agente lendo (hasAgentReader) — a acusação não é a única frase", () => {
    it("card de shell sem agente → NÃO acusa: o ponteiro é o outro (o vínculo está vivo, falta agente)", () => {
      expect(
        decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, hasAgentReader: false }),
      ).toEqual({ action: "notify_no_agent" });
    });

    it("card bash COM agente lendo (TUI dentro) → o silêncio dele é julgado como o de qualquer agente", () => {
      // Ser bash não decide nada: com leitor, o card entra na MESMA régua dos
      // outros. Sem fato de turno, essa régua responde a frase factual — não a
      // acusação (que só vale com turno declarado).
      expect(
        decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false, hasAgentReader: true }),
      ).toEqual({ action: "notify_unproven" });
      expect(
        decideIdleWithoutReport({
          ...base,
          reportedSinceWorkGranted: false,
          hasAgentReader: true,
          declaredIdle: true,
        }),
      ).toEqual({ action: "notify" });
    });

    it("o silêncio exige a prova EXPLÍCITA: fato ausente não silencia (volta ao erro barulhento)", () => {
      // `undefined` = ninguém informou. Tratar ausência como "sem leitor"
      // trocaria um alarme errado por um alarme que SOME — e o segundo é pior:
      // um watchdog que não vigia entrega menos que watchdog nenhum.
      // Sem fato de turno junto, a resposta é a INFERIDA (factual), não a
      // acusação: o que não se perde é o SINAL.
      expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false })).toEqual({
        action: "notify_unproven",
      });
      expect(
        decideIdleWithoutReport({
          ...base,
          reportedSinceWorkGranted: false,
          hasAgentReader: undefined as unknown as boolean,
        }),
      ).toEqual({ action: "notify_unproven" });
    });

    it("o piso continua valendo para o card sem agente — vincular é o fluxo NORMAL, não um aviso imediato", () => {
      // Quem prepara cards e vincula ANTES de subir o CLI não pode receber o
      // aviso no mesmo segundo. O momento útil é "passou o piso e ninguém leu".
      expect(
        decideIdleWithoutReport({
          ...base,
          reportedSinceWorkGranted: false,
          hasAgentReader: false,
          msSinceLastActivity: IDLE_WITHOUT_REPORT_MS - 1,
        }),
      ).toEqual({ action: "skip", reason: "not_idle_long_enough" });
    });

    it("os portões anteriores continuam vencendo: report deste episódio, consentimento e task", () => {
      expect(
        decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: true, hasAgentReader: false }),
      ).toEqual({ action: "skip", reason: "reported_this_episode" });
      expect(
        decideIdleWithoutReport({ ...base, waitingOnConsent: true, hasAgentReader: false }),
      ).toEqual({ action: "skip", reason: "waiting_consent" });
      expect(
        decideIdleWithoutReport({
          ...base,
          reportedSinceWorkGranted: false,
          hasAgentReader: false,
          hasLinkedRunningTask: false,
        }),
      ).toEqual({ action: "skip", reason: "no_linked_running_task" });
    });

    it("turno DECLARADO encerrado sem leitor também não acusa (a frase segue o leitor, não o relógio)", () => {
      expect(
        decideIdleWithoutReport({
          ...base,
          reportedSinceWorkGranted: false,
          hasAgentReader: false,
          declaredIdle: true,
        }),
      ).toEqual({ action: "notify_no_agent" });
    });
  });
});
