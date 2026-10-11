import { describe, expect, it } from "vitest";
import {
  apiMappingFromRows,
  canManageImport,
  defaultSlackMapping,
  duplicateLabel,
  selectedImportCount,
  togglePreviewSelection,
  updateMappingTarget,
  wizardStepState,
  type ImportPreviewRow,
} from "../../src/renderer/src/import-decisions";
import {
  buildImportRequestBody,
  canRunImport,
  duplicateHint,
  mappingFromRows,
  parseImportPreview,
  previewSelectableCount,
} from "../../src/main/import-decision";

describe("import-decisions (renderer)", () => {
  it("gates import by role", () => {
    expect(canManageImport("owner")).toBe(true);
    expect(canManageImport("admin")).toBe(true);
    expect(canManageImport("member")).toBe(false);
    expect(canManageImport(null)).toBe(false);
  });

  it("formats duplicate hints with #ref", () => {
    const row: ImportPreviewRow = {
      title: "Fila",
      externalId: "slack:1",
      duplicate: true,
      existingRef: "58",
      meta: null,
      selected: false,
    };
    expect(duplicateLabel(row)).toBe("já importada como #58");
    expect(duplicateLabel({ ...row, existingRef: "#58" })).toBe("já importada como #58");
    expect(duplicateLabel({ ...row, duplicate: false })).toBeNull();
  });

  it("counts selected non-duplicates and toggles selection", () => {
    const rows: ImportPreviewRow[] = [
      { title: "A", externalId: "1", duplicate: false, existingRef: null, meta: null, selected: true },
      { title: "B", externalId: "2", duplicate: true, existingRef: "#58", meta: null, selected: false },
      { title: "C", externalId: "3", duplicate: false, existingRef: null, meta: null, selected: false },
    ];
    expect(selectedImportCount(rows)).toBe(1);
    const next = togglePreviewSelection(rows, "3");
    expect(selectedImportCount(next)).toBe(2);
    expect(togglePreviewSelection(rows, "2")).toEqual(rows);
  });

  it("updates mapping targets and builds API mapping", () => {
    const rows = defaultSlackMapping();
    const updated = updateMappingTarget(rows, "first_line", "contract");
    expect(updated.find((r) => r.sourceKey === "first_line")?.target).toBe("contract");
    expect(apiMappingFromRows(rows).title).toBe("first_line");
  });

  it("wizard step states", () => {
    expect(wizardStepState(3, 1)).toBe("done");
    expect(wizardStepState(3, 3)).toBe("active");
    expect(wizardStepState(3, 4)).toBe("todo");
  });
});

describe("import-decision (main)", () => {
  it("parses preview with existing_ref", () => {
    const preview = parseImportPreview({
      kind: "slack",
      total: 3,
      duplicates: 1,
      items: [
        { title: "A", external_id: "a", duplicate: false },
        { title: "B", external_id: "b", duplicate: true, existing_ref: "#58", meta: "Carla" },
      ],
    });
    expect(preview?.duplicates).toBe(1);
    expect(preview?.items[1]?.existingRef).toBe("#58");
    expect(duplicateHint(preview!.items[1]!)).toBe("já importada como #58");
    expect(previewSelectableCount(preview!.items)).toBe(1);
  });

  it("builds import request body and mapping from rows", () => {
    const body = buildImportRequestBody({
      kind: "slack",
      channel: "backlog",
      reaction: "ticket",
      continueImport: true,
    });
    expect(body.kind).toBe("slack");
    expect((body.rule as { channel: string }).channel).toBe("backlog");
    expect(body.continue).toBe(true);
    expect(canRunImport("member")).toBe(false);
    expect(mappingFromRows([{ sourceKey: "Titulo", sourceLabel: "Titulo", target: "title" }]).title).toBe("Titulo");
  });
});
