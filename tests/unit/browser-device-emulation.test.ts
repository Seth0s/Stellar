import { describe, it, expect } from "vitest";
import { buildMobileUserAgent } from "../../src/main/browser-registry";

/**
 * Pendentes #188, opção intermediária (device emulation UA+touch) —
 * investigação read-only anterior confirmou, ao vivo, que google.com só
 * serve o layout mobile quando o header `User-Agent` diz "Mobile"; o
 * viewport (`setContentSize`/`setZoomFactor`, já corretos) não muda o HTML
 * que o servidor decidiu mandar. `buildMobileUserAgent` é a única peça de
 * lógica pura desta tarefa (o resto — `wc.setUserAgent`, `wc.reload`,
 * `Emulation.setTouchEmulationEnabled` — só existe com um `webContents`
 * Electron de verdade, não testável aqui) — deriva o UA mobile a PARTIR do
 * UA desktop real da build (nunca hardcoded), pra nunca dessincronizar da
 * versão de Chromium embutida no Electron instalado.
 */
describe("buildMobileUserAgent: deriva um UA mobile do UA desktop real", () => {
  it("troca o token de plataforma por um Android e insere ' Mobile' antes do Safari final", () => {
    const desktop = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const mobile = buildMobileUserAgent(desktop);
    expect(mobile).toBe("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36");
  });

  it("preserva o número de versão do Chrome real (nunca hardcoded)", () => {
    const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.5.1234.7 Safari/537.36";
    expect(buildMobileUserAgent(desktop)).toContain("Chrome/99.5.1234.7");
  });

  it("é idempotente: aplicar de novo num UA já mobile não duplica ' Mobile'", () => {
    const desktop = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const onceApplied = buildMobileUserAgent(desktop);
    const twiceApplied = buildMobileUserAgent(onceApplied);
    expect(twiceApplied).toBe(onceApplied);
    expect(twiceApplied.match(/ Mobile /g)?.length ?? 0).toBe(1);
  });

  it("review adversarial achado 4: sem o sufixo Safari/ esperado, ainda assim garante a palavra 'Mobile' no UA (acrescenta no final)", () => {
    const semSafari = "Mozilla/5.0 (X11; Linux x86_64) AlgumMotorEstranho/1.0";
    expect(buildMobileUserAgent(semSafari)).toBe("Mozilla/5.0 (Linux; Android 13; Pixel 7) AlgumMotorEstranho/1.0 Mobile");
  });

  it("fallback do achado 4 também é idempotente", () => {
    const semSafari = "Mozilla/5.0 (X11; Linux x86_64) AlgumMotorEstranho/1.0";
    const onceApplied = buildMobileUserAgent(semSafari);
    expect(buildMobileUserAgent(onceApplied)).toBe(onceApplied);
  });
});
