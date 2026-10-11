import { describe, expect, it } from "vitest";
import {
  LOCAL_IMPORT_BATCH_SIZE,
  addPreviewTotals,
  buildLocalImportRow,
  chunkRows,
  initialBatches,
  localExternalId,
  localImportBody,
  localTaskKind,
  localTaskTitle,
  newTaskCount,
  pickSample,
  processedLines,
  summarizeBatches,
  summarizeLocalBoard,
  totalOpen,
  totalOutOfScope,
} from "../../src/renderer/src/local-board-import-decisions";
import { collectLocalImportRows, loadLocalBoards, type LocalImportReader } from "../../src/renderer/src/local-board-import";

describe("local board import — mapping", () => {
  it("takes the first non-blank line as title, capped at 200 characters", () => {
    expect(localTaskTitle("\n  \n  Fix the header \nsecond line")).toBe("Fix the header");
    expect(localTaskTitle("   \n ")).toBe("");
    expect(Array.from(localTaskTitle("x".repeat(500))).length).toBe(200);
    // Code points, not UTF-16 units: no lone surrogate at the cut.
    expect(localTaskTitle("😀".repeat(300))).toBe("😀".repeat(200));
  });

  it("maps purpose to the team kind and defaults to implementar", () => {
    expect(localTaskKind("implement")).toBe("implementar");
    expect(localTaskKind("fix")).toBe("corrigir");
    expect(localTaskKind("investigate")).toBe("investigar");
    expect(localTaskKind("integrate")).toBe("integrar");
    expect(localTaskKind("measure")).toBe("medir");
    expect(localTaskKind(null)).toBe("implementar");
    expect(localTaskKind(undefined)).toBe("implementar");
    expect(localTaskKind("toString")).toBe("implementar");
  });

  it("builds a row with the full prompt as contract and a stable external id", () => {
    const row = buildLocalImportRow({ id: "abc", boardName: "B", prompt: "Title line\n\nbody", purpose: "fix" });
    expect(row).toEqual({
      title: "Title line",
      contract: "Title line\n\nbody",
      kind: "corrigir",
      priority: "media",
      external_id: "local:abc",
    });
    expect(localExternalId("abc")).toBe("local:abc");
    expect(buildLocalImportRow({ id: "x", boardName: "B", prompt: "  \n", purpose: null })).toBeNull();
  });

  it("serialises rows as the json import body", () => {
    const row = buildLocalImportRow({ id: "1", boardName: "B", prompt: "t", purpose: null })!;
    const body = localImportBody([row]);
    expect(body.kind).toBe("json");
    expect(body.continue).toBe(false);
    expect(body.mapping).toEqual({ title: "title", kind: "kind", priority: "priority", contract: "contract", external_id: "external_id" });
    expect(JSON.parse(body.data as string)).toEqual([row]);
  });
});

describe("local board import — scope and batches", () => {
  it("counts only pending and blocked as open", () => {
    const s = summarizeLocalBoard({ id: "b", name: "B" }, [
      { status: "pending" },
      { status: "pending" },
      { status: "blocked" },
      { status: "done" },
      { status: "failed" },
      { status: "superseded" },
      { status: "running" },
    ]);
    expect(s).toEqual({ id: "b", name: "B", pending: 2, blocked: 1, other: 4 });
    const t = summarizeLocalBoard({ id: "c", name: "C" }, [{ status: "done" }]);
    expect(totalOpen([s, t], new Set(["b", "c"]))).toBe(3);
    expect(totalOpen([s, t], new Set(["c"]))).toBe(0);
    expect(totalOutOfScope([s, t], new Set(["b", "c"]))).toBe(5);
  });

  it("chunks into batches of 200", () => {
    const rows = Array.from({ length: 219 }, (_, i) => i);
    const chunks = chunkRows(rows);
    expect(chunks.map((c) => c.length)).toEqual([200, 19]);
    expect(chunkRows([])).toEqual([]);
    expect(chunkRows(Array.from({ length: 200 }, (_, i) => i)).length).toBe(1);
    expect(LOCAL_IMPORT_BATCH_SIZE).toBe(200);
    expect(initialBatches(219).map((b) => b.lines)).toEqual([200, 19]);
    expect(initialBatches(0)).toEqual([]);
  });

  it("sums preview totals and derives the new count", () => {
    const totals = addPreviewTotals({ total: 200, duplicates: 3 }, { total: 19, duplicates: 3 });
    expect(totals).toEqual({ total: 219, duplicates: 6 });
    expect(newTaskCount(totals)).toBe(213);
    expect(newTaskCount({ total: 1, duplicates: 5 })).toBe(0);
  });

  it("summarises a run: done, stopped and failed", () => {
    const batches = initialBatches(219);
    batches[0] = { ...batches[0], status: "done", created: 197, skipped: 3 };
    expect(processedLines(batches)).toBe(200);
    const stopped = summarizeBatches(batches, true);
    expect(stopped).toMatchObject({ created: 197, skipped: 3, notImported: 19, batchesDone: 1, batchesTotal: 2, stopped: true, error: null });
    batches[1] = { ...batches[1], status: "failed", error: "boom" };
    expect(summarizeBatches(batches, false)).toMatchObject({ notImported: 19, error: "boom", stopped: false });
    batches[1] = { ...batches[1], status: "done", created: 16, skipped: 3, error: null };
    expect(summarizeBatches(batches, false)).toMatchObject({ created: 213, skipped: 6, notImported: 0, batchesDone: 2 });
  });

  it("samples up to three new rows then up to two existing ones", () => {
    const mk = (n: number, duplicate: boolean) => ({ title: `t${n}`, externalId: `e${n}`, duplicate, existingRef: null });
    const items = [mk(1, true), mk(2, false), mk(3, false), mk(4, false), mk(5, false), mk(6, true), mk(7, true)];
    expect(pickSample(items).map((i) => i.title)).toEqual(["t2", "t3", "t4", "t1", "t6"]);
  });
});

describe("local board import — reading", () => {
  const prompts: Record<string, string> = { a: "Alpha\nbody", b: "Beta", c: "   ", d: "Delta" };
  const reader: LocalImportReader = {
    listBoards: async () => [
      { id: "b1", name: "One" },
      { id: "b2", name: "Two" },
    ],
    listBoardTasks: async (boardId) =>
      boardId === "b1"
        ? [
            { id: "a", status: "pending", purpose: "fix" },
            { id: "b", status: "blocked", purpose: null },
            { id: "x", status: "done", purpose: null },
          ]
        : [
            { id: "b", status: "pending", purpose: null },
            { id: "c", status: "pending", purpose: null },
            { id: "d", status: "pending", purpose: "measure" },
          ],
    getPrompt: async (id) => (id in prompts ? { ok: true, prompt: prompts[id] } : { ok: false, error: "no such task" }),
  };

  it("collects open tasks of the selected boards once, skipping empty prompts", async () => {
    const snapshot = await loadLocalBoards(reader);
    expect(snapshot.summaries.map((s) => [s.id, s.pending, s.blocked, s.other])).toEqual([
      ["b1", 1, 1, 1],
      ["b2", 3, 0, 0],
    ]);
    const { rows, boardOf } = await collectLocalImportRows(reader, snapshot, new Set(["b1", "b2"]));
    expect(rows.map((r) => r.external_id)).toEqual(["local:a", "local:b", "local:d"]);
    expect(rows.map((r) => r.kind)).toEqual(["corrigir", "implementar", "medir"]);
    expect(boardOf.get("local:b")).toBe("One");
    const onlyTwo = await collectLocalImportRows(reader, snapshot, new Set(["b2"]));
    expect(onlyTwo.rows.map((r) => r.external_id)).toEqual(["local:b", "local:d"]);
  });

  it("surfaces a prompt read failure", async () => {
    const failing: LocalImportReader = { ...reader, getPrompt: async () => ({ ok: false, error: "no such task" }) };
    const snapshot = await loadLocalBoards(failing);
    await expect(collectLocalImportRows(failing, snapshot, new Set(["b1"]))).rejects.toThrow("no such task");
  });
});
