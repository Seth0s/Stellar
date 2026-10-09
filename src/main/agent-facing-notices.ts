/**
 * Canonical copy for automatic notices typed into agent cards.
 * Every builder returns one English line and names the tool that holds more detail.
 */

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function value(input: unknown, max = 96): string {
  return String(input ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

function taskKey(taskId: string): string {
  const safe = value(taskId, 64);
  return safe.length > 8 ? safe.slice(0, 8) : safe;
}

function taskRef(taskId: string | null | undefined): string {
  return taskId ? `task ${taskKey(taskId)}` : "the task";
}

function cardRef(cardId: string | null | undefined): string {
  return cardId ? `card ${value(cardId, 64)}` : "the card";
}

export const APP_NOTICE = {
  reportAvailable(
    taskId?: string | null,
    cardId?: string | null,
    /** Normalized report estado — parcial is a checkpoint, not a conclusion. */
    estado?: "parcial" | "final" | null,
  ): string {
    const task = taskId ? ` for ${taskRef(taskId)}` : cardId ? ` from ${cardRef(cardId)}` : "";
    const detail = taskId
      ? ` with taskId ${taskKey(taskId)}`
      : cardId
        ? ` with target ${value(cardId, 64)}`
        : "";
    const tag =
      estado === "final" ? " (final)" : estado === "parcial" ? " (parcial checkpoint)" : "";
    return singleLine(`report available${task}${tag} — call read_report${detail} for the result.`);
  },

  /** Cheap intention nudge after N writes without decisaoTomada. */
  intentionCheckpoint(input: { writes: number; threshold: number }): string {
    return singleLine(
      `You've made ${input.writes} writes without an intention checkpoint (threshold ${input.threshold}); call report with estado "parcial" and a one-sentence decisaoTomada now — do not wait until the end.`,
    );
  },

  reportGates(input: {
    taskId?: string | null;
    passed: number;
    total: number;
    pending?: boolean;
    /** Per-command scores, e.g. "npm run check:types 0/1, npm run test:unit 1/1". */
    perGate?: string | null;
  }): string {
    const task = input.taskId ? taskRef(input.taskId) : "the task";
    const taskArg = input.taskId ? ` with taskId ${taskKey(input.taskId)}` : "";
    const per = input.perGate && !input.pending ? ` [${input.perGate}]` : "";
    const result = input.pending
      ? "gates still running"
      : `gates ${input.passed}/${input.total} ${input.passed === input.total ? "passed" : "failed"}${per}`;
    return singleLine(
      `report available for ${task} — ${result}; call read_report${taskArg} for the report and get_task${taskArg} for gateRun details.`,
    );
  },

  gateContradiction(input: {
    taskId: string;
    reportOk: boolean;
    gatesOk: boolean;
    passed: number;
    total: number;
    attributionClass?: "task_failed" | "ok";
    perGate?: string | null;
  }): string {
    const task = taskKey(input.taskId);
    const report = input.reportOk ? "success" : "failure";
    const gates = input.gatesOk ? "passed" : "failed";
    const klass = input.attributionClass ?? "task_failed";
    const per = input.perGate ? ` [${input.perGate}]` : "";
    return singleLine(
      `gate ${klass} for task ${task}: report ${report}, gates ${gates} (${input.passed}/${input.total})${per} — call get_task with taskId ${task} for gateRun output.`,
    );
  },

  gateInconclusive(input: {
    taskId: string;
    passed: number;
    total: number;
    perGate?: string | null;
    reason?: string | null;
    /**
     * Clause after the em dash. Default is the foreign-path case; the no-path
     * parseable case must pass its own text — claiming "outside this task's
     * files" would be false when nothing was attributed.
     */
    detail?: string | null;
  }): string {
    const task = taskKey(input.taskId);
    const per = input.perGate ? ` [${input.perGate}]` : "";
    const why = input.reason ? ` (${value(input.reason, 120)})` : "";
    const detail = value(input.detail ?? "errors look outside this task's files", 160);
    return singleLine(
      `gate_inconclusive for task ${task}: measured gates ${input.passed}/${input.total} failed${per}${why} — ${detail}; call get_task with taskId ${task} for gateRun details.`,
    );
  },

  gateEnvironmentError(input: { taskId: string }): string {
    const task = taskKey(input.taskId);
    return singleLine(
      `gate_env_error for task ${task}: a declared path was unavailable — call get_task with taskId ${task} for gateRun details.`,
    );
  },

  exitedWithoutReport(input: { cardId?: string | null; taskId?: string | null; exitCode: number }): string {
    const task = input.taskId ? ` on ${taskRef(input.taskId)}` : "";
    const detail = input.taskId ? `; inspect get_task with taskId ${taskKey(input.taskId)}` : "; inspect the terminal with read_card";
    return singleLine(`${cardRef(input.cardId)} exited with code ${input.exitCode}${task} without calling report${detail}.`);
  },

  idleWithoutReport(input: {
    cardId?: string | null;
    taskId?: string | null;
    kind: "turn-ended" | "unproven" | "no-agent" | "screen-report";
    idleMinutes?: number;
  }): string {
    const taskId = input.taskId;
    const task = taskId ? taskRef(taskId) : "the task";
    const taskArg = taskId ? ` with taskId ${taskKey(taskId)}` : "";
    const cardId = value(input.cardId, 64);
    if (input.kind === "screen-report") {
      if (!taskId && !cardId) return "report left on screen after a turn ended";
      return singleLine(
        `report left on screen after a turn ended${taskId ? ` for ${task}` : ""}${cardId ? ` on ${cardRef(cardId)}` : ""}; inspect read_card${cardId ? ` with cardId ${cardId}` : ""} and call report.`,
      );
    }
    if (input.kind === "no-agent") {
      if (!taskId && !cardId) return "no agent is reading";
      return singleLine(
        `no agent is reading ${cardId ? cardRef(cardId) : "the card"}${taskId ? ` for ${task}` : ""}; inspect get_task${taskArg} and assign an agent.`,
      );
    }
    if (input.kind === "unproven") {
      const minutes = Math.max(1, Math.round(input.idleMinutes ?? 1));
      const prefix = `no report for ${minutes}min and no turn fact`;
      if (!taskId && !cardId) return prefix;
      return singleLine(
        `${prefix}${cardId ? ` on ${cardRef(cardId)}` : ""}${taskId ? ` for ${task}` : ""}; verify with read_card${cardId ? ` using cardId ${cardId}` : ""}.`,
      );
    }
    if (!taskId && !cardId) return "turn ended without calling report";
    return singleLine(
      `turn ended without calling report${taskId ? ` for ${task}` : ""}${cardId ? ` on ${cardRef(cardId)}` : ""}; inspect get_task${taskArg} and call report.`,
    );
  },

  silentBoot(input: { cardId: string; waitedSec: number }): string {
    return singleLine(
      `${cardRef(input.cardId)} produced no output in ${input.waitedSec}s and is still alive; inspect its screen with read_card using cardId ${value(input.cardId, 64)}.`,
    );
  },

  selfReportReminder(taskId: string): string {
    const task = taskKey(taskId);
    return singleLine(
      `You ended your turn without calling report for task ${task}; call report now or inspect get_task with taskId ${task}.`,
    );
  },

  blockedQuestion(input: { taskId: string; waitedMinutes?: number }): string {
    const task = taskKey(input.taskId);
    const waited = input.waitedMinutes === undefined ? "" : ` for ${Math.max(0, input.waitedMinutes)}min`;
    return singleLine(
      `task ${task} is BLOCKED on a question${waited}; inspect get_task with taskId ${task} and answer with answer_blocked_task.`,
    );
  },

  blockedAnswer(taskId: string): string {
    const task = taskKey(taskId);
    return singleLine(
      `task ${task} question answered; get_task with taskId ${task} shows the saved answer, and answer_blocked_task records another decision.`,
    );
  },

  taskLinked(input: { taskId: string; role: string }): string {
    const task = taskKey(input.taskId);
    const lead = input.role === "reviewer" ? "task for you to review" : "task for you";
    return singleLine(`${lead}: ${task} (role: ${value(input.role, 24)}) — read it with get_task using taskId ${task}.`);
  },

  quotaHealth(input: { cardLabel: string; provider: string; percent: number; threshold: number }): string {
    return singleLine(
      `card ${value(input.cardLabel, 48)} (${value(input.provider, 32)}) provider quota is ${input.percent}% used, past the ${input.threshold}% warning threshold; inspect list_cards for current health.`,
    );
  },

  contextHealth(input: { cardLabel: string; provider: string; percent: number }): string {
    return singleLine(
      `card ${value(input.cardLabel, 48)} (${value(input.provider, 32)}) context is at ${input.percent}% and near its limit; inspect list_cards for current health.`,
    );
  },

  quotaDeath(input: { provider: string; cardId: string }): string {
    return singleLine(
      `[stellar] ${cardRef(input.cardId)} exited after provider quota exhaustion (${value(input.provider, 32)}), not a crash; inspect read_card with cardId ${value(input.cardId, 64)} for the preserved output.`,
    );
  },

  trustPrompt(input: { cardId: string; provider: string; cwd?: string; root?: string | null }): string {
    const where = input.root
      ? `outside root ${value(input.root, 64)}`
      : "with no declared board root";
    return singleLine(
      `${cardRef(input.cardId)} has an unconfirmed ${value(input.provider, 32)} trust prompt at ${value(input.cwd, 64)} (${where}); inspect read_card with cardId ${value(input.cardId, 64)} and confirm it by hand.`,
    );
  },

  sessionUnresolved(input: { cardId: string; taskId: string; reason: string }): string {
    const card = value(input.cardId, 64);
    const task = taskKey(input.taskId);
    return singleLine(
      `${cardRef(card)} session ownership for task ${task} is unproven (${value(input.reason, 24)}); inspect get_task with taskId ${task} and read_card with cardId ${card}.`,
    );
  },

  queuedSpawn(input: { cardId: string; provider: string; waitedSec: number }): string {
    const card = value(input.cardId, 64);
    return singleLine(
      `queued spawn_agent created ${cardRef(card)} (${value(input.provider, 32)}) after ${input.waitedSec}s; do not spawn another, close any duplicate, and inspect list_cards.`,
    );
  },

  reservationDelivered(input: { taskId: string; cardId: string; contextWarning?: string | null }): string {
    const task = taskKey(input.taskId);
    const warning = input.contextWarning ? ` — warning: ${value(input.contextWarning, 96)}` : "";
    return singleLine(
      `task ${task} delivered to card ${value(input.cardId, 64)} (reservation)${warning}; inspect get_task with taskId ${task}.`,
    );
  },

  reservationStuck(input: { taskId: string; cardId: string; reason: string }): string {
    const task = taskKey(input.taskId);
    return singleLine(
      `reservation for task ${task} on card ${value(input.cardId, 64)} did not start: ${value(input.reason, 96)}; inspect get_task with taskId ${task}.`,
    );
  },

  supersededDependency(input: { dependentTaskId: string; supersededTaskId: string; substituteTaskId: string }): string {
    const dependent = taskKey(input.dependentTaskId);
    return singleLine(
      `task ${dependent} still depends on superseded task ${taskKey(input.supersededTaskId)}; update its dependency to ${taskKey(input.substituteTaskId)} and inspect get_task with taskId ${dependent}.`,
    );
  },

  statusAskResolved(input: { requestedStatus: string; allowed: boolean; taskId?: string | null; cardId?: string | null }): string {
    const task = input.taskId ? ` for task ${taskKey(input.taskId)}` : "";
    const detail = input.taskId
      ? ` with taskId ${taskKey(input.taskId)}`
      : input.cardId
        ? ` with cardId ${value(input.cardId, 64)}`
        : "";
    const result = input.allowed ? "accepted" : "refused";
    return singleLine(
      `human ${result} the status request ${value(input.requestedStatus, 32)}${task}; inspect ${input.taskId ? "get_task" : "read_card"}${detail} for the saved state.`,
    );
  },
} as const;
