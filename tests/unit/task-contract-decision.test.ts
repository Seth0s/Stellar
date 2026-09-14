import { describe, it, expect } from "vitest";
import {
  parseTaskContractInput,
  appendTaskContract,
  missingReportSchemaField,
  contractFromTaskRow,
  allowCommitToSql,
  allowCommitFromSql,
  territoryToSql,
  territoryFromSql,
} from "../../src/main/task-contract-decision";

describe("parseTaskContractInput", () => {
  it("absent everything is NORMAL nulls", () => {
    expect(parseTaskContractInput({})).toEqual({
      ok: true,
      contract: { territory: null, gates: null, allowCommit: null, reportSchema: null },
    });
  });

  it("accepts structured lists and boolean", () => {
    const d = parseTaskContractInput({
      territory: [" src/a.ts ", "src/b.ts"],
      gates: ["npm test"],
      allowCommit: false,
      reportSchema: ["separation", "evidence"],
    });
    expect(d).toEqual({
      ok: true,
      contract: {
        territory: ["src/a.ts", "src/b.ts"],
        gates: ["npm test"],
        allowCommit: false,
        reportSchema: ["separation", "evidence"],
      },
    });
  });

  it("refuses a bad shape and names the field", () => {
    expect(parseTaskContractInput({ territory: "src/" })).toMatchObject({
      ok: false,
      field: "territory",
    });
    expect(parseTaskContractInput({ gates: [""] })).toMatchObject({ ok: false, field: "gates" });
    expect(parseTaskContractInput({ allowCommit: "no" })).toMatchObject({
      ok: false,
      field: "allowCommit",
    });
    expect(parseTaskContractInput({ reportSchema: [1] })).toMatchObject({
      ok: false,
      field: "reportSchema",
    });
  });

  it("null clears a field when explicitly passed", () => {
    const d = parseTaskContractInput({ territory: null, allowCommit: null });
    expect(d.ok && d.contract.territory).toBeNull();
    expect(d.ok && d.contract.allowCommit).toBeNull();
  });
});

describe("appendTaskContract", () => {
  it("leaves brief alone when nothing is declared", () => {
    expect(appendTaskContract("do the work", {
      territory: null,
      gates: null,
      allowCommit: null,
      reportSchema: null,
    })).toBe("do the work");
    expect(appendTaskContract(undefined, {
      territory: null,
      gates: null,
      allowCommit: null,
      reportSchema: null,
    })).toBeUndefined();
  });

  it("appends only declared fields as a structured block", () => {
    const text = appendTaskContract("fix the bug", {
      territory: ["src/main/foo.ts"],
      gates: ["npx vitest run foo"],
      allowCommit: false,
      reportSchema: ["separation", "files"],
    });
    expect(text).toBe(
      [
        "fix the bug",
        "",
        "[stellar:contract]",
        "territory:",
        "- src/main/foo.ts",
        "gates:",
        "- npx vitest run foo",
        "allowCommit: false",
        "reportSchema:",
        "- separation",
        "- files",
      ].join("\n"),
    );
  });

  it("contract-only brief when prompt is empty", () => {
    expect(
      appendTaskContract(undefined, {
        territory: null,
        gates: null,
        allowCommit: false,
        reportSchema: null,
      }),
    ).toBe("[stellar:contract]\nallowCommit: false");
  });
});

describe("missingReportSchemaField", () => {
  it("returns null when schema is absent or satisfied", () => {
    expect(missingReportSchemaField({ ok: true }, null)).toBeNull();
    expect(missingReportSchemaField({ ok: true, a: 1 }, ["a"])).toBeNull();
    expect(missingReportSchemaField({ a: null, b: false }, ["a", "b"])).toBeNull();
  });

  it("names the first missing key", () => {
    expect(missingReportSchemaField({ ok: true }, ["separation", "files"])).toBe("separation");
    expect(missingReportSchemaField({ separation: "x" }, ["separation", "files"])).toBe("files");
  });

  it("non-object report fails the first schema field", () => {
    expect(missingReportSchemaField("plain", ["a"])).toBe("a");
    expect(missingReportSchemaField(["a"], ["a"])).toBe("a");
  });
});

describe("sql round-trip", () => {
  it("territory and allowCommit survive TEXT/INTEGER NULL", () => {
    expect(territoryFromSql(territoryToSql(["a", "b"]))).toEqual(["a", "b"]);
    expect(territoryFromSql(territoryToSql(null))).toBeNull();
    expect(allowCommitFromSql(allowCommitToSql(false))).toBe(false);
    expect(allowCommitFromSql(allowCommitToSql(true))).toBe(true);
    expect(allowCommitFromSql(allowCommitToSql(null))).toBeNull();
  });

  it("contractFromTaskRow reads store columns", () => {
    expect(
      contractFromTaskRow({
        territory_json: '["src/x.ts"]',
        gates_json: '["npm test"]',
        allow_commit: 0,
        report_schema_json: '["separation"]',
      }),
    ).toEqual({
      territory: ["src/x.ts"],
      gates: ["npm test"],
      allowCommit: false,
      reportSchema: ["separation"],
    });
  });
});
