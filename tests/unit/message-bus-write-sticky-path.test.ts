import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest, type StickyOp } from "../../src/main/message-bus";
import { MAX_FILE_BYTES } from "../../src/main/fs-tools";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

/**
 * write_sticky's `path` form must reuse fs-tools `confine` + `readFile` +
 * `MAX_FILE_BYTES` (via `readFileAllowingAbsolute`). A new unbounded
 * read would trade a classifier problem for a hole. Inline `content`
 * stays valid; append works for both forms.
 */
describe("message-bus: write_sticky path form reuses fs-tools confine", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let lastWrite: { cardId: string; op: StickyOp } | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    lastWrite = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(opts?: { cards?: Array<{ id: string; kind: string; cwd: string }>; autonomous?: boolean }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-write-sticky-path-"));
    const cards = (opts?.cards ?? [{ id: "agent-1", kind: "terminal", cwd: dir }]).map((c) => ({
      id: c.id,
      kind: c.kind,
      provider: c.kind === "terminal" ? "claude" : "",
      cwd: c.cwd,
      label: null,
      displayName: c.id,
    }));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [
          ...cards,
          { id: "note-1", kind: "sticky", provider: "", cwd: "", label: null, displayName: "note-1" },
        ],
        getAnyCard: (id: string) =>
          id === "offboard-note"
            ? { boardId: "other", kind: "sticky", provider: null }
            : id === "note-1"
              ? { boardId: "board-a", kind: "sticky", provider: null }
              : undefined,
        isBoardAutonomous: () => opts?.autonomous === true,
        updateStickyContentDirect: (cardId: string, content: string, mode: "replace" | "append") => ({
          ok: true as const,
          content: mode === "append" ? `PREV${content}` : content,
        }),
        onAutoConnect: () => undefined,
        onStickyRequest: (requestId: string, cardId: string, op: StickyOp) => {
          lastWrite = { cardId, op };
          const content = op.op === "write" ? op.content : "";
          bus!.resolveSticky(requestId, {
            ok: true,
            content,
            ...(op.op === "write" && op.mode === "append" ? { appended: true as const, totalLines: content.split("\n").length } : {}),
          });
        },
      }),
    );
    return bus;
  }

  it("inline content still replaces (path is an alternative, not a replacement)", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      content: "hello inline",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello inline");
    expect(lastWrite?.op).toMatchObject({ op: "write", content: "hello inline", mode: "replace" });
  });

  it("inline append still appends", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      content: "\nmore",
      mode: "append",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; appended?: boolean };

    expect(res.ok).toBe(true);
    expect(res.appended).toBe(true);
    expect(lastWrite?.op).toMatchObject({ op: "write", content: "\nmore", mode: "append" });
  });

  it("path relative to the caller cwd is read by main and written", async () => {
    const b = makeBus();
    writeFileSync(join(dir, "roster.md"), "Ana 001\nBruno 002");
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "roster.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("Ana 001\nBruno 002");
    expect(lastWrite?.op).toMatchObject({ op: "write", content: "Ana 001\nBruno 002", mode: "replace" });
  });

  it("absolute path still inside the caller cwd is remapped, then confined", async () => {
    const b = makeBus();
    const abs = join(dir, "abs-note.md");
    writeFileSync(abs, "from absolute");
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: abs,
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("from absolute");
  });

  it("path form honors append", async () => {
    const b = makeBus();
    writeFileSync(join(dir, "chunk.md"), "\nchunk");
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "chunk.md",
      mode: "append",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; appended?: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.appended).toBe(true);
    expect(lastWrite?.op).toMatchObject({ op: "write", content: "\nchunk", mode: "append" });
  });

  it("content and path together are refused", async () => {
    const b = makeBus();
    writeFileSync(join(dir, "x.md"), "x");
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      content: "inline",
      path: "x.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content or path, not both/);
    expect(lastWrite).toBeNull();
  });

  it("neither content nor path is refused", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing content or path/);
  });

  it("path outside the caller cwd is refused (confine, not a raw read)", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "/etc/passwd",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes the caller's project root/);
    expect(lastWrite).toBeNull();
  });

  it("relative escape via .. is refused", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "../outside.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes the caller's project root/);
  });

  it("symlink pointing outside the root is refused (same confine canonicalize)", async () => {
    const b = makeBus();
    const outside = join(dir, "..", `stellar-sticky-outside-${Date.now()}.md`);
    writeFileSync(outside, "leaked");
    try {
      symlinkSync(outside, join(dir, "link.md"));
      const res = (await b.handleRequest({
        cmd: "write_sticky",
        target: "note-1",
        path: "link.md",
        requesterId: "agent-1",
      } as BusRequest)) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/escapes the caller's project root/);
      expect(lastWrite).toBeNull();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("path form without a caller cwd is refused (no unbounded absolute read)", async () => {
    const b = makeBus({ cards: [{ id: "agent-1", kind: "terminal", cwd: "" }] });
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "/tmp/whatever.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/project root \(cwd\)/);
    expect(lastWrite).toBeNull();
  });

  it("file over MAX_FILE_BYTES is refused (same cap as readFile)", async () => {
    const b = makeBus();
    writeFileSync(join(dir, "huge.md"), "x".repeat(MAX_FILE_BYTES + 1));
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "huge.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/larger than/);
    expect(lastWrite).toBeNull();
  });

  it("update_card_content path form on the loaded board delegates resolved bytes", async () => {
    const b = makeBus();
    writeFileSync(join(dir, "via-update.md"), "via update");
    const res = (await b.handleRequest({
      cmd: "update_card_content",
      target: "note-1",
      path: "via-update.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("via update");
    expect(lastWrite?.op).toMatchObject({ op: "write", content: "via update", mode: "replace" });
  });

  it("update_card_content path form appends on an autonomous unloaded board", async () => {
    const b = makeBus({ autonomous: true });
    writeFileSync(join(dir, "off.md"), " + from file");
    const res = (await b.handleRequest({
      cmd: "update_card_content",
      target: "offboard-note",
      path: "off.md",
      mode: "append",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("PREV + from file");
    expect(lastWrite).toBeNull();
  });

  it("nested relative path under the cwd is allowed", async () => {
    const b = makeBus();
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "a.md"), "nested");
    const res = (await b.handleRequest({
      cmd: "write_sticky",
      target: "note-1",
      path: "notes/a.md",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; content?: string };

    expect(res.ok).toBe(true);
    expect(res.content).toBe("nested");
  });
});
