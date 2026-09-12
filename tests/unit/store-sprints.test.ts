import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow, type BoardRow } from "../../src/main/store";

function makeBoard(id: string): BoardRow {
  return {
    id,
    name: `Board ${id}`,
    project: "",
    cwd: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
  };
}

function makeTask(id: string, boardId: string, status: string): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: `task ${id}`,
    provider: null,
    status,
    card_id: null,
    board_id: boardId,
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
    sprint_id: null,
    created_at: now,
    updated_at: now,
    actor: "human",
  };
}

describe("store.ts: sprints — snapshot no fechamento + migração", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("upsert com board_id atribui sprint ativo (cria se precisar)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-assign-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("t1", "b1", "pending"));
    const task = store.getTask("t1")!;
    const active = store.getActiveSprint("b1")!;
    expect(active.closed_at).toBeNull();
    expect(active.number).toBe(1);
    expect(task.sprint_id).toBe(active.id);
    store.close();
  });

  it("close congela snapshot; done/failed ficam; todo/doing migram", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-close-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("todo1", "b1", "pending"));
    store.upsertTask(makeTask("doing1", "b1", "running"));
    store.upsertTask(makeTask("done1", "b1", "done"));
    store.upsertTask(makeTask("fail1", "b1", "failed"));

    const first = store.getActiveSprint("b1")!;
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    expect(closed.closed.id).toBe(first.id);
    expect(closed.closed.closed_at).not.toBeNull();
    expect(closed.closed.number).toBe(1);
    expect(closed.opened.number).toBe(2);
    expect(closed.closed.count_todo).toBe(1);
    expect(closed.closed.count_doing).toBe(1);
    expect(closed.closed.count_done).toBe(1);
    expect(closed.closed.count_failed).toBe(1);
    expect(closed.closed.migrated_out).toBe(2);
    expect(closed.opened.migrated_in).toBe(2);
    expect(closed.opened.closed_at).toBeNull();

    // Done + failed stay on closed sprint; unfinished open work moved.
    expect(store.getTask("done1")!.sprint_id).toBe(closed.closed.id);
    expect(store.getTask("fail1")!.sprint_id).toBe(closed.closed.id);
    expect(store.getTask("todo1")!.sprint_id).toBe(closed.opened.id);
    expect(store.getTask("doing1")!.sprint_id).toBe(closed.opened.id);

    // Frozen board snapshot includes all four as they were at close.
    const snap = store.getSprintSnapshot(closed.closed.id)!;
    expect(snap).toHaveLength(4);
    expect(snap.map((t) => t.id).sort()).toEqual(["doing1", "done1", "fail1", "todo1"]);

    // Snapshot counts do NOT change when a migrated task later finishes.
    store.upsertTask({ ...store.getTask("todo1")!, status: "done", actor: "human" });
    const listed = store.listSprints("b1");
    const frozen = listed.find((s) => s.id === closed.closed.id)!;
    expect(frozen.count_todo).toBe(1);
    expect(frozen.count_done).toBe(1);
    expect(frozen.count_todo + frozen.count_doing + frozen.count_done + frozen.count_failed).toBe(4);
    store.close();
  });

  it("fila vazia e already-closed recusam com motivo", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-empty-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    const open = store.openSprint("b1");
    expect(open.ok).toBe(true);
    const empty = store.closeSprint("b1");
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toMatch(/empty/i);

    // Close a sprint that only has done work — nothing migrates, so the
    // newly opened sprint is empty and a second close must refuse.
    store.upsertTask(makeTask("done1", "b1", "done"));
    const c1 = store.closeSprint("b1");
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(c1.closed.migrated_out).toBe(0);
    expect(c1.opened.migrated_in).toBe(0);
    const c2 = store.closeSprint("b1");
    expect(c2.ok).toBe(false);
    if (c2.ok) return;
    expect(c2.error).toMatch(/empty/i);
    store.close();
  });

  it("failed retomada (drag pra a fazer) entra no sprint CORRENTE", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-resume-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("keep", "b1", "done"));
    store.upsertTask(makeTask("fail1", "b1", "failed"));
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(store.getTask("fail1")!.sprint_id).toBe(closed.closed.id);

    store.upsertTask({ ...store.getTask("fail1")!, status: "pending", actor: "human" });
    expect(store.getTask("fail1")!.sprint_id).toBe(closed.opened.id);
    // Closed snapshot untouched.
    const frozen = store.listSprints("b1").find((s) => s.id === closed.closed.id)!;
    expect(frozen.count_failed).toBe(1);
    store.close();
  });

  it("migração NÃO é barrada pela trava humana de status (UPDATE dedicado)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-lock-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("t1", "b1", "pending"));
    store.upsertTask(makeTask("done1", "b1", "done"));
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const task = store.getTask("t1")!;
    expect(task.status).toBe("pending");
    expect(task.sprint_id).toBe(closed.opened.id);
    store.close();
  });

  it("openSprint é idempotente enquanto há sprint ativo", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-open-idem-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    const a = store.openSprint("b1");
    const b = store.openSprint("b1");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.sprint.id).toBe(b.sprint.id);
    expect(store.listSprints("b1")).toHaveLength(1);
    store.close();
  });
});
