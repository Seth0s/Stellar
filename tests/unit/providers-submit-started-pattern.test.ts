import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import { providerCapacity } from "../../src/main/providers";
import { decideSubmitCheck, deliveryNeedle } from "../../src/main/type-and-submit-decision";

/**
 * O INÍCIO DE TURNO POR PROVIDER, preso à SAÍDA REAL (2026-10-05).
 *
 * O defeito que isto trava: o composer global mostrava "Sem confirmação ·
 * Master: unknown" para uma mensagem que CHEGOU. A causa, medida: o commit
 * 6cc876f fez `sent` exigir evidência POSITIVA (`submitStartedPattern`), e os
 * padrões declarados não casavam a TUI real — o claude de hoje sorteia o VERBO
 * do spinner (`Drizzling`, `Swooping`…), e o commandcode (dinâmico) não
 * declarava marcador nenhum.
 *
 * A regra do repo é "medido, nunca presumido": cada `submitStartedPattern`
 * abaixo casa uma linha que foi COLHIDA ao vivo (um `read_card` num card
 * trabalhando) e gravada em `fixtures/tui-submit-started/`. Trocar o padrão por
 * um palpite derruba este teste.
 *
 * O caminho testado é o REAL (`decideSubmitCheck`), não um `.test()` solto: o
 * que importa não é o regex casar a linha, é o veredito virar `sent` quando a
 * evidência aparece, e NÃO virar `sent` quando só a tela ociosa está na frente.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/tui-submit-started/${name}`, import.meta.url), "utf8");

function patternFor(provider: string): RegExp {
  const pattern = providerCapacity(provider)?.delivery.submitStartedPattern;
  if (!pattern) throw new Error(`${provider} não declara submitStartedPattern`);
  return pattern;
}

beforeAll(() => {
  // O mesmo boot do app: sem isto o `commandcode` (dinâmico) não está no registro.
  loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-submit-started-")));
});

describe("submitStartedPattern dos providers — preso à saída real", () => {
  it("claude: a linha de spinner REAL aparece e promove a entrega a `sent`", () => {
    const idle = fixture("claude-idle.txt");
    const working = fixture("claude-working.txt");
    const pattern = patternFor("claude");
    // A prova da medição: a linha do spinner de um card trabalhando casa…
    expect(working).toContain("Drizzling…");
    expect(pattern.test(working)).toBe(true);
    // …e a tela parada no composer NÃO casa (nada de `sent` otimista).
    expect(pattern.test(idle)).toBe(false);

    const result = decideSubmitCheck({
      screenTextBeforeWrite: idle,
      screenText: working,
      sentNeedle: deliveryNeedle("resuma o estado do board"),
      hasNewActivitySinceWrite: true,
      targetRole: "agent",
      submitStartedPattern: pattern,
    });
    expect(result).toBe("sent");
  });

  it("commandcode: o marcador REAL (`esc to interrupt`) promove a entrega a `sent`", () => {
    const idle = fixture("commandcode-idle.txt");
    const working = fixture("commandcode-working.txt");
    const pattern = patternFor("commandcode");
    expect(working).toContain("esc to interrupt");
    expect(pattern.test(working)).toBe(true);
    // A tela que terminou o turno (`Worked for …`) NÃO é início de turno.
    expect(pattern.test(idle)).toBe(false);

    const result = decideSubmitCheck({
      screenTextBeforeWrite: idle,
      screenText: working,
      sentNeedle: deliveryNeedle("[de: Master] rode a task e reporte"),
      hasNewActivitySinceWrite: true,
      targetRole: "agent",
      submitStartedPattern: pattern,
    });
    expect(result).toBe("sent");
  });

  it("sem a evidência positiva, o veredito continua `unknown` — não é `sent` por presença de tela", () => {
    const idle = fixture("commandcode-idle.txt");
    const result = decideSubmitCheck({
      screenTextBeforeWrite: idle,
      screenText: idle,
      sentNeedle: deliveryNeedle("mensagem que não está na tela"),
      hasNewActivitySinceWrite: true,
      targetRole: "agent",
      submitStartedPattern: patternFor("commandcode"),
    });
    expect(result).toBe("unknown");
  });
});
