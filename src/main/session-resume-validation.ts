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
 *
 * DESIGN-BACKLOG.md, "`resume_id` envelhece sozinho" (2026-09-11) — causa 2:
 * existencia+conteudo nao bastam quando o carimbo aponta pra um arquivo
 * velho-mas-ainda-la enquanto a sessao viva e outra. `mtimeMs` +
 * `referenceActivityMs` (atividade conhecida do card) fecham isso: se o
 * arquivo esta parado ha mais que `staleAfterMs` depois da ultima
 * atividade do card, o id e "stale" — nao e a sessao que o card esta
 * rodando. Sem `referenceActivityMs` o ramo stale nao dispara (nao ha
 * como distinguir "sessao idle legitima" de "carimbo envelhecido" so com
 * relogio de parede — varios cards no mesmo cwd invalidariam uns aos
 * outros). Medido contra CLI real (2026-09-12): `claude --resume`/
 * `--continue` reusam o mesmo id; `claude --fork-session` cria id NOVO e
 * congela o mtime do pai — exatamente o padrao que este ramo detecta.
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
  /** mtime do alvo em ms epoch, quando o formato expõe um arquivo (ou
   * equivalente). `null`/`undefined` quando o provider não tem sinal de
   * tempo confiável neste caminho (ex.: índice do codex) — o ramo stale
   * abaixo simplesmente não dispara sem ele. */
  mtimeMs?: number | null;
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
       * primeiro turno terminar).
       * `"stale"` — existe e tem conteúdo, mas o mtime está velho demais
       * frente à última atividade conhecida do card (causa 2 do item
       * "envelhece sozinho"). */
      reason: "missing" | "empty" | "stale";
    };

export interface ResumeValidityOpts {
  /** Última atividade conhecida do card (ms epoch). Sem isto o ramo
   * stale não corre — ver o doc comment do módulo. */
  referenceActivityMs?: number;
  /** Quão atrás do `referenceActivityMs` o `mtimeMs` pode ficar antes de
   * contar como stale. */
  staleAfterMs?: number;
}

export function decideResumeValidity(
  evidence: ResumeTargetEvidence,
  opts: ResumeValidityOpts = {},
): ResumeValidity {
  if (!evidence.exists) return { valid: false, reason: "missing" };
  if (!evidence.hasContent) return { valid: false, reason: "empty" };
  const { referenceActivityMs, staleAfterMs } = opts;
  if (
    referenceActivityMs !== undefined &&
    staleAfterMs !== undefined &&
    evidence.mtimeMs != null &&
    referenceActivityMs - evidence.mtimeMs > staleAfterMs
  ) {
    return { valid: false, reason: "stale" };
  }
  return { valid: true };
}
