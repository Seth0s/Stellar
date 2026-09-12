import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

/**
 * A refused scheme used to reach consent + card creation: normalizeUrl
 * threw only inside `void loadURL(...)` after the card existed, and
 * `open`/`spawn_card` returned `{ok:true}`. The caller must see the
 * error, and neither path may ask a human (or auto-approve on an
 * autonomous board) before that.
 */
describe("message-bus: esquemas recusados falham antes do consentimento", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(opts?: { autonomous?: boolean; onOpen?: (...args: unknown[]) => void; onSpawn?: (...args: unknown[]) => void }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-open-scheme-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getCardBoardId: (id: string) => (id ? "board-a" : undefined),
        isBoardAutonomous: () => opts?.autonomous === true,
        listCards: () => [],
        onOpenRequest: (...args: unknown[]) => {
          if (opts?.onOpen) opts.onOpen(...args);
          else throw new Error("refused scheme must not reach onOpenRequest");
        },
        onSpawnCardRequest: (...args: unknown[]) => {
          if (opts?.onSpawn) opts.onSpawn(...args);
          else throw new Error("refused scheme must not reach onSpawnCardRequest");
        },
      }),
    );
    return bus;
  }

  it("open file://: ok:false, consentimento não é pedido", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "open",
      url: "file:///tmp/prototype.html",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported url scheme: file:/);
  });

  it("open file:// em board autônomo: ainda recusa, sem auto-approve", async () => {
    const b = makeBus({ autonomous: true });
    const res = (await b.handleRequest({
      cmd: "open",
      url: "file:///etc/passwd",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported url scheme: file:/);
  });

  it("open javascript:/data:/blob: também recusa antes do modal", async () => {
    const b = makeBus();
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "blob:https://example.com/abc"]) {
      const res = (await b.handleRequest({ cmd: "open", url, requesterId: "agent-1" } as BusRequest)) as {
        ok: boolean;
        error?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/unsupported url scheme:/);
    }
  });

  it("open https:// chega no pedido de consentimento", async () => {
    let asked = 0;
    const b = makeBus({
      onOpen: (requestId: unknown) => {
        asked += 1;
        b.resolveOpen(String(requestId), true, "card-9");
      },
    });
    const res = await b.handleRequest({
      cmd: "open",
      url: "https://example.com",
      requesterId: "agent-1",
    } as BusRequest);
    expect(asked).toBe(1);
    expect(res).toEqual({ ok: true, cardId: "card-9" });
  });

  it("spawn_card browser com file://: ok:false, consentimento não é pedido", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "spawn_card",
      kind: "browser",
      url: "file:///tmp/coverage/index.html",
      requesterId: "agent-1",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported url scheme: file:/);
  });

  it("spawn_card browser sem url ainda pede consentimento (about:blank)", async () => {
    let asked = 0;
    const b = makeBus({
      onSpawn: (requestId: unknown) => {
        asked += 1;
        b.resolveSpawnCard(String(requestId), { ok: true, cardId: "b1" });
      },
    });
    const res = await b.handleRequest({
      cmd: "spawn_card",
      kind: "browser",
      requesterId: "agent-1",
    } as BusRequest);
    expect(asked).toBe(1);
    expect(res).toEqual({ ok: true, cardId: "b1" });
  });

  it("spawn_card sticky não valida url — esquema recusado em outro kind não bloqueia", async () => {
    let asked = 0;
    const b = makeBus({
      onSpawn: (requestId: unknown) => {
        asked += 1;
        b.resolveSpawnCard(String(requestId), { ok: true, cardId: "s1" });
      },
    });
    const res = await b.handleRequest({
      cmd: "spawn_card",
      kind: "sticky",
      requesterId: "agent-1",
    } as BusRequest);
    expect(asked).toBe(1);
    expect(res).toEqual({ ok: true, cardId: "s1" });
  });
});
