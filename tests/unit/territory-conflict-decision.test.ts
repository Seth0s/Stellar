import { describe, it, expect } from "vitest";
import { decideTerritoryConflict, territoryEntriesOverlap } from "../../src/main/territory-conflict-decision";

describe("territoryEntriesOverlap", () => {
  it("glob idêntico colide", () => {
    expect(territoryEntriesOverlap("vhosts/Backend/app/**", "vhosts/Backend/app/**")).toBe(true);
  });

  it("um prefixo de path cru dentro do glob do outro colide", () => {
    expect(territoryEntriesOverlap("vhosts/Admin/src/**", "vhosts/Admin/src/Foo.tsx")).toBe(true);
  });

  it("diretórios irmãos não colidem (mesma raiz, segmento seguinte diferente)", () => {
    expect(territoryEntriesOverlap("vhosts/Backend/app/**", "vhosts/Admin/src/**")).toBe(false);
  });

  it("arquivos com nomes parecidos mas distintos não colidem", () => {
    expect(territoryEntriesOverlap("src/main/message-bus.ts", "src/main/message-bus-old.ts")).toBe(false);
  });

  it("entrada com anotação colada colide pelo path real (medido: 'src/main/store.ts (actor)')", () => {
    expect(territoryEntriesOverlap("src/main/store.ts (actor)", "src/main/store.ts")).toBe(true);
  });

  it("'/' final equivale a '/**' — diretório inteiro", () => {
    expect(territoryEntriesOverlap("docs/", "docs/onboarding.md")).toBe(true);
  });

  it("prosa (medido: 'leitura de ~/.config/stellar…') nunca colide — não é path", () => {
    expect(territoryEntriesOverlap("leitura de ~/.config/stellar e ~/.config/agent-canvas", "src/main/store.ts")).toBe(false);
  });

  it("wildcard DENTRO de um segmento é comparado como string literal (limite declarado)", () => {
    expect(territoryEntriesOverlap("tests/unit/*task*", "tests/unit/task-board-model.test.ts")).toBe(false);
    expect(territoryEntriesOverlap("tests/unit/*task*", "tests/unit/*task*")).toBe(true);
  });
});

describe("decideTerritoryConflict", () => {
  it("território não declarado do candidato: nunca recusa (não inventa colisão)", () => {
    const decision = decideTerritoryConflict({
      taskId: "t1",
      territory: null,
      activeTasks: [{ taskId: "t2", territory: ["src/main/message-bus.ts"] }],
    });
    expect(decision.ok).toBe(true);
  });

  it("território não declarado da task ativa: nunca recusa (sem evidência do outro lado)", () => {
    const decision = decideTerritoryConflict({
      taskId: "t1",
      territory: ["src/main/message-bus.ts"],
      activeTasks: [{ taskId: "t2", territory: null }],
    });
    expect(decision.ok).toBe(true);
  });

  it("a própria task nunca conta como colisão contra si mesma", () => {
    const decision = decideTerritoryConflict({
      taskId: "t1",
      territory: ["src/main/message-bus.ts"],
      activeTasks: [{ taskId: "t1", territory: ["src/main/message-bus.ts"] }],
    });
    expect(decision.ok).toBe(true);
  });

  it("colisão real: recusa nomeando a task e as duas entradas", () => {
    const decision = decideTerritoryConflict({
      taskId: "t1",
      territory: ["vhosts/Backend/app/**", "vhosts/Backend/tests/**"],
      activeTasks: [
        { taskId: "t2", territory: ["vhosts/Admin/src/**"] },
        { taskId: "t3", territory: ["vhosts/Backend/app/**"] },
      ],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.conflictingTaskId).toBe("t3");
      expect(decision.mine).toBe("vhosts/Backend/app/**");
      expect(decision.theirs).toBe("vhosts/Backend/app/**");
      expect(decision.error).toContain("t3");
      expect(decision.error).toContain("ACTIVE");
    }
  });

  it("sem nenhum território sobreposto entre múltiplas tasks ativas: ok", () => {
    const decision = decideTerritoryConflict({
      taskId: "t1",
      territory: ["src/main/message-bus.ts", "src/main/spawn-profile-decision.ts"],
      activeTasks: [
        { taskId: "t2", territory: ["vhosts/Backend/app/**"] },
        { taskId: "t3", territory: ["vhosts/Admin/src/**"] },
      ],
    });
    expect(decision.ok).toBe(true);
  });
});
