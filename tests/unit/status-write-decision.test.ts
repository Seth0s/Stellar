import { describe, it, expect } from "vitest";
import {
  decideStatusWrite,
  decideStatusAsk,
  retainStatusAsk,
  describeStatusHeldWarning,
} from "../../src/main/status-write-decision";

const noDivergence = { existingDivergedStatus: null, existingDivergedActor: null } as const;

describe("decideStatusWrite (decisão 8 — status híbrido com precedência)", () => {
  it("criação (sem linha anterior): aplica o status proposto, sem divergência", () => {
    expect(
      decideStatusWrite({
        previousActor: null,
        previousStatus: null,
        proposedStatus: "running",
        newActor: "agent",
        ...noDivergence,
      }),
    ).toMatchObject({
      status: "running",
      statusChanged: true,
      divergedStatus: null,
      recordDeclaration: false,
      warnAgent: false,
    });
  });

  it("humano SEMPRE vence: aplica e limpa divergência", () => {
    expect(
      decideStatusWrite({
        previousActor: "agent",
        previousStatus: "running",
        proposedStatus: "done",
        newActor: "human",
        existingDivergedStatus: "failed",
        existingDivergedActor: "app",
      }),
    ).toEqual({
      status: "done",
      statusChanged: true,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    });
  });

  it("agente sobre status humano: NÃO desloca, declara, avisa, sinaliza", () => {
    expect(
      decideStatusWrite({
        previousActor: "human",
        previousStatus: "running",
        proposedStatus: "done",
        newActor: "agent",
        ...noDivergence,
      }),
    ).toEqual({
      status: "running",
      statusChanged: false,
      divergedStatus: "done",
      divergedActor: "agent",
      recordDeclaration: true,
      warnAgent: true,
      declaredStatus: "done",
    });
  });

  it("app sobre status humano: NÃO desloca, declara, sinaliza, SEM warnAgent", () => {
    expect(
      decideStatusWrite({
        previousActor: "human",
        previousStatus: "running",
        proposedStatus: "failed",
        newActor: "app",
        ...noDivergence,
      }),
    ).toMatchObject({
      status: "running",
      statusChanged: false,
      divergedStatus: "failed",
      divergedActor: "app",
      warnAgent: false,
      recordDeclaration: true,
    });
  });

  it("proposta EXPLÍCITA alinhada ao status humano: limpa divergência (card voltou a viver)", () => {
    expect(
      decideStatusWrite({
        previousActor: "human",
        previousStatus: "running",
        proposedStatus: "running",
        newActor: "app",
        existingDivergedStatus: "failed",
        existingDivergedActor: "app",
      }),
    ).toEqual({
      status: "running",
      statusChanged: false,
      divergedStatus: null,
      divergedActor: null,
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    });
  });

  it("proposedStatus null (update sem status): NÃO limpa divergência existente", () => {
    expect(
      decideStatusWrite({
        previousActor: "human",
        previousStatus: "running",
        proposedStatus: null,
        newActor: "agent",
        existingDivergedStatus: "failed",
        existingDivergedActor: "app",
      }),
    ).toEqual({
      status: "running",
      statusChanged: false,
      divergedStatus: "failed",
      divergedActor: "app",
      recordDeclaration: false,
      warnAgent: false,
      declaredStatus: null,
    });
  });

  it("proposedStatus null sem divergência prévia: permanece limpo", () => {
    expect(
      decideStatusWrite({
        previousActor: "human",
        previousStatus: "running",
        proposedStatus: null,
        newActor: "agent",
        ...noDivergence,
      }),
    ).toMatchObject({
      status: "running",
      statusChanged: false,
      divergedStatus: null,
      divergedActor: null,
    });
  });

  it("sem lock humano: app/agente sobrescrevem normalmente", () => {
    expect(
      decideStatusWrite({
        previousActor: "agent",
        previousStatus: "running",
        proposedStatus: "failed",
        newActor: "app",
        ...noDivergence,
      }),
    ).toMatchObject({ status: "failed", statusChanged: true, divergedStatus: null, warnAgent: false });
  });
});

describe("decideStatusAsk (terceiro caminho — agente pede, humano decide)", () => {
  const liveDivergence = { existingDivergedStatus: "done", existingDivergedActor: "agent" as const };

  it("pedido igual ao status atual: already, sem autoApply, divergência intacta", () => {
    expect(
      decideStatusAsk({
        currentStatus: "pending",
        requestedStatus: "pending",
        ...liveDivergence,
        boardAutonomous: false,
      }),
    ).toEqual({
      outcome: "already",
      divergedStatus: "done",
      divergedActor: "agent",
      autoApply: false,
    });
  });

  it("pedido diferente: park imediato, divergência convive, autoApply false", () => {
    expect(
      decideStatusAsk({
        currentStatus: "pending",
        requestedStatus: "done",
        ...liveDivergence,
        boardAutonomous: false,
      }),
    ).toEqual({
      outcome: "park",
      divergedStatus: "done",
      divergedActor: "agent",
      autoApply: false,
    });
  });

  it("board autônomo NÃO dispensa — autoApply continua false (decisão 4)", () => {
    expect(
      decideStatusAsk({
        currentStatus: "pending",
        requestedStatus: "done",
        existingDivergedStatus: null,
        existingDivergedActor: null,
        boardAutonomous: true,
      }),
    ).toMatchObject({ outcome: "park", autoApply: false, divergedStatus: null });
  });

  it("aviso de hold aponta o caminho novo sem recusar a escrita direta", () => {
    expect(describeStatusHeldWarning("pending", "done")).toContain("request_task_status");
    expect(describeStatusHeldWarning("pending", "done")).toContain("prevails");
  });
});

describe("retainStatusAsk", () => {
  const parked = {
    requestedStatus: "done",
    requestedReason: "protótipo aceito",
    requestedBy: "416",
    requestedAt: 10,
  };
  const cleared = {
    requestedStatus: null,
    requestedReason: null,
    requestedBy: null,
    requestedAt: null,
  };

  it("humano escreve status: limpa o pedido (decidiu)", () => {
    expect(
      retainStatusAsk({ existing: parked, newActor: "human", proposedStatus: "done", resultingStatus: "done" }),
    ).toEqual({ ask: cleared, resolvedBy: "human-status" });
  });

  it("humano edita prompt (sem status): mantém o pedido", () => {
    expect(
      retainStatusAsk({ existing: parked, newActor: "human", proposedStatus: null, resultingStatus: "pending" }),
    ).toEqual({ ask: parked, resolvedBy: null });
  });

  it("agente/app com hold (status não virou o pedido): mantém o pedido", () => {
    expect(
      retainStatusAsk({ existing: parked, newActor: "agent", proposedStatus: "done", resultingStatus: "pending" }),
    ).toEqual({ ask: parked, resolvedBy: null });
    expect(
      retainStatusAsk({ existing: parked, newActor: "app", proposedStatus: "failed", resultingStatus: "pending" }),
    ).toEqual({ ask: parked, resolvedBy: null });
  });

  it("agente/app aplicam o mesmo status pedido: encerra, resolvedBy applied-ask", () => {
    expect(
      retainStatusAsk({ existing: parked, newActor: "agent", proposedStatus: "done", resultingStatus: "done" }),
    ).toEqual({ ask: cleared, resolvedBy: "applied-ask" });
    expect(
      retainStatusAsk({ existing: parked, newActor: "app", proposedStatus: "done", resultingStatus: "done" }),
    ).toEqual({ ask: cleared, resolvedBy: "applied-ask" });
  });

  it("agente aplica outro status: não resolve ESTE pedido", () => {
    expect(
      retainStatusAsk({ existing: parked, newActor: "agent", proposedStatus: "failed", resultingStatus: "failed" }),
    ).toEqual({ ask: parked, resolvedBy: null });
  });
});
