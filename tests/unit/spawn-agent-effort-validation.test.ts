import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { projectEffortValues } from "../../src/main/agent-availability-projection";
import { PROVIDERS, providerById } from "../../src/main/providers";

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
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
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
          reason: "test", requesterId: "card-1",
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
      void bus.handleRequest({ cmd: "spawn_agent", provider: "antigravity", effort, reason: "test", requesterId: "card-1" } as BusRequest);
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
        reason: "test", requesterId: "card-1",
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
        void bus.handleRequest({ cmd: "spawn_agent", provider: "claude", effort, reason: "test", requesterId: "card-1" } as BusRequest);
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
      void bus.handleRequest({ cmd: "spawn_agent", provider: "antigravity", reason: "test", requesterId: "card-1" } as BusRequest);
      await new Promise((r) => setTimeout(r, 20));
      expect(receivedParams).toBeDefined();
      expect(receivedParams!.effort).toBeUndefined();
    } finally {
      bus.close();
    }
  });

  // Cross-module invariant, not a duplicate of the implementation: a UI que
  // OFERECE esforço e o gate independente do `spawn_agent` têm de concordar
  // sobre a faixa de cada provider. Se os dois se afastarem, isto falha —
  // ou o popover ofereceria um valor que o servidor recusa, ou o servidor
  // aceitaria um valor que o popover nunca oferece.
  //
  // A fonte do lado da UI MUDOU (task 07b05f43): era
  // `PROVIDER_EFFORT_VALUES`, um mapa COPIADO no renderer que só conhecia
  // claude e antigravity; agora é a PROJEÇÃO da própria declaração
  // (`AgentAvailability.effortValues` → `projectEffortValues`), a mesma que o
  // Rail usa para montar o select. Isto deixa o invariante mais forte do que
  // era: antes ele comparava o gate com uma CÓPIA que podia estar velha por
  // conta própria (e estava: cline e commandcode declaram esforço e o mapa
  // não tinha entrada para eles); agora ele compara o gate com a leitura da
  // MESMA declaração, e por isso cobre TODOS os providers que declaram faixa
  // — nativos e genéricos.
  beforeAll(async () => {
    // O catálogo embutido entra como no boot do app: sem isto os dois CLIs
    // genéricos não estão no registro e o invariante não os cobriria.
    const { loadDynamicProviders } = await import("../../src/main/providers-dynamic");
    loadDynamicProviders("/tmp/stellar-spawn-effort-no-userdata");
  });

  it("a faixa oferecida pela UI (projeção) e o gate de spawn_agent concordam, para TODO provider que declara esforço", async () => {
    const candidates = ["low", "medium", "high", "xhigh", "max", "none", "garbage"];
    const declaring = PROVIDERS.map((p) => p.id).filter(
      (id) => providerById(id)!.capacity.effort.mechanism === "flag",
    );
    // A lista não é fixa de propósito: um provider novo que passe a declarar
    // faixa entra neste invariante sem ninguém editar o teste.
    expect(declaring).toEqual(expect.arrayContaining(["claude", "antigravity", "cline", "commandcode"]));

    for (const provider of declaring) {
      const offered = projectEffortValues(providerById(provider)!.capacity.effort);
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
          void bus.handleRequest({ cmd: "spawn_agent", provider, effort, reason: "test", requesterId: "card-1" } as BusRequest);
          await new Promise((r) => setTimeout(r, 20));
          expect({ provider, effort, dispatched }).toEqual({
            provider,
            effort,
            dispatched: offered.includes(effort),
          });
        } finally {
          bus.close();
        }
      }
    }
  });
});
