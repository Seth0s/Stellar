import { describe, it, expect } from "vitest";
import { MaskQueue } from "../../src/renderer/src/mask-buffer";

describe("MaskQueue", () => {
  it("passes data through untouched when nothing is pending", () => {
    const q = new MaskQueue();
    expect(q.consume("hello world\r\n")).toBe("hello world\r\n");
  });

  it("masks a single needle arriving in one chunk", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    expect(q.consume('"/tmp/a.png" ')).toBe("[imagem #1] ");
  });

  it("masks a needle split across multiple chunks", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    expect(q.consume('"/tmp/a.')).toBe("");
    expect(q.consume('png" ')).toBe("[imagem #1] ");
  });

  it("gives up and flushes raw once the buffer exceeds the needle length without a match", () => {
    const q = new MaskQueue();
    q.push({ needle: "short", replacement: "[x]" });
    expect(q.consume("this is definitely longer than the needle")).toBe("this is definitely longer than the needle");
  });

  // Achado ao vivo (2026-09-06) — a versão anterior (um único slot,
  // sobrescrito a cada `push`) perdia/misturava a primeira colagem quando
  // uma segunda chegava antes da primeira resolver. Reproduz exatamente
  // essa sequência de eventos, sem depender de nenhum timing real de
  // clipboard/PTY.
  it("resolves two pending masks independently, in order, even if the second is pushed before the first resolves", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    // Chunk parcial da primeira colagem chega...
    expect(q.consume('"/tmp/a.')).toBe("");
    // ...mas antes de resolver, a segunda colagem já é armada (o cenário
    // exato que corrompia o slot único).
    q.push({ needle: '"/tmp/b.png"', replacement: "[imagem #2]" });
    // O resto do eco da primeira chega, junto com o início da segunda —
    // o espaço entre os dois paths fica retido no buffer (ainda não sabe
    // se faz parte do que vem antes do segundo needle) até o próximo chunk.
    expect(q.consume('png" "/tmp/b.')).toBe("[imagem #1]");
    expect(q.consume('png" ')).toBe(' [imagem #2] ');
  });

  it("resolves two pending masks that arrive fully within the SAME chunk", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    q.push({ needle: '"/tmp/b.png"', replacement: "[imagem #2]" });
    expect(q.consume('"/tmp/a.png" "/tmp/b.png" ')).toBe("[imagem #1] [imagem #2] ");
  });

  it("giving up on the front item doesn't discard a later queued item", () => {
    const q = new MaskQueue();
    q.push({ needle: "zzz-not-in-buffer-zzz", replacement: "[x]" });
    q.push({ needle: '"/tmp/b.png"', replacement: "[imagem #2]" });
    const filler = "this plain text is longer than the never-found needle above";
    // First item's needle never shows up — buffer grows past its length,
    // gets flushed raw, front is dropped, second item keeps waiting.
    expect(q.consume(filler)).toBe(filler);
    expect(q.consume('"/tmp/b.png" ')).toBe("[imagem #2] ");
  });
});
