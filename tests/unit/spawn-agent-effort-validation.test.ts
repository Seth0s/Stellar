import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { PROVIDER_EFFORT_VALUES } from "../../src/renderer/src/card-types";

// DESIGN-BACKLOG.md §2.1 "effort do card não é persistido", 2026-09-10 —
// entrega 1(c): `claude` accepts low/medium/high/xhigh/max, antigravity
// only low/high (confirmed live against each CLI, not assumed — see
// providers.ts's own antigravity comment). DECISION: an antigravity
// spawn_agent with an out-of-range effort is REFUSED (ok:false, no card
// ever created), never silently remapped to the nearest supported value
// — see message-bus.ts's `ANTIGRAVITY_EFFORT_VALUES` doc comment for the
// full argument. This file proves the invariant, not the implementation:
// (1) an invalid antigravity effort never reaches `onSpawnAgentRequest`
// at all (no card, no human consent modal, no wasted spawn-depth budget);
// (2) claude's wider range is never refused at this layer; (3) a request
// missing `effort` entirely (the common case — no cost/behavior change)
// is untouched.
function callbacksWithSpies(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getCardBoardId") return () => undefined;
        if (prop === "isBoardAutonomous") return () => false;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus.ts: spawn_agent effort validation por provider", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function sockPath(name: string): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-effort-"));
    return join(dir, name);
  }

  it("antigravity com effort fora de low/high: refusado, onSpawnAgentRequest NUNCA chamado", async () => {
    let dispatched = false;
    const bus = createMessageBus(
      sockPath("a.sock"),
      callbacksWithSpies({
        onSpawnAgentRequest: (() => {
          dispatched = true;
        }) as never,
      }),
    );
    try {
      const res = (await bus.handleRequest({
        cmd: "spawn_agent",
        provider: "antigravity",
        effort: "medium",
        requesterId: "card-1",
      } as BusRequest)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/low.*high|high.*low/i);
      expect(dispatched).toBe(false);
    } finally {
      bus.close();
    }
  });

  it.each(["low", "high"])("antigravity com effort=%s: passa a validação, chega em onSpawnAgentRequest", async (effort) => {
    let receivedEffort: string | undefined;
    const bus = createMessageBus(
      sockPath("a.sock"),
      callbacksWithSpies({
        onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: { effort?: string }) => {
          receivedEffort = params.effort;
        }) as never,
      }),
    );
    try {
      // Sem `wait`, handleRequest resolve assim que o request é
      // despachado (SPAWN_TIMEOUT_MS é longo) — não precisamos simular
      // aprovação humana pra provar que a validação deixou passar.
      void bus.handleRequest({ cmd: "spawn_agent", provider: "antigravity", effort, requesterId: "card-1" } as BusRequest);
      await new Promise((r) => setTimeout(r, 20));
      expect(receivedEffort).toBe(effort);
    } finally {
      bus.close();
    }
  });

  it.each(["medium", "xhigh", "max", "low", "high"])(
    "claude com effort=%s: nunca refusado por este gate (só antigravity tem range restrito)",
    async (effort) => {
      let dispatched = false;
      const bus = createMessageBus(
        sockPath("a.sock"),
        callbacksWithSpies({
          onSpawnAgentRequest: (() => {
            dispatched = true;
          }) as never,
        }),
      );
      try {
        void bus.handleRequest({ cmd: "spawn_agent", provider: "claude", effort, requesterId: "card-1" } as BusRequest);
        await new Promise((r) => setTimeout(r, 20));
        expect(dispatched).toBe(true);
      } finally {
        bus.close();
      }
    },
  );

  it("spawn_agent sem effort nenhum: comportamento pré-existente intacto (chega em onSpawnAgentRequest com effort undefined)", async () => {
    let receivedParams: { effort?: string } | undefined;
    const bus = createMessageBus(
      sockPath("a.sock"),
      callbacksWithSpies({
        onSpawnAgentRequest: ((_requestId: string, _requesterId: string, params: { effort?: string }) => {
          receivedParams = params;
        }) as never,
      }),
    );
    try {
      void bus.handleRequest({ cmd: "spawn_agent", provider: "antigravity", requesterId: "card-1" } as BusRequest);
      await new Promise((r) => setTimeout(r, 20));
      expect(receivedParams).toBeDefined();
      expect(receivedParams!.effort).toBeUndefined();
    } finally {
      bus.close();
    }
  });

  // Cross-module invariant, not a duplicate of the implementation: the
  // UI's own offer list (card-types.ts's PROVIDER_EFFORT_VALUES, used by
  // Rail.tsx's terminal-creation popover so a human can't even PICK an
  // invalid value) and message-bus.ts's independent refusal gate must
  // agree on antigravity's range. If they ever drift apart, this fails —
  // either the popover would offer something the server refuses, or the
  // server would accept something the popover never offers.
  it("PROVIDER_EFFORT_VALUES.antigravity e o gate de spawn_agent concordam em toda a gama", async () => {
    const candidates = ["low", "medium", "high", "xhigh", "max", "garbage"];
    for (const effort of candidates) {
      let dispatched = false;
      const bus = createMessageBus(
        sockPath("a.sock"),
        callbacksWithSpies({
          onSpawnAgentRequest: (() => {
            dispatched = true;
          }) as never,
        }),
      );
      try {
        // Intentionally not awaited: a value the gate accepts dispatches
        // to `onSpawnAgentRequest` and then sits waiting for a (never
        // sent, in this test) approval/resolution — awaiting the promise
        // directly would hang until SPAWN_TIMEOUT_MS. Whether it reached
        // `onSpawnAgentRequest` at all is the signal this test needs.
        void bus.handleRequest({ cmd: "spawn_agent", provider: "antigravity", effort, requesterId: "card-1" } as BusRequest);
        await new Promise((r) => setTimeout(r, 20));
        const offeredByUi = PROVIDER_EFFORT_VALUES.antigravity.includes(effort);
        expect(dispatched).toBe(offeredByUi);
      } finally {
        bus.close();
      }
    }
  });
});
