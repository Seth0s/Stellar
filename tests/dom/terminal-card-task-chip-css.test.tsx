/**
 * O CHIP DA TASK NO HEADER NÃO HERDA A CAIXA DE BOTÃO DE ÍCONE.
 *
 * O chip é um <button> dentro de `.card-head`, e `.card-head button` fixa
 * `width`/`height` na caixa de 28px dos botões de ícone (sino, parar, mais,
 * fechar). Sem um reset na regra do chip ele ficava um círculo de 28px com o
 * id vazando pelos dois lados — só uns dígitos do meio apareciam.
 *
 * jsdom não faz layout, então a medida de verdade está em
 * scripts/verify/smoke-card-task-chip.mjs. Aqui fica o que o CI consegue
 * prender: a regra do chip (e a do "+N") devolve largura e altura ao conteúdo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "../../src/renderer/src/styles/cards.css"), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `regra ${selector} existe`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("chip da task no header do card", () => {
  it("o botão de ícone do header continua fixando a caixa de 28px (a causa)", () => {
    const body = ruleBody(".card-head button");
    expect(body).toContain("width: var(--card-action-size)");
    expect(body).toContain("height: var(--card-action-size)");
  });

  it.each([".card-head .card-head-task", ".card-head .card-head-task-more"])("%s dimensiona pelo próprio texto", (selector) => {
    const body = ruleBody(selector);
    expect(body).toContain("width: auto");
    expect(body).toContain("height: auto");
    expect(body).toContain("flex: none");
  });

  it("o chip não ganha reticências: o id inteiro ou nada", () => {
    expect(ruleBody(".card-head .card-head-task")).not.toMatch(/text-overflow:\s*ellipsis/);
  });
});
