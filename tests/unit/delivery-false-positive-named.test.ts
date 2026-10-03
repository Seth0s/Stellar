import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decideSubmitCheck } from "../../src/main/type-and-submit-decision";

/**
 * O "FALSO POSITIVO DE MENSAGEM ENVIADA" — NOMEADO, NÃO SILENCIADO (task 238388cc).
 *
 * O dono achou que este defeito já tinha sido resolvido. O que foi resolvido
 * (f2559b9b) foi a ATRIBUIÇÃO de report — parente, NÃO a confirmação de envio.
 * A confirmação de envio é `decideSubmitCheck` (`type-and-submit-decision.ts`) e
 * ela NÃO tem evidência positiva de submit para o provider GENÉRICO: o
 * `commandcode` NÃO declara `submitStartedPattern` (lido da declaração abaixo),
 * então a checagem afirmativa de "começou um turno" é PULADA ("Regra do Vazio",
 * doc do módulo) e o veredito `"sent"` cai em `agulha ausente + houve atividade`
 * — dois fatos que também são verdadeiros quando o Enter foi engolido e o
 * composer foi limpo por uma repintura. É este o falso positivo que continua de
 * pé, e o teste abaixo grava a FORMA exata dele para não voltar em silêncio.
 *
 * Sintoma (a) (card preso em running) e sintoma (b) (falso "enviada") NÃO são a
 * mesma raiz: (a) mora no reconhecimento do fim de turno
 * (`terminal-turn-signal.ts`); (b) mora na confirmação da entrega
 * (`type-and-submit-decision.ts`). Foi o (a) que este trabalho consertou.
 */
function declared(providerId: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(new URL("../../src/main/data/providers.builtin.json", import.meta.url), "utf8")) as {
    providers: Array<Record<string, unknown>>;
  };
  const p = json.providers.find((x) => x.id === providerId);
  if (!p) throw new Error(`provider ${providerId} não está em providers.builtin.json`);
  return p;
}

describe("(b) o falso positivo de 'mensagem enviada' — a forma, lida da declaração", () => {
  it("commandcode (GENÉRICO) não declara `submitStartedPattern` — a checagem afirmativa é pulada", () => {
    const delivery = declared("commandcode").capacity as Record<string, unknown> | undefined;
    const d = (delivery?.delivery ?? {}) as Record<string, unknown>;
    // A prova documental: sem vocabulário de início de turno declarado.
    expect(d.submitStartedPattern).toBeUndefined();
    // Ele DECLARA o fim de turno por tela (o marcador que a sonda mediu).
    expect(JSON.stringify(d.turnEnd)).toContain("Worked for");
  });

  it("o veredito `sent` é alcançado SEM nenhuma evidência POSITIVA de submit", () => {
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
    expect(result).toBe("sent");

    // E são EXATAMENTE dois fatos (ausência da agulha + atividade nova): tirar
    // a atividade derruba para `unknown`. Nenhum deles é evidência de que o
    // PROMPT FOI ACEITO — a evidência positiva é o que um
    // `submitStartedPattern` daria, e o commandcode não declara nenhum.
    const withoutActivity = decideSubmitCheck({
      screenText: "trabalho anterior do agente\nrégua\n❯ \nrégua\natalhos",
      screenTextBeforeWrite: "❯ \n",
      sentNeedle,
      hasNewActivitySinceWrite: false,
      targetRole: "agent",
    });
    expect(withoutActivity).toBe("unknown");
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
