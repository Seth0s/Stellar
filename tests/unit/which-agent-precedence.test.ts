import { describe, it, expect } from "vitest";
import { which, providerById } from "../../src/main/providers";

describe("reprodução: precedência de which() com binário ambíguo 'agent'", () => {
  it("comporta-se como name-major: prefere cursor-agent, mesmo que agent exista em diretório anterior", () => {
    const pathDirs = ["/qualquer/bin", "/home/usuario/.local/bin"];
    const executables = new Set([
      "/qualquer/bin/agent",
      "/home/usuario/.local/bin/cursor-agent",
    ]);

    const isExecutable = (candidate: string) => executables.has(candidate);

    const cursorProvider = providerById("cursor")!;
    expect(cursorProvider.binaryNames).toEqual(["cursor-agent", "agent"]);

    const resolved = which(cursorProvider.binaryNames, {
      pathDirs,
      isExecutable,
      platform: "linux",
    });

    // O laço externo de which() varre binaryNames e o interno varre pathDirs.
    // Como "cursor-agent" é o primeiro nome, ele procura em todo o PATH e encontra
    // em ~/.local/bin/cursor-agent, vencendo o "agent" ambíguo de um diretório anterior.
    expect(resolved).toBe("/home/usuario/.local/bin/cursor-agent");
    expect(resolved).not.toBe("/qualquer/bin/agent");
  });
});
