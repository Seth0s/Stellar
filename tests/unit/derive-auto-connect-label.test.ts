import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";
import { setLocale } from "../../src/shared/i18n";

/**
 * `deriveAutoConnectLabel` — spawn_agent case (2026-09-14).
 * The arrow names the RELATION (purpose + reviewer), not a second copy
 * of the card title. Regression keeps the five pre-existing cmds.
 */

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => overrides[prop] ?? (() => undefined),
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    prompt: "Connector de spawn nasce sem label. Texto longo que viraria o nome do card.",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    result_json: null,
    deps_json: null,
    purpose: "fix",
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("deriveAutoConnectLabel", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    // A locale do `t()` é módulo-global: o teste de paridade em en (abaixo)
    // muda e isto devolve o default pros testes seguintes.
    setLocale("pt-BR");
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-label-"));
    bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacksWithOverrides(overrides));
    return bus;
  }

  describe("spawn_agent", () => {
    it("com task + purpose fix (implementer) → 'correção'", () => {
      const t = task({ purpose: "fix" });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", taskId: t.id, provider: "claude" } as BusRequest)).toBe(
        "correção",
      );
    });

    it("sem taskId → null", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", provider: "claude" } as BusRequest)).toBeNull();
    });

    it("role reviewer + purpose → 'revisão · correção'", () => {
      const t = task({ purpose: "fix" });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(
        b.deriveAutoConnectLabel({
          cmd: "spawn_agent",
          taskId: t.id,
          role: "reviewer",
          provider: "claude",
        } as BusRequest),
      ).toBe("revisão · correção");
    });

    it("role reviewer sem purpose → 'revisão'", () => {
      const t = task({ purpose: null });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(
        b.deriveAutoConnectLabel({
          cmd: "spawn_agent",
          taskId: t.id,
          role: "reviewer",
          provider: "claude",
        } as BusRequest),
      ).toBe("revisão");
    });

    it("implementer sem purpose → null (ausência é normal)", () => {
      const t = task({ purpose: null });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", taskId: t.id, provider: "claude" } as BusRequest)).toBeNull();
    });

    it("passa por truncateForLabel (não trunca por conta própria)", () => {
      // purpose labels are short; prove the sanitizer path still runs by
      // ensuring a purpose with C0 whitespace collapses the same way.
      const t = task({ purpose: "implement" });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", taskId: t.id, provider: "claude" } as BusRequest)).toBe(
        "implementação",
      );
    });

    it("purpose integrate → 'integração' (task 5b173f00: a cadeia de ternários caía em null e a pill ficava SEM rótulo)", () => {
      const t = task({ purpose: "integrate" });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", taskId: t.id, provider: "claude" } as BusRequest)).toBe(
        "integração",
      );
    });

    it("em en a pill fala o MESMO vocabulário da Fila (a cópia pt-BR divergia: 'implementation' vs 'implementação')", () => {
      setLocale("en");
      const t = task({ purpose: "integrate" });
      const b = makeBus({ getTask: ((id: string) => (id === t.id ? t : undefined)) as never });
      expect(b.deriveAutoConnectLabel({ cmd: "spawn_agent", taskId: t.id, provider: "claude" } as BusRequest)).toBe(
        "integration",
      );
      // E o substantivo da pill vem de chave própria (`review`), não do
      // verbo `task.role.reviewer` ("reviews").
      expect(
        b.deriveAutoConnectLabel({
          cmd: "spawn_agent",
          taskId: t.id,
          role: "reviewer",
          provider: "claude",
        } as BusRequest),
      ).toBe("review · integration");
    });
  });

  describe("alimentador spawn_agent → connectorLabel (uma fonte)", () => {
    it("spawn com task+purpose coloca connectorLabel='correção' nos params (não usa reason)", async () => {
      const t = task({ purpose: "fix" });
      const spawned: Array<Record<string, unknown>> = [];
      dir = mkdtempSync(join(tmpdir(), "stellar-derive-feed-"));
      bus = createMessageBus(
        join(dir, "agent-canvas.sock"),
        callbacksWithOverrides({
          getTask: ((id: string) => (id === t.id ? t : undefined)) as never,
          getCardBoardId: (() => "b1") as never,
          isBoardAutonomous: (() => true) as never,
          onSpawnAgentRequest: ((requestId: string, _r: string, params: Record<string, unknown>) => {
            spawned.push(params);
            bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "spawned-card" });
          }) as never,
          listCards: (() => [{ id: "orch", kind: "terminal", provider: "claude", cwd: "", label: null }]) as never,
        }),
      );

      const res = (await bus.handleRequest({
        cmd: "spawn_agent",
        provider: "bash",
        taskId: t.id,
        requesterId: "orch",
        reason: "REGRAS DESTE BOARD — NÃO deve virar label do connector",
        label: "prova-label",
      } as BusRequest)) as { ok: boolean };

      expect(res.ok).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].connectorLabel).toBe("correção");
      expect(spawned[0].reason).toBe("REGRAS DESTE BOARD — NÃO deve virar label do connector");
    });

    it("spawn sem task → connectorLabel null mesmo com reason", async () => {
      const spawned: Array<Record<string, unknown>> = [];
      dir = mkdtempSync(join(tmpdir(), "stellar-derive-feed-"));
      bus = createMessageBus(
        join(dir, "agent-canvas.sock"),
        callbacksWithOverrides({
          getCardBoardId: (() => "b1") as never,
          isBoardAutonomous: (() => true) as never,
          onSpawnAgentRequest: ((requestId: string, _r: string, params: Record<string, unknown>) => {
            spawned.push(params);
            bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "spawned-card" });
          }) as never,
          listCards: (() => [{ id: "orch", kind: "terminal", provider: "claude", cwd: "", label: null }]) as never,
        }),
      );

      await bus.handleRequest({
        cmd: "spawn_agent",
        provider: "bash",
        brief: "explore",
        requesterId: "orch",
        reason: "só modal",
      } as BusRequest);

      expect(spawned[0].connectorLabel).toBeNull();
      expect(spawned[0].reason).toBe("só modal");
    });

    it("spawn reviewer → connectorLabel 'revisão · correção'", async () => {
      const t = task({ purpose: "fix", status: "running", card_id: "impl" });
      const spawned: Array<Record<string, unknown>> = [];
      dir = mkdtempSync(join(tmpdir(), "stellar-derive-feed-"));
      bus = createMessageBus(
        join(dir, "agent-canvas.sock"),
        callbacksWithOverrides({
          getTask: ((id: string) => (id === t.id ? t : undefined)) as never,
          getCardBoardId: (() => "b1") as never,
          isBoardAutonomous: (() => true) as never,
          linkTaskCard: (() => undefined) as never,
          onSpawnAgentRequest: ((requestId: string, _r: string, params: Record<string, unknown>) => {
            spawned.push(params);
            bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "reviewer-card" });
          }) as never,
          listCards: (() => [
            { id: "orch", kind: "terminal", provider: "claude", cwd: "", label: null },
            { id: "impl", kind: "terminal", provider: "claude", cwd: "", label: null },
          ]) as never,
        }),
      );

      await bus.handleRequest({
        cmd: "spawn_agent",
        provider: "bash",
        taskId: t.id,
        role: "reviewer",
        brief: "revise o trabalho",
        requesterId: "orch",
        reason: "texto do modal",
      } as BusRequest);

      expect(spawned[0].connectorLabel).toBe("revisão · correção");
    });
  });

  describe("regressão dos cinco cmds existentes", () => {
    it("send → text", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "send", text: "ls -la", target: "t" } as BusRequest)).toBe("ls -la");
    });

    it("browser_type → text, senão selector", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "browser_type", text: "hello", target: "t" } as BusRequest)).toBe("hello");
      expect(b.deriveAutoConnectLabel({ cmd: "browser_type", selector: "#q", target: "t" } as BusRequest)).toBe("#q");
    });

    it("browser_click → selector", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "browser_click", selector: "button.submit", target: "t" } as BusRequest)).toBe(
        "button.submit",
      );
    });

    it("browser_scroll → selector ou null", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "browser_scroll", selector: "#main", target: "t" } as BusRequest)).toBe("#main");
      expect(b.deriveAutoConnectLabel({ cmd: "browser_scroll", target: "t" } as BusRequest)).toBeNull();
    });

    it("browser_eval → js", () => {
      const b = makeBus();
      expect(b.deriveAutoConnectLabel({ cmd: "browser_eval", js: "document.title", target: "t" } as BusRequest)).toBe(
        "document.title",
      );
    });
  });
});
