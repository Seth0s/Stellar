import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest, type CrossBoardReadAuditRecord } from "../../src/main/message-bus";
import { openStore, type TaskRow } from "../../src/main/store";

describe("message bus board scope", () => {
  let dir = "";
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("requires human consent for a foreign task and audits both decisions", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-cross-board-read-"));
    const task = {
      id: "task-b",
      prompt: "foreign task",
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: "board-b",
      cwd: null,
      spawn_profile: null,
      result_json: null,
      deps_json: null,
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
    } satisfies TaskRow;
    const audits: CrossBoardReadAuditRecord[] = [];
    let consent = false;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop === "getCardBoardId") return (id: string) => id === "caller-card" ? "board-a" : undefined;
            if (prop === "boardExists") return (id: string) => id === "board-a" || id === "board-b";
            if (prop === "getTask") return (id: string) => id === task.id ? task : undefined;
            if (prop === "requestCrossBoardReadConsent") return async () => consent;
            if (prop === "recordCrossBoardReadAudit") return (audit: CrossBoardReadAuditRecord) => audits.push(audit);
            if (prop === "listCards") return () => [];
            if (prop === "listAllConnectors") return () => [];
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );

    const request = {
      cmd: "request_cross_board_read",
      requesterId: "caller-card",
      targetBoardId: "board-b",
      resourceKind: "task",
      resourceId: "task-b",
      reason: "Review the related task",
    } satisfies BusRequest;
    const denied = await bus.handleRequest(request, { callerCardId: "caller-card", scopeEnforced: true });
    expect(denied.ok).toBe(false);
    expect(audits.at(-1)).toMatchObject({
      requesterCardId: "caller-card",
      callerBoardId: "board-a",
      targetBoardId: "board-b",
      resourceKind: "task",
      resourceId: "task-b",
      decision: "denied",
    });

    consent = true;
    const allowed = await bus.handleRequest(request, { callerCardId: "caller-card", scopeEnforced: true });
    expect(allowed).toMatchObject({ ok: true, targetBoardId: "board-b", resourceId: "task-b" });
    expect(audits.at(-1)).toMatchObject({ requesterCardId: "caller-card", decision: "allowed" });
  });

  it("persists cross-board read audit rows in the store", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-cross-board-audit-store-"));
    const store = openStore(dir);
    try {
      store.recordCrossBoardReadAudit({
        requester_card_id: "caller-card",
        caller_board_id: "board-a",
        target_board_id: "board-b",
        resource_kind: "report",
        resource_id: "seq-9",
        reason: "Review the related report",
        decision: "denied",
        requested_at: 42,
      });
      expect(store.listCrossBoardReadAudit()).toHaveLength(1);
      expect(store.listCrossBoardReadAudit()[0]).toMatchObject({
        requester_card_id: "caller-card",
        caller_board_id: "board-a",
        target_board_id: "board-b",
        resource_kind: "report",
        resource_id: "seq-9",
        decision: "denied",
        requested_at: 42,
      });
    } finally {
      store.close();
    }
  });
});
