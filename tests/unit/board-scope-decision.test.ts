import { describe, expect, it } from "vitest";
import {
  BOARD_SCOPE_TOOL_GROUPS,
  decideAcbridgeBoardAccess,
  decideBoardScope,
  decideCrossBoardRead,
  type BoardScopeToolGroup,
} from "../../src/main/board-scope-decision";

describe("decideBoardScope", () => {
  it.each(BOARD_SCOPE_TOOL_GROUPS)("allows an omitted boardId to resolve to the caller for %s", (group) => {
    expect(decideBoardScope({ group, callerBoardId: "board-a" })).toEqual({
      allowed: true,
      boardId: "board-a",
      source: "caller",
    });
  });

  it.each(BOARD_SCOPE_TOOL_GROUPS)("refuses a foreign boardId for %s and names the field", (group) => {
    expect(decideBoardScope({ group, callerBoardId: "board-a", requestedBoardId: "board-b" })).toEqual({
      allowed: false,
      field: "boardId",
      error: `boardId is outside the caller board scope for ${group}`,
    });
  });

  it.each(BOARD_SCOPE_TOOL_GROUPS)("refuses a foreign resource for %s and names its identifier field", (group) => {
    expect(
      decideBoardScope({
        group,
        callerBoardId: "board-a",
        resourceBoardId: "board-b",
        resourceField: "taskId",
      }),
    ).toEqual({
      allowed: false,
      field: "taskId",
      error: "taskId belongs to a different board than the caller",
    });
  });

  it("allows explicit access to the caller board and keeps the requested scope", () => {
    expect(
      decideBoardScope({ group: "reports", callerBoardId: "board-a", requestedBoardId: "board-a" }),
    ).toEqual({ allowed: true, boardId: "board-a", source: "requested" });
  });

  it("fails closed when the trusted caller board identity is absent", () => {
    expect(decideBoardScope({ group: "cards", callerBoardId: " " })).toEqual({
      allowed: false,
      field: "callerBoardId",
      error: "caller board identity is unavailable",
    });
  });

  it("keeps the declared groups available to the bus and MCP adapters", () => {
    const groups: BoardScopeToolGroup[] = [...BOARD_SCOPE_TOOL_GROUPS];
    expect(groups).toContain("browser");
    expect(groups).toContain("send_to_card");
    expect(groups).toContain("get_page_text");
    expect(groups).toContain("sticky");
  });

  it("requires a separate, reasoned request for another board", () => {
    expect(
      decideCrossBoardRead({
        callerBoardId: "board-a",
        targetBoardId: "board-b",
        resourceKind: "task",
        resourceId: "task-1",
        reason: "Review the related task",
      }),
    ).toEqual({ allowed: true, targetBoardId: "board-b" });
  });

  it("refuses a same-board request and names targetBoardId", () => {
    expect(
      decideCrossBoardRead({
        callerBoardId: "board-a",
        targetBoardId: "board-a",
        resourceKind: "card",
        resourceId: "card-1",
        reason: "Review the related card",
      }),
    ).toEqual({
      allowed: false,
      field: "targetBoardId",
      error: "request_cross_board_read requires a different board",
    });
  });

  it.each(["targetBoardId", "resourceId", "reason"] as const)("requires %s", (field) => {
    const input = {
      callerBoardId: "board-a",
      targetBoardId: "board-b",
      resourceKind: "report" as const,
      resourceId: "seq-12",
      reason: "Review report",
      [field]: " ",
    };
    const result = decideCrossBoardRead(input);
    expect(result).toMatchObject({ allowed: false, field });
  });

  it("authenticates acbridge by a live card and rejects a forged board", () => {
    expect(decideAcbridgeBoardAccess({
      mode: "dev",
      clientCardId: "card-a",
      cardBoardId: "board-a",
      cardAlive: true,
      explicitBoardId: "board-b",
      boardExists: true,
    })).toMatchObject({ allowed: false, field: "clientBoardId" });
    expect(decideAcbridgeBoardAccess({
      mode: "dev",
      clientCardId: "card-a",
      cardBoardId: "board-a",
      cardAlive: true,
      explicitBoardId: "board-a",
      boardExists: true,
    })).toEqual({ allowed: true, callerBoardId: "board-a", callerCardId: "card-a", source: "card" });
  });

  it("allows standalone acbridge only on an explicit existing dev board", () => {
    expect(decideAcbridgeBoardAccess({ mode: "dev", boardExists: true })).toMatchObject({ allowed: false, field: "--board-id" });
    expect(decideAcbridgeBoardAccess({ mode: "dev", explicitBoardId: "board-a", boardExists: false })).toMatchObject({ allowed: false, field: "--board-id" });
    expect(decideAcbridgeBoardAccess({ mode: "dev", explicitBoardId: "board-a", boardExists: true })).toEqual({
      allowed: true,
      callerBoardId: "board-a",
      callerCardId: null,
      source: "explicit-board",
    });
  });

  it("requires app authentication in packaged builds", () => {
    expect(decideAcbridgeBoardAccess({ mode: "packaged", explicitBoardId: "board-a", boardExists: true })).toMatchObject({
      allowed: false,
      field: "clientCardId",
      error: expect.stringContaining("terminal card launched by Stellar"),
    });
  });
});
