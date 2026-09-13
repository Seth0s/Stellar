import type { StatusWriteDecision } from "./status-write-decision";
import type { TaskRow } from "./store";

/**
 * The one funnel every task write goes through in the main process —
 * agent (`create_task`/`update_task` via MCP or acbridge), the engine's own
 * auto-dispatch/retry writes, and the three human gestures on the Fila
 * (approve button, drag to a column, Allow on a status ask). `index.ts`
 * builds it once and hands `persistTask` to the message bus as its
 * `upsertTask` callback, so there is no second entry point.
 *
 * Why it exists (2026-09-13): "task reached `done` → dispatch dependents"
 * was decided in ONE caller only (`update_task`, message-bus.ts). Every
 * other writer of `done` — approve button, drag to "concluído", Allow on
 * an ask — wrote the row and nothing observed it: the dependent stayed
 * `pending` forever (312d4c0a, deps=[97f34bf8], parent done by button,
 * 0 task_cards). Spreading `onTaskDone(id)` into each handler would be a
 * fifth copy of the rule and the next new writer would be born dead
 * again. The detection is made here, once, from the `StatusWriteDecision`
 * the store returns — never from what the caller *meant* to write, since
 * the store may HOLD a write (decision 8, human lock) and a held write
 * must not unblock anyone.
 *
 * Re-entrancy: `onTaskDone` writes back through `persistTask` (dependent →
 * `running`), which lands here again. `running` is not `done`, so the
 * chain stops after one level; a task never reaches `done` as a side
 * effect of dispatch, so there is no recursion. Double dispatch is guarded
 * at the other end (message-bus.ts `dispatchIfUnblocked` marks `running`
 * before spawning and checks `statusChanged`), and the second `done`
 * write of a near-simultaneous pair arrives with `statusChanged: false`
 * (already done), so it never reaches `onTaskDone` at all.
 */
export type TaskWriteFunnelDeps = {
  upsertTask: (task: TaskRow) => StatusWriteDecision;
  applyColumnDrop: (dragged: TaskRow, siblingImplicitOrders: { id: string; implicitOrder: number }[]) => StatusWriteDecision;
  /** Push to whoever has the board open + the scope footer. Called once
   * per write, before dependents are considered (same order `update_task`
   * always had: persist → push → dispatch). */
  afterWrite: (boardId: string | null) => void;
  /** The bus's dependents engine (`createMessageBus(...).onTaskDone`).
   * Looked up per call, not captured: in `index.ts` the bus is created
   * AFTER the funnel and holds it as a callback. */
  onTaskDone: (taskId: string) => void;
};

/** Pure predicate, exported so tests and the funnel agree on one
 * definition: the row's status actually CHANGED and the resulting status
 * is `done`. `statusChanged` already implies the previous status was not
 * `done`, so no separate "was it done before" check is needed. */
export function reachedDone(decision: StatusWriteDecision): boolean {
  return decision.statusChanged && decision.status === "done";
}

export function createTaskWriteFunnel(deps: TaskWriteFunnelDeps) {
  function settle(task: TaskRow, decision: StatusWriteDecision): StatusWriteDecision {
    deps.afterWrite(task.board_id);
    if (reachedDone(decision)) deps.onTaskDone(task.id);
    return decision;
  }
  return {
    persistTask: (task: TaskRow): StatusWriteDecision => settle(task, deps.upsertTask(task)),
    persistColumnDrop: (dragged: TaskRow, siblingImplicitOrders: { id: string; implicitOrder: number }[]): StatusWriteDecision =>
      settle(dragged, deps.applyColumnDrop(dragged, siblingImplicitOrders)),
  };
}
