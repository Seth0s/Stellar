import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * Task 6266d3e7 — ids curtos em TODAS as tools que recebem `taskId`. Um prefixo
 * único (>= 8) resolve; ambíguo RECUSA listando os candidatos (nunca adivinha).
 * Exercitado pelo `update_task` (não pelo `get_task`, que já tinha a fatia).
 */

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    spawn_profile: null,
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
    ...over,
  } as unknown as TaskRow;
}

function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: false, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

const AMBIG_A = "abcd1234-0000-4000-8000-000000000001";
const AMBIG_B = "abcd1234-0000-4000-8000-000000000002";

describe("ids curtos em todas as tools (task 6266d3e7)", () => {
  let ctx: { bus: ReturnType<typeof createMessageBus>; dir: string; upserted: TaskRow[] } | null = null;

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function rig() {
    const dir = mkdtempSync(join(tmpdir(), "stellar-short-ids-"));
    const tasks = new Map<string, TaskRow>([
      [AMBIG_A, baseTask(AMBIG_A)],
      [AMBIG_B, baseTask(AMBIG_B)],
    ]);
    const upserted: TaskRow[] = [];
    const callbacks = new Proxy(
      {
        getTask: (id: string) => tasks.get(id),
        listTasks: () => [...tasks.values()],
        upsertTask: (t: TaskRow) => {
          upserted.push(t);
          return applied(t.status);
        },
        getTaskCards: () => [],
        listTaskCardsForCard: () => [],
      },
      { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
    ) as Parameters<typeof createMessageBus>[1];
    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, dir, upserted };
  }

  it("prefixo ÚNICO em update_task resolve para o id completo", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "update_task", taskId: "abcd1234-0000-4000-8000-000000000001", suggestedOrder: 7 } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(ctx.upserted).toHaveLength(1);
    expect(ctx.upserted[0]!.id).toBe(AMBIG_A);
  });

  it("prefixo de 8 chars que casa DUAS tasks é RECUSADO listando os candidatos", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "update_task", taskId: "abcd1234", suggestedOrder: 7 } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ambiguous");
    expect(res.error).toContain("abcd1234");
    expect(ctx.upserted).toHaveLength(0);
  });

  it("prefixo curto demais (< 8) não resolve", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "update_task", taskId: "abcd", suggestedOrder: 7 } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no such task");
  });

  it("a resolução vale para o get_task também (id exato continua vencendo)", async () => {
    ctx = rig();
    const res = (await ctx.bus.handleRequest({ cmd: "get_task", taskId: "abcd1234-0000-4000-8000-000000000002" } as BusRequest)) as { ok: boolean; task?: { id: string } };
    expect(res.ok).toBe(true);
    expect(res.task!.id).toBe(AMBIG_B);
  });
});
