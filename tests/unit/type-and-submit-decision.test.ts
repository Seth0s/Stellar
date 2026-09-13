import { describe, it, expect } from "vitest";
import {
  decideWriteReadiness,
  decideSubmitCheck,
  decideDeliveryGate,
  renewsHumanInputGateClock,
  shouldPressEnterOnAttempt,
  deliveryWriteOpensTurn,
  looksLikeSubmitStarted,
  needleVisibleOnScreen,
  composerClearSequence,
  wrapBracketedPaste,
  deliveryTextBytes,
  followUpsAppearedSince,
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

  it("rodada 4: scroll troca Working velho por novo (contagem flat) → ainda é appeared", () => {
    // Measured failure mode: 8-line window drops old Working as new enters;
    // count stays 1, count-only delta was false → false "unsent" → duplicate.
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
    expect(appearedSinceBaseline(before, after, SUBMIT_STARTED_PATTERN)).toBe(true);
    expect(submitStartedAppearedSince(before, after)).toBe(true);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
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
    expect(submitStartedAppearedSince(before, after)).toBe(true);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
      }),
    ).toBe("sent");
  });

  it("review A: timer [10s]→[11s] no mesmo Working NÃO é appeared (não marca sent)", () => {
    // Measured failure: raw neighborhood differs only in digits → false
    // "appeared" → "sent" while Enter still needed. Digit-stabilize holds.
    const before = "task running\n[10s] Working\n> ";
    const after = "task running\n[11s] Working\n[Pasted text #2 +14 lines]";
    expect(appearedSinceBaseline(before, after, SUBMIT_STARTED_PATTERN)).toBe(false);
    expect(submitStartedAppearedSince(before, after)).toBe(false);
    expect(
      decideSubmitCheck({
        screenTextBeforeWrite: before,
        screenText: after,
        sentNeedle: "Task briefing long enough",
        hasNewActivitySinceWrite: true,
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
      prevFixed = decideSubmitCheck({ ...needle, screenText: screens[i]! });
      if (prevFixed === "sent") break;
    }
    expect(fixedPresses).toBe(1);
    expect(prevFixed).toBe("sent");
  });

  it("investigação: baseline JÁ contendo follow-ups e um chip [Pasted text], screenText com chip novo no compositor => devolve unsent e dispara 4 Enters", () => {
    // Caso exato solicitado na investigação:
    // screenTextBeforeWrite já continha a caixa de follow-ups e um chip [Pasted text #1]
    const before = [
      "follow-ups",
      "  ○ [Pasted text #1 +10 lines]",
      "enter steer · ↑ select/edit · esc cancel",
    ].join("\n");

    // screenText depois com mais um chip no compositor (sem o bullet [○●→] de item aceito na fila):
    const after = [
      "follow-ups",
      "  ○ [Pasted text #1 +10 lines]",
      "enter steer · ↑ select/edit · esc cancel",
      "[Pasted text #2 +14 lines]",
    ].join("\n");

    const input: SubmitCheckInput = {
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "consertar o roteamento",
      hasNewActivitySinceWrite: true,
    };

    // 1. O que decideSubmitCheck devolve:
    // followUpsAppearedSince: FOLLOW_UPS_HEADING_PATTERN conta 1 vs 1 (flat).
    // FOLLOW_UP_ROW_PATTERN (/[○●→]\s*\[Pasted text[^\]]*\]/gi) só casa em "○ [Pasted text #1]",
    // pois o chip novo no compositor não tem bullet [○●→]. Contagem flat: 1 vs 1.
    // submitStartedAppearedSince dá false (nenhum Working/Thinking novo).
    // Linha 330: if (/pasted text/i.test(after)) return "unsent" dispara!
    const decision = decideSubmitCheck(input);
    expect(decision).toBe("unsent");

    // 2. O que shouldPressEnterOnAttempt faz com esse resultado nas 4 voltas:
    let prevResult: "sent" | "unsent" | "unknown" | null = null;
    let enterCount = 0;
    const enterDecisions: boolean[] = [];

    for (let attempt = 0; attempt < 4; attempt++) {
      const willPress = shouldPressEnterOnAttempt(attempt, prevResult);
      enterDecisions.push(willPress);
      if (willPress) enterCount++;
      // A cada volta a tela continua contendo o chip
      prevResult = decideSubmitCheck(input);
      if (prevResult === "sent") break;
    }

    // Prova matemática do bug:
    // Tentativa 0 aperta Enter (inicial).
    // Tentativa 1 aperta Enter de novo (unsent).
    // Tentativa 2 aperta Enter de novo (unsent).
    // Tentativa 3 aperta Enter de novo (unsent).
    // Total: 4 Enters disparados!
    expect(enterDecisions).toEqual([true, true, true, true]);
    expect(enterCount).toBe(4);
    expect(prevResult).toBe("unsent");
  });

  it("investigação: se o 2º chip já tem bullet [○●→], countPatternMatches sobe e devolve sent (1 Enter)", () => {
    const before = [
      "follow-ups",
      "  ○ [Pasted text #1 +10 lines]",
      "enter steer · ↑ select/edit · esc cancel",
    ].join("\n");
    // Se o segundo chip entrar como linha com bullet na fila:
    const after = [
      "follow-ups",
      "  ○ [Pasted text #1 +10 lines]",
      "  ○ [Pasted text #2 +14 lines]",
      "enter steer · ↑ select/edit · esc cancel",
    ].join("\n");

    const decision = decideSubmitCheck({
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "consertar",
      hasNewActivitySinceWrite: true,
    });
    // Onde a leitura do código do usuário divergiu do código:
    // FOLLOW_UP_ROW_PATTERN conta 2 > 1, então followUpsAppearedSince intercepta ANTES da linha 330!
    expect(decision).toBe("sent");
    expect(shouldPressEnterOnAttempt(0, null)).toBe(true);
  });

  it("investigação caso Cursor real: histórico tem chip e Cursor está rodando tool (Running não está no vocabulário) => unsent e 4 Enters", () => {
    // Medição real do Cursor Agent (agent v2026.09.10):
    // Cursor NÃO usa cabeçalho "follow-ups" nem "○ [Pasted text]".
    // Cursor usa "Running", "Reading", "Grepping" e prompt "→ Add a follow-up ctrl+c to stop".
    const before = [
      "  → [Pasted text #1 +50 lines]",
      " ⠠⠜ Running  35 tokens",
      "  → Add a follow-up                                 ctrl+c to stop",
    ].join("\n");

    // Entrega 2 envia mensagem enquanto Cursor está em execução.
    // O chip anterior continua no histórico das 8 linhas:
    const after = [
      "  → [Pasted text #1 +50 lines]",
      " ⠠⠜ Running  35 tokens",
      "  → Add a follow-up                                 ctrl+c to stop",
    ].join("\n");

    const decision = decideSubmitCheck({
      screenTextBeforeWrite: before,
      screenText: after,
      sentNeedle: "nova instrução de teste",
      hasNewActivitySinceWrite: true,
    });

    // 1. followUpsAppearedSince é false (sem heading follow-ups, sem bullet row)
    // 2. submitStartedAppearedSince é false (Running NÃO está em SUBMIT_STARTED_PATTERN)
    // 3. Linha 330 (/pasted text/i.test(after)) vê o chip do turno 1 no histórico e devolve "unsent"!
    expect(decision).toBe("unsent");

    // 4 Enters são disparados para o Cursor que aceita follow-ups a cada Enter!
    let enterCount = 0;
    let prev: "sent" | "unsent" | "unknown" | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (shouldPressEnterOnAttempt(attempt, prev)) enterCount++;
      prev = decision;
    }
    expect(enterCount).toBe(4);
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

describe("renewsHumanInputGateClock", () => {
  it("tecla humana renova; delivery não", () => {
    expect(renewsHumanInputGateClock("human")).toBe(true);
    expect(renewsHumanInputGateClock("delivery")).toBe(false);
  });
});
