import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import { providerCapacity } from "../../src/main/providers";
import { decideSubmitCheck, shouldSteerAfterPark } from "../../src/main/type-and-submit-decision";

/**
 * Task 9c28adde — `send_to_card` dizia "delivered" quando o brief só tinha
 * entrado na CAIXA DE MID-TURN do cline. Medido ao vivo (2026-09-23, card
 * 97924227): a entrega assentou "delivered (sent, 1 enter)" enquanto o texto
 * estava em "Queued messages: … Enter with empty input to steer first" e o
 * agente seguia noutro turno, sem as regras do brief.
 *
 * O cursor já modela isso como dado (`capacity.delivery.midTurnQueue:
 * { parkedPattern, steerKey }`). O cline é provider DINÂMICO (nasce de
 * `data/providers.builtin.json`), e a declaração dele não tinha a fila — daí
 * o veredito "delivered". Estes testes provam a DECLARAÇÃO e o EFEITO dela na
 * decisão pura, sem PTY e sem instância do app.
 */

// A chrome observada (o dono citou o texto): a caixa "Queued messages" E a
// dica "enter with empty input to steer". O padrão exige AS DUAS (como o do
// cursor exige `follow-ups` E `enter steer`), para não parquear por engano.
const CLINE_PARKED_SCREEN = [
  "│ Cline is working…                                              │",
  "│ Queued messages:                                               │",
  "│   [de: Master cc] rode a task e reporte                        │",
  "│ enter with empty input to steer first                          │",
].join("\n");

const BEFORE = "│ Cline is working…                                              │";

describe("cline: a fila de mid-turn é DADO do provider (task 9c28adde)", () => {
  beforeAll(() => {
    // O mesmo boot do app: lê `data/providers.builtin.json` para o registro.
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-cline-midturn-")));
  });

  it("o spec embutido do cline declara delivery.midTurnQueue (padrão + tecla de steer)", () => {
    const mq = providerCapacity("cline")?.delivery.midTurnQueue;
    expect(mq?.parkedPattern).toBeInstanceOf(RegExp);
    expect(mq?.steerKey).toBe("\r");
  });

  it("a caixa de fila do cline vira 'parked' (não 'sent'/'delivered'), e o steer é o gesto dela", () => {
    const mq = providerCapacity("cline")!.delivery.midTurnQueue!;
    const result = decideSubmitCheck({
      screenText: CLINE_PARKED_SCREEN,
      screenTextBeforeWrite: BEFORE,
      sentNeedle: "[de: Master cc] rode a task e reporte",
      hasNewActivitySinceWrite: true,
      submitStartedPattern: undefined,
      midTurnParkedPattern: mq.parkedPattern,
      targetRole: "agent",
      readlineAccepted: null,
    });
    expect(result).toBe("parked");
    // `steer:true` (o default do send_to_card) pressiona a tecla declarada.
    expect(shouldSteerAfterPark({ result, steer: true, steerKey: mq.steerKey })).toBe(true);
    // `steer:false` (avisos internos) NÃO pressiona — parqueia sem injetar.
    expect(shouldSteerAfterPark({ result, steer: false, steerKey: mq.steerKey })).toBe(false);
  });

  it("sem a chrome de fila, um 'Working' qualquer NÃO parqueia (não é um detector de mentira)", () => {
    const mq = providerCapacity("cline")!.delivery.midTurnQueue!;
    const result = decideSubmitCheck({
      screenText: BEFORE,
      screenTextBeforeWrite: BEFORE,
      sentNeedle: "[de: Master cc] rode a task e reporte",
      hasNewActivitySinceWrite: false,
      submitStartedPattern: undefined,
      midTurnParkedPattern: mq.parkedPattern,
      targetRole: "agent",
      readlineAccepted: null,
    });
    expect(result).not.toBe("parked");
  });
});
