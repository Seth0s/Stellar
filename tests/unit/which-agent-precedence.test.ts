import { describe, it, expect } from "vitest";
import { which, providerById } from "../../src/main/providers";

describe("reprodução: precedência de which() com binário ambíguo 'agent'", () => {
  it("retorna /qualquer/bin/agent em vez de cursor-agent no diretório posterior", () => {
    const pathDirs = ["/qualquer/bin", "/home/usuario/.local/bin"];
    const executables = new Set([
      "/qualquer/bin/agent",
      "/home/usuario/.local/bin/cursor-agent",
    ]);

    const isExecutable = (candidate: string) => executables.has(candidate);

    const cursorProvider = providerById("cursor")!;
    expect(cursorProvider.binaryNames).toEqual(["agent", "cursor-agent"]);

    const resolved = which(cursorProvider.binaryNames, {
      pathDirs,
      isExecutable,
      platform: "linux",
    });

    // O laço externo de which() varre pathDirs e o interno varre binaryNames.
    // Como /qualquer/bin é o primeiro diretório e contém um executável chamado "agent",
    // ele vence imediatamente e mascara o "cursor-agent" legítimo no diretório seguinte.
    expect(resolved).toBe("/qualquer/bin/agent");
    expect(resolved).not.toBe("/home/usuario/.local/bin/cursor-agent");
  });
});
