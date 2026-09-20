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
    expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false })).toEqual({ action: "notify" });
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
    expect(decideIdleWithoutReport({ ...base, reportedSinceWorkGranted: false })).toEqual({
      action: "notify",
    });
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
});
