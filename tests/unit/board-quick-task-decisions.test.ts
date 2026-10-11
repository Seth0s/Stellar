import { describe, expect, it } from "vitest";
import {
  canSubmitQuick,
  countUnassignedTeamTasks,
  emptyQuickTask,
  filterBoardCommands,
  matchTaskByQuery,
  quickLocalPrompt,
  quickTeamBody,
  quickToFormState,
  selectionToContractContext,
  suggestedTerritory,
  visibleBoardCommands,
} from "../../src/renderer/src/board-quick-task-decisions";

describe("board-quick-task-decisions", () => {
  it("builds selection context from names and cwd only", () => {
    const text = selectionToContractContext([
      { id: "1", kind: "terminal", label: "claude", cwd: "/tmp/proj" },
      { id: "2", kind: "sticky", label: "nota", cwd: null },
    ]);
    expect(text).toContain("claude");
    expect(text).toContain("/tmp/proj");
    expect(text).toContain("nota");
    expect(text).not.toContain("scrollback");
  });

  it("suggests territory globs from open file roots", () => {
    expect(suggestedTerritory(["/home/u/proj/src/reports/a.ts"])).toContain("src/reports/**");
  });

  it("requires a title to submit", () => {
    expect(canSubmitQuick(emptyQuickTask())).toBe(false);
    expect(canSubmitQuick({ ...emptyQuickTask(), title: "Fix tz" })).toBe(true);
  });

  it("maps quick state to local prompt and team body", () => {
    const q = {
      ...emptyQuickTask("board"),
      title: "Corrigir timezone",
      kind: "corrigir" as const,
      territory: ["src/reports/**"],
    };
    expect(quickLocalPrompt(q)).toContain("Corrigir timezone");
    expect(quickLocalPrompt(q)).toContain("src/reports/**");
    expect(quickTeamBody({ ...q, destination: "team" })).toMatchObject({
      title: "Corrigir timezone",
      kind: "corrigir",
    });
    expect(quickToFormState(q).destination).toBe("board");
  });

  it("filters Ctrl+K commands in prototype order and hides Distribuir without team", () => {
    expect(filterBoardCommands("").map((c) => c.id)).toEqual([
      "new-board",
      "new-team",
      "distribute",
      "import",
      "selection-to-task",
      "open-by-id",
    ]);
    expect(filterBoardCommands("seleção").map((c) => c.id)).toEqual(["selection-to-task"]);
    expect(filterBoardCommands("task").map((c) => c.id)).toEqual([
      "new-board",
      "new-team",
      "distribute",
      "import",
      "selection-to-task",
    ]);
    expect(visibleBoardCommands("task", { teamConnected: false }).map((c) => c.id)).toEqual([
      "new-board",
      "new-team",
      "import",
      "selection-to-task",
    ]);
    expect(visibleBoardCommands("task", { teamConnected: true }).map((c) => c.id)).toContain("distribute");
    expect(filterBoardCommands("#c0ffee12").map((c) => c.id)).toEqual(["open-by-id"]);
    expect(countUnassignedTeamTasks([{ state: "sem_dono" }, { state: "rodando" }, { state: "sem_dono" }])).toBe(2);
    const tasks = [
      { id: "c0ffee12-aaaa-4bbb-8ccc-ddddeeeeffff", prompt: "Criação rápida" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", prompt: "Outra" },
    ];
    expect(matchTaskByQuery("#c0ffee12", tasks)?.id).toBe(tasks[0]!.id);
    expect(matchTaskByQuery("criação", tasks)?.prompt).toContain("Criação");
    expect(matchTaskByQuery("#zzzz", tasks)).toBeNull();
  });
});
