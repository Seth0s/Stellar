import { describe, it, expect } from "vitest";
import {
  HIDDEN_OUTPUT_MAX_BYTES,
  appendPendingDraw,
  createPendingDraw,
  decideTerminalDraw,
  flushPendingDraw,
  hasPendingDraw,
  readPendingDraw,
} from "../../src/renderer/src/terminal-render";

/**
 * The two renderer decisions: when a card may draw (frame grouping / off-screen
 * skip) and the held-output buffer that makes the replay lossless and
 * duplicate-free. Pure, so none of this needs a live xterm.
 */
describe("terminal-render: quando o card desenha", () => {
  it("fora da viewport NUNCA desenha — nem o card em foco", () => {
    expect(decideTerminalDraw({ visible: false, focused: true })).toBe("skip");
    expect(decideTerminalDraw({ visible: false, focused: false })).toBe("skip");
  });

  it("visível e em foco desenha na hora, sem teto", () => {
    expect(decideTerminalDraw({ visible: true, focused: true })).toBe("now");
  });

  it("visível e sem foco entra no agrupamento por quadro", () => {
    expect(decideTerminalDraw({ visible: true, focused: false })).toBe("coalesce");
  });
});

describe("terminal-render: o buffer retido (replay sem perda nem duplicação)", () => {
  it("guarda em ordem e devolve a concatenação exata", () => {
    let s = createPendingDraw();
    s = appendPendingDraw(s, "primeiro\n");
    s = appendPendingDraw(s, "segundo\n");
    expect(readPendingDraw(s)).toBe("primeiro\nsegundo\n");
    expect(hasPendingDraw(s)).toBe(true);
  });

  it("o flush esvazia: cada byte é desenhado UMA vez", () => {
    let s = createPendingDraw();
    s = appendPendingDraw(s, "aaa");
    s = appendPendingDraw(s, "bbb");
    const first = flushPendingDraw(s);
    expect(first.text).toBe("aaabbb");
    expect(hasPendingDraw(first.next)).toBe(false);
    // A second flush of the drained state draws nothing — the other half of
    // "no duplication".
    expect(flushPendingDraw(first.next).text).toBe("");
  });

  it("continua de onde parou depois de um flush", () => {
    let s = createPendingDraw();
    s = appendPendingDraw(s, "um");
    s = flushPendingDraw(s).next;
    s = appendPendingDraw(s, "dois");
    expect(readPendingDraw(s)).toBe("dois");
  });

  it("respeita o teto em bytes: sobrevive o histórico recente", () => {
    let s = createPendingDraw();
    s = appendPendingDraw(s, "aaaa", 8);
    s = appendPendingDraw(s, "bbbb", 8);
    s = appendPendingDraw(s, "cccc", 8);
    expect(readPendingDraw(s)).toBe("bbbbcccc");
    expect(s.bytes).toBe(8);
  });

  it("um chunk maior que o teto fica pela CAUDA, sem cortar code point", () => {
    let s = createPendingDraw();
    // A two-byte UTF-8 character: a cap of 3 cannot fit "x" (1) + it (2) + "y" (1).
    s = appendPendingDraw(s, "xéy", 3);
    expect(readPendingDraw(s)).toBe("éy");
    expect(s.bytes).toBeLessThanOrEqual(3);
  });

  it("teto 0 declaradamente não guarda nada", () => {
    let s = createPendingDraw();
    s = appendPendingDraw(s, "abc", 0);
    expect(readPendingDraw(s)).toBe("");
    expect(s.bytes).toBe(0);
  });

  it("o teto default é declarado, nunca 'ilimitado'", () => {
    expect(HIDDEN_OUTPUT_MAX_BYTES).toBeGreaterThan(0);
    let s = createPendingDraw();
    for (let i = 0; i < 100; i++) s = appendPendingDraw(s, "x".repeat(64 * 1024));
    expect(s.bytes).toBeLessThanOrEqual(HIDDEN_OUTPUT_MAX_BYTES);
  });
});
