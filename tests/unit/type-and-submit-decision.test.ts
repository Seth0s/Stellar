import { describe, it, expect } from "vitest";
import {
  decideWriteReadiness,
  decideSubmitCheck,
  decideDeliveryGate,
  renewsHumanInputGateClock,
  shouldPressEnterOnAttempt,
  looksLikeSubmitStarted,
  needleVisibleOnScreen,
  composerClearSequence,
  wrapBracketedPaste,
  deliveryTextBytes,
  followUpsAppearedSince,
  submitStartedAppearedSince,
  HUMAN_INPUT_GATE_MAX_AGE_MS,
  WRITE_READY_QUIET_MS,
  WRITE_READY_MAX_WAIT_MS,
  type WriteReadinessInput,
  type SubmitCheckInput,
} from "../../src/main/type-and-submit-decision";

// DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
// caixa sem submeter" + "Cards recebem a mesma task duas vezes".

describe("decideWriteReadiness", () => {
  const base: WriteReadinessInput = {
    hasReceivedData: false,
    msSinceLastActivity: 0,
    msSinceSpawn: 0,
  };

  it("nunca recebeu dado nenhum, spawn recente => wait (TUI ainda pode estar subindo)", () => {
    expect(decideWriteReadiness({ ...base, hasReceivedData: false, msSinceSpawn: 500 })).toEqual({ action: "wait" });
  });

  it("recebeu dado mas ainda dentro da janela de quiescência => wait (TUI pode estar no meio de um redraw)", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: WRITE_READY_QUIET_MS - 1, msSinceSpawn: 500 }),
    ).toEqual({ action: "wait" });
  });

  it("recebeu dado e passou da janela de quiescência => proceed/quiet", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: WRITE_READY_QUIET_MS, msSinceSpawn: 500 }),
    ).toEqual({ action: "proceed", reason: "quiet" });
  });

  it("card vivo há muito tempo e quieto => proceed/quiet imediato", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: 3_600_000, msSinceSpawn: 3_600_000 }),
    ).toEqual({ action: "proceed", reason: "quiet" });
  });

  it("nunca quieto mas já passou do teto => proceed/timeout", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: 1, msSinceSpawn: WRITE_READY_MAX_WAIT_MS }),
    ).toEqual({ action: "proceed", reason: "timeout" });
  });

  it("nunca recebeu dado e já passou do teto => proceed/timeout", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: false, msSinceLastActivity: WRITE_READY_MAX_WAIT_MS, msSinceSpawn: WRITE_READY_MAX_WAIT_MS }),
    ).toEqual({ action: "proceed", reason: "timeout" });
  });
});

describe("looksLikeSubmitStarted / needleVisibleOnScreen / delta", () => {
  it("Working/Thinking/Generating contam como resposta real, não eco", () => {
    expect(looksLikeSubmitStarted("→ brief\n  Working")).toBe(true);
    expect(looksLikeSubmitStarted("Thinking…")).toBe(true);
    expect(looksLikeSubmitStarted("Generating...")).toBe(true);
    expect(looksLikeSubmitStarted("❯ brief only, no response yet")).toBe(false);
  });

  it("needle longo: match em qualquer lugar; curto: só no tail", () => {
    expect(needleVisibleOnScreen("history consertar o roteamento do push here", "consertar o roteamento")).toBe(true);
    expect(needleVisibleOnScreen("ok is buried above\n\n\n\n\n\n> ", "ok")).toBe(false);
    expect(needleVisibleOnScreen("line1\nline2\n> ok", "ok")).toBe(true);
  });

  it("delta: Working/follow-ups só contam se a contagem sobe vs baseline", () => {
    expect(submitStartedAppearedSince("agent said Working yesterday", "agent said Working yesterday\n> chip")).toBe(false);
    expect(submitStartedAppearedSince("idle prompt", "→ brief\n  Working")).toBe(true);
    expect(followUpsAppearedSince("follow-ups\n  ○ [Pasted text #1 +2 lines]", "follow-ups\n  ○ [Pasted text #1 +2 lines]\n> new")).toBe(false);
    expect(
      followUpsAppearedSince(
        "follow-ups\n  ○ [Pasted text #1 +2 lines]",
        "follow-ups\n  ○ [Pasted text #1 +2 lines]\n  ○ [Pasted text #2 +14 lines]",
      ),
    ).toBe(true);
  });
});

describe("decideSubmitCheck", () => {
  const base: SubmitCheckInput = {
    screenText: "",
    screenTextBeforeWrite: "",
    sentNeedle: "consertar o roteamento",
    hasNewActivitySinceWrite: true,
  };

  it("paste chip no composer (sem follow-ups/Working novos) => unsent", () => {
    expect(decideSubmitCheck({ ...base, screenText: "[Pasted text #1 +40 lines]" })).toBe("unsent");
  });

  it("NOVA caixa follow-ups + Working => sent (fila real do bug — pare Enter)", () => {
    const screen = `follow-ups
  ○ [Pasted text #2 +14 lines]
  ○ [Pasted text #2 +14 lines]
  enter steer · ↑ select/edit · esc cancel
→ [Pasted text #2 +14 lines]
  Working`;
    expect(decideSubmitCheck({ ...base, screenText: screen, screenTextBeforeWrite: "Add a follow-up" })).toBe("sent");
  });

  it("Working NOVO na tela => sent mesmo com needle (eco no histórico)", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "→ consertar o roteamento do push\n  Working",
      }),
    ).toBe("sent");
  });

  it("achado 1: prosa velha com Working NÃO é sent — Enter engolido, texto preso", () => {
    const stale = "I was Working on the plan yesterday.\n> ";
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: stale,
        screenText: `${stale}[Pasted text #2 +14 lines]`,
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("unsent");
  });

  it("achado 2: follow-ups do TURNO ANTERIOR + paste novo ainda no composer => unsent", () => {
    const priorBox = `follow-ups
  ○ [Pasted text #1 +3 lines]
enter steer`;
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: priorBox,
        screenText: `${priorBox}\n[Pasted text #2 +14 lines]`,
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("unsent");
  });

  it("Working + Pasted text com Working NOVO => sent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "→ [Pasted text #2 +14 lines]\n  Working",
      }),
    ).toBe("sent");
  });

  it("needle visível SEM submit-started novo => unsent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenText: "> consertar o roteamento do push",
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("unsent");
  });

  it("needle ausente sem atividade => unknown (boot)", () => {
    expect(decideSubmitCheck({ ...base, screenText: "", hasNewActivitySinceWrite: false })).toBe("unknown");
    expect(decideSubmitCheck({ ...base, screenText: "Loading codex...", hasNewActivitySinceWrite: false })).toBe("unknown");
  });

  it("needle ausente com atividade + Thinking novo => sent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "> Thinking...",
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("sent");
  });

  it("aviso curto (ok) ainda na caixa do tail => unsent", () => {
    expect(
      decideSubmitCheck({
        screenText: "banner\n> ok",
        screenTextBeforeWrite: "banner\n> ",
        sentNeedle: "ok",
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("unsent");
  });

  it("aviso curto sumiu do tail + atividade => sent", () => {
    expect(
      decideSubmitCheck({
        screenText: "banner\n> ",
        screenTextBeforeWrite: "banner\n> ",
        sentNeedle: "ok",
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("sent");
  });
});

describe("shouldPressEnterOnAttempt", () => {
  it("tentativa 0 sempre aperta Enter", () => {
    expect(shouldPressEnterOnAttempt(0, null)).toBe(true);
    expect(shouldPressEnterOnAttempt(0, "unknown")).toBe(true);
  });

  it("depois: só unsent aperta Enter de novo", () => {
    expect(shouldPressEnterOnAttempt(1, "unsent")).toBe(true);
    expect(shouldPressEnterOnAttempt(1, "unknown")).toBe(false);
    expect(shouldPressEnterOnAttempt(1, "sent")).toBe(false);
  });

  it("simulação tela do dono com baseline vazio: 1 Enter (não 4)", () => {
    const screens = [
      `follow-ups\n  ○ [Pasted text #2 +14 lines]\n  Working`,
      `follow-ups\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  Working`,
      `follow-ups\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  Working`,
      `follow-ups\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  ○ [Pasted text #2 +14 lines]\n  → [Pasted text #2 +14 lines]`,
    ];
    const needle = { sentNeedle: "consertar", hasNewActivitySinceWrite: true, screenTextBeforeWrite: "" };

    let prevFixed: "sent" | "unsent" | "unknown" | null = null;
    let fixedPresses = 0;
    for (let i = 0; i < 4; i++) {
      if (shouldPressEnterOnAttempt(i, prevFixed)) fixedPresses++;
      prevFixed = decideSubmitCheck({ ...needle, screenText: screens[i]! });
      if (prevFixed === "sent") break;
    }
    expect(fixedPresses).toBe(1);
    expect(prevFixed).toBe("sent");
  });
});

describe("wrapBracketedPaste / deliveryTextBytes / composerClearSequence", () => {
  it("envolve com CSI 200~ / 201~", () => {
    expect(wrapBracketedPaste("hello")).toBe("\x1b[200~hello\x1b[201~");
  });

  it("só envelopa multi-linha ou texto longo — avisos curtos ficam crus", () => {
    expect(deliveryTextBytes("ok")).toBe("ok");
    expect(deliveryTextBytes("[de: X] aviso curto")).toBe("[de: X] aviso curto");
    expect(deliveryTextBytes("line1\nline2")).toBe("\x1b[200~line1\nline2\x1b[201~");
    expect(deliveryTextBytes("x".repeat(120))).toBe(`\x1b[200~${"x".repeat(120)}\x1b[201~`);
  });

  it("é Ctrl+U duas vezes — limpa linha pendente sem Ctrl+C", () => {
    expect(composerClearSequence()).toBe("\x15\x15");
  });
});

describe("decideDeliveryGate", () => {
  it("linha vazia deixa a entrega passar imediatamente", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: false, pendingHumanInputLastAtMs: null, nowMs: 10_000 }),
    ).toEqual({ action: "proceed", reason: "empty" });
  });

  it("tecla humana recente bloqueia a entrega", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputLastAtMs: 10_000, nowMs: 10_000 + HUMAN_INPUT_GATE_MAX_AGE_MS - 1 }),
    ).toEqual({ action: "wait", reason: "human-input" });
  });

  it("digitação contínua por mais de 30s NÃO libera — idade da última tecla", () => {
    const lastKeyAt = 10_000 + 90_000;
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputLastAtMs: lastKeyAt, nowMs: lastKeyAt + 1_000 }),
    ).toEqual({ action: "wait", reason: "human-input" });
  });

  it("pausa de 30s DEPOIS de digitar libera", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputLastAtMs: 10_000, nowMs: 10_000 + HUMAN_INPUT_GATE_MAX_AGE_MS }),
    ).toEqual({ action: "proceed", reason: "expired" });
  });

  it("estado antigo sem timestamp não bloqueia a fila", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputLastAtMs: null, nowMs: 10_000 }),
    ).toEqual({ action: "proceed", reason: "unknown-age" });
  });
});

describe("renewsHumanInputGateClock", () => {
  it("tecla humana renova; delivery não", () => {
    expect(renewsHumanInputGateClock("human")).toBe(true);
    expect(renewsHumanInputGateClock("delivery")).toBe(false);
  });
});
