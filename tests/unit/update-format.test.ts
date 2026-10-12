import { describe, it, expect, beforeAll } from "vitest";
import { setLocale } from "../../src/shared/i18n";
import {
  errorDetailLine,
  formatMegabytes,
  formatSpeed,
  formatWholeMegabytes,
  parseChangelogNotes,
  remainingTime,
} from "../../src/renderer/src/update-format";
import type { UpdaterError } from "../../src/main/update-state";

beforeAll(() => setLocale("pt-BR"));

const err = (over: Partial<UpdaterError>): UpdaterError => ({
  kind: "network",
  stage: "download",
  code: null,
  detail: "boom",
  percent: null,
  transferred: null,
  total: null,
  neededBytes: null,
  freeBytes: null,
  swapLogPath: null,
  ...over,
});

describe("update numbers", () => {
  it("prints decimal megabytes with one decimal, in the locale", () => {
    expect(formatMegabytes(18_400_000, "pt-BR")).toBe("18,4");
    expect(formatMegabytes(38_200_000, "en")).toBe("38.2");
    expect(formatSpeed(3_100_000, "pt-BR")).toBe("3,1");
    expect(formatWholeMegabytes(38_200_000, "pt-BR")).toBe("38");
  });

  it("estimates the time left, rounding up", () => {
    expect(remainingTime({ transferred: 18_400_000, total: 38_200_000, bytesPerSecond: 3_100_000 })).toEqual({ unit: "s", value: 7 });
    expect(remainingTime({ transferred: 0, total: 300_000_000, bytesPerSecond: 1_000_000 })).toEqual({ unit: "min", value: 5 });
    expect(remainingTime({ transferred: 1, total: 10, bytesPerSecond: 1e9 })).toEqual({ unit: "s", value: 1 });
  });

  it("says nothing about time until a speed is known", () => {
    expect(remainingTime({ transferred: 0, total: 10, bytesPerSecond: 0 })).toBeNull();
    expect(remainingTime({ transferred: 0, total: 0, bytesPerSecond: 5 })).toBeNull();
  });
});

describe("errorDetailLine", () => {
  it("adds how far a download got", () => {
    expect(
      errorDetailLine(err({ code: "net::ERR_INTERNET_DISCONNECTED", detail: "net::ERR_INTERNET_DISCONNECTED", percent: 62, transferred: 23_700_000, total: 38_200_000 }), "pt-BR"),
    ).toBe("net::ERR_INTERNET_DISCONNECTED (62% · 23,7 de 38,2 MB)");
  });

  it("adds the disk numbers when they are known", () => {
    expect(
      errorDetailLine(err({ kind: "disk", code: "ENOSPC", detail: "no space left on device, write", neededBytes: 120_000_000, freeBytes: 41_000_000 }), "pt-BR"),
    ).toBe("ENOSPC: no space left on device, write (necessário 120 MB, livre 41 MB)");
  });

  it("leaves a bare message bare", () => {
    expect(errorDetailLine(err({ stage: "install", detail: "Command dnf exited with code 1" }), "pt-BR")).toBe("Command dnf exited with code 1");
  });
});

describe("parseChangelogNotes", () => {
  it("keeps list items and flattens inline markup", () => {
    const body = ["## Novidades", "", "- **Novo:** a janela de atualização", "* Corrigido: [fila](https://x.y) travava", "1. `Melhor` erro de rede", "", "<!-- stellar:commits -->", "---"].join("\n");
    expect(parseChangelogNotes(body)).toEqual(["Novo: a janela de atualização", "Corrigido: fila travava", "Melhor erro de rede"]);
  });

  it("counts a loose paragraph as a note and caps the list", () => {
    expect(parseChangelogNotes("Só um parágrafo.")).toEqual(["Só um parágrafo."]);
    expect(parseChangelogNotes(Array.from({ length: 20 }, (_, i) => `- n${i}`).join("\n"), 3)).toHaveLength(3);
  });

  it("is empty for an empty body", () => {
    expect(parseChangelogNotes("")).toEqual([]);
  });
});
