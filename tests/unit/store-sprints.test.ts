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

  it("close congela snapshot; done/julgada ficam; todo/doing/interrompida(pending) migram", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-close-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("todo1", "b1", "pending"));
    store.upsertTask(makeTask("doing1", "b1", "running"));
    store.upsertTask(makeTask("done1", "b1", "done"));
    store.upsertTask({
      ...makeTask("fail1", "b1", "failed"),
      result_json: JSON.stringify({ failureKind: "julgada", error: "desistiu" }),
    });
    // Interrompida already rewritten to pending by the write path.
    store.upsertTask({
      ...makeTask("intr1", "b1", "pending"),
      result_json: JSON.stringify({ failureKind: "interrompida", error: "exit 129" }),
    });

    const first = store.getActiveSprint("b1")!;
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    expect(closed.closed.id).toBe(first.id);
    expect(closed.closed.count_todo).toBe(2); // todo1 + intr1
    expect(closed.closed.count_doing).toBe(1);
    expect(closed.closed.count_done).toBe(1);
    expect(closed.closed.count_failed).toBe(1); // só julgada
    expect(closed.closed.migrated_out).toBe(3); // todo + doing + interrompida
    expect(closed.opened.migrated_in).toBe(3);

    expect(store.getTask("done1")!.sprint_id).toBe(closed.closed.id);
    expect(store.getTask("fail1")!.sprint_id).toBe(closed.closed.id);
    expect(store.getTask("todo1")!.sprint_id).toBe(closed.opened.id);
    expect(store.getTask("doing1")!.sprint_id).toBe(closed.opened.id);
    expect(store.getTask("intr1")!.sprint_id).toBe(closed.opened.id);

    const snap = store.getSprintSnapshot(closed.closed.id)!;
    expect(snap).toHaveLength(5);
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

  it("renameSprint grava name; null/vazio volta pro fallback Sprint N", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-rename-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("t1", "b1", "pending"));
    const active = store.getActiveSprint("b1")!;
    const renamed = store.renameSprint(active.id, "  Maestro  ");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.sprint.name).toBe("Maestro");
    expect(store.getSprint(active.id)!.name).toBe("Maestro");
    const cleared = store.renameSprint(active.id, "   ");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.sprint.name).toBeNull();
    store.close();
  });

  it("deleteSprint move tasks pro anterior e reabre o fechado (undo do close)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-delete-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("todo1", "b1", "pending"));
    store.upsertTask(makeTask("done1", "b1", "done"));
    const first = store.getActiveSprint("b1")!;
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(store.getTask("todo1")!.sprint_id).toBe(closed.opened.id);
    expect(store.getTask("done1")!.sprint_id).toBe(closed.closed.id);

    const deleted = store.deleteSprint(closed.opened.id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.movedTaskCount).toBe(1);
    expect(deleted.restored!.id).toBe(first.id);
    expect(deleted.restored!.closed_at).toBeNull();
    expect(deleted.restored!.snapshot_json).toBeNull();
    expect(store.getSprint(closed.opened.id)).toBeUndefined();
    expect(store.getActiveSprint("b1")!.id).toBe(first.id);
    expect(store.getTask("todo1")!.sprint_id).toBe(first.id);
    expect(store.getTask("done1")!.sprint_id).toBe(first.id);
    store.close();
  });

  it("deleteSprint recusa sprint fechado; recusa único com tasks; apaga vazio sem anterior", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-sprint-delete-refuse-"));
    const store = openStore(dir);
    store.upsertBoard(makeBoard("b1"));
    store.upsertTask(makeTask("t1", "b1", "pending"));
    const only = store.getActiveSprint("b1")!;
    const refuseOnly = store.deleteSprint(only.id);
    expect(refuseOnly.ok).toBe(false);
    if (refuseOnly.ok) return;
    expect(refuseOnly.error).toMatch(/only sprint/i);

    // Close with a done-only board so the NEW active sprint is empty —
    // pending t1 must be finished first so nothing migrates.
    store.upsertTask({ ...store.getTask("t1")!, status: "done", actor: "human" });
    const closed = store.closeSprint("b1");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.opened.migrated_in).toBe(0);
    const refuseClosed = store.deleteSprint(closed.closed.id);
    expect(refuseClosed.ok).toBe(false);
    if (refuseClosed.ok) return;
    expect(refuseClosed.error).toMatch(/closed/i);

    const emptyActive = store.getActiveSprint("b1")!;
    expect(emptyActive.id).toBe(closed.opened.id);
    const delEmpty = store.deleteSprint(emptyActive.id);
    expect(delEmpty.ok).toBe(true);
    if (!delEmpty.ok) return;
    expect(delEmpty.movedTaskCount).toBe(0);
    expect(store.getActiveSprint("b1")!.id).toBe(closed.closed.id);

    // Sole empty active (no previous): just delete the row.
    store.upsertBoard(makeBoard("b2"));
    const openB2 = store.openSprint("b2");
    expect(openB2.ok).toBe(true);
    if (!openB2.ok) return;
    const delSole = store.deleteSprint(openB2.sprint.id);
    expect(delSole.ok).toBe(true);
    if (!delSole.ok) return;
    expect(delSole.restored).toBeNull();
    expect(store.getActiveSprint("b2")).toBeUndefined();
    store.close();
  });
});
