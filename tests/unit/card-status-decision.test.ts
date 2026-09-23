import { describe, it, expect } from "vitest";
import { decideCardStatus, describeCardStatus, type CardStatusFacts } from "../../src/main/card-status-decision";

/**
 * O status do card decidido por FATOS (task 4245c6f5).
 *
 * O defeito medido: `pty-registry.ts:1004` marca `lastActivityAt` a CADA byte
 * do PTY, e `card_status` decidia só por `agora - lastActivityAt >= 5s`. Um
 * TUI parado que REPINTA (cursor piscando, linha de status) emite bytes para
 * sempre → "running" eterno, que foi o que o dono do repo viu em cinco cards
 * parados em "Ask your question...". O caminho inverso: um shell bash no
 * prompt não emite byte nenhum → "idle" em 5s, sem sentido, porque num shell
 * não existe turno.
 *
 * A regra que estes testes travam: bytes significam coisas diferentes por
 * provider, e onde não há FATO a resposta é `unknown` — nunca um palpite
 * entre running e idle, que seria plausível e errado.
 */

const NOW = 1_000_000;
const THRESHOLD = 5_000;

function facts(overrides: Partial<CardStatusFacts> = {}): CardStatusFacts {
  return {
    provider: "claude",
    alive: true,
    waitingOnConsent: false,
    lastActivityAt: NOW - THRESHOLD - 1,
    turnEndedAt: null,
    hasPendingHumanInput: false,
    now: NOW,
    idleThresholdMs: THRESHOLD,
    ...overrides,
  };
}

describe("decideCardStatus", () => {
  describe("o TUI parado que repinta (o caso observado ao vivo)", () => {
    it("saída fluindo DEPOIS do turn ended = running", () => {
      expect(
        decideCardStatus(facts({ turnEndedAt: NOW - 1_000, lastActivityAt: NOW })),
      ).toBe("running");
    });

    it("turn ended e NENHUMA saída desde então = idle, mesmo com o card repintando antes", () => {
      // O ponto do fix: `lastActivityAt` recente não segura mais o card em
      // "running" quando o turno já foi declarado encerrado.
      expect(
        decideCardStatus(facts({ turnEndedAt: NOW - 100, lastActivityAt: NOW - 200 })),
      ).toBe("idle");
    });

    it("NUNCA declarou turno e sem linha de input pendente = unknown (não escolhe)", () => {
      // O caso exato dos cinco cards: bytes fresquíssimos, nenhum fato de
      // turno. Antes isto respondia "running" para sempre.
      expect(decideCardStatus(facts({ turnEndedAt: null, lastActivityAt: NOW }))).toBe("unknown");
    });

    it("linha de input pendente é sinal POSITIVO de 'esperando você' = idle", () => {
      expect(
        decideCardStatus(facts({ turnEndedAt: null, lastActivityAt: NOW, hasPendingHumanInput: true })),
      ).toBe("idle");
    });
  });

  describe("bash: vocabulário próprio", () => {
    it("shell com bytes de repaint = NÃO DÁ PARA SABER (o caso real deste board)", () => {
      // O caso que originou a task, medido ao vivo: um card `bash` com um TUI
      // DENTRO (o dono abre cards bash à mão e digita `cmd --yolo`) repinta
      // para sempre, e é INDISTINGUÍVEL de um comando de verdade produzindo
      // saída. Antes isto respondia `running` — a mentira. Medido no board:
      // `97924083` (shell puro) responde `idle`, `97924119` (TUI dentro)
      // respondia `running`.
      const status = decideCardStatus(facts({ provider: "bash", lastActivityAt: NOW }));
      expect(status).toBe("unknown");
      expect(status).not.toBe("running");
    });

    it("shell quieto = at-prompt (o outro lado continua sólido: shell puro não repinta)", () => {
      const quiet = decideCardStatus(facts({ provider: "bash", lastActivityAt: NOW - THRESHOLD - 1 }));
      expect(quiet).toBe("at-prompt");
      expect(quiet).not.toBe("idle");
    });

    it("shell quieto com turno declarado continua at-prompt — nunca vira idle", () => {
      // Bytes recentes dariam `unknown`; o que este caso trava é o outro
      // lado: mesmo com um `turn_complete` declarado, o shell não entra no
      // vocabulário de turno.
      const status = decideCardStatus(
        facts({ provider: "bash", turnEndedAt: NOW, lastActivityAt: NOW - THRESHOLD - 1 }),
      );
      expect(status).toBe("at-prompt");
      expect(status).not.toBe("idle");
    });
  });

  describe("precedências", () => {
    it("consentimento vence tudo: card bloqueado no modal é waiting, não running", () => {
      expect(
        decideCardStatus(facts({ waitingOnConsent: true, turnEndedAt: NOW - 1_000, lastActivityAt: NOW })),
      ).toBe("waiting");
    });

    it("sem entry viva = exited", () => {
      expect(decideCardStatus(facts({ alive: false, lastActivityAt: null }))).toBe("exited");
    });

    it("sem entry viva vence até o consentimento (processo já morreu)", () => {
      expect(decideCardStatus(facts({ alive: false, waitingOnConsent: true }))).toBe("exited");
    });
  });

  describe("provider desconhecido não vira bash", () => {
    it("provider null segue o caminho de agente (unknown), nunca at-prompt", () => {
      expect(decideCardStatus(facts({ provider: null, lastActivityAt: NOW }))).toBe("unknown");
    });
  });

  describe("a frase de cada estado ENSINA (é o que o agente lê)", () => {
    it("unknown e at-prompt se explicam, e 'at-prompt' diz que não é agente", () => {
      expect(describeCardStatus("unknown")).toContain("cannot tell");
      expect(describeCardStatus("at-prompt")).toContain("not an agent");
      expect(describeCardStatus("idle")).toContain("turn ended");
    });
  });
});
