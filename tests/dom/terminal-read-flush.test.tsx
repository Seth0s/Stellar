import { describe, it, expect, afterEach } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  getTerminalText,
  readTerminalText,
  registerTerminal,
  registerTerminalFlusher,
  unregisterTerminal,
  unregisterTerminalFlusher,
} from "../../src/renderer/src/terminal-registry";
import { appendPendingDraw, createPendingDraw, flushPendingDraw } from "../../src/renderer/src/terminal-render";

/**
 * `read_card` on a card that is off the canvas viewport. The card holds its
 * bytes back from the xterm (terminal-render.ts), so the read must drain them
 * into the xterm BEFORE answering, and the same drain must leave nothing to be
 * drawn again when the card returns to view.
 *
 * A fake xterm stands in for the real one: a line buffer plus a `write` that
 * records chunks and calls the completion callback, which is all
 * `getTerminalText` and the flush-then-read path touch.
 */
function makeFakeTerminal() {
  const lines: string[] = [];
  const writes: string[] = [];
  const term = {
    buffer: {
      get active() {
        return {
          get length() {
            return lines.length;
          },
          getLine: (i: number) => ({ translateToString: () => lines[i] ?? "" }),
        };
      },
    },
    write: (data: string, cb?: () => void) => {
      writes.push(data);
      for (const row of data.split("\n")) lines.push(row);
      cb?.();
    },
  } as unknown as Terminal;
  return { term, lines, writes };
}

/**
 * A card mirroring useTerminal's contract: output is held, and one drain
 * function both the registry (read) and the visible path use — so a test can
 * prove the two share the single held buffer.
 */
function makeCard(id: string, term: Terminal) {
  let held = createPendingDraw();
  registerTerminal(id, term);
  const drain = async () => {
    const { text, next } = flushPendingDraw(held);
    held = next;
    if (!text) return;
    await new Promise<void>((resolve) => term.write(text, resolve));
  };
  registerTerminalFlusher(id, drain);
  return {
    receiveOutput: (data: string) => {
      held = appendPendingDraw(held, data);
    },
    returnToView: drain,
    heldBytes: () => held.bytes,
  };
}

const registered: string[] = [];
afterEach(() => {
  for (const id of registered.splice(0)) {
    unregisterTerminal(id);
    unregisterTerminalFlusher(id);
  }
});

describe("read_card de um card fora da tela", () => {
  it("devolve a saída retida — o flush roda ANTES da leitura", async () => {
    const { term } = makeFakeTerminal();
    const card = makeCard("c-off", term);
    registered.push("c-off");
    // Produced while the card is off the viewport: held, not yet in the xterm.
    card.receiveOutput("OFFSCREEN_ONE\nOFFSCREEN_TWO\n");
    expect(getTerminalText("c-off", 20)).not.toContain("OFFSCREEN_ONE");

    const text = await readTerminalText("c-off", 20);
    expect(text).toContain("OFFSCREEN_ONE");
    expect(text).toContain("OFFSCREEN_TWO");
  });

  it("ao voltar à vista nada se repete", async () => {
    const { term, writes } = makeFakeTerminal();
    const card = makeCard("c-once", term);
    registered.push("c-once");
    card.receiveOutput("REPEAT_MARK\n");

    const first = await readTerminalText("c-once", 20);
    expect(first).not.toBeNull();
    expect(first!.split("REPEAT_MARK").length - 1).toBe(1);
    expect(card.heldBytes()).toBe(0);
    const writesAfterRead = writes.length;

    // Returning to view runs the SAME drain: the held buffer is already empty,
    // so nothing is drawn a second time.
    await card.returnToView();
    expect(writes.length).toBe(writesAfterRead);

    const second = await readTerminalText("c-once", 20);
    expect(second).not.toBeNull();
    expect(second!.split("REPEAT_MARK").length - 1).toBe(1);
    expect(writes.length).toBe(writesAfterRead);
  });

  it("sem bytes retidos, lê o estado atual sem tocar no terminal", async () => {
    const { term } = makeFakeTerminal();
    term.write("PRESENT_LINE\n");
    registerTerminal("c-idle", term);
    registered.push("c-idle");
    const text = await readTerminalText("c-idle", 20);
    expect(text).toContain("PRESENT_LINE");
  });

  it("um card desconhecido devolve null", async () => {
    expect(await readTerminalText("ghost", 20)).toBeNull();
  });
});
