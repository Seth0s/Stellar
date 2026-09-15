import { describe, it, expect } from "vitest";
import { decideConnectorMotion } from "../../src/renderer/src/connector-motion-decision";

describe("connector-motion-decision — marcha do traço de conector", () => {
  it("board parado sem agente vivo e sem task running → não anima (o caso medido a 11%)", () => {
    expect(decideConnectorMotion({ anyLiveAgentCard: false, anyTaskRunning: false })).toBe(false);
  });

  it("agente vivo segura a animação (mesmo ocioso no prompt — barato, e é o cue 'board vivo')", () => {
    expect(decideConnectorMotion({ anyLiveAgentCard: true, anyTaskRunning: false })).toBe(true);
  });

  it("task em running segura a animação mesmo sem terminal aberto", () => {
    expect(decideConnectorMotion({ anyLiveAgentCard: false, anyTaskRunning: true })).toBe(true);
  });

  it("conector não anima por causa de card estático (sticky/files) sem nenhuma produção", () => {
    expect(decideConnectorMotion({ anyLiveAgentCard: false, anyTaskRunning: false })).toBe(false);
  });
});
