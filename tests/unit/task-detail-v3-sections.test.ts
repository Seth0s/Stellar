import { describe, expect, it } from "vitest";
import {
  extractAcceptanceBullets,
  extractWhatIsBlurb,
  measuredGateRows,
} from "../../src/renderer/src/task-detail-v3-sections";

describe("extractAcceptanceBullets", () => {
  it("reads bullets under O aceite", () => {
    const prompt = `Cards ainda esquecem o report.

O aceite
- Testes com amostras reais
- Smoke isolado
- Suíte sem regressão

FAZER
1. algo`;
    expect(extractAcceptanceBullets(prompt)).toEqual([
      "Testes com amostras reais",
      "Smoke isolado",
      "Suíte sem regressão",
    ]);
  });
});

describe("extractWhatIsBlurb", () => {
  it("takes leading prose before FAZER/ACEITE", () => {
    const prompt = `Cards ainda esquecem o report. Quando um implementador termina o turno…

FAZER
1. Fim de turno`;
    expect(extractWhatIsBlurb(prompt)).toMatch(/Cards ainda esquecem/);
  });
});

describe("measuredGateRows", () => {
  it("names the failed command and outside files when measured", () => {
    expect(
      measuredGateRows({
        ok: false,
        failedCommand: "npm run check:types",
        isolation: { undeclaredInTerritory: ["a.ts", "b.ts"] },
      }),
    ).toEqual([
      {
        cmd: "npm run check:types",
        ok: false,
        detail: "2 arquivos fora do território",
      },
    ]);
  });
});
