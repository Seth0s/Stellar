/**
 * `browser_eval` — quanto esperar, e o que dizer quando estoura.
 *
 * Dois modos de falha medidos em uso real (task 56624e6b):
 *
 * MODO 1 — um eval cujo JavaScript levava 3,3s foi morto pelo idle timeout de
 * 300s do MCP, e o erro que chegou (\"idle timeout\") não falava do script.
 * MECANISMO: a expressão devolvia um thenable que NUNCA resolvia (o
 * `setTimeout` aninhado pendurava a cadeia) e a espera ficou aberta até o
 * limite ALHEIO. O conserto não é "esperar menos": é ter limite PRÓPRIO e uma
 * mensagem que diga o que foi esperado.
 *
 * MODO 2 — numa SPA Angular, devolver uma Promise trouxe literalmente
 * `{\"__zone_symbol__state\": null, \"__zone_symbol__value\": []}`. O Zone.js
 * TROCA a Promise global; a espera do Electron reconhece Promise por
 * identidade, não reconhece a trocada, e devolve o OBJETO como se fosse o
 * valor — um valor plausível que não é o valor, pior que um erro. MEDIDO na
 * fixture do smoke (que substitui a Promise global, como o Zone faz): a mesma
 * expressão devolveu o objeto do Zone antes, e o valor depois.
 *
 * O limite default de 10s cobre o uso normal (medir/rolar/esperar um render) e
 * é PARÂMETRO porque há eval legitimamente lento; o teto existe para não
 * encostar no idle timeout do MCP.
 */

/** Limite default de um `browser_eval`, em ms. */
export const EVAL_TIMEOUT_DEFAULT_MS = 10_000;
/** Piso: abaixo disso nem uma ida e volta à página cabe. */
export const EVAL_TIMEOUT_MIN_MS = 200;
/** Teto: o idle timeout do MCP (~300s) é um erro RUIM de receber; o limite
 * próprio tem de estourar antes, com uma mensagem do script. */
export const EVAL_TIMEOUT_MAX_MS = 120_000;

/** Normaliza o limite vindo do chamador (ausente/inválido → default). */
export function normalizeEvalTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return EVAL_TIMEOUT_DEFAULT_MS;
  const clamped = Math.round(value);
  if (clamped < EVAL_TIMEOUT_MIN_MS) return EVAL_TIMEOUT_MIN_MS;
  if (clamped > EVAL_TIMEOUT_MAX_MS) return EVAL_TIMEOUT_MAX_MS;
  return clamped;
}

/** AGENT-FACING — DO NOT TRANSLATE. Diz o que houve e como mudar. */
export function describeEvalTimeout(input: { waitedMs: number; timeoutMs: number }): string {
  return (
    `[de: stellar] browser_eval gave up after waiting ${input.timeoutMs}ms (${(input.timeoutMs / 1000).toFixed(1)}s) ` +
    `for the expression to settle — the script itself KEPT RUNNING in the page (nothing was killed, and its result ` +
    `was discarded), and if it resolves a promise later you will not see it. This is a limit of THIS call, not the ` +
    `page's: pass a larger \`timeoutMs\` (up to ${EVAL_TIMEOUT_MAX_MS}ms) when the eval legitimately takes long ` +
    `(waiting a render, scrolling a big page), or make the expression resolve faster — an expression that never ` +
    `settles (a promise with no resolve, a chained setTimeout that hangs) will always hit this. Nothing was returned.`
  );
}

/**
 * Corpo que roda DENTRO da página: espera a expressão do chamador por `.then`,
 * NÃO por identidade de Promise — é isso que sobrevive ao Zone.js e a qualquer
 * polyfill que troque a Promise global.
 *
 * O envelope é uma `async function`: o `await` dela usa a máquina interna do
 * JavaScript, então o valor que chega de volta ao processo main é uma Promise
 * de verdade (reconhecível), não o objeto do framework.
 */
export function awaitExpressionSource(expression: string): string {
  return `(async () => {
    const valor = (${expression});
    if (valor && typeof valor.then === "function") return await valor;
    return valor;
  })()`;
}
