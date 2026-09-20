import { describe, it, expect } from "vitest";
import { detectTrustPrompt } from "../../src/main/pty-registry";

// Item 18 do sticky (2026-09-20) — `detectTrustPrompt` é o reconhecimento
// puro por trás de `trustPromptPending`: um card `claude` cujo cwd ainda
// não é confiável para no "Quick safety check" TUI, e sem reconhecer o
// texto o único sinal que sobra é um exit ambíguo ("saiu (código 1)"),
// indistinguível de crash. Testado direto contra a função pura — o
// wiring com o pty real já é exercitado por
// `pty-registry-session-claim-leak.test.ts`.
const TRUST_PROMPT_TEXT =
  "Quick safety check: Is this a project you created or one you trust? " +
  "(Like your own code, a well-known open source project, or work from " +
  "your team). If not, take a moment to review what's in this folder first.";

describe("detectTrustPrompt", () => {
  it("reconhece o prompt exato para o provider claude", () => {
    const hit = detectTrustPrompt("claude", TRUST_PROMPT_TEXT);
    expect(hit).not.toBeNull();
    expect(hit?.excerpt).toContain("Quick safety check");
  });

  it("não reconhece nada quando o texto não contém o prompt", () => {
    expect(detectTrustPrompt("claude", "tudo normal, nenhum diálogo aqui")).toBeNull();
  });

  it("não reconhece o prompt para um provider não observado (sem diálogo medido)", () => {
    expect(detectTrustPrompt("codex", TRUST_PROMPT_TEXT)).toBeNull();
    expect(detectTrustPrompt("cursor", TRUST_PROMPT_TEXT)).toBeNull();
    expect(detectTrustPrompt("bash", TRUST_PROMPT_TEXT)).toBeNull();
  });

  it("reconhece o prompt mesmo cercado de outro scrollback (janela de flush)", () => {
    const noisy = `alguma saída anterior\n${TRUST_PROMPT_TEXT}\nmais texto depois`;
    const hit = detectTrustPrompt("claude", noisy);
    expect(hit).not.toBeNull();
    expect(hit?.excerpt).toContain("Quick safety check");
  });
});
