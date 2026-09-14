import { describe, it, expect } from "vitest";
import {
  resolveTaskDispatchCwd,
  resolveTaskDispatchLabel,
  decideTaskDispatchProvider,
  decideTaskDispatchCwd,
  PROVIDER_UNDECLARED_REASON,
} from "../../src/main/task-dispatch-decision";

describe("resolveTaskDispatchCwd", () => {
  it("usa o cwd da task quando é path não-vazio", () => {
    expect(resolveTaskDispatchCwd("/home/lucas/Workplace/Projects/Stellar")).toBe(
      "/home/lucas/Workplace/Projects/Stellar",
    );
  });

  it("trimma espaços laterais mas preserva o path", () => {
    expect(resolveTaskDispatchCwd("  /tmp/repo  ")).toBe("/tmp/repo");
  });

  it("fallback explícito: null/undefined/vazio → undefined (renderer usa activeBoardCwd)", () => {
    expect(resolveTaskDispatchCwd(null)).toBeUndefined();
    expect(resolveTaskDispatchCwd(undefined)).toBeUndefined();
    expect(resolveTaskDispatchCwd("")).toBeUndefined();
    expect(resolveTaskDispatchCwd("   ")).toBeUndefined();
  });

  it("não inventa path — só devolve o que a task carregou", () => {
    // Contraste com o bug: NUNCA derivar de board/heurística de repo aqui.
    expect(resolveTaskDispatchCwd(null)).not.toBe("/home/lucas");
  });
});

describe("decideTaskDispatchProvider", () => {
  it("provider declarado despacha com o valor trimado", () => {
    expect(decideTaskDispatchProvider("  cursor  ")).toEqual({ action: "dispatch", provider: "cursor" });
  });

  it("ausente/vazio → recusa; nunca inventa claude", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(decideTaskDispatchProvider(raw)).toEqual({
        action: "refuse",
        reason: PROVIDER_UNDECLARED_REASON,
      });
    }
    expect(decideTaskDispatchProvider(null).action === "refuse").toBe(true);
    expect(JSON.stringify(decideTaskDispatchProvider(null))).not.toContain("claude");
  });
});

describe("decideTaskDispatchCwd", () => {
  it("declaração da filha vence o pai", () => {
    expect(
      decideTaskDispatchCwd("/tmp/child", [{ id: "p", cwd: "/tmp/parent", depIds: [] }], ["p"]),
    ).toEqual({ action: "ok", cwd: "/tmp/child" });
  });

  it("herda o cwd do pai quando a filha está ausente", () => {
    expect(
      decideTaskDispatchCwd(null, [{ id: "p", cwd: "/tmp/parent", depIds: [] }], ["p"]),
    ).toEqual({ action: "ok", cwd: "/tmp/parent" });
  });

  it("pai NULL e avô com cwd → herda do avô", () => {
    expect(
      decideTaskDispatchCwd(
        null,
        [
          { id: "parent", cwd: null, depIds: ["grand"] },
          { id: "grand", cwd: "/tmp/grand", depIds: [] },
        ],
        ["parent"],
      ),
    ).toEqual({ action: "ok", cwd: "/tmp/grand" });
  });

  it("pais divergem em cwd → recusa com motivo legível", () => {
    const decision = decideTaskDispatchCwd(
      null,
      [
        { id: "a", cwd: "/tmp/a", depIds: [] },
        { id: "b", cwd: "/tmp/b", depIds: [] },
      ],
      ["a", "b"],
    );
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.reason).toContain("pais divergem em cwd");
      expect(decision.reason).toContain("/tmp/a");
      expect(decision.reason).toContain("/tmp/b");
    }
  });

  it("ninguém na cadeia tem cwd → undefined (board root)", () => {
    expect(
      decideTaskDispatchCwd(null, [{ id: "p", cwd: null, depIds: [] }], ["p"]),
    ).toEqual({ action: "ok", cwd: undefined });
  });
});

describe("resolveTaskDispatchLabel", () => {
  it("usa o prompt quando existe", () => {
    expect(resolveTaskDispatchLabel({ id: "abcdef12-xxxx", prompt: "i18n fase 2" })).toBe("i18n fase 2");
  });

  it("trunca prompt longo", () => {
    const long = "x".repeat(60);
    expect(resolveTaskDispatchLabel({ id: "abcdef12", prompt: long })).toBe(`${"x".repeat(45)}…`);
  });

  it("cai no id curto quando não há prompt", () => {
    expect(resolveTaskDispatchLabel({ id: "ceaabaac-rest-of-uuid", prompt: null })).toBe("task ceaabaac");
    expect(resolveTaskDispatchLabel({ id: "short", prompt: "  " })).toBe("task short");
  });
});
