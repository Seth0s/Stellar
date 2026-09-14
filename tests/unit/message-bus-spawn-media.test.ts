import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { describeAcceptedSpawnMedia } from "../../src/main/spawn-media-decision";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: spawn_card kind media", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(opts?: {
    onSpawn?: (...args: unknown[]) => void;
    prepare?: (boardId: string, sourcePath: string) => { ok: true; path: string } | { ok: false; error: string };
    autonomous?: boolean;
  }) {
    dir = dir ?? mkdtempSync(join(tmpdir(), "stellar-bus-media-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getCardBoardId: (id: string) => (id === "agent-1" ? "board-a" : undefined),
        isBoardAutonomous: () => opts?.autonomous === true,
        listCards: () => [
          {
            id: "agent-1",
            kind: "terminal",
            provider: "bash",
            cwd: dir,
            label: null,
            displayName: "bash",
          },
        ],
        listCardsForBoard: () => [],
        findSpawnByChild: () => null,
        recordSpawn: () => undefined,
        prepareMediaAsset:
          opts?.prepare ??
          ((boardId: string, sourcePath: string) => ({
            ok: true as const,
            path: `/fake/board-assets/${boardId}/${sourcePath.split("/").pop()}`,
          })),
        onSpawnCardRequest: opts?.onSpawn ?? (() => undefined),
      }),
    );
    return bus;
  }

  it("refuses unknown kind naming media in the list", async () => {
    const b = makeBus();
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "spreadsheet",
      reason: "no",
      requesterId: "agent-1",
    } as BusRequest);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("media");
  });

  it("refuses media without path before consent", async () => {
    let asked = false;
    const b = makeBus({ onSpawn: () => { asked = true; } });
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "media",
      reason: "show diagram",
      requesterId: "agent-1",
    } as BusRequest);
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toContain("requires path");
    expect(String(result.error)).toContain(describeAcceptedSpawnMedia());
    expect(asked).toBe(false);
  });

  it("refuses unsupported type before consent, teaching accepted set", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-media-"));
    const bad = join(dir, "sheet.xlsx");
    writeFileSync(bad, "x");
    let asked = false;
    const b = makeBus({ onSpawn: () => { asked = true; } });
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "media",
      path: bad,
      reason: "show sheet",
      requesterId: "agent-1",
    } as BusRequest);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/\.xlsx/);
    expect(String(result.error)).toContain(describeAcceptedSpawnMedia());
    expect(asked).toBe(false);
  });

  it("refuses missing file before consent", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-media-"));
    let asked = false;
    const b = makeBus({ onSpawn: () => { asked = true; } });
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "media",
      path: join(dir, "gone.png"),
      reason: "show",
      requesterId: "agent-1",
    } as BusRequest);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/file not found/);
    expect(asked).toBe(false);
  });

  it("copies then asks consent with assetPath+mediaType (not sticky auto-approve)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-media-"));
    const src = join(dir, "shot.png");
    writeFileSync(src, "png");
    const prepared: string[] = [];
    let captured: { autoApprove?: boolean; assetPath?: string; mediaType?: string; path?: string; kind?: string } | null =
      null;
    const b = makeBus({
      prepare: (boardId, sourcePath) => {
        prepared.push(`${boardId}:${sourcePath}`);
        return { ok: true, path: `/assets/${boardId}/media-copied.png` };
      },
      onSpawn: (requestId, _requesterId, params) => {
        captured = params as typeof captured;
        b.resolveSpawnCard(requestId as string, { ok: true, cardId: "media-1" });
      },
    });
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "media",
      path: src,
      reason: "show screenshot",
      requesterId: "agent-1",
    } as BusRequest);
    expect(prepared).toEqual([`board-a:${src}`]);
    expect(captured).toMatchObject({
      kind: "media",
      autoApprove: false,
      assetPath: "/assets/board-a/media-copied.png",
      mediaType: "image",
      path: src,
    });
    expect(result).toEqual({ ok: true, cardId: "media-1" });
  });

  it("auto-approves media on autonomous board", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-media-"));
    const src = join(dir, "doc.pdf");
    writeFileSync(src, "%PDF");
    let captured: { autoApprove?: boolean; mediaType?: string } | null = null;
    const b = makeBus({
      autonomous: true,
      onSpawn: (_requestId, _requesterId, params) => {
        captured = params as typeof captured;
        const requestId = (_requestId as string);
        b.resolveSpawnCard(requestId, { ok: true, cardId: "media-9" });
      },
    });
    const result = await b.handleRequest({
      cmd: "spawn_card",
      kind: "media",
      path: "doc.pdf",
      reason: "show pdf",
      requesterId: "agent-1",
    } as BusRequest);
    expect(result).toEqual({ ok: true, cardId: "media-9" });
    expect(captured).toMatchObject({ autoApprove: true, mediaType: "pdf" });
  });
});
