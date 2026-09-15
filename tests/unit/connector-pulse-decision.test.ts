import { describe, it, expect } from "vitest";
import {
  decideConnectorPulse,
  connectorPulseFrames,
  type PulsePoint,
} from "../../src/renderer/src/connector-pulse-decision";

describe("decideConnectorPulse — só trabalho vivo pulsa", () => {
  const liveAgent = {
    connectorKind: "spawned",
    toCardKind: "terminal",
    toCardProvider: "claude",
    toCardLive: true,
  };

  it("conector spawned para um card de agente VIVO → pulsa", () => {
    expect(decideConnectorPulse(liveAgent)).toBe(true);
  });

  it("conector spawned para terminal bash (não é agente) → não pulsa", () => {
    expect(decideConnectorPulse({ ...liveAgent, toCardProvider: "bash" })).toBe(false);
  });

  it("conector spawned para agente já error/exited → não pulsa", () => {
    expect(decideConnectorPulse({ ...liveAgent, toCardLive: false })).toBe(false);
  });

  it("conector spawned para destino que não é terminal → não pulsa", () => {
    expect(decideConnectorPulse({ ...liveAgent, toCardKind: "sticky", toCardProvider: null })).toBe(
      false,
    );
  });

  it("conector depends/context/manual para agente vivo → não pulsa (só spawned é linhagem de trabalho)", () => {
    expect(decideConnectorPulse({ ...liveAgent, connectorKind: "depends" })).toBe(false);
    expect(decideConnectorPulse({ ...liveAgent, connectorKind: "context" })).toBe(false);
    expect(decideConnectorPulse({ ...liveAgent, connectorKind: null })).toBe(false);
    expect(decideConnectorPulse({ ...liveAgent, connectorKind: "manual" })).toBe(false);
  });
});

describe("connectorPulseFrames — amostragem do caminho por transform", () => {
  // Bézier com o controle sobre a própria reta = reta: resultado exato,
  // sem tolerância de arco.
  const straightStart: PulsePoint = { x: 0, y: 0 };
  const straightControl: PulsePoint = { x: 50, y: 0 };
  const straightEnd: PulsePoint = { x: 100, y: 0 };

  it("começa no start, termina no end e cobre offset 0..1", () => {
    const frames = connectorPulseFrames(straightStart, straightControl, straightEnd, 5);
    expect(frames).toHaveLength(5);
    expect(frames[0]).toEqual({ offset: 0, x: 0, y: 0 });
    expect(frames[4]).toEqual({ offset: 1, x: 100, y: 0 });
    expect(frames.map((f) => f.offset)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("num caminho reto, espaça os frames por igual (velocidade constante)", () => {
    const frames = connectorPulseFrames(straightStart, straightControl, straightEnd, 5);
    const xs = frames.map((f) => f.x);
    expect(xs).toEqual([0, 25, 50, 75, 100]);
  });

  it("num caminho curvo, os passos consecutivos têm comprimento ~igual (reparametrizado por arco)", () => {
    const start: PulsePoint = { x: 0, y: 0 };
    const control: PulsePoint = { x: 60, y: 120 };
    const end: PulsePoint = { x: 200, y: 0 };
    const frames = connectorPulseFrames(start, control, end, 21);
    const steps: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      steps.push(Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y));
    }
    const max = Math.max(...steps);
    const min = Math.min(...steps);
    expect(max - min).toBeLessThan(max * 0.05);
  });

  it("cada frame cai sobre a Bézier (bate com B(t) para o t implícito)", () => {
    const start: PulsePoint = { x: 0, y: 0 };
    const control: PulsePoint = { x: 60, y: 120 };
    const end: PulsePoint = { x: 200, y: 0 };
    const frames = connectorPulseFrames(start, control, end, 9);
    // Reconstrói o t paramétrico resolvendo B_x(t) = f.x por bisseção
    // (B_x é estritamente crescente neste caminho) e confere B_y(t) = f.y.
    for (const f of frames) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const mt = 1 - mid;
        const bx = mt * mt * start.x + 2 * mt * mid * control.x + mid * mid * end.x;
        if (bx < f.x) lo = mid;
        else hi = mid;
      }
      const tm = (lo + hi) / 2;
      const mtm = 1 - tm;
      const by = mtm * mtm * start.y + 2 * mtm * tm * control.y + tm * tm * end.y;
      expect(Math.abs(by - f.y)).toBeLessThan(1e-6);
    }
  });

  it("caminho degenerado (comprimento zero) → sem frames, o chamador não anima", () => {
    const p: PulsePoint = { x: 10, y: 10 };
    expect(connectorPulseFrames(p, p, p, 10)).toEqual([]);
  });

  it("frameCount abaixo de 2 é clampeado para 2 (offset 0 e 1 sempre existem)", () => {
    const frames = connectorPulseFrames(straightStart, straightControl, straightEnd, 1);
    expect(frames).toHaveLength(2);
    expect(frames[0].offset).toBe(0);
    expect(frames[1].offset).toBe(1);
  });
});
