import { describe, expect, it } from "vitest";
import {
  agentReceivesPreview,
  beforeCreateChecklist,
  canSubmitCreate,
  emptyCreateTaskForm,
  formToCreateContract,
  primaryCtaLabel,
  purposeFromQuickKind,
  seedFromQuick,
  territoryConflictsForCreate,
  whereColumn,
} from "../../src/renderer/src/create-task-form-decisions";

describe("create-task-form-decisions", () => {
  it("maps purpose pills from quick kinds", () => {
    expect(purposeFromQuickKind("investigar")).toBe("investigate");
    expect(purposeFromQuickKind("implementar")).toBe("implement");
    expect(purposeFromQuickKind("corrigir")).toBe("fix");
    expect(purposeFromQuickKind("medir")).toBe("measure");
  });

  it("defaults allowCommit to false", () => {
    expect(emptyCreateTaskForm().allowCommit).toBe(false);
  });

  it("requires a title to submit", () => {
    expect(canSubmitCreate(emptyCreateTaskForm())).toBe(false);
    expect(canSubmitCreate(emptyCreateTaskForm({ title: "Fix scroll" }))).toBe(true);
  });

  it("maps form to create_task contract fields", () => {
    const form = emptyCreateTaskForm({
      title: "Terminal scroll",
      purpose: "fix",
      briefing: "FEEDBACK\n\nFAZER\n1. Repro",
      territory: [
        { path: "src/renderer/src/useTerminal.ts", shared: false, sharedNote: "" },
        {
          path: "src/renderer/src/App.tsx",
          shared: true,
          sharedNote: "só o handler de visibilidade",
        },
      ],
      gates: [
        { cmd: "npm run check:types", exclusiveMachine: false },
        { cmd: "npx vitest run", exclusiveMachine: true },
      ],
      allowCommit: false,
      reviewWanted: true,
      provider: "claude",
      deps: [{ id: "ad6787aa-1111-2222-3333-444455556666", title: "inv", statusLabel: "rodando" }],
      maxRetries: 2,
      fallbackProviders: "antigravity, codex",
      cwd: "Stellar",
      suggestedPriority: "alta",
    });
    const contract = formToCreateContract(form);
    expect(contract.prompt).toContain("Terminal scroll");
    expect(contract.prompt).toContain("FEEDBACK");
    expect(contract.purpose).toBe("fix");
    expect(contract.territory).toEqual([
      "src/renderer/src/useTerminal.ts",
      "shared:src/renderer/src/App.tsx (só o handler de visibilidade)",
    ]);
    expect(contract.gates).toEqual([
      "npm run check:types",
      { cmd: "npx vitest run", exclusive: "machine" },
    ]);
    expect(contract.allowCommit).toBe(false);
    expect(contract.review).toBe("wanted");
    expect(contract.provider).toBe("claude");
    expect(contract.deps).toEqual(["ad6787aa-1111-2222-3333-444455556666"]);
    expect(contract.maxRetries).toBe(2);
    expect(contract.fallbackProviders).toEqual(["antigravity", "codex"]);
    expect(contract.cwd).toBe("Stellar");
    expect(contract.suggestedOrder).toBe(0);
  });

  it("detects territory overlap with running tasks", () => {
    const conflicts = territoryConflictsForCreate(
      [{ path: "src/renderer/src/App.tsx", shared: false, sharedNote: "" }],
      [
        {
          id: "511abc00-0000-0000-0000-000000000001",
          title: "other",
          territory: ["src/renderer/src/App.tsx"],
          phase: "running",
        },
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.id.startsWith("511abc")).toBe(true);
  });

  it("builds reactive CTA and column from when", () => {
    expect(primaryCtaLabel("deps")).toBe("Criar");
    expect(primaryCtaLabel("now")).toBe("Criar e despachar");
    expect(primaryCtaLabel("reserve")).toBe("Criar e reservar");
    expect(whereColumn("now")).toBe("Rodando");
  });

  it("lists conflict in before-create checklist", () => {
    const form = emptyCreateTaskForm({
      title: "x",
      briefing: "y",
      gates: [{ cmd: "npm test", exclusiveMachine: false }],
      territory: [{ path: "src/a.ts", shared: true, sharedNote: "note" }],
    });
    const items = beforeCreateChecklist(form, [
      { id: "511abc00-0000-0000-0000-000000000001", title: "t", territory: ["src/a.ts"], phase: "running" },
    ]);
    expect(items.some((i) => i.warn && i.text.includes("#511abc"))).toBe(true);
  });

  it("previews what the agent receives", () => {
    const text = agentReceivesPreview(
      emptyCreateTaskForm({
        title: "Terminal: scroll",
        purpose: "fix",
        briefing: "FEEDBACK DO DONO\nlinha2\nlinha3",
        territory: [{ path: "src/useTerminal.ts", shared: false, sharedNote: "" }],
        gates: [{ cmd: "npm test", exclusiveMachine: false }],
      }),
    );
    expect(text).toContain("corrigir");
    expect(text).toContain("Terminal: scroll");
    expect(text).toContain("commit: não");
  });

  it("seeds from quick create", () => {
    const seed = seedFromQuick({
      title: "Quick",
      kind: "implementar",
      contract: "brief",
      territory: ["src/**"],
    });
    expect(seed.purpose).toBe("implement");
    expect(seed.briefing).toBe("brief");
    expect(seed.territory?.[0]?.path).toBe("src/**");
  });
});
