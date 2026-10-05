import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCROLLBACK_MAX_BYTES,
  appendScrollback,
  createScrollback,
  readScrollback,
  resolveScrollbackMaxBytes,
  trimLeadingPartialEscape,
} from "../../src/main/session-scrollback";

/**
 * The byte ring that lets the xterm be repainted after returning to a
 * background session. What is proven here is the CAP (by bytes, not lines) and
 * the honest count of what was dropped.
 */
describe("session-scrollback: anel de bytes com teto", () => {
  it("guarda em ordem e devolve o texto cronológico", () => {
    let s = createScrollback();
    s = appendScrollback(s, "primeiro\n", 1024);
    s = appendScrollback(s, "segundo\n", 1024);
    expect(readScrollback(s)).toBe("primeiro\nsegundo\n");
    expect(s.droppedBytes).toBe(0);
  });

  it("evicta da frente quando passa do teto — ficam os bytes MAIS RECENTES", () => {
    let s = createScrollback();
    // 3 chunks de 4 bytes com teto de 8: o primeiro sai.
    s = appendScrollback(s, "aaaa", 8);
    s = appendScrollback(s, "bbbb", 8);
    s = appendScrollback(s, "cccc", 8);
    expect(readScrollback(s)).toBe("bbbbcccc");
    expect(s.bytes).toBe(8);
    expect(s.droppedBytes).toBe(4);
  });

  it("um chunk maior que o teto é mantido pela CAUDA do chunk", () => {
    let s = createScrollback();
    s = appendScrollback(s, "0123456789", 4);
    expect(readScrollback(s)).toBe("6789");
    expect(s.droppedBytes).toBe(6);
  });

  it("conta descartados quando o teto é 0 (declaradamente não guarda)", () => {
    let s = createScrollback();
    s = appendScrollback(s, "abc", 0);
    expect(readScrollback(s)).toBe("");
    expect(s.droppedBytes).toBe(3);
    s = appendScrollback(s, "de", 0);
    expect(s.droppedBytes).toBe(5);
  });

  it("não corta no meio de um code point multibyte", () => {
    let s = createScrollback();
    // The second character is 2 bytes in UTF-8: a cap of 3 fits "a" plus that
    // character (3 bytes) but not a third character.
    s = appendScrollback(s, "aé", 3);
    expect(readScrollback(s)).toBe("aé");
    expect(Buffer.byteLength(readScrollback(s), "utf8")).toBeLessThanOrEqual(3);
  });

  it("teto configurável por env, com default e recusa de lixo", () => {
    expect(resolveScrollbackMaxBytes({})).toBe(DEFAULT_SCROLLBACK_MAX_BYTES);
    expect(resolveScrollbackMaxBytes({ STELLAR_SCROLLBACK_MAX_BYTES: "1024" })).toBe(1024);
    expect(resolveScrollbackMaxBytes({ STELLAR_SCROLLBACK_MAX_BYTES: "0" })).toBe(0);
    expect(resolveScrollbackMaxBytes({ STELLAR_SCROLLBACK_MAX_BYTES: "abc" })).toBe(DEFAULT_SCROLLBACK_MAX_BYTES);
    expect(resolveScrollbackMaxBytes({ STELLAR_SCROLLBACK_MAX_BYTES: "-5" })).toBe(DEFAULT_SCROLLBACK_MAX_BYTES);
  });
});

describe("session-scrollback: apara o rabo de escape cortado na borda", () => {
  it("mantém texto que começa limpo", () => {
    expect(trimLeadingPartialEscape("hello\nworld")).toBe("hello\nworld");
  });

  it("mantém um CSI bem-formado no começo", () => {
    expect(trimLeadingPartialEscape("\u001b[31mred")).toBe("\u001b[31mred");
  });

  it("apara um CSI quebrado (ESC sem terminador) até a quebra de linha", () => {
    expect(trimLeadingPartialEscape("\u001b[3\nresto")).toBe("resto");
  });

  it("apara o rabo de um CSI sem o ESC introducer", () => {
    expect(trimLeadingPartialEscape("[31mjunk\nok")).toBe("ok");
  });

  it("texto vazio continua vazio", () => {
    expect(trimLeadingPartialEscape("")).toBe("");
  });
});
