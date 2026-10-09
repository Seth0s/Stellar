export const BOARD_SCOPE_TOOL_GROUPS = [
  "tasks",
  "reports",
  "cards",
  "snapshot",
  "unreported_work",
  "deliveries",
  "sprints",
  "connectors",
  "reservations",
  "card_status",
  "sticky",
  "browser",
  "send_to_card",
  "get_page_text",
] as const;

export type BoardScopeToolGroup = (typeof BOARD_SCOPE_TOOL_GROUPS)[number];

export type BoardScopeDecision =
  | { allowed: true; boardId: string; source: "caller" | "requested" }
  | { allowed: false; field: string; error: string };

export type BoardScopeInput = {
  group: BoardScopeToolGroup;
  callerBoardId: string;
  requestedBoardId?: string | null;
  resourceBoardId?: string | null;
  resourceField?: string;
};

export type CrossBoardReadRequest = {
  callerBoardId: string;
  targetBoardId: string;
  resourceKind: "task" | "card" | "report" | "sprint" | "connector";
  resourceId: string;
  reason: string;
};

export type CrossBoardReadDecision =
  | { allowed: true; targetBoardId: string }
  | { allowed: false; field: string; error: string };

export function decideCrossBoardRead(input: CrossBoardReadRequest): CrossBoardReadDecision {
  if (!input.targetBoardId.trim()) {
    return { allowed: false, field: "targetBoardId", error: "targetBoardId is required" };
  }
  if (input.targetBoardId === input.callerBoardId) {
    return { allowed: false, field: "targetBoardId", error: "request_cross_board_read requires a different board" };
  }
  if (!input.resourceId.trim()) {
    return { allowed: false, field: "resourceId", error: "resourceId is required" };
  }
  if (!input.reason.trim()) {
    return { allowed: false, field: "reason", error: "reason is required" };
  }
  return { allowed: true, targetBoardId: input.targetBoardId };
}

export type AcbridgeBoardAccessInput = {
  mode: "dev" | "packaged";
  clientCardId?: string | null;
  cardBoardId?: string | null;
  cardAlive?: boolean;
  explicitBoardId?: string | null;
  boardExists: boolean;
};

export type AcbridgeBoardAccessDecision =
  | { allowed: true; callerBoardId: string; callerCardId: string | null; source: "card" | "explicit-board" }
  | { allowed: false; field: string; error: string };

export function decideAcbridgeBoardAccess(input: AcbridgeBoardAccessInput): AcbridgeBoardAccessDecision {
  const explicitBoardId = input.explicitBoardId?.trim() || null;
  if (input.clientCardId) {
    if (!input.cardAlive || !input.cardBoardId) {
      return { allowed: false, field: "clientCardId", error: "clientCardId is not an authenticated live card" };
    }
    if (explicitBoardId && explicitBoardId !== input.cardBoardId) {
      return { allowed: false, field: "clientBoardId", error: "clientBoardId does not match the authenticated card board" };
    }
    return { allowed: true, callerBoardId: input.cardBoardId, callerCardId: input.clientCardId, source: "card" };
  }
  if (input.mode === "packaged") {
    return {
      allowed: false,
      field: "clientCardId",
      error: "standalone acbridge access is disabled in packaged Stellar; authenticate by running acbridge from a terminal card launched by Stellar",
    };
  }
  if (!explicitBoardId) {
    return { allowed: false, field: "--board-id", error: "development acbridge requires an explicit --board-id <id>" };
  }
  if (!input.boardExists) {
    return { allowed: false, field: "--board-id", error: `no such board ${JSON.stringify(explicitBoardId)}` };
  }
  return { allowed: true, callerBoardId: explicitBoardId, callerCardId: null, source: "explicit-board" };
}

export function decideBoardScope(input: BoardScopeInput): BoardScopeDecision {
  if (input.callerBoardId.trim() === "") {
    return { allowed: false, field: "callerBoardId", error: "caller board identity is unavailable" };
  }

  const requestedBoardId = input.requestedBoardId?.trim() || input.callerBoardId;
  if (requestedBoardId !== input.callerBoardId) {
    return {
      allowed: false,
      field: "boardId",
      error: `boardId is outside the caller board scope for ${input.group}`,
    };
  }

  if (input.resourceBoardId && input.resourceBoardId !== input.callerBoardId) {
    const field = input.resourceField?.trim() || "resourceId";
    return {
      allowed: false,
      field,
      error: `${field} belongs to a different board than the caller`,
    };
  }

  return {
    allowed: true,
    boardId: input.callerBoardId,
    source: input.requestedBoardId?.trim() ? "requested" : "caller",
  };
}
