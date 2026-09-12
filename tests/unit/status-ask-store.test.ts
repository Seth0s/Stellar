import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

/**
 * Third path at the store choke point: setStatusAsk never touches
 * status/diverged_*; a later human status write clears the ask; an
 * agent hold leaves both signals in place.
 */
describe("store.ts: pedido de status (terceiro caminho)", () => {
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

  it("setStatusAsk estaciona o pedido sem mudar status nem diverged_*", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { actor: "human" }));
      store.upsertTask(base("t1", { status: "done", actor: "agent", updated_at: Date.now() + 1 }));
      expect(store.getTask("t1")!.status).toBe("pending");
      expect(store.getTask("t1")!.diverged_status).toBe("done");

      const parked = store.setStatusAsk("t1", {
        status: "done",
        reason: "protótipo aceito",
        requesterId: "416",
        at: Date.now() + 2,
      });
      expect(parked).toEqual({ ok: true });

      const t = store.getTask("t1")!;
      expect(t.status).toBe("pending");
      expect(t.diverged_status).toBe("done");
      expect(t.diverged_actor).toBe("agent");
      expect(t.requested_status).toBe("done");
      expect(t.requested_reason).toBe("protótipo aceito");
      expect(t.requested_by).toBe("416");
      expect(t.transitions!.filter((x) => x.kind === "request")).toHaveLength(1);
      expect(t.transitions!.find((x) => x.kind === "status" && x.to_value === "done")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("humano aceita via upsert: aplica status, limpa pedido E divergência", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t2", { actor: "human" }));
      store.setStatusAsk("t2", { status: "done", reason: "feito", requesterId: "9", at: Date.now() + 1 });
      store.upsertTask(base("t2", { status: "done", actor: "human", updated_at: Date.now() + 2 }));

      const t = store.getTask("t2")!;
      expect(t.status).toBe("done");
      expect(t.requested_status).toBeNull();
      expect(t.requested_reason).toBeNull();
      expect(t.diverged_status).toBeNull();
    } finally {
      store.close();
    }
  });

  it("humano recusa: limpa só o pedido; divergência e status ficam", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t3", { actor: "human" }));
      store.upsertTask(base("t3", { status: "done", actor: "agent", updated_at: Date.now() + 1 }));
      store.setStatusAsk("t3", { status: "done", reason: "feito", requesterId: "9", at: Date.now() + 2 });
      expect(store.setStatusAsk("t3", null)).toEqual({ ok: true });

      const t = store.getTask("t3")!;
      expect(t.status).toBe("pending");
      expect(t.diverged_status).toBe("done");
      expect(t.requested_status).toBeNull();
      expect(t.transitions!.some((x) => x.kind === "request_denied")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("escrita direta de agente (decisão 8) com pedido vivo: hold + divergência, pedido permanece", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t4", { actor: "human" }));
      store.setStatusAsk("t4", { status: "done", reason: "feito", requesterId: "9", at: Date.now() + 1 });
      const decision = store.upsertTask(base("t4", { status: "done", actor: "agent", updated_at: Date.now() + 2 }));
      expect(decision).toMatchObject({ status: "pending", statusChanged: false, warnAgent: true, divergedStatus: "done" });

      const t = store.getTask("t4")!;
      expect(t.requested_status).toBe("done");
      expect(t.diverged_status).toBe("done");
    } finally {
      store.close();
    }
  });

  it("task inexistente: setStatusAsk recusa", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-status-ask-"));
    const store = openStore(dir);
    try {
      expect(store.setStatusAsk("missing", { status: "done", reason: null, requesterId: null, at: 1 })).toEqual({
        ok: false,
        error: 'no such task "missing"',
      });
    } finally {
      store.close();
    }
  });
});
