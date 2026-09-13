import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * `link_task_card` — role writer for a card that ALREADY exists (the
 * "reuse a live card as reviewer" pattern). Sister of spawn_agent's
 * `role`. Fixed here:
 *  - reviewer → `linkTaskCard` only, `card_id` untouched;
 *  - implementer (default when omitted) → becomes principal `card_id`
 *    (upsertTask, status not proposed) AND explicit role row;
 *  - refusals happen before any write: unknown task, card not open,
 *    unknown role, principal card asked to become reviewer.
 */
function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-link",
    prompt: "work",
    provider: "claude",
    status: "running",
    card_id: "impl",
    board_id: "b1",
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
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("message-bus: link_task_card", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function run(req: Record<string, unknown>, existing: TaskRow | undefined = task(), openCards = ["impl", "rev"]) {
    dir = mkdtempSync(join(tmpdir(), "stellar-link-task-card-"));
    const upserted: TaskRow[] = [];
    const linked: Array<{ taskId: string; cardId: string; role: string }> = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "getTask") return (id: string) => (existing && id === existing.id ? existing : undefined);
            if (prop === "listCards") return () => openCards.map((id) => ({ id, kind: "terminal", provider: "claude", cwd: "", label: null }));
            if (prop === "upsertTask")
              return (t: TaskRow) => {
                upserted.push(t);
                return applied(t.status);
              };
            if (prop === "linkTaskCard") return (taskId: string, cardId: string, role: string) => linked.push({ taskId, cardId, role });
            if (prop === "listAllConnectors") return () => [];
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    const res = (await bus.handleRequest({ cmd: "link_task_card", ...req } as BusRequest)) as Record<string, unknown>;
    return { res, upserted, linked };
  }

  it("reviewer: só a linha de papel; card_id da task não muda", async () => {
    const { res, upserted, linked } = await run({ taskId: "t-link", cardId: "rev", role: "reviewer" });
    expect(res).toEqual({ ok: true, taskId: "t-link", cardId: "rev", role: "reviewer" });
    expect(linked).toEqual([{ taskId: "t-link", cardId: "rev", role: "reviewer" }]);
    expect(upserted).toEqual([]);
  });

  it("implementer (default quando omitido): vira card_id principal sem propor status, e grava o papel explícito", async () => {
    const { res, upserted, linked } = await run({ taskId: "t-link", cardId: "rev" });
    expect(res).toEqual({ ok: true, taskId: "t-link", cardId: "rev", role: "implementer" });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].card_id).toBe("rev");
    expect(upserted[0].status).toBe("running");
    expect(upserted[0].statusProposed).toBe(false);
    expect(upserted[0].actor).toBe("agent");
    expect(linked).toEqual([{ taskId: "t-link", cardId: "rev", role: "implementer" }]);
  });

  it("role inválido: recusado, nada gravado, nenhum default inventado", async () => {
    const { res, upserted, linked } = await run({ taskId: "t-link", cardId: "rev", role: "observer" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('got "observer"');
    expect(upserted).toEqual([]);
    expect(linked).toEqual([]);
  });

  it("card principal pedido como reviewer: recusado — as duas tabelas não podem discordar do mesmo card", async () => {
    const { res, linked } = await run({ taskId: "t-link", cardId: "impl", role: "reviewer" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("principal card");
    expect(linked).toEqual([]);
  });

  it("task inexistente / card não aberto / campos faltando: recusa antes de escrever", async () => {
    const missingTask = await run({ taskId: "nope", cardId: "rev", role: "reviewer" }, undefined);
    expect(missingTask.res).toEqual({ ok: false, error: 'no such task "nope"' });
    expect(missingTask.linked).toEqual([]);

    const closedCard = await run({ taskId: "t-link", cardId: "ghost", role: "reviewer" });
    expect(closedCard.res).toEqual({ ok: false, error: 'no open card with id "ghost"' });
    expect(closedCard.linked).toEqual([]);

    expect((await run({ cardId: "rev" })).res).toEqual({ ok: false, error: "missing taskId" });
    expect((await run({ taskId: "t-link" })).res).toEqual({ ok: false, error: "missing cardId" });
  });
});
