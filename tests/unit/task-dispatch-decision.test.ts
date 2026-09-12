import { describe, it, expect } from "vitest";
import { resolveTaskDispatchCwd, resolveTaskDispatchLabel } from "../../src/main/task-dispatch-decision";

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
