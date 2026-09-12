import { describe, it, expect } from "vitest";
import { decideStatusWrite } from "../../src/main/status-write-decision";

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
