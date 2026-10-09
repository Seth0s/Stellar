/**
 * Complete TaskRow factory for unit tests.
 *
 * `spawn_profile` (and the other required columns) must be present — a
 * Partial spread into an incomplete literal makes TypeScript treat required
 * fields as optional (TS2322/TS2741), and `as TaskRow` would lie about shape.
 * Object.assign keeps the return typed as TaskRow while allowing overrides.
 */
import type { TaskRow } from "../../src/main/store";

const DEFAULTS: TaskRow = {
  id: "t1",
  prompt: "prompt",
  provider: "claude",
  status: "pending",
  card_id: null,
  board_id: "b1",
  cwd: null,
  spawn_profile: null,
  result_json: null,
  deps_json: null,
  purpose: null,
  review: null,
  territory_json: null,
  gates_json: null,
  allow_commit: null,
  report_schema_json: null,
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
};

export function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return Object.assign({}, DEFAULTS, overrides);
}
