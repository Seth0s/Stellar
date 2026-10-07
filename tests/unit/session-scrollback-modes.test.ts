import { describe, expect, it } from "vitest";
import { appendScrollback, createScrollback, readScrollback, readScrollbackWithModes } from "../../src/main/session-scrollback";

/**
 * The terminal modes at the ring's cut travel with the ring: dropping the front
 * must not lose that the program is in the alternate screen, with the mouse on.
 */
const ESC = "\u001b";
const ENTER = `${ESC}[?1049h${ESC}[?1002h${ESC}[?2004h`;

describe("session-scrollback: modos do terminal no corte do anel", () => {
  it("o corte por eviction leva a entrada da tela alternativa para os modos do corte", () => {
    let s = createScrollback();
    s = appendScrollback(s, ENTER, 100); // the entry, 30 bytes
    s = appendScrollback(s, "x".repeat(60), 100);
    s = appendScrollback(s, "y".repeat(60), 100); // evicts the entry
    expect(readScrollback(s)).not.toContain("1049");
    expect(s.cutModes).toMatchObject({ altScreen: true, mouseButton: true, bracketedPaste: true });
    expect(readScrollbackWithModes(s).startsWith(`${ESC}[?1049h`)).toBe(true);
  });

  it("um chunk maior que o teto: o início cortado do PRÓPRIO chunk também é rastreado", () => {
    let s = createScrollback();
    s = appendScrollback(s, ENTER + "z".repeat(500), 100);
    expect(s.droppedBytes).toBeGreaterThan(0);
    expect(s.cutModes.altScreen).toBe(true);
    expect(readScrollbackWithModes(s).startsWith(`${ESC}[?1049h`)).toBe(true);
  });

  it("teto 0: tudo é descartado, mas o estado do terminal é lembrado", () => {
    let s = createScrollback();
    s = appendScrollback(s, ENTER, 0);
    s = appendScrollback(s, "dados", 0);
    expect(readScrollback(s)).toBe("");
    expect(s.cutModes.altScreen).toBe(true);
  });

  it("a saída da tela alternativa também é descartada: o estado no corte é o de DEPOIS dela", () => {
    let s = createScrollback();
    s = appendScrollback(s, ENTER, 100);
    s = appendScrollback(s, `${ESC}[?1049l${ESC}[?1002l${ESC}[?2004l`, 100);
    s = appendScrollback(s, "x".repeat(90), 100);
    s = appendScrollback(s, "y".repeat(90), 100);
    expect(s.cutModes.altScreen).toBe(false);
    expect(readScrollbackWithModes(s)).toBe("y".repeat(90)); // nothing to restore
  });

  it("o que fica no anel NÃO entra nos modos do corte (ele os reaplica quando for reproduzido)", () => {
    let s = createScrollback();
    s = appendScrollback(s, ENTER, 1000);
    expect(s.cutModes.altScreen).toBe(false);
    expect(readScrollbackWithModes(s)).toBe(ENTER);
  });

  it("uma sequência partida entre dois chunks descartados é reconhecida", () => {
    let s = createScrollback();
    s = appendScrollback(s, `${ESC}[?10`, 40);
    s = appendScrollback(s, "49h", 40);
    s = appendScrollback(s, "a".repeat(35), 40);
    s = appendScrollback(s, "b".repeat(35), 40);
    expect(s.cutModes.altScreen).toBe(true);
  });
});
