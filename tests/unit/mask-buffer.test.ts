import { describe, it, expect } from "vitest";
import { MaskQueue } from "../../src/renderer/src/mask-buffer";

describe("MaskQueue", () => {
  it("passes data through untouched when nothing is pending", () => {
    const q = new MaskQueue();
    expect(q.consume("hello world\r\n")).toBe("hello world\r\n");
  });

  // DESIGN-BACKLOG.md 2026-09-10, sintoma (a) — "[imagem #1]" (11 cols)
  // where the real path (needle, 12 cols with its quotes) used to be
  // leaves the CLI's own cursor math (done over the REAL length it sent,
  // not what the screen actually shows) one column short, so the next
  // thing it draws lands one column early — a "vão branco". The
  // replacement is padded with spaces up to the needle's own length so
  // xterm.js's cursor ends up exactly where the CLI already assumes it
  // is. The one extra trailing space here (two, not one) IS that pad —
  // the real, literally-typed space after the path (`typed = quotedPath +
  // " "` in useTerminal.ts) is untouched and still comes right after it.
  it("pads the replacement to the needle's own width, closing the cursor-math gap", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" }); // needle: 12 cols, replacement: 11 cols
    expect(q.consume('"/tmp/a.png" ')).toBe("[imagem #1]  ");
  });

  it("does not touch a replacement that's already as wide as (or wider than) its needle", () => {
    const q = new MaskQueue();
    q.push({ needle: '"x"', replacement: "[imagem #1]" }); // replacement (11) longer than needle (3)
    expect(q.consume('"x" ')).toBe("[imagem #1] ");
  });

  it("masks a needle split across multiple chunks", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    expect(q.consume('"/tmp/a.')).toBe("");
    expect(q.consume('png" ')).toBe("[imagem #1]  ");
  });

  it("gives up and flushes raw once the buffer exceeds the needle length without a match", () => {
    const q = new MaskQueue();
    q.push({ needle: "short", replacement: "[x]" });
    expect(q.consume("this is definitely longer than the needle")).toBe("this is definitely longer than the needle");
  });

  // DESIGN-BACKLOG.md 2026-09-10, sintoma (b), o grave — this is THE
  // regression test for it. The old queue removed a needle from itself
  // the first time it matched, so the CLI redrawing the same line later
  // (submit, resize, reflow, history) re-emitted the real path with
  // nothing left pending to catch it, and it leaked raw. The needle must
  // stay masked for as many times as it's ever echoed again, not just
  // the first.
  it("masks the SAME needle every time it reappears, not just the first (submit/resize/reflow redraw)", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    expect(q.consume('"/tmp/a.png" ')).toBe("[imagem #1]  ");
    // The CLI redraws its whole input box from ITS OWN buffer (which
    // still holds the real path) — e.g. on Enter. Same needle, arriving
    // a second time, inside unrelated surrounding bytes.
    expect(q.consume('\x1b[2K\x1b[G> "/tmp/a.png" (sending)')).toBe('\x1b[2K\x1b[G> [imagem #1]  (sending)');
    // And a third time (a resize repainting the same line again).
    expect(q.consume('"/tmp/a.png"')).toBe("[imagem #1] ");
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
    // O resto do eco da primeira chega, junto com o início da segunda.
    expect(q.consume('png" "/tmp/b.')).toBe("[imagem #1]  ");
    expect(q.consume('png" ')).toBe("[imagem #2]  ");
  });

  it("resolves two pending masks that arrive fully within the SAME chunk", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a.png"', replacement: "[imagem #1]" });
    q.push({ needle: '"/tmp/b.png"', replacement: "[imagem #2]" });
    expect(q.consume('"/tmp/a.png" "/tmp/b.png" ')).toBe("[imagem #1]  [imagem #2]  ");
  });

  it("giving up on one item doesn't discard another tracked needle", () => {
    const q = new MaskQueue();
    q.push({ needle: "zzz-not-in-buffer-zzz", replacement: "[x]" });
    q.push({ needle: '"/tmp/b.png"', replacement: "[imagem #2]" });
    const filler = "this plain text is longer than the never-found needle above";
    expect(q.consume(filler)).toBe(filler);
    expect(q.consume('"/tmp/b.png" ')).toBe("[imagem #2]  ");
  });

  // The rolling tail guard has to be per-needle, not "wait for the
  // longest pending needle no matter what" — otherwise ordinary output
  // that doesn't even start like any tracked needle would sit buffered
  // for no reason. A single character with no relation to any needle
  // must flush immediately, in the SAME consume() call it arrives in.
  it("flushes ordinary bytes immediately when they can't be the start of any pending needle", () => {
    const q = new MaskQueue();
    q.push({ needle: '"/tmp/a-quite-long-path-name.png"', replacement: "[imagem #1]" });
    expect(q.consume("plain shell output, nothing to mask here\r\n")).toBe(
      "plain shell output, nothing to mask here\r\n",
    );
  });
});
