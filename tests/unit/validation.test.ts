import { describe, it, expect } from "vitest";
import { required } from "../../src/renderer/src/validation";

describe("validation functions", () => {
  it("required validator returns error on empty string or whitespace only", () => {
    const validate = required("Nome da Sessão");

    expect(validate("")).toBe("Nome da Sessão é obrigatório");
    expect(validate("   ")).toBe("Nome da Sessão é obrigatório");
    expect(validate("\t\n")).toBe("Nome da Sessão é obrigatório");
  });

  it("required validator returns null on valid non-empty string", () => {
    const validate = required("Nome da Sessão");

    expect(validate("Minha Sessão")).toBeNull();
    expect(validate("  Válido  ")).toBeNull();
  });
});
