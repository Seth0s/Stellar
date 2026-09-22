import { describe, it, expect } from "vitest";
import { deriveVersionJump } from "../../src/renderer/src/update-jump";

/** O SELO DO SALTO (task 5fb0c21b): patch / minor / major, pela regra do
 *  semver, decidido puro e testado — sem lib `semver` (o app não a tem como
 *  dependência direta) e sem inventar selo quando a versão não é comparável. */
describe("deriveVersionJump", () => {
  it("patch quando só o terceiro número muda", () => {
    expect(deriveVersionJump("0.8.2", "0.8.3")).toBe("patch");
    expect(deriveVersionJump("0.8.2", "0.8.99")).toBe("patch");
  });

  it("minor quando o segundo muda (mesmo com o terceiro voltando)", () => {
    expect(deriveVersionJump("0.8.2", "0.9.0")).toBe("minor");
    expect(deriveVersionJump("0.8.2", "0.9.1")).toBe("minor");
  });

  it("major quando o primeiro muda", () => {
    expect(deriveVersionJump("0.8.2", "1.0.0")).toBe("major");
    expect(deriveVersionJump("1.9.9", "2.0.0")).toBe("major");
  });

  it("pré-release e metadados de build são ignorados na comparação (semver)", () => {
    expect(deriveVersionJump("0.8.2-beta.1", "0.8.2")).toBe("patch");
    expect(deriveVersionJump("0.8.2+sha.abc", "0.8.3")).toBe("patch");
    expect(deriveVersionJump("0.8.2", "1.0.0-rc.1")).toBe("major");
  });

  it("versão não comparável -> null (a UI não inventa selo)", () => {
    for (const [a, b] of [
      ["0.8", "1.0.0"],
      ["0.8.2", "v1.0.0"],
      ["", "1.0.0"],
      ["0.8.2", "abc"],
      ["0.8.2.1", "1.0.0"],
    ] as const) {
      expect(deriveVersionJump(a, b), `${a} -> ${b}`).toBeNull();
    }
  });
});
