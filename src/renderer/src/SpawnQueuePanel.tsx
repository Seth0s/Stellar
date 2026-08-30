import type { SpawnQueueEntry } from "../../preload/index";
import { Icon } from "./icons";

/**
 * DESIGN-BACKLOG.md item 60, peça 1 — real UI for the per-board spawn
 * queue (reversal of item 58/59's "structural refusal, never a queue").
 * Floating panel, same visual family as the topbar's autonomous badge —
 * shows only while the ACTIVE board actually has something queued, kept
 * live via App.tsx's `onQueueChanged` push, never polled.
 */
export function SpawnQueuePanel({
  queue,
  describeRequester,
}: {
  queue: SpawnQueueEntry[];
  /** App.tsx's `describeCard` — same human-friendly label ("Bash 2°")
   * already used by AgentAskModal, reused here for consistency. */
  describeRequester: (cardId: string) => string;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="spawn-queue-panel thin-scroll">
      <div className="spawn-queue-heading">
        <Icon name="clock" size={13} />
        fila de spawn — {queue.length} aguardando
      </div>
      <ul className="spawn-queue-list">
        {queue.map((entry, i) => (
          <li key={entry.id} className="spawn-queue-item">
            <span className="spawn-queue-position">{i + 1}</span>
            <span className="spawn-queue-provider">{entry.provider}</span>
            <span className="spawn-queue-requester">de {describeRequester(entry.requesterId)}</span>
            {entry.reason && <span className="spawn-queue-reason">{entry.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
