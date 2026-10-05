import { describe, expect, it } from "vitest";
import type { TeamTaskDependencyInfo } from "../../src/preload/index";
import {
  canConfirmDelete,
  deleteDescriptionKey,
  deleteImpact,
  deleteSubmitKey,
  normalizeConfirm,
} from "../../src/renderer/src/team-task-delete-decisions";

const dep: TeamTaskDependencyInfo = { id: "d1", shortId: 60, title: "Métricas de retry", state: "sem_dono" };

describe("team-task-delete-decisions", () => {
  it("lists the running agent only when the task is running", () => {
    const running = deleteImpact({ state: "rodando" }, []);
    expect(running[0].key).toBe("teamTask.delete.impact.agent");
    const idle = deleteImpact({ state: "sem_dono" }, []);
    expect(idle.some((i) => i.key === "teamTask.delete.impact.agent")).toBe(false);
  });

  it("names each dependent and always ends with the history line", () => {
    const lines = deleteImpact({ state: "rodando" }, [dep]);
    expect(lines.map((l) => l.key)).toEqual([
      "teamTask.delete.impact.agent",
      "teamTask.delete.impact.dependent",
      "teamTask.delete.impact.history",
    ]);
    expect(lines[1].params).toEqual({ ref: "#60", title: "Métricas de retry" });
  });

  it("requires typing the id, with or without the hash", () => {
    expect(normalizeConfirm(" #58 ")).toBe("58");
    expect(canConfirmDelete("#58", "#58")).toBe(true);
    expect(canConfirmDelete("58", "#58")).toBe(true);
    expect(canConfirmDelete("", "#58")).toBe(false);
    expect(canConfirmDelete("59", "#58")).toBe(false);
  });

  it("labels the submit button per mode", () => {
    expect(deleteSubmitKey("archive")).toBe("teamTask.delete.submitArchive");
    expect(deleteSubmitKey("purge")).toBe("teamTask.delete.submitPurge");
  });

  it("uses the risky description only when running or with dependents", () => {
    expect(deleteDescriptionKey({ state: "rodando" }, [])).toBe("teamTask.delete.descRisky");
    expect(deleteDescriptionKey({ state: "sem_dono" }, [dep])).toBe("teamTask.delete.descRisky");
    expect(deleteDescriptionKey({ state: "sem_dono" }, [])).toBe("teamTask.delete.desc");
  });
});
