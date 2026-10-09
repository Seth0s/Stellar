/** Adapt a TaskBoardItem into the pure Fila V3 fact shape. */
import type { TaskBoardItem } from "../../preload/index";
import { deriveTaskPhaseForBoardItem, shortTaskId } from "./task-board-model";
import type { QueueTaskFacts } from "./task-fila-v3-decision";

export function queueFactsFromBoardItem(
  task: TaskBoardItem,
  extras?: {
    depTitles?: Readonly<Record<string, string | undefined>>;
    recentAction?: string | null;
    contextPercent?: number | null;
    lastActivityAgeMs?: number | null;
    hasReportThisRound?: boolean;
    providerQuotaExhausted?: boolean;
    supersededTitle?: string | null;
    supersededReason?: string | null;
    supersededTargetDone?: boolean;
    gateRedOutsideTerritory?: boolean | null;
    gateFailedFilesOutside?: number | null;
    approverLabel?: string | null;
    reviewerLabel?: string | null;
    failureKind?: string | null;
  },
): QueueTaskFacts {
  const phase = deriveTaskPhaseForBoardItem(task);
  const rounds = task.verdicts?.length ?? 0;
  const lastReviewer = [...(task.verdicts ?? [])].reverse().find((v) => v.role === "reviewer" && v.verdict === "aprovado");
  const outside =
    extras?.gateRedOutsideTerritory ??
    (task.gateRun != null &&
      !task.gateRun.ok &&
      (task.gateRun.isolation?.undeclaredInTerritory?.length ?? 0) > 0);
  return {
    phase,
    status: task.status,
    cardAlive: task.cardAlive,
    blockedQuestion: task.blockedQuestion,
    requestedStatus: task.requestedStatus,
    requestedReason: task.requestedReason,
    review: task.review,
    cards: task.cards,
    recentAction: extras?.recentAction ?? task.recentAction ?? null,
    screenTurnState: task.screenTurnState ?? null,
    providerQuotaExhausted: extras?.providerQuotaExhausted,
    provider: task.provider,
    deps: task.deps,
    depTitles: extras?.depTitles,
    gateRun: task.gateRun
      ? {
          ok: task.gateRun.ok,
          failedCommand: task.gateRun.failedCommand,
          isolation: task.gateRun.isolation
            ? { undeclaredInTerritory: task.gateRun.isolation.undeclaredInTerritory }
            : null,
          commands: task.gateRun.commands ?? null,
        }
      : null,
    reviewerLabel: extras?.reviewerLabel ?? null,
    approverLabel:
      extras?.approverLabel ??
      (lastReviewer ? "revisor" : rounds > 0 ? "Master" : null),
    rounds,
    failureKind: extras?.failureKind ?? null,
    updatedAt: task.updatedAt,
    supersededBy: task.supersededBy,
    supersededTargetDone: extras?.supersededTargetDone,
    supersededTitle: extras?.supersededTitle ?? task.supersededTitle ?? null,
    supersededReason: extras?.supersededReason ?? task.supersededReason ?? null,
    purpose: task.purpose,
    lastActivityAgeMs: extras?.lastActivityAgeMs ?? null,
    contextPercent: extras?.contextPercent ?? null,
    hasReportThisRound: extras?.hasReportThisRound ?? (task.report != null ? true : false),
    blockedAskedAt: task.blockedQuestion?.askedAt ?? null,
    gateRedOutsideTerritory: outside,
    gateFailedFilesOutside:
      extras?.gateFailedFilesOutside ?? task.gateRun?.isolation?.undeclaredInTerritory.length ?? null,
  };
}

export function boardItemTitle(task: TaskBoardItem): string {
  const preview = task.promptPreview?.trim();
  if (preview) {
    const first = preview.split(/\n/)[0]?.trim() ?? preview;
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
  }
  return shortTaskId(task.id);
}
