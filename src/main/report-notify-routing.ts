/**
 * Pure routing decision for `notifySpawnerOfIdleCard`/`notifySpawnerOfReport`
 * (message-bus.ts) — "given a card that just went idle or reported, who (if
 * anyone) should be pushed a notification?"
 *
 * DESIGN-BACKLOG.md §0 "Push de report se perde em silencio quando o
 * orquestrador READOTA um card" (achado ao vivo, 2026-09-11) — the routing
 * used to be a single question, "who spawned this card, and are they still
 * alive?" (`resolveLiveSpawner`'s `kind === "spawned"` connector lookup).
 * That premise breaks under READOPTION: an orchestrator that reattaches to
 * an already-existing card (after a restart that lost its session — the
 * `resume_id` bug immediately above this one in the backlog) briefs it via
 * `send_to_card`, never `spawn_agent`. No `spawned` connector is ever
 * created for that pairing, so the old single-source lookup returned `null`
 * and the caller's `if (!spawnerId) return` silently dropped the push —
 * confirmed live: the report itself was fine (`read_report` returned it
 * normally), only the push vanished, with no log, no error, nothing.
 *
 * RODADA 1 (this fix's first version): add a 2nd source — the last card
 * that sent this card a directive via `send_to_card`, tracked directly by
 * `recordDirectiveSent` (message-bus.ts's `send` cmd handler) rather than
 * inferred from the connector graph at all ("fecha o caso de readoção sem
 * depender de conector nenhum" — the backlog's own wording) — with
 * `directiveFrom` winning over `spawnedBy` unconditionally whenever it was
 * present and alive, on the argument that a directive can only ever be sent
 * to a card that already exists, so any recorded directive is causally
 * AFTER that card's spawn — making "prefer directive when present"
 * equivalent to "prefer whichever source is more recent".
 *
 * RODADA 2 (review adversarial, this rodada) — that causal argument is true
 * but the conclusion drawn from it only holds with ONE actor in the
 * picture. Stellar is explicitly multi-agent: any card can `send_to_card`
 * any other, and doing so is normal use, not something only the "rightful"
 * orchestrator does. Concretely: orchestrator A spawns worker W (`spawned`
 * connector, A alive throughout). While W works, an unrelated card B — a
 * sibling agent, a second orchestrator, anyone — sends W one message for
 * its own reasons. `directiveFrom` now points at B, and RODADA 1's
 * unconditional preference pushed W's eventual report to B, never to A —
 * who spawned W, is alive, and is the one actually waiting. Blind
 * "most-recently-talked-to" is a hijack vector the moment there's more than
 * one actor who might legitimately talk to a card.
 *
 * Fix — invert the precedence: a live `spawnedBy` now wins UNCONDITIONALLY,
 * `directiveFrom` only ever applies as a fallback for when there's no live
 * spawner on record at all. This closes RODADA 2's hijack (A stays alive,
 * A's `spawned` connector never went anywhere, so B's unrelated message
 * never gets a look-in) while STILL fixing the original bug: what actually
 * failed in the live incident was never "the spawner died" — card 330 (the
 * orchestrator) survived the restart with the same id, same liveness, the
 * whole time. What was missing was the `spawned` CONNECTOR ROW itself —
 * absence, not liveness. CORRECTION (review rodada 2, achado 2): an earlier
 * version of this comment blamed "the restart" for losing that row. That was
 * wrong, and worth writing down because it nearly became folklore: connector
 * rows are plain SQLite and survive restarts intact. The real mechanism is
 * `deleteCardDirect` (main/index.ts), which calls
 * `store.deleteConnectorsForCard` before deleting a card — so closing the
 * card that did the spawning cascades ITS connectors away, and any worker it
 * spawned is left with no lineage at all. A card spawned by a human, never by
 * an orchestrator, reaches the same state by simply never having had one.
 * Either way the row is ABSENT, which is what this function actually keys
 * on, so the routing below is unchanged by the correction. So `spawnedById` for
 * the readopted worker resolves to `null` — not "present but dead" — and
 * this function falls straight through to `directiveFrom`, which is 330
 * itself (the same card that re-briefed the worker via `send_to_card` after
 * reattaching). Same correct outcome as RODADA 1 for the bug that motivated
 * this task; RODADA 2's hijack scenario, which requires the `spawned`
 * connector to still be alive and present, no longer reaches `directiveFrom`
 * at all.
 *
 * What this loses (asked for explicitly in review, stated plainly rather
 * than hidden): a GENUINE hand-off — orchestrator A spawns W, then
 * deliberately delegates ongoing stewardship of W to orchestrator C, A
 * stays alive but has moved on — will still route W's report to A, not C,
 * as long as A's `spawned` connector exists and A hasn't exited, even
 * though C is the one actually waiting now. This function alone cannot
 * distinguish "C sent W a message" from "C took over W" — and deliberately
 * doesn't try to guess (a message-content or frequency heuristic here would
 * be exactly the "heuristica fragil" this task was told to avoid). The
 * escape hatch already exists and needs no new code: `set_connector_kind`
 * (mcp-server.ts) lets any card explicitly retag its OWN connector to a
 * target as `"spawned"` — store.ts's `setConnectorKind` bumps that row's
 * `updated_at` on write, and `resolveLiveSpawner` (message-bus.ts) always
 * picks the most-recently-updated `spawned` connector into a card. A
 * deliberate hand-off is therefore one explicit `set_connector_kind` call
 * away from being the recognized spawner-of-record — the same tool, and the
 * same "you'd only touch this to annotate one by hand" case its own
 * description already names — while an ordinary, non-hand-off message
 * never silently acquires that status just by being sent.
 *
 * The common case — orchestrator spawns a card, the card reports once, no
 * `send_to_card` ever happened in between — never populates `directiveFrom`
 * at all, so this falls through to `spawnedBy` exactly as before either
 * rodada. That path is unaffected by any of the above: same source (the
 * `spawned` connector lookup, still in message-bus.ts, still checking
 * `isCardAlive`), same result.
 */

export interface ReportRoutingInput {
  /** The card id that last sent this card a directive via `send_to_card`
   * (message-bus.ts's `lastDirectiveFrom` map), or `null` if none ever did
   * (or the map was reset, e.g. by a main-process restart). Consulted only
   * as a FALLBACK — see this module's RODADA 2 doc comment above. */
  directiveFromId: string | null;
  /** Whether `directiveFromId` is still a live card (`isCardAlive`).
   * Meaningless when `directiveFromId` is `null`. */
  directiveFromAlive: boolean;
  /** The card id that spawned this card, per the most recent `spawned`
   * connector pointing at it (`resolveLiveSpawner`'s existing lookup), or
   * `null` if none exists. Wins unconditionally over `directiveFromId`
   * whenever present and alive. */
  spawnedById: string | null;
  /** Whether `spawnedById` is still a live card (`isCardAlive`).
   * Meaningless when `spawnedById` is `null`. */
  spawnedByAlive: boolean;
}

export type ReportRoutingDecision =
  | { targetId: string; source: "directive" | "spawned" }
  | { targetId: null; source: "none" };

export function decideReportNotifyTarget(input: ReportRoutingInput): ReportRoutingDecision {
  // RODADA 2 — spawned lineage checked FIRST, unconditionally, so a live
  // spawner can never be shouldered aside by an unrelated card that merely
  // sent a message (this module's own hijack scenario, doc comment above).
  if (input.spawnedById && input.spawnedByAlive) {
    return { targetId: input.spawnedById, source: "spawned" };
  }
  // Fallback only: no live spawner on record at all — a card a human opened
  // (never had a `spawned` connector), or one whose spawner card was closed,
  // taking its connectors with it via `deleteConnectorsForCard`. The last
  // directive sender is the best remaining signal of who actually wants to
  // know.
  if (input.directiveFromId && input.directiveFromAlive) {
    return { targetId: input.directiveFromId, source: "directive" };
  }
  return { targetId: null, source: "none" };
}
