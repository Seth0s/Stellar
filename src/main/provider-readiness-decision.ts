/**
 * "O BINÁRIO EXISTE" NÃO É "DÁ PARA USAR" (task 1777060e).
 *
 * O DEFEITO, medido nesta máquina com o `omp` (Oh My Pi 18.2.8), que está
 * instalado e PELA METADE de propósito (o valor dele para esta task é estar
 * assim):
 *
 *   - `which omp` resolve (`~/.bun/bin/omp`) e `omp --version` responde
 *     `omp/18.2.8` — para o `checkAgentAvailability` isto era DISPONÍVEL;
 *   - a credencial NÃO existe: `omp auth-broker status --json` devolve
 *     `{"ok":false,"reason":"not_configured"}` (exit 0, medido), e a tabela
 *     `auth_credentials` do `agent.db` tem 0 linhas;
 *   - e `omp -p "..."` NÃO ERRA, NÃO IMPRIME NADA e PENDURA até ser morto.
 *
 * Resultado: o provider aparecia disponível, o spawn "dava certo", e o card
 * ficava calado para sempre — e o `card_status` de provider genérico responde
 * `unknown`, então nem o orquestrador percebe. Um card verde que nunca responde.
 *
 * A CLASSE DO DEFEITO é a que esta base passou o dia inteiro removendo:
 * pergunta cara respondida por um proxy barato. "Disponível" derivado de "o
 * arquivo existe" é o mesmo formato do `running` derivado de "card vivo".
 *
 * A REGRA DAQUI, e é assimétrica de propósito: só a PROVA conta. Um probe que
 * não respondeu (ausente, timeout, saída ilegível) NÃO é evidência de ausência
 * de credencial — é `unknown`, e `unknown` nunca vira acusação nem vira
 * "pronto". As quatro respostas, cada uma do tamanho da evidência:
 *
 *   missing    — o binário não resolve (`which` = null);
 *   not-ready  — instalado E o probe DECLARADO respondeu que não está pronto
 *                (o próprio tool diz: `{"ok":false,"reason":"not_configured"}`);
 *   ready      — instalado E o probe respondeu que está;
 *   unknown    — instalado, e o app NÃO SABE: nenhum probe declarado, ou o
 *                probe não chegou a responder. É o estado honesto — e é por
 *                isso que ele é o default de um provider que não declara nada.
 *
 * POR QUE O PROBE É DECLARADO POR PROVIDER E NÃO UMA HEURÍSTICA GLOBAL: como
 * saber "pronto" varia por harness. Medido no `omp`, os caminhos que respondem
 * sem chamar modelo são `omp auth-broker status --json` (0,69s, resposta
 * explícita em JSON, exit 0) e a própria tabela `auth_credentials` do
 * `agent.db` (0,78ms). Nenhum dos dois é genérico: o segundo lê um schema
 * PRIVADO do tool (uma atualização dele quebra a sonda EM SILÊNCIO, que é o
 * pior resultado possível — uma resposta errada é pior que `unknown`), e o
 * primeiro é `omp`-específico por construção. Então o probe mora na DECLARAÇÃO
 * do provider (o mesmo lugar onde o `binaryNames` e o `session.store` já
 * moram), e o que este módulo faz é LER a resposta dele.
 *
 * ORÇAMENTO (medido, e é o que decidiu o desenho): a sonda do `omp` custa
 * 0,69s, contra os ~1,7s que o spec do opencode JÁ recusou para validação por
 * spawn. Por isso ela NÃO roda no caminho do spawn nem no caminho síncrono do
 * `checkAgentAvailability` (que é `which()` síncrono, e bloquear o main por
 * 0,69s congelaria a UI): roda em background, com cache por TTL, e o resultado
 * chega à tela pelo mesmo push que o resto da disponibilidade já usa. Enquanto
 * não chegou, a resposta é `unknown` — nunca "pronto" por otimismo.
 */

export type ProviderReadinessState = "missing" | "ready" | "not-ready" | "unknown";

/**
 * O probe DECLARADO no spec do provider. `command` roda o PRÓPRIO binário do
 * provider com estes args (nunca um shell), com timeout curto, e lê o veredito
 * de um campo do JSON que ele imprime.
 *
 * O veredito vem do CAMPO, não do exit code: medido, `omp auth-broker status
 * --json` sai com 0 e diz `"ok": false`. Amarrar a resposta a exit code seria
 * ler a evidência errada — e um dia o tool mudaria de código de saída sem
 * mudar de significado.
 */
export type ReadinessProbe = {
  kind: "command";
  /** Args do PRÓPRIO binário (um item = um elemento de argv; sem shell). */
  args: string[];
  /** Campo booleano do JSON impresso que diz "pronto" (ex.: `"ok"`). */
  okPath: string;
  /** Teto do probe. Curto de propósito: não é validação de trabalho, é leitura. */
  timeoutMs: number;
  /**
   * O comando que o HUMANO roda para sair do estado. DADO, não invenção: quem
   * declara o provider mediu o comando dele. `null`/ausente = a UI não promete
   * nenhum caminho (melhor não dizer nada do que mandar o dono rodar algo
   * errado).
   */
  hint?: string | null;
};

/** A resposta do probe, como ele foi executado. `null` = ainda não rodou. */
export type ReadinessProbeResult =
  | { kind: "answered"; stdout: string }
  | { kind: "unanswered"; why: "spawn-failed" | "timeout" | "exit-code" };

export type ReadinessDecision = {
  state: ProviderReadinessState;
  /** O QUE sustenta a resposta — viaja para a tela e para o relato. */
  evidence: string;
};

/** Lê um campo booleano de um JSON impresso. Devolve `null` quando não dá para
 *  ler (não é JSON, não é objeto, o campo não é booleano) — e `null` NUNCA é
 *  tratado como `false`: é ausência de resposta. */
export function readReadinessVerdict(stdout: string, okPath: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>)[okPath];
  return typeof value === "boolean" ? value : null;
}

/** A razão que o PRÓPRIO tool deu (`reason`), para a tela poder repetir a
 *  palavra dele em vez de inventar uma. Ausente quando não há. */
export function readReadinessReason(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const reason = parsed?.reason;
    return typeof reason === "string" && reason.trim() !== "" ? reason : null;
  } catch {
    return null;
  }
}

/**
 * A decisão, pura. Ordem das perguntas — e cada uma responde o que PODE:
 *
 *   1. o binário resolve? não -> `missing` (a única negativa sustentada por
 *      um fato de disco);
 *   2. o provider declara um probe? não -> `unknown` (o app não sabe, e dizer
 *      "pronto" aqui é exatamente o defeito que esta task remove);
 *   3. o probe respondeu? não (timeout/exit/spawn) -> `unknown` com a razão do
 *      INSTRUMENTO — nunca "sem credencial", que seria inventar;
 *   4. o veredito é legível? não -> `unknown`;
 *   5. veredito `true` -> `ready`; `false` -> `not-ready`, repetindo o `reason`
 *      que o tool deu.
 */
export function decideProviderReadiness(input: {
  installed: boolean;
  probe: ReadinessProbe | null;
  result: ReadinessProbeResult | null;
}): ReadinessDecision {
  if (!input.installed) {
    return { state: "missing", evidence: "o binário não resolve no PATH" };
  }
  if (input.probe === null) {
    return { state: "unknown", evidence: "instalado; nenhum probe de prontidão declarado" };
  }
  if (input.result === null) {
    return { state: "unknown", evidence: "instalado; o probe declarado ainda não respondeu" };
  }
  if (input.result.kind === "unanswered") {
    return { state: "unknown", evidence: `instalado; o probe não respondeu (${input.result.why})` };
  }
  const verdict = readReadinessVerdict(input.result.stdout, input.probe.okPath);
  if (verdict === null) {
    return { state: "unknown", evidence: "instalado; a saída do probe não diz pronto/não-pronto" };
  }
  if (verdict) return { state: "ready", evidence: "o probe declarado respondeu que está pronto" };
  const reason = readReadinessReason(input.result.stdout);
  return {
    state: "not-ready",
    evidence:
      reason === null ? "o probe declarado respondeu que NÃO está pronto" : `respondeu: ${reason}`,
  };
}
