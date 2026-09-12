import { describe, it, expect } from "vitest";
import {
  ACTIVITY_IDLE_MS,
  ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS,
  decideTerminalActivity,
  initialTerminalActivity,
  type TerminalActivityState,
} from "../../src/renderer/src/terminal-activity-decision";

const SIGNAL = true;
const NO_SIGNAL = false;

function apply(state: TerminalActivityState, event: Parameters<typeof decideTerminalActivity>[1], hasSignal = SIGNAL) {
  return decideTerminalActivity(state, event, hasSignal);
}

describe("decideTerminalActivity — barra depois do fim do turno", () => {
  it("turn_complete, depois byte solto: a barra apaga e não reacende", () => {
    let state = initialTerminalActivity();
    state = apply(state, "data").next;
    expect(state.isActive).toBe(true);

    const ended = apply(state, "turn_complete");
    expect(ended.next).toEqual({ isActive: false, signalProven: true, turnOpen: false });
    expect(ended.armIdleMs).toBeNull();

    // O caso fotografado / reintroduzido por 82d8e39: prompt, spinner,
    // toast da CLI depois do Stop. Sem janela aberta, dado não é turno.
    const stray = apply(ended.next, "data");
    expect(stray.next.isActive).toBe(false);
    expect(stray.next.turnOpen).toBe(false);
    expect(stray.next.signalProven).toBe(true);
    expect(stray.armIdleMs).toBeNull();
  });

  it("vários bytes soltos depois do fim continuam sem reacender e sem armar timer", () => {
    let state = apply(apply(initialTerminalActivity(), "data").next, "turn_complete").next;
    for (let i = 0; i < 5; i++) {
      const r = apply(state, "data");
      expect(r.next.isActive).toBe(false);
      expect(r.armIdleMs).toBeNull();
      state = r.next;
    }
  });

  it("entrada nova depois do fim reabre; silêncio não arma timer (ferramenta lenta)", () => {
    const idle = apply(apply(initialTerminalActivity(), "data").next, "turn_complete").next;

    const opened = apply(idle, "input");
    expect(opened.next.isActive).toBe(true);
    expect(opened.next.turnOpen).toBe(true);
    expect(opened.armIdleMs).toBeNull();

    const midTool = apply(opened.next, "data");
    expect(midTool.next.isActive).toBe(true);
    expect(midTool.armIdleMs).toBeNull();
  });

  it("turno reaberto só apaga no próximo turn_complete, não em byte de eco", () => {
    let state = apply(apply(initialTerminalActivity(), "data").next, "turn_complete").next;
    state = apply(state, "input").next;
    state = apply(state, "data").next;
    expect(state.isActive).toBe(true);

    const done = apply(state, "turn_complete");
    expect(done.next.isActive).toBe(false);
    expect(done.next.turnOpen).toBe(false);

    expect(apply(done.next, "data").next.isActive).toBe(false);
  });
});

describe("decideTerminalActivity — capacidade ainda não provada", () => {
  it("provider com sinal: dado arma o fallback de 180s (bootstrap, não o 900ms)", () => {
    const r = apply(initialTerminalActivity(), "data", SIGNAL);
    expect(r.next.isActive).toBe(true);
    expect(r.next.signalProven).toBe(false);
    expect(r.armIdleMs).toBe(ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS);
  });

  it("idle_timeout no bootstrap apaga sem provar o sinal", () => {
    const r = apply(apply(initialTerminalActivity(), "data").next, "idle_timeout");
    expect(r.next.isActive).toBe(false);
    expect(r.next.signalProven).toBe(false);
    expect(r.armIdleMs).toBeNull();
  });

  it("depois do timeout, dado novo reacende e rearma o bootstrap (ainda sem prova)", () => {
    const afterTimeout = apply(apply(initialTerminalActivity(), "data").next, "idle_timeout").next;
    const r = apply(afterTimeout, "data");
    expect(r.next.isActive).toBe(true);
    expect(r.next.signalProven).toBe(false);
    expect(r.armIdleMs).toBe(ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS);
  });
});

describe("decideTerminalActivity — provider sem sinal real (bash)", () => {
  it("dado sempre arma 900ms, inclusive depois de um turn_complete injetado", () => {
    const first = apply(initialTerminalActivity(), "data", NO_SIGNAL);
    expect(first.next.isActive).toBe(true);
    expect(first.armIdleMs).toBe(ACTIVITY_IDLE_MS);

    const ended = apply(first.next, "turn_complete", NO_SIGNAL);
    expect(ended.next.isActive).toBe(false);

    // bash não tem latch de sinal — silêncio curto continua sendo o off.
    const echo = apply(ended.next, "data", NO_SIGNAL);
    expect(echo.next.isActive).toBe(true);
    expect(echo.armIdleMs).toBe(ACTIVITY_IDLE_MS);
  });
});

describe("decideTerminalActivity — exit e interrupt", () => {
  it("exit apaga mesmo no meio de um turno aberto e provado", () => {
    let state = apply(apply(initialTerminalActivity(), "data").next, "turn_complete").next;
    state = apply(state, "input").next;
    const r = apply(state, "exit");
    expect(r.next.isActive).toBe(false);
    expect(r.next.turnOpen).toBe(false);
    expect(r.next.signalProven).toBe(true);
    expect(r.armIdleMs).toBeNull();
  });

  it("interrupt fecha a janela sem desfazer a prova do sinal", () => {
    let state = apply(apply(initialTerminalActivity(), "data").next, "turn_complete").next;
    state = apply(state, "input").next;
    const r = apply(state, "interrupt");
    expect(r.next.isActive).toBe(false);
    expect(r.next.turnOpen).toBe(false);
    expect(r.next.signalProven).toBe(true);
    expect(apply(r.next, "data").next.isActive).toBe(false);
  });
});
