/**
 * Pure lineage decision: given a card, who spawned it / last directed it
 * via `send_to_card`? Live `spawned` wins; inbound `modified` is fallback.
 * Fed by `resolveNotifyTarget` in message-bus.ts for the AGENT-half push
 * (short PTY pointer via `enqueueCardDelivery`) when a card reports or
 * exits without report. OS notifications stay removed — this module only
 * answers "who", never "how to popup".
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
 * an in-memory `lastDirectiveFrom` Map in message-bus.ts — with
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
 *
 * RODADA 3 (DESIGN-BACKLOG.md §0 "Relatorio nao chega ao orquestrador
 * depois de um restart", 2026-09-12) — RODADA 1's in-memory Map died on
 * every main-process restart, so a card that was ONLY ever directed (never
 * spawned — connector `kind: "modified"`, not `"spawned"`) reported into
 * `{ targetId: null, source: "none" }` the morning after: report on disk,
 * nobody notified. The `connectors` row already held the edge, the
 * directive label, and `updated_at` across the restart; it just wasn't
 * read as a route. Directive fallback now comes from
 * `pickLatestDirectiveSender` below (most recent `kind === "modified"`
 * edge INTO the reporting card) — same SQLite table the spawned path
 * already trusts, no second volatile source of truth. Precedence from
 * RODADA 2 is unchanged: live spawner still wins unconditionally;
 * `modified` is never promoted to lineage.
 *
 * RODADA 4 (task 5abe8bf5) — a aresta `spawned` é só a aresta VISUAL: ela
 * morre junto com o card que spawnou (`deleteConnectorsForCard`, main/index.ts)
 * e, até esta rodada, era a ÚNICA fonte de linhagem do roteamento. Medido no
 * banco vivo: o registro append-only `spawns` tem 231 destinos e apenas 9
 * ainda têm aresta visual — 222 perderam o único sinal de linhagem que este
 * módulo lia, e para eles o roteamento ficava ESTRUTURALMENTE empurrado para
 * o fallback "último que falou". `spawnerOfRecordId` abaixo é essa linhagem
 * durável: entra ACIMA do fallback de diretiva e ABAIXO de uma aresta visual
 * VIVA (que continua sendo o sinal mais recente). Mesmo princípio da RODADA 3
 * — preferir a linha em SQLite à fonte volátil —, um degrau acima.
 *
 * RODADA 5 (task 98c99324) — o limite que a RODADA 4 declarou: se o
 * spawner-of-record está MORTO, a decisão ainda caía no fallback "último que
 * falou". Fechado com `none` explícito (ver o ramo), e a medição no board
 * vivo decidiu — não a elegância:
 *
 *   - `spawns` tem 231 linhas e 231 destinos distintos: 147 de origem AGENTE
 *     (`from_card_id` preenchido) e 84 de origem HUMANA (NULL). Só os 147 têm
 *     spawner-of-record; um card humano nunca entra neste ramo.
 *   - 19 terminais abertos: 9 têm spawner de registro VIVO (roteiam por
 *     `spawned`), **0 têm spawner de registro MORTO**, 10 não têm registro.
 *     Ou seja, o estado desta rodada está ESTRUTURALMENTE aberto e hoje
 *     VAZIO — a escolha abaixo afeta 0 cards, então foi decidida pelo que
 *     acontece quando ele ocorrer, não pela frequência.
 *   - o board inteiro tem 11 conectores (9 `spawned`, 2 `modified`), um único
 *     alvo de `modified`, e **nenhum card com registro E diretiva ao mesmo
 *     tempo**. É por isso que o fallback parecia certo: hoje ele nem tem para
 *     onde cair. Um `send_to_card` posterior criaria a aresta que faltava e
 *     transformaria o acaso em sequestro — `none` explícito corta isso.
 *   - a alternativa (c) "dono vivo da task" foi medida e RECUSADA: entre os
 *     147 spawns de agente, o criador da task é o próprio spawner em 71
 *     (redundante — mesmo id, morto), DIVERGE em 16 e não existe em 60.
 *   - a alternativa (d) "mark do board" não é um degrau abaixo: é o PRIMEIRO
 *     ramo desta função. Boards 64 e 97924025 têm mark NULL; o 118 tem
 *     97924064 vivo — e nos três, quando o mark existe e vive, esta rodada
 *     nunca é alcançada.
 *
 * `none` aqui é resposta honesta, não descarte: o report continua no disco e
 * legível por `read_report` (a RODADA 3 existe para não perder o report
 * quando há alvo; aqui não há alvo conhecido). O que não se faz é entregar a
 * um terceiro.
 */

/** Minimal connector shape this module needs — matches store.ts's
 * `ConnectorRow` fields used for routing, without importing the store. */
export type DirectiveConnectorEdge = {
  kind: string | null;
  from_card_id: string;
  to_card_id: string;
  updated_at: number;
};

/**
 * Who last directed `cardId` via `send_to_card`, as persisted on the
 * connector graph (`kind === "modified"`, written by AUTO_CONNECT_CMDS
 * for `send` — never inferred from label text).
 *
 * Multiple `modified` edges into the same target (A briefed W, then B
 * briefed W later): pick the highest `updated_at`. Same rule
 * `resolveLiveSpawner` already uses for competing `spawned` edges, and
 * the same "last writer wins" semantics the old in-memory Map had —
 * subsequent `send`s bump `updated_at` via `setConnectorLabel`, so a
 * later brief from the same pair still wins without creating a second
 * row. Only inbound edges count (`to_card_id === cardId`); an outbound
 * `modified` from the reporting card is someone ELSE's directive, not
 * ours. `browser_*` also auto-connects as `modified`, but those edges
 * point at browser cards, which never call `report` — so filtering by
 * the reporting card's id keeps them out without a second kind.
 */
export function pickLatestDirectiveSender(
  connectors: readonly DirectiveConnectorEdge[],
  cardId: string,
): string | null {
  const latest = connectors
    .filter((c) => c.kind === "modified" && c.to_card_id === cardId)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  return latest?.from_card_id ?? null;
}

export interface ReportRoutingInput {
  /** The card id that last sent this card a directive via `send_to_card`
   * (resolved from the most recent `kind === "modified"` connector into
   * this card — see `pickLatestDirectiveSender`), or `null` if none.
   * Consulted only as a FALLBACK — see this module's RODADA 2 doc
   * comment above. Survives main-process restarts because the connector
   * row lives in SQLite (RODADA 3). */
  directiveFromId: string | null;
  /** Whether `directiveFromId` is still a live card (`isCardAlive`).
   * Meaningless when `directiveFromId` is `null`. */
  directiveFromAlive: boolean;
  /** The card id that spawned this card, per the most recent `spawned`
   * connector pointing at it (`resolveLiveSpawner`'s existing lookup), or
   * `null` if none exists. Wins unconditionally over `directiveFromId`
   * whenever present and alive — unless a board orchestrator mark is set. */
  spawnedById: string | null;
  /** Whether `spawnedById` is still a live card (`isCardAlive`).
   * Meaningless when `spawnedById` is `null`. */
  spawnedByAlive: boolean;
  /**
   * Spawner-of-RECORD from the durable `spawns` registry
   * (`findSpawnByChild`), or `null`. It is the SAME lineage fact as
   * `spawnedById`, from the source that survives the spawner card being
   * closed — the connector is only the visual edge (see this module's
   * RODADA 4 doc and `spawn_lineage`). Consulted only when there is no LIVE
   * visual spawn edge; still below a live one, still above the directive
   * fallback.
   */
  spawnerOfRecordId?: string | null;
  /** Whether `spawnerOfRecordId` is still a live card (`isCardAlive`).
   * Meaningless when the id is null/absent. */
  spawnerOfRecordAlive?: boolean;
  /**
   * Board orchestrator mark (`boards.orchestrator_card_id`), or `null`
   * when the board is unmarked. When present and alive, this is THE
   * report target for the board — not a second router, the same function
   * with one more input. Dead mark escalates to the human (`none`) and
   * does NOT fall through to spawned/directive (owner: never trap).
   */
  orchestratorCardId?: string | null;
  /** Whether `orchestratorCardId` is still a live card. Meaningless when
   * the id is null/absent. */
  orchestratorAlive?: boolean;
}

export type ReportRoutingDecision =
  | { targetId: string; source: "directive" | "spawned" | "orchestrator" }
  | { targetId: null; source: "none" };

export function decideReportNotifyTarget(input: ReportRoutingInput): ReportRoutingDecision {
  // Board mark — when set and alive, reports go to the orchestrator.
  // When set but dead, escalate to human (none): do not fall through to
  // lineage, or a closed/hung mark would silently re-route to a spawner.
  const orchId = input.orchestratorCardId ?? null;
  if (orchId) {
    if (input.orchestratorAlive) {
      return { targetId: orchId, source: "orchestrator" };
    }
    return { targetId: null, source: "none" };
  }
  // RODADA 2 — spawned lineage checked FIRST, unconditionally, so a live
  // spawner can never be shouldered aside by an unrelated card that merely
  // sent a message (this module's own hijack scenario, doc comment above).
  if (input.spawnedById && input.spawnedByAlive) {
    return { targetId: input.spawnedById, source: "spawned" };
  }
  // RODADA 4 — a aresta visual morreu com o card que spawnou, mas a linhagem
  // continua GRAVADA (registro `spawns`, append-only). Linhagem conhecida
  // vence conversa: é isto que impede o card que só passou pela conversa de
  // virar o destino (o motivo desta task).
  if (input.spawnerOfRecordId && input.spawnerOfRecordAlive) {
    return { targetId: input.spawnerOfRecordId, source: "spawned" };
  }
  // RODADA 5 — a linhagem é CONHECIDA e o dono dela está MORTO: `none`
  // explícito, e NÃO o fallback de diretiva logo abaixo. É o mesmo argumento
  // do ramo do mark do board, um degrau abaixo: quando o alvo CORRETO é
  // conhecido e não está lá, cair para "o último que falou" entrega o report
  // a um terceiro — o sequestro que a RODADA 2 fechou uma casa acima. Cair
  // aqui por acidente (porque nenhuma aresta `modified` existe) é o que
  // acontecia antes; a diferença é que agora não depende do acaso.
  //
  // Não cai para o mark porque o mark JÁ é o primeiro ramo (logo acima): se
  // houvesse mark vivo, esta linha nunca seria alcançada.
  //
  // O dono VIVO da task era a alternativa (c), e foi recusado pelo NÚMERO,
  // não por elegância: entre os 147 spawns de origem agente, o card que criou
  // a task coincide com o spawner de registro em 71 (redundante — seria o
  // mesmo id morto), DIVERGE em 16 e não existe em 60. Um alvo que só
  // coincide 48% das vezes e falta em 41% não é um fato de roteamento; usá-lo
  // seria a heurística que este módulo recusa por princípio.
  if (input.spawnerOfRecordId) {
    return { targetId: null, source: "none" };
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
