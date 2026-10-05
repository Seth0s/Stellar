/**
 * CREATE/EDIT TASK — the pure form decisions (no React, no I/O).
 *
 * Screen 14: the full form. This module owns everything testable without a DOM:
 * the destination switch (team vs. this board), the kind hints, the territory
 * conflict check against running tasks, the agent-preview block, the
 * where-it-appears copy and the submit label — plus the request bodies the two
 * backends (team API and the local queue) expect.
 */

import type { TeamMemberInfo, TeamTaskInfo, TeamTaskKindInfo, TeamTaskPriorityInfo } from "../../preload/index";
import type { MessageKey } from "../../shared/i18n";
import { memberDisplayName, territoriesOverlap } from "./team-board-decisions";

export type TaskDestination = "team" | "board";
export type TaskAssignment = "person" | "open" | "auto";

export type TaskGateDraft = { cmd: string; exclusive: boolean };

export type TeamTaskFormState = {
  destination: TaskDestination;
  title: string;
  kind: TeamTaskKindInfo;
  contract: string;
  territory: string[];
  gates: TaskGateDraft[];
  dependsOn: string;
  reviewerId: string;
  provider: string;
  assignment: TaskAssignment;
  assigneeId: string;
  sprintId: string;
  priority: TeamTaskPriorityInfo;
  allowCommit: boolean;
  reportSchema: string[];
  maxRetries: number;
};

export function emptyTaskForm(): TeamTaskFormState {
  return {
    destination: "team",
    title: "",
    kind: "implementar",
    contract: "",
    territory: [],
    gates: [],
    dependsOn: "",
    reviewerId: "",
    provider: "",
    assignment: "open",
    assigneeId: "",
    sprintId: "",
    priority: "media",
    allowCommit: false,
    reportSchema: ["filesChanged", "decision", "evidence", "notDone", "gatesOutput"],
    maxRetries: 2,
  };
}

/** The kind → explanation hint, straight from the prototype. */
export const KIND_HINT_KEY: Record<TeamTaskKindInfo, MessageKey> = {
  investigar: "teamTask.form.kindHint.investigate",
  implementar: "teamTask.form.kindHint.implement",
  corrigir: "teamTask.form.kindHint.fix",
  medir: "teamTask.form.kindHint.measure",
  integrar: "teamTask.form.kindHint.integrate",
};

export const ASSIGNMENT_LABEL_KEY: Record<TaskAssignment, MessageKey> = {
  person: "teamTask.form.assign.person",
  open: "teamTask.form.assign.open",
  auto: "teamTask.form.assign.auto",
};

/** Running tasks whose territory overlaps the draft's — the conflict warning.
 *  Only tasks actually in flight (rodando/aguardando_revisao) count. */
export function territoryConflicts(territory: readonly string[], tasks: readonly TeamTaskInfo[]): TeamTaskInfo[] {
  const wanted = territory.filter((t) => t.trim() !== "");
  if (wanted.length === 0) return [];
  return tasks.filter(
    (task) =>
      (task.state === "rodando" || task.state === "aguardando_revisao") &&
      task.territory.some((owned) => wanted.some((w) => territoriesOverlap(owned, w))),
  );
}

/** The "where it appears" copy: where the task lands, given destination + assignment. */
export function whereAppearsKey(destination: TaskDestination, assignment: TaskAssignment): MessageKey {
  if (destination === "board") return "teamTask.form.where.board";
  if (assignment === "person") return "teamTask.form.where.person";
  if (assignment === "auto") return "teamTask.form.where.auto";
  return "teamTask.form.where.open";
}

/** Whether the distribution block (person/sprint/priority) is shown at all. */
export function showsDistribution(destination: TaskDestination): boolean {
  return destination === "team";
}

/** The dialog's primary button label key; a name is passed for the "person" case. */
export function submitLabelKey(destination: TaskDestination, assignment: TaskAssignment): MessageKey {
  if (destination === "board") return "teamTask.form.submit.board";
  if (assignment === "person") return "teamTask.form.submit.person";
  return "teamTask.form.submit.team";
}

export type TaskFormValidation = { ok: boolean; missingTitle: boolean };

/** The only hard gate is a non-empty title; everything else has a default. */
export function validateTaskForm(form: TeamTaskFormState): TaskFormValidation {
  const missingTitle = form.title.trim() === "";
  return { ok: !missingTitle, missingTitle };
}

/** The preview block the agent will receive (the prototype's agent preview). */
export function agentPreviewLines(form: TeamTaskFormState, members: readonly TeamMemberInfo[]): string[] {
  const lines: string[] = [];
  lines.push(form.title.trim() === "" ? "—" : form.title.trim());
  const territory = form.territory.filter((t) => t.trim() !== "");
  if (territory.length > 0) lines.push(`TERRITÓRIO  ${territory.join(", ")}`);
  const gates = form.gates.filter((g) => g.cmd.trim() !== "");
  if (gates.length > 0) lines.push(`GATES       ${gates.map((g) => (g.exclusive ? `${g.cmd} (exclusivo)` : g.cmd)).join(" · ")}`);
  if (form.dependsOn.trim() !== "") lines.push(`DEPENDE DE  ${form.dependsOn.trim()}`);
  if (form.reviewerId) lines.push(`REVISÃO     ${memberDisplayName(members, form.reviewerId)}`);
  lines.push(`COMMIT      ${form.allowCommit ? "sim" : "não: quem revisa commita"}`);
  if (form.reportSchema.length > 0) lines.push(`RELATÓRIO   ${form.reportSchema.join(", ")}`);
  return lines;
}

/** Body for the team API create/update — only the fields the backend knows. */
export function toTeamTaskBody(form: TeamTaskFormState): Record<string, unknown> {
  const gates = form.gates
    .filter((g) => g.cmd.trim() !== "")
    .map((g) => (g.exclusive ? { cmd: g.cmd.trim(), exclusive: "repo" } : g.cmd.trim()));
  const body: Record<string, unknown> = {
    title: form.title.trim(),
    kind: form.kind,
    priority: form.priority,
    territory: form.territory.filter((t) => t.trim() !== ""),
    gates,
    allow_commit: form.allowCommit,
    report_schema: form.reportSchema,
    max_retries: form.maxRetries,
    provider: form.provider.trim(),
  };
  if (form.contract.trim() !== "") body.contract = form.contract;
  if (form.dependsOn.trim() !== "") body.depends_on = form.dependsOn.trim();
  if (form.reviewerId) body.reviewer_id = form.reviewerId;
  if (form.sprintId) body.sprint_id = form.sprintId;
  if (form.assignment === "person" && form.assigneeId) {
    body.assignee_id = form.assigneeId;
    if (form.assignment === "person" && form.assigneeId) body.state = "atribuida";
  } else if (form.assignment === "auto") {
    body.auto_dispatch = true;
  }
  return body;
}

/** The local queue briefing for the board-only destination. */
export function toLocalPrompt(form: TeamTaskFormState): string {
  const lines: string[] = [form.title.trim()];
  const meta: string[] = [];
  const territory = form.territory.filter((t) => t.trim() !== "");
  if (territory.length > 0) meta.push(`território: ${territory.join(", ")}`);
  const gates = form.gates.filter((g) => g.cmd.trim() !== "").map((g) => g.cmd.trim());
  if (gates.length > 0) meta.push(`gates: ${gates.join(" | ")}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const body = form.contract.trim();
  if (body) lines.push("", body);
  return lines.join("\n");
}

// ---- autosaved draft + reusable templates ---------------------------------

export type TeamTaskTemplate = { name: string; form: TeamTaskFormState };

export function draftStorageKey(teamId: string): string {
  return `stellar.team.taskDraft.${teamId}`;
}

export function templatesStorageKey(teamId: string): string {
  return `stellar.team.taskTemplates.${teamId}`;
}

function parseTemplates(raw: unknown): TeamTaskTemplate[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { templates?: unknown }).templates)) return [];
  const out: TeamTaskTemplate[] = [];
  for (const item of (raw as { templates: unknown[] }).templates) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.form !== "object" || rec.form === null) continue;
    out.push({ name: rec.name, form: { ...emptyTaskForm(), ...(rec.form as Partial<TeamTaskFormState>) } });
  }
  return out;
}

export function readTemplates(teamId: string): TeamTaskTemplate[] {
  try {
    return parseTemplates(JSON.parse(localStorage.getItem(templatesStorageKey(teamId)) ?? "null"));
  } catch {
    return [];
  }
}

export function writeTemplates(teamId: string, templates: readonly TeamTaskTemplate[]): void {
  try {
    localStorage.setItem(templatesStorageKey(teamId), JSON.stringify({ templates }));
  } catch {
    /* storage unavailable: templates stay in-memory for this session */
  }
}
