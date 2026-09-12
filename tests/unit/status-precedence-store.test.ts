import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

/**
 * DESIGN-BACKLOG.md §2.1 Decisão 8 — integração no choke point
 * (`upsertTaskInternal`). A função pura vive em status-write-decision.test.ts;
 * isto trava o QUE o banco grava (status autoritativo, diverged_*,
 * declaration vs status transition, limpeza).
 */
describe("store.ts: status híbrido com precedência (decisão 8)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function base(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
    const now = Date.now();
    return {
      id,
      prompt: "faz X",
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: "default",
      cwd: null,
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  it("humano move; agente update_task NÃO desloca status; grava declaration + diverged_*", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { status: "done", actor: "agent" }));
      store.upsertTask(base("t1", { status: "running", actor: "human", updated_at: Date.now() + 1 }));

      const decision = store.upsertTask(base("t1", { status: "done", actor: "agent", updated_at: Date.now() + 2 }));
      expect(decision).toMatchObject({
        status: "running",
        statusChanged: false,
        divergedStatus: "done",
        divergedActor: "agent",
        recordDeclaration: true,
        warnAgent: true,
      });

      const t = store.getTask("t1")!;
      expect(t.status).toBe("running");
      expect(t.diverged_status).toBe("done");
      expect(t.diverged_actor).toBe("agent");

      const transitions = t.transitions!;
      // create + human move = 2 status; agent hold = 1 declaration
      expect(transitions.filter((x) => x.kind === "status")).toHaveLength(2);
      expect(transitions.filter((x) => x.kind === "declaration")).toHaveLength(1);
      expect(transitions.find((x) => x.kind === "declaration")).toMatchObject({
        from_value: "running",
        to_value: "done",
        actor: "agent",
      });

      // last_actor de status continua humano — declaração NÃO desfaz o lock
      const last = store.listLastActorsForBoard("default").find((r) => r.task_id === "t1");
      expect(last?.last_actor).toBe("human");
    } finally {
      store.close();
    }
  });

  it("app (resolveCardExit) sobre humano: hold + diverged, SEM warnAgent; last_actor segue humano", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t2", { status: "running", actor: "agent" }));
      store.upsertTask(base("t2", { status: "done", actor: "human", updated_at: Date.now() + 1 }));
      store.upsertTask(base("t2", { status: "running", actor: "human", updated_at: Date.now() + 2 }));

      const decision = store.upsertTask(base("t2", { status: "failed", actor: "app", updated_at: Date.now() + 3 }));
      expect(decision).toMatchObject({
        status: "running",
        statusChanged: false,
        divergedStatus: "failed",
        divergedActor: "app",
        warnAgent: false,
        recordDeclaration: true,
      });
      expect(store.getTask("t2")!.status).toBe("running");
      expect(store.listLastActorsForBoard("default").find((r) => r.task_id === "t2")?.last_actor).toBe("human");
    } finally {
      store.close();
    }
  });

  it("humano move de novo: limpa divergência", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t3", { status: "done", actor: "agent" }));
      store.upsertTask(base("t3", { status: "running", actor: "human", updated_at: Date.now() + 1 }));
      store.upsertTask(base("t3", { status: "failed", actor: "app", updated_at: Date.now() + 2 }));
      expect(store.getTask("t3")!.diverged_status).toBe("failed");

      store.upsertTask(base("t3", { status: "done", actor: "human", updated_at: Date.now() + 3 }));
      const t = store.getTask("t3")!;
      expect(t.status).toBe("done");
      expect(t.diverged_status).toBeNull();
      expect(t.diverged_actor).toBeNull();
    } finally {
      store.close();
    }
  });

  it("proposta alinhada EXPLÍCITA ao status humano: limpa divergência sem mudar status", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t4", { status: "done", actor: "agent" }));
      store.upsertTask(base("t4", { status: "running", actor: "human", updated_at: Date.now() + 1 }));
      store.upsertTask(base("t4", { status: "failed", actor: "app", updated_at: Date.now() + 2 }));
      expect(store.getTask("t4")!.diverged_status).toBe("failed");

      const decision = store.upsertTask(base("t4", { status: "running", actor: "app", updated_at: Date.now() + 3 }));
      expect(decision.divergedStatus).toBeNull();
      expect(store.getTask("t4")!.status).toBe("running");
      expect(store.getTask("t4")!.diverged_status).toBeNull();
    } finally {
      store.close();
    }
  });

  it("statusProposed:false (update sem status): NÃO limpa divergência — só bookkeeping", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t4b", { status: "done", actor: "agent" }));
      store.upsertTask(base("t4b", { status: "running", actor: "human", updated_at: Date.now() + 1 }));
      store.upsertTask(base("t4b", { status: "failed", actor: "app", updated_at: Date.now() + 2 }));
      expect(store.getTask("t4b")!.diverged_status).toBe("failed");

      const decision = store.upsertTask(
        base("t4b", {
          status: "running", // same as current — but statusProposed:false means "did not propose"
          result_json: JSON.stringify({ note: "partial" }),
          actor: "agent",
          statusProposed: false,
          updated_at: Date.now() + 3,
        }),
      );
      expect(decision.statusChanged).toBe(false);
      expect(decision.divergedStatus).toBe("failed");
      expect(store.getTask("t4b")!.diverged_status).toBe("failed");
      expect(store.getTask("t4b")!.result_json).toContain("partial");
    } finally {
      store.close();
    }
  });

  it("sem lock humano: app/agente ainda sobrescrevem normalmente", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-prec-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t5", { status: "running", actor: "agent" }));
      store.upsertTask(base("t5", { status: "failed", actor: "app", updated_at: Date.now() + 1 }));
      expect(store.getTask("t5")!.status).toBe("failed");
      expect(store.getTask("t5")!.diverged_status).toBeNull();
    } finally {
      store.close();
    }
  });
});
