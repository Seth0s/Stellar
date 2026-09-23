/**
 * A REGRA QUE FALTA: CONFERIR A IMPOSIÇÃO DE ID DE SESSÃO (task 201bd13b).
 *
 * O DEFEITO MEDIDO. `canImposeSessionId: true` é uma afirmação num arquivo de
 * configuração, e nada no sistema a confere. Quando o id é imposto, o
 * `pty-registry.ts` (linhas 1085-1090) grava esse id como se tivesse sido
 * ENCONTRADO — `claimSessionId(...)` + `onSessionFound(cardId, imposedSessionId)`
 * — e PULA o `watchForSession`. Ou seja: para um card com id imposto não existe
 * nem o canal que descobriria o id real. Se a CLI ignorar o id em silêncio, o
 * card fica apontando para uma sessão que não existe e ninguém avisa.
 *
 * Foi o que aconteceu com o cline (corrigido em `6c42314`: `--id` é RETOMAR) e
 * é o que a varredura desta task achou no cursor — lá a afirmação era
 * VERDADEIRA mas a FLAG estava errada (`--resume`, que é retomar; a de impor é
 * `--new-session-id`, e ela não aparece no `--help`). Dois defeitos, a mesma
 * raiz: uma afirmação que o sistema nunca confere.
 *
 * A DETECÇÃO BARATA (e é barata): depois do spawn, ler o store DECLARADO pelo
 * provider e ver se o id imposto aparece. O I/O não mora aqui — quem já sabe
 * ler store por provider é `session-watch.ts` (`getResumeTargetEvidence`, usado
 * hoje para validar um `resumeId` de restauração). Esta função é só a decisão,
 * pura, para poder ser testada sem store nenhum.
 *
 * O QUE ESTE MÓDULO NÃO FAZ (e é decisão, não esquecimento): não lê disco, não
 * agenda timer, não escreve no banco. O ponto de ligação está declarado no
 * comentário de `impositionFollowUp`.
 */

/**
 * Quanto esperar antes de concluir. Medido do lado generoso: a CLI precisa
 * gravar o arquivo/linha do store depois de subir, e um falso "não pegou"
 * re-armaria o watcher num card que estava certo. O watcher já espera por
 * janelas desta ordem, então este valor não inventa uma escala nova.
 */
export const IMPOSITION_GRACE_MS = 8000;

/** O que a leitura do store declarado devolveu para o id imposto. */
export type StoreRead = { exists: boolean; hasContent: boolean };

export type ImpositionVerification =
  | { verdict: "too-early" }
  | { verdict: "confirmed"; id: string }
  | { verdict: "not-imposed"; id: string; declarationContradicted: true }
  | { verdict: "unknown"; reason: "no-store" | "unreadable" };

export function decideImpositionVerification(input: {
  imposedId: string;
  elapsedMs: number;
  /** `null` = não há canal de medição (provider sem store declarado, ou leitura
   *  falhou). Nunca é tratado como "não existe". */
  storeRead: StoreRead | null;
}): ImpositionVerification {
  if (input.elapsedMs < IMPOSITION_GRACE_MS) return { verdict: "too-early" };
  if (input.storeRead === null) return { verdict: "unknown", reason: "no-store" };
  if (!input.storeRead.exists) {
    // O id imposto NÃO está no store do provider: a imposição não pegou. A
    // declaração que a prometia está contradita por medição — e é isso que o
    // app precisa registrar, senão a mesma afirmação segue sendo usada.
    return { verdict: "not-imposed", id: input.imposedId, declarationContradicted: true };
  }
  // `exists` é o que a imposição promete (o ID existe). `hasContent` é outra
  // pergunta: uma sessão recém-criada pode ainda estar vazia, e reprovar por
  // isso re-armaria o watcher num card correto.
  return { verdict: "confirmed", id: input.imposedId };
}

/**
 * O que o app FAZ com o veredito. Puro de propósito: o efeito fica no
 * chamador, no ponto de ligação medido — `pty-registry.ts`, logo depois do
 * `if (imposedSessionId) { claimSessionId(...); onSessionFound(...) }`:
 *
 *   - `rearm-watcher`: a imposição não pegou. Soltar a reivindicação
 *     (`releaseSessionId`) e armar o `watchForSession` que o caminho do id
 *     imposto PULOU, para o card descobrir o id real em vez de apontar para o
 *     nada. Hoje esse caminho não existe — é exatamente este o buraco.
 *   - `keep`: nada a fazer; a reivindicação do id imposto fica de pé.
 *   - `wait`: ainda não se concluiu; não agir no escuro.
 */
export function impositionFollowUp(
  verification: ImpositionVerification,
): "rearm-watcher" | "keep" | "wait" {
  switch (verification.verdict) {
    case "not-imposed":
      return "rearm-watcher";
    case "confirmed":
    case "unknown":
      return "keep";
    case "too-early":
      return "wait";
  }
}

/** A linha que o app GASTA quando a declaração não se sustenta. */
export function describeImpositionContradiction(input: {
  providerId: string;
  cardId: string;
  cwd: string;
  imposedId: string;
}): string {
  return (
    `[session-imposition] ${input.providerId} declarou canImposeSessionId: true, mas o id imposto ` +
    `${input.imposedId} não apareceu no store declarado (card ${input.cardId}, cwd ${input.cwd}) — ` +
    `a imposição não pegou: soltei a reivindicação e armei o watcher para descobrir a sessão real.`
  );
}

/**
 * A APLICAÇÃO do veredito, com os efeitos injetados — é esta função que a
 * ligação chama, e é por isso que a ligação é testável sem PTY nenhum.
 *
 * `not-imposed` faz as TRÊS coisas que a task pede: solta o id imposto
 * (senão ele fica preso no refcount como se alguém o usasse), arma o watcher
 * que aquele caminho PULAVA (é ele que descobre a sessão de verdade) e loga a
 * contradição — a declaração é uma afirmação, e uma afirmação contradita por
 * medição tem de aparecer em algum lugar.
 */
export function applyImpositionVerification(
  verification: ImpositionVerification,
  actions: {
    releaseImposedId: (id: string) => void;
    rearmWatcher: () => void;
    logContradiction: (line: string) => void;
  },
  context: { providerId: string; cardId: string; cwd: string },
): "rearmed" | "kept" | "waited" {
  if (impositionFollowUp(verification) === "wait") return "waited";
  if (verification.verdict !== "not-imposed") return "kept";
  actions.releaseImposedId(verification.id);
  actions.rearmWatcher();
  actions.logContradiction(describeImpositionContradiction({ ...context, imposedId: verification.id }));
  return "rearmed";
}
