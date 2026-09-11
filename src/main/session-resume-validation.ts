/**
 * DESIGN-BACKLOG.md, "Bugs Urgentes" — `resume_id` nao sobrevive ao
 * restart, achado 2 (2026-09-11): o card 330 restaurou com
 * `resume_id = ae126710...` (arquivo de 2550 bytes, nascido do spawn
 * travado que o usuário matou) em vez de `53fcab93...` (15.9 MB, a sessão
 * de fato em uso). Nada na leitura de boot desconfiava de um `resume_id`
 * — `pty-registry.ts::spawn` pulava `watchForSession` inteiro sempre que
 * `spawnOpts.resumeId` vinha preenchido (ver seu próprio comentário,
 * ~473-501) e passava direto pra `--resume <id>`, silencioso mesmo que o
 * arquivo/registro por trás daquele id não existisse mais ou nunca tivesse
 * recebido conteúdo real.
 *
 * Esta é a metade PURA e testável dessa checagem — mesmo precedente de
 * `session-rearm-decision.ts`: cada provider tem seu próprio formato de
 * armazenamento (arquivo `.jsonl` do claude, `.db` sqlite do antigravity,
 * diretório com `store.db` do cursor, linha de tabela do opencode, índice
 * append-only do codex), então TODA a leitura de disco/db por-provider
 * fica fora daqui (`getResumeTargetEvidence` em `session-watch.ts`, que já
 * é o módulo que conhece esses layouts) — esta função só decide, a partir
 * de uma evidência já normalizada, se o resumeId restaurado merece
 * confiança.
 *
 * Deliberadamente NÃO é a mesma pergunta do achado 2/encaminhamento 2
 * (invalidar um claim cujo PTY morreu sem completar um turno) — aquele
 * exige definir "turno completo" por provider, decisão de escopo adiada.
 * Esta função é só uma guarda de sanidade na LEITURA: "existe alguma coisa
 * aqui, e essa coisa não está vazia?" — não tenta julgar se a sessão é
 * "boa" além disso. `hasContent` fica a cargo de cada
 * `getResumeTargetEvidence` decidir com o sinal mais barato e honesto que
 * seu formato oferece (tamanho de arquivo pros baseados em arquivo,
 * existência de uma mensagem pro opencode — tokens/custo só aparecem no
 * fim do turno — e presença no índice pro codex, que não expõe um tamanho
 * de rollout neste caminho).
 */
export interface ResumeTargetEvidence {
  /** Existe algum arquivo/registro para este id, no lugar onde este
   * provider guarda sessão? `false` cobre tanto "nunca existiu" quanto
   * "existiu e foi apagado" — a leitura não precisa distinguir os dois,
   * o tratamento é o mesmo (spawn limpo). */
  exists: boolean;
  /** Havendo algo (`exists === true`), aquilo tem conteúdo real além de
   * um stub vazio recém-criado? Ignorado quando `exists` é `false`. */
  hasContent: boolean;
}

export type ResumeValidity =
  | { valid: true }
  | {
      valid: false;
      /** `"missing"` — nada no disco/db pra este id (apagado, ou nunca
       * existiu — ex.: o `ae126710` de um dia poderia até ter sido limpo
       * por uma rotina de manutenção externa sem o Stellar saber).
       * `"empty"` — existe, mas nunca recebeu conteúdo real (o caso
       * medido ao vivo: 2550 bytes de um spawn que travou antes do
       * primeiro turno terminar). */
      reason: "missing" | "empty";
    };

export function decideResumeValidity(evidence: ResumeTargetEvidence): ResumeValidity {
  if (!evidence.exists) return { valid: false, reason: "missing" };
  if (!evidence.hasContent) return { valid: false, reason: "empty" };
  return { valid: true };
}
