import { describe, expect, it } from "vitest";

const CLAUDE_PATTERN = /\b(Working|Thinking)\b/i;
const CURSOR_PATTERN = /[\u2800-\u28FF]\s*(?:Running|Reading|Grepping)\b/i;
import {
  decideWriteReadiness,
  decideSubmitCheck,
  decideDeliveryGate,
  inspectDeliveryHold,
  renewsHumanInputGateClock,
  shouldPressEnterOnAttempt,
  deliveryWriteOpensTurn,
  looksLikeSubmitStarted,
  needleVisibleOnScreen,
  composerClearSequence,
  wrapBracketedPaste,
  deliveryTextBytes,
  submitStartedAppearedSince,
  appearedSinceBaseline,
  updateBracketedPasteMode,
  initialBracketedPasteModeState,
  incompletePrivateModeSuffix,
  HUMAN_INPUT_GATE_MAX_AGE_MS,
  WRITE_READY_QUIET_MS,
  WRITE_READY_MAX_WAIT_MS,
  SUBMIT_STARTED_PATTERN,
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
  it("needle longo: match em qualquer lugar; curto: só no tail", () => {
    expect(needleVisibleOnScreen("history consertar o roteamento do push here", "consertar o roteamento")).toBe(true);
    expect(needleVisibleOnScreen("ok is buried above\n\n\n\n\n\n> ", "ok")).toBe(false);
    expect(needleVisibleOnScreen("line1\nline2\n> ok", "ok")).toBe(true);
  });

  it("delta: Working só conta se a contagem sobe vs baseline", () => {
    expect(submitStartedAppearedSince("agent said Working yesterday", "agent said Working yesterday\n> chip", CLAUDE_PATTERN)).toBe(false);
    expect(submitStartedAppearedSince("idle prompt", "→ brief\n  Working", CLAUDE_PATTERN)).toBe(true);
  });

  it("rodada 4: scroll troca Working velho por novo (contagem flat) → ainda é appeared", () => {
    const before = [
      "prose Working yesterday",
      "follow-ups",
      "  ○ [Pasted text #1 +3 lines]",
      "enter steer · ↑ select",
      "ready",
      "ready",
      "ready",
      "> ",
    ].join("\n");
    const after = [
      "follow-ups",
      "  ○ [Pasted text #1 +3 lines]",
      "enter steer · ↑ select",
      "ready",
      "ready",
      "→ brief was submitted",
      "  Working",
      "[Pasted text #2 +14 lines]",
    ].join("\n");
    expect(appearedSinceBaseline(before, after, CLAUDE_PATTERN)).toBe(true);
    expect(submitStartedAppearedSince(before, after, CLAUDE_PATTERN)).toBe(true);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("sent");
  });

  it("rodada 4: scroll + needle no histórico não vira unsent (não reenvia Enter)", () => {
    const before = ["  Working", "old", "old", "old", "old", "old", "old", "> "].join("\n");
    const after = [
      "old",
      "old",
      "old",
      "old",
      "old",
      "Task briefing long enough is here",
      "  Working",
      "> ",
    ].join("\n");
    expect(submitStartedAppearedSince(before, after, CLAUDE_PATTERN)).toBe(true);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("sent");
  });

  it("review A: timer [10s]→[11s] no mesmo Working NÃO é appeared (não marca sent)", () => {
    const before = "task running\n[10s] Working\n> ";
    const after = "task running\n[11s] Working\n[Pasted text #2 +14 lines]";
    expect(appearedSinceBaseline(before, after, CLAUDE_PATTERN)).toBe(false);
    expect(submitStartedAppearedSince(before, after, CLAUDE_PATTERN)).toBe(false);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("unsent"); // paste chip still in composer — retry Enter
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



  it("Working NOVO na tela => sent mesmo com needle (eco no histórico)", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "→ consertar o roteamento do push\n  Working",
        submitStartedPattern: CLAUDE_PATTERN,
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
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("unsent");
  });



  it("Working + Pasted text com Working NOVO => sent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "→ [Pasted text #2 +14 lines]\n  Working",
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("sent");
  });

  it("needle visível SEM submit-started novo => unsent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenText: "> consertar o roteamento do push",
        hasNewActivitySinceWrite: true,
        submitStartedPattern: CLAUDE_PATTERN,
      }),
    ).toBe("unsent");
  });

  it("needle ausente sem atividade => unknown (boot)", () => {
    expect(decideSubmitCheck({ ...base, screenText: "", hasNewActivitySinceWrite: false, submitStartedPattern: CLAUDE_PATTERN })).toBe("unknown");
    expect(decideSubmitCheck({ ...base, screenText: "Loading codex...", hasNewActivitySinceWrite: false, submitStartedPattern: CLAUDE_PATTERN })).toBe("unknown");
  });

  it("needle ausente com atividade + Thinking novo => sent", () => {
    expect(
      decideSubmitCheck({
        ...base,
        screenTextBeforeWrite: "> ",
        screenText: "> Thinking...",
        hasNewActivitySinceWrite: true,
        submitStartedPattern: CLAUDE_PATTERN,
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

describe("deliveryWriteOpensTurn", () => {
  it("só o corpo da entrega abre o turno; Enter de retentativa e limpeza não", () => {
    expect(deliveryWriteOpensTurn("body")).toBe(true);
    expect(deliveryWriteOpensTurn("enter")).toBe(false);
    expect(deliveryWriteOpensTurn("composer_clear")).toBe(false);
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
      prevFixed = decideSubmitCheck({ ...needle, screenText: screens[i]!, submitStartedPattern: CLAUDE_PATTERN });
      if (prevFixed === "sent") break;
    }
    expect(fixedPresses).toBe(1);
    expect(prevFixed).toBe("sent");
  });

  it("investigação: chip preso no compositor (novo chip no tail) => devolve unsent e dispara 4 Enters", () => {
    // Comportamento atualizado: sem follow-ups.
    // O baseline tinha um chip (pode ser velho)
    const before = [
      "  → [Pasted text #1 +10 lines]",
      "enter steer · ↑ select/edit · esc cancel",
    ].join("\n");

    // Depois, um NOVO chip aparece no compositor (na cauda da tela), e não há sinal de Running.
    // Isso significa que a entrega está presa no compositor (Enter foi engolido).
    const after = [
      "  → [Pasted text #1 +10 lines]",
      "enter steer · ↑ select/edit · esc cancel",
      "[Pasted text #2 +14 lines]",
    ].join("\n");

    const input: SubmitCheckInput = {
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "consertar o roteamento",
      hasNewActivitySinceWrite: true,
      submitStartedPattern: CURSOR_PATTERN,
    };

    // Agora, como o chip "Pasted text" está no TAIL (últimas 6 linhas), a função devolve "unsent".
    const decision = decideSubmitCheck(input);
    expect(decision).toBe("unsent");

    let prevResult: "sent" | "unsent" | "unknown" | null = null;
    let enterCount = 0;
    const enterDecisions: boolean[] = [];

    for (let attempt = 0; attempt < 4; attempt++) {
      const willPress = shouldPressEnterOnAttempt(attempt, prevResult);
      enterDecisions.push(willPress);
      if (willPress) enterCount++;
      prevResult = decideSubmitCheck(input);
      if (prevResult === "sent") break;
    }

    expect(enterDecisions).toEqual([true, true, true, true]);
    expect(enterCount).toBe(4);
    expect(prevResult).toBe("unsent");
  });

  it("investigação: chip velho no histórico (fora do tail) e sem chip novo no compositor => não retenta", () => {
    // Esse é o conserto da linha 330.
    // Baseline tem um chip
    const before = [
      "  → [Pasted text #1 +10 lines]",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "enter steer",
    ].join("\n");
    
    // Após tentar submeter, o texto novo sumiu (foi consumido), mas não gerou sinal afirmativo ainda.
    // O chip velho continua lá em cima (fora das 6 últimas linhas).
    const after = [
      "  → [Pasted text #1 +10 lines]",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "old",
      "enter steer",
      "loading...",
    ].join("\n");

    const decision = decideSubmitCheck({
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "novo texto muito longo",
      hasNewActivitySinceWrite: true,
      submitStartedPattern: CURSOR_PATTERN,
    });
    // Como o chip está fora do tail, ele não dispara o fallback de "unsent".
    // E como o needle sumiu da tela e há nova atividade, ele passa a devolver "sent" (ou unknown se falso).
    // Neste caso, como a atividade é true e needleVisible é false, devolve "sent".
    expect(decision).toBe("sent");
  });

  it("investigação caso Cursor real: histórico tem chip e Cursor está rodando tool (agora Running faz parte do vocabulário) => sent", () => {
    // A medição ao vivo derrubou o follow-ups e trouxe o vocabulário real:
    const before = [
      "  → [Pasted text #1 +50 lines]",
      "  → Add a follow-up                                 ctrl+c to stop",
    ].join("\n");

    // Entrega 2 envia mensagem. O Cursor aceita e atualiza o estado com um spinner.
    // Note que o chip antigo e o spinner Running estão na tela.
    const after = [
      "  → [Pasted text #1 +50 lines]",
      " ⠠⠜ Running  40 tokens",
      "  → Add a follow-up                                 ctrl+c to stop",
    ].join("\n");

    const decision = decideSubmitCheck({
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "nova instrução de teste",
      hasNewActivitySinceWrite: true,
      submitStartedPattern: CURSOR_PATTERN,
    });

    // 1. followUpsAppearedSince foi removido (padrão morto).
    // 2. submitStartedAppearedSince AGORA detecta "Running" novo e retorna "sent"!
    // 3. A linha 330 nem é alcançada, consertando o bug original de múltiplos Enters e retentativas falsas.
    expect(decision).toBe("sent");
  });
});

describe("wrapBracketedPaste / deliveryTextBytes / composerClearSequence", () => {
  it("envolve com CSI 200~ / 201~", () => {
    expect(wrapBracketedPaste("hello")).toBe("\x1b[200~hello\x1b[201~");
  });

  it("só envelopa quando o peer pediu 2004h — na dúvida manda cru", () => {
    expect(deliveryTextBytes("ok")).toBe("ok");
    expect(deliveryTextBytes("[de: X] aviso curto")).toBe("[de: X] aviso curto");
    // Blind wrap was the rodada-4 poison: multi/long without DECSET → raw.
    expect(deliveryTextBytes("line1\nline2")).toBe("line1\nline2");
    expect(deliveryTextBytes("x".repeat(120))).toBe("x".repeat(120));
    expect(deliveryTextBytes("line1\nline2", false)).toBe("line1\nline2");
    expect(deliveryTextBytes("line1\nline2", true)).toBe("\x1b[200~line1\nline2\x1b[201~");
    expect(deliveryTextBytes("x".repeat(120), true)).toBe(`\x1b[200~${"x".repeat(120)}\x1b[201~`);
    expect(deliveryTextBytes("ok", true)).toBe("ok");
  });

  it("é Ctrl+U duas vezes — limpa linha pendente sem Ctrl+C", () => {
    expect(composerClearSequence()).toBe("\x15\x15");
  });
});

describe("updateBracketedPasteMode (DECSET 2004)", () => {
  it("liga com 2004h, desliga com 2004l, inclusive em modos combinados", () => {
    let state = initialBracketedPasteModeState();
    expect(state.enabled).toBe(false);
    state = updateBracketedPasteMode(state, "boot\x1b[?2004h");
    expect(state.enabled).toBe(true);
    state = updateBracketedPasteMode(state, "\x1b[?1000;2004l");
    expect(state.enabled).toBe(false);
    state = updateBracketedPasteMode(state, "\x1b[?1;2004;1000h");
    expect(state.enabled).toBe(true);
  });

  it("recompõe sequência partida entre chunks via carry", () => {
    let state = initialBracketedPasteModeState();
    state = updateBracketedPasteMode(state, "hello\x1b[?");
    expect(state.enabled).toBe(false);
    expect(incompletePrivateModeSuffix(state.carry + "")).toBeTruthy();
    state = updateBracketedPasteMode(state, "2004hworld");
    expect(state.enabled).toBe(true);
  });

  it("ignora outros DECSET e começa desligado (na dúvida, cru)", () => {
    const state = updateBracketedPasteMode(initialBracketedPasteModeState(), "\x1b[?25l\x1b[?1000h");
    expect(state.enabled).toBe(false);
  });

  it("review B: RIS (ESC c) e DECSTR (CSI ! p) desligam o modo", () => {
    let state = updateBracketedPasteMode(initialBracketedPasteModeState(), "\x1b[?2004h");
    expect(state.enabled).toBe(true);
    state = updateBracketedPasteMode(state, "redraw\x1bc");
    expect(state.enabled).toBe(false);
    state = updateBracketedPasteMode(state, "\x1b[?2004h");
    expect(state.enabled).toBe(true);
    state = updateBracketedPasteMode(state, "soft\x1b[!p");
    expect(state.enabled).toBe(false);
  });

  it("review B: RIS depois 2004h no mesmo chunk reabilita (ordem do stream)", () => {
    let state = updateBracketedPasteMode(initialBracketedPasteModeState(), "\x1b[?2004h");
    state = updateBracketedPasteMode(state, "\x1bc\x1b[?2004h");
    expect(state.enabled).toBe(true);
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

describe("inspectDeliveryHold", () => {
  const ready = { action: "proceed" as const, reason: "quiet" as const };
  const tuiWait = { action: "wait" as const };
  const humanWait = { action: "wait" as const, reason: "human-input" as const };
  const gateOpen = { action: "proceed" as const, reason: "empty" as const };

  it("tecla humana recente vence TUI ocupada e fila à frente", () => {
    expect(inspectDeliveryHold({ writeReadiness: tuiWait, deliveryGate: humanWait, queueAhead: true })).toBe(
      "human-input",
    );
  });

  it("TUI ainda subindo, sem humano => card-busy", () => {
    expect(inspectDeliveryHold({ writeReadiness: tuiWait, deliveryGate: gateOpen, queueAhead: false })).toBe("card-busy");
  });

  it("outra entrega já na FIFO => card-busy", () => {
    expect(inspectDeliveryHold({ writeReadiness: ready, deliveryGate: gateOpen, queueAhead: true })).toBe("card-busy");
  });

  it("nada segurando => undefined", () => {
    expect(inspectDeliveryHold({ writeReadiness: ready, deliveryGate: gateOpen, queueAhead: false })).toBeUndefined();
  });
});

describe("renewsHumanInputGateClock", () => {
  it("tecla humana renova; delivery não", () => {
    expect(renewsHumanInputGateClock("human")).toBe(true);
    expect(renewsHumanInputGateClock("delivery")).toBe(false);
  });
});
