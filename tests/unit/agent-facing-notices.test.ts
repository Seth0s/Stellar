import { describe, expect, it } from "vitest";
import { APP_NOTICE } from "../../src/main/agent-facing-notices";

const taskId = "task-12345678";
const cardId = "card-87654321";

const notices: Array<{ name: string; text: string; tools: string[] }> = [
  { name: "report available", text: APP_NOTICE.reportAvailable(taskId), tools: ["read_report"] },
  {
    name: "report with completed gates",
    text: APP_NOTICE.reportGates({ taskId, passed: 1, total: 2 }),
    tools: ["read_report", "get_task"],
  },
  {
    name: "report with pending gates",
    text: APP_NOTICE.reportGates({ taskId, passed: 0, total: 0, pending: true }),
    tools: ["read_report", "get_task"],
  },
  {
    name: "gate task_failed",
    text: APP_NOTICE.gateContradiction({
      taskId,
      reportOk: true,
      gatesOk: false,
      passed: 1,
      total: 2,
      attributionClass: "task_failed",
      perGate: "npm run check:types 0/1",
    }),
    tools: ["get_task"],
  },
  {
    name: "gate inconclusive outside files",
    text: APP_NOTICE.gateInconclusive({
      taskId,
      passed: 0,
      total: 2,
      perGate: "npm run check:types 0/1, npm run test:unit 0/1",
      detail: "errors look outside this task's files",
    }),
    tools: ["get_task"],
  },
  {
    name: "gate inconclusive no path parsed",
    text: APP_NOTICE.gateInconclusive({
      taskId,
      passed: 0,
      total: 1,
      detail: "could not attribute the failure to any file (no path parsed)",
    }),
    tools: ["get_task"],
  },
  {
    name: "gate environment error",
    text: APP_NOTICE.gateEnvironmentError({ taskId }),
    tools: ["get_task"],
  },
  {
    name: "exit without report",
    text: APP_NOTICE.exitedWithoutReport({ cardId, taskId, exitCode: 1 }),
    tools: ["get_task"],
  },
  {
    name: "turn ended without report",
    text: APP_NOTICE.idleWithoutReport({ kind: "turn-ended", taskId, cardId }),
    tools: ["get_task", "report"],
  },
  {
    name: "idle without proven turn end",
    text: APP_NOTICE.idleWithoutReport({ kind: "unproven", taskId, cardId, idleMinutes: 9 }),
    tools: ["read_card"],
  },
  {
    name: "task has no agent reader",
    text: APP_NOTICE.idleWithoutReport({ kind: "no-agent", taskId, cardId }),
    tools: ["get_task"],
  },
  {
    name: "report left on screen",
    text: APP_NOTICE.idleWithoutReport({ kind: "screen-report", taskId, cardId }),
    tools: ["read_card", "report"],
  },
  { name: "silent boot", text: APP_NOTICE.silentBoot({ cardId, waitedSec: 45 }), tools: ["read_card"] },
  { name: "self report reminder", text: APP_NOTICE.selfReportReminder(taskId), tools: ["report", "get_task"] },
  { name: "blocked question", text: APP_NOTICE.blockedQuestion({ taskId, waitedMinutes: 2 }), tools: ["get_task", "answer_blocked_task"] },
  { name: "blocked answer", text: APP_NOTICE.blockedAnswer(taskId), tools: ["get_task", "answer_blocked_task"] },
  { name: "task linked to card", text: APP_NOTICE.taskLinked({ taskId, role: "reviewer" }), tools: ["get_task"] },
  {
    name: "quota health",
    text: APP_NOTICE.quotaHealth({ cardLabel: "Claude\n1", provider: "claude", percent: 95, threshold: 80 }),
    tools: ["list_cards"],
  },
  { name: "context health", text: APP_NOTICE.contextHealth({ cardLabel: "Claude 1", provider: "claude", percent: 90 }), tools: ["list_cards"] },
  { name: "quota exit", text: APP_NOTICE.quotaDeath({ provider: "claude", cardId }), tools: ["read_card"] },
  { name: "unconfirmed trust prompt", text: APP_NOTICE.trustPrompt({ cardId, provider: "claude", cwd: "/repo\nnext", root: "/repo" }), tools: ["read_card"] },
  { name: "unresolved session", text: APP_NOTICE.sessionUnresolved({ cardId, taskId, reason: "paired-by-order" }), tools: ["get_task", "read_card"] },
  { name: "queued spawn arrived", text: APP_NOTICE.queuedSpawn({ cardId, provider: "claude", waitedSec: 301 }), tools: ["list_cards"] },
  {
    name: "reservation delivered",
    text: APP_NOTICE.reservationDelivered({ taskId, cardId, contextWarning: "context at 90%\nwarning" }),
    tools: ["get_task"],
  },
  { name: "reservation did not start", text: APP_NOTICE.reservationStuck({ taskId, cardId, reason: "ready\nfree" }), tools: ["get_task"] },
  {
    name: "superseded dependency",
    text: APP_NOTICE.supersededDependency({ dependentTaskId: taskId, supersededTaskId: "old-task", substituteTaskId: "new-task" }),
    tools: ["get_task"],
  },
  { name: "resolved status request", text: APP_NOTICE.statusAskResolved({ requestedStatus: "done", allowed: true, taskId }), tools: ["get_task"] },
];

describe("automatic agent notices", () => {
  it.each(notices)("$name is one line and points to the right detail tool", ({ text, tools }) => {
    expect(text).not.toMatch(/[\r\n]/);
    for (const tool of tools) expect(text).toContain(tool);
  });
});
