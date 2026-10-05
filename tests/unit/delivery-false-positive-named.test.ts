import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decideSubmitCheck } from "../../src/main/type-and-submit-decision";

/**
 * O "FALSO POSITIVO DE MENSAGEM ENVIADA" — NOMEADO (238388cc) e CORRIGIDO
 * (e256d946).
 *
 * A task 238388cc NOMEOU o defeito: o que tinha sido resolvido antes (f2559b9b)
 * era a ATRIBUIÇÃO de report — parente, NÃO a confirmação de envio. A confirmação
 * é `decideSubmitCheck`: o `commandcode` é GENÉRICO e não declara
 * `submitStartedPattern`, então a checagem AFIRMATIVA era PULADA ("Regra do
 * Vazio") e o veredito caía em `agulha ausente + houve atividade` — DOIS fatos
 * que também são verdadeiros quando o Enter foi engolido e uma repintura limpou
 * o composer — AFIRMANDO `sent`.
 *
 * A correção (e256d946) INVERTE A POLARIDADE: `sent` exige evidência POSITIVA de
 * submit; sem ela, `unknown`. Os casos abaixo nasceram VERMELHOS contra o código
 * anterior (devolviam `sent`) e ficam verdes com a inversão.
 */
function declared(providerId: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(new URL("../../src/main/data/providers.builtin.json", import.meta.url), "utf8")) as {
    providers: Array<Record<string, unknown>>;
  };
  const p = json.providers.find((x) => x.id === providerId);
  if (!p) throw new Error(`provider ${providerId} não está em providers.builtin.json`);
  return p;
}

describe("(b) o falso positivo de 'mensagem enviada' — a forma e o veredito NOVO", () => {
  it("commandcode PASSOU a declarar o início de turno MEDIDO (2026-10-05) — a checagem afirmativa não é mais pulada", () => {
    const delivery = declared("commandcode").capacity as Record<string, unknown> | undefined;
    const d = (delivery?.delivery ?? {}) as Record<string, unknown>;
    // 2026-10-05: o defeito do composer ("Sem confirmação · Master: unknown")
    // tinha DUAS metades. Aqui está a do provider dinâmico: ele era GENÉRICO e
    // não declarava vocabulário de início de turno, então a checagem afirmativa
    // era PULADA e o veredito caía em `unknown` para uma mensagem que chegou.
    // Medido ao vivo (Command Code v1.74.1) e declarado como FONTE de regex.
    expect(typeof d.submitStartedPattern).toBe("string");
    expect(String(d.submitStartedPattern)).toContain("esc to interrupt");
    // Ele DECLARA o fim de turno por tela (o marcador que a sonda mediu).
    expect(JSON.stringify(d.turnEnd)).toContain("Worked for");
  });

  it("Enter engolido + composer limpo por repintura ⇒ `unknown`, NUNCA `sent`", () => {
    const sentNeedle = "resuma o estado do board".slice(0, 24);
    const result = decideSubmitCheck({
      // Composer limpo e agulha ausente — o que TAMBÉM é o estado depois de uma
      // repintura que limpou um composer cujo Enter foi engolido.
      screenText: "trabalho anterior do agente\nrégua\n❯ \nrégua\natalhos",
      screenTextBeforeWrite: "❯ \n",
      sentNeedle,
      hasNewActivitySinceWrite: true,
      targetRole: "agent",
      // Sem `submitStartedPattern` e sem `midTurnParkedPattern`: a forma
      // declarada do commandcode.
    });
    // O defeito: os dois fatos FRACOS não provam que o prompt foi aceito. Sem
    // evidência positiva, a resposta honesta é "não sei".
    expect(result).toBe("unknown");
  });

  it("o veredito NÃO depende de 'houve atividade': sem ela, também `unknown`", () => {
    const sentNeedle = "resuma o estado do board".slice(0, 24);
    const withoutActivity = decideSubmitCheck({
      screenText: "trabalho anterior do agente\nrégua\n❯ \nrégua\natalhos",
      screenTextBeforeWrite: "❯ \n",
      sentNeedle,
      hasNewActivitySinceWrite: false,
      targetRole: "agent",
    });
    // Antes: com atividade dava `sent` espúrio e sem atividade dava `unknown`.
    // Agora os DOIS são `unknown` — a ausência de evidência positiva é o que
    // decide, não a atividade.
    expect(withoutActivity).toBe("unknown");
  });

  it("o caso LEGÍTIMO segue `sent`: com evidência POSITIVA de que o turno começou", () => {
    const sentNeedle = "resuma o estado do board".slice(0, 24);
    const result = decideSubmitCheck({
      screenTextBeforeWrite: "❯ \n",
      // O início de turno apareceu NOVO vs baseline — a ÚNICA evidência
      // positiva de que o prompt foi aceito.
      screenText: "resuma o estado do board\n✻ Thinking…\n❯ \n",
      sentNeedle,
      hasNewActivitySinceWrite: true,
      targetRole: "agent",
      submitStartedPattern: /\b(Thinking|Working|esc to interrupt)\b/i,
    });
    expect(result).toBe("sent");
  });

  it("com a agulha AINDA visível o veredito é `unsent` (o caminho honesto continua funcionando)", () => {
    const sentNeedle = "resuma o estado do board".slice(0, 24);
    expect(
      decideSubmitCheck({
        screenText: `❯ ${sentNeedle} resto do texto`,
        screenTextBeforeWrite: "❯ \n",
        sentNeedle,
        hasNewActivitySinceWrite: true,
        targetRole: "agent",
      }),
    ).toBe("unsent");
  });
});
