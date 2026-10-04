import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import { midTurnQueueAutoDelivers, providerCapacity } from "../../src/main/providers";
import { decideSubmitCheck, shouldSteerAfterPark } from "../../src/main/type-and-submit-decision";

/**
 * DEFEITO MEDIDO (2026-10-04, board 64): toda `send_to_card` do orquestrador
 * para um card commandcode ocupado virava, para o remetente, um aviso tardio
 * falso (o texto estava ACEITO na fila da própria TUI):
 *
 *   Queued (1)
 *   › [de: Master] Do orquestrador — …
 *
 * e o agente o recebia ao terminar o passo. A `capacity.delivery.midTurnQueue`
 * já existia (cursor, cline); faltava ao commandcode. Diferença do cursor: a
 * fila do commandcode SE ENTREGA SOZINHA ao fim do turno — não há tecla de
 * steer. `steerKey` ausente é esse fato (nunca uma tecla cega).
 */

// A chrome mediana real: "Queued (N)" seguida da linha "› " com o início do texto.
const COMMANDCODE_QUEUED = [
  "✻ Working on it…",
  "  Queued (1)",
  "  › [de: Master] rode a task e reporte",
].join("\n");
const BEFORE = "✻ Working on it…";

describe("commandcode: a fila de mid-turn é MEDIDA e SEM tecla de steer", () => {
  beforeAll(() => {
    // O mesmo boot do app: lê `data/providers.builtin.json` para o registro.
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-cc-midturn-")));
  });

  it("declara `midTurnQueue` com o padrão medido, e SEM `steerKey` (fila autoentregue)", () => {
    const mq = providerCapacity("commandcode")?.delivery.midTurnQueue;
    expect(mq?.parkedPattern).toBeInstanceOf(RegExp);
    expect(mq?.steerKey).toBeUndefined();
    expect(midTurnQueueAutoDelivers(mq)).toBe(true);
  });

  it("a chrome 'Queued (N) › texto' vira `parked`, e NENHUMA tecla é pressionada", () => {
    const mq = providerCapacity("commandcode")!.delivery.midTurnQueue!;
    const result = decideSubmitCheck({
      screenText: COMMANDCODE_QUEUED,
      screenTextBeforeWrite: BEFORE,
      sentNeedle: "[de: Master] rode a task e reporte",
      hasNewActivitySinceWrite: true,
      submitStartedPattern: undefined,
      midTurnParkedPattern: mq.parkedPattern,
      targetRole: "agent",
      readlineAccepted: null,
    });
    expect(result).toBe("parked");
    // Mesmo com `steer:true` (o default do send_to_card), NÃO há tecla: a fila
    // se entrega sozinha — a regra do dono é nunca um Enter cego.
    expect(shouldSteerAfterPark({ result, steer: true, steerKey: mq.steerKey })).toBe(false);
  });

  it("(d) o cursor continua com steer declarado — parked + 1 tecla", () => {
    const cursor = providerCapacity("cursor")!.delivery.midTurnQueue!;
    expect(cursor.steerKey).toBe("\r");
    expect(midTurnQueueAutoDelivers(cursor)).toBe(false);
    expect(shouldSteerAfterPark({ result: "parked", steer: true, steerKey: cursor.steerKey })).toBe(true);
  });
});
