import { describe, expect, it } from "vitest";
import {
  EVAL_TIMEOUT_DEFAULT_MS,
  EVAL_TIMEOUT_MAX_MS,
  EVAL_TIMEOUT_MIN_MS,
  awaitExpressionSource,
  describeEvalTimeout,
  normalizeEvalTimeout,
} from "../../src/main/browser-eval-timeout-decision";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `browser_eval` que espera Promise e tem limite próprio (task 56624e6b).
 * Os dois modos de falha medidos: o objeto interno do Zone.js devolvido como
 * se fosse valor, e a espera que escorria até o idle timeout de 300s do MCP.
 */
describe("normalizeEvalTimeout — quanto esperar", () => {
  it("ausente ou inválido cai no default de 10s", () => {
    expect(normalizeEvalTimeout(undefined)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout(null)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout("3000")).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout(Number.NaN)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(EVAL_TIMEOUT_DEFAULT_MS).toBe(10_000);
  });

  it("respeita o valor do chamador dentro da faixa (o limite É parâmetro)", () => {
    expect(normalizeEvalTimeout(3000)).toBe(3000);
    expect(normalizeEvalTimeout(100)).toBe(EVAL_TIMEOUT_MIN_MS);
    expect(normalizeEvalTimeout(250)).toBe(250);
  });

  it("teta no máximo para não encostar no idle timeout do MCP", () => {
    expect(normalizeEvalTimeout(999_999)).toBe(EVAL_TIMEOUT_MAX_MS);
    expect(EVAL_TIMEOUT_MAX_MS).toBeLessThan(300_000);
  });
});

describe("describeEvalTimeout — a metade do conserto que é a mensagem", () => {
  const texto = describeEvalTimeout({ waitedMs: 3000, timeoutMs: 3000 });

  it("diz QUANTO esperou, em ms e em segundos", () => {
    expect(texto).toContain("3000ms");
    expect(texto).toContain("3.0s");
  });

  it("diz que o script SEGUE rodando e que o resultado foi descartado", () => {
    expect(texto).toContain("KEPT RUNNING");
    expect(texto).toContain("discarded");
  });

  it("ensina como aumentar, e nomeia o teto", () => {
    expect(texto).toContain("timeoutMs");
    expect(texto).toContain(String(EVAL_TIMEOUT_MAX_MS));
  });

  it("avisa que expressão que nunca resolve SEMPRE vai bater nesse limite", () => {
    expect(texto).toContain("never");
  });
});

describe("awaitExpressionSource — a espera por `.then`, não por identidade", () => {
  it("o envelope espera por `.then` (sobrevive ao Zone.js e a polyfill)", () => {
    const src = awaitExpressionSource("Promise.resolve(1)");
    expect(src).toContain("typeof valor.then === \"function\"");
    expect(src).toContain("await valor");
    expect(src.startsWith("(async () => {")).toBe(true);
  });

  it("a expressão do chamador entra LITERAL (sem escaping que a mude)", () => {
    const expr = "(() => ({ a: `t${1}`, b: \"x\" }))()";
    expect(awaitExpressionSource(expr)).toContain(expr);
  });

  it("o registry usa o envelope E o limite próprio no caminho do browser_eval", () => {
    // Amarra o fio: sem isto, o módulo poderia estar testado e NÃO usado.
    const registry = readFileSync(fileURLToPath(new URL("../../src/main/browser-registry.ts", import.meta.url)), "utf8");
    expect(registry).toContain("awaitExpressionSource(js)");
    expect(registry).toContain("normalizeEvalTimeout(timeoutMsInput)");
    expect(registry).toContain("describeEvalTimeout({");
  });
});
