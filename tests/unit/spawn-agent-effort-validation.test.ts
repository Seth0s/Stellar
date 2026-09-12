import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { PROVIDER_EFFORT_VALUES } from "../../src/renderer/src/card-types";

// DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" — ranges
// re-measured 2026-09-12 against the live CLIs (not the comments):
// `claude` (v2.1.269) accepts low/medium/high/xhigh/max; `agy` (v1.2.2)
// accepts low/medium/high. DECISION: a spawn_agent with an effort
// outside THAT provider's range is REFUSED (ok:false, no card ever
// created), never silently remapped — see message-bus.ts's
// `CLAUDE_EFFORT_VALUES` / `ANTIGRAVITY_EFFORT_VALUES` doc comment for
// the full argument. This file proves the invariant, not the
// implementation: (1) an invalid effort never reaches
// `onSpawnAgentRequest` at all (no card, no human consent modal, no
// wasted spawn-depth budget); (2) every in-range value for that
// provider is left through; (3) a request missing `effort` entirely
// (the common case — no cost/behavior change) is untouched.
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

  it.each(["xhigh", "max", "garbage"])(
    "antigravity com effort=%s (fora de low/medium/high): refusado, onSpawnAgentRequest NUNCA chamado",
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
        const res = (await bus.handleRequest({
          cmd: "spawn_agent",
          provider: "antigravity",
          effort,
          requesterId: "card-1",
        } as BusRequest)) as { ok: boolean; error?: string };
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/low.*medium.*high/i);
        expect(dispatched).toBe(false);
      } finally {
        bus.close();
      }
    },
  );

  it.each(["low", "medium", "high"])("antigravity com effort=%s: passa a validação, chega em onSpawnAgentRequest", async (effort) => {
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

  it("claude com effort fora da faixa: refusado, onSpawnAgentRequest NUNCA chamado", async () => {
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
        provider: "claude",
        effort: "garbage",
        requesterId: "card-1",
      } as BusRequest)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/low.*medium.*high.*xhigh.*max/i);
      expect(dispatched).toBe(false);
    } finally {
      bus.close();
    }
  });

  it.each(["medium", "xhigh", "max", "low", "high"])(
    "claude com effort=%s: passa a validação, chega em onSpawnAgentRequest",
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
  // agree on each provider's range. If they ever drift apart, this
  // fails — either the popover would offer something the server refuses,
  // or the server would accept something the popover never offers.
  it.each(["claude", "antigravity"] as const)(
    "PROVIDER_EFFORT_VALUES.%s e o gate de spawn_agent concordam em toda a gama",
    async (provider) => {
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
          void bus.handleRequest({ cmd: "spawn_agent", provider, effort, requesterId: "card-1" } as BusRequest);
          await new Promise((r) => setTimeout(r, 20));
          const offeredByUi = (PROVIDER_EFFORT_VALUES[provider] ?? []).includes(effort);
          expect(dispatched).toBe(offeredByUi);
        } finally {
          bus.close();
        }
      }
    },
  );
});
