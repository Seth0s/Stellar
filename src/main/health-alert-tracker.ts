import { healthAlertScope, type HealthAlert } from "./card-health";

/**
 * "WARN ONCE" FOR CARD HEALTH — the de-duplication the orchestrator's alerts
 * go through, kept pure so it can be tested without a bus.
 *
 * THE KEY: `recipient | scope | key`
 *   - recipient: the orchestrator card being told. Two boards = two
 *     orchestrators, and each must hear the conclusion once.
 *   - scope:     `card:<id>` for a context alert (that card's own window) and
 *     `provider:<id>` for a quota alert (the plan is shared by every card of
 *     the provider — a second card reaching the same conclusion adds nothing).
 *   - key:       the level from `healthAlerts` (`context`, `quota:80`, …).
 *
 * WHERE IT LIVES: in memory, inside the bus (one tracker per bus). It is not
 * persisted on purpose: after an app restart the orchestrator has lost the
 * conversation anyway, and one fresh warning per level is the right cost.
 *
 * WHEN IT RESETS (the key leaves `sent`):
 *   - the card's reading is TRUSTWORTHY and sits `REARM_MARGIN_POINTS` below the
 *     level (see `healthCoolKeys`). A missing or torn reading never re-arms:
 *     that is what made the same conclusion fire again after a repaint glitch.
 *   - for a provider-scoped key, only when EVERY card that voted on it is cool.
 *   - `forgetCard` (the card is gone) drops its votes and its context keys.
 *   - `clear` (the bus closes).
 */
export type HealthAlertTracker = {
  /**
   * Feed one card's reading. `alerts` are the levels active now, `cool` the
   * levels proven cool. Returns the alerts that have NOT been sent yet — the
   * caller delivers exactly these.
   */
  track(input: { recipient: string; cardId: string; provider: string; alerts: HealthAlert[]; cool: string[] }): HealthAlert[];
  forgetCard(cardId: string): void;
  clear(): void;
};

export function createHealthAlertTracker(): HealthAlertTracker {
  /** Full keys already sent. */
  const sent = new Set<string>();
  /** Provider-scoped keys: per voting card, is it still at/above the level? */
  const votes = new Map<string, Map<string, boolean>>();

  const fullKey = (recipient: string, cardId: string, provider: string, key: string): string =>
    healthAlertScope(key) === "provider"
      ? `${recipient}|provider:${provider}|${key}`
      : `${recipient}|card:${cardId}|${key}`;

  return {
    track({ recipient, cardId, provider, alerts, cool }) {
      const fresh: HealthAlert[] = [];
      const seen = new Set<string>();
      for (const alert of alerts) {
        const full = fullKey(recipient, cardId, provider, alert.key);
        if (healthAlertScope(alert.key) === "provider") {
          const voters = votes.get(full) ?? new Map<string, boolean>();
          voters.set(cardId, true);
          votes.set(full, voters);
        }
        // Two alerts with one key in the same pass collapse to one.
        if (seen.has(full)) continue;
        seen.add(full);
        if (sent.has(full)) continue;
        sent.add(full);
        fresh.push(alert);
      }
      for (const key of cool) {
        const full = fullKey(recipient, cardId, provider, key);
        if (seen.has(full)) continue;
        if (healthAlertScope(key) === "provider") {
          const voters = votes.get(full);
          if (!voters) continue;
          voters.set(cardId, false);
          if ([...voters.values()].every((active) => !active)) {
            votes.delete(full);
            sent.delete(full);
          }
        } else {
          sent.delete(full);
        }
      }
      return fresh;
    },
    forgetCard(cardId) {
      for (const full of [...sent]) {
        if (full.includes(`|card:${cardId}|`)) sent.delete(full);
      }
      for (const [full, voters] of votes) {
        voters.delete(cardId);
        if (voters.size === 0) {
          votes.delete(full);
          sent.delete(full);
        }
      }
    },
    clear() {
      sent.clear();
      votes.clear();
    },
  };
}
