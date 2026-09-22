/**
 * A IDENTIDADE QUE O CARD DECLARA EXISTE? — a checagem que faltava, e o
 * que fazia um relatório mentir para sempre.
 *
 * MEDIDO 2026-09-22 (task 34e27f66), no board vivo: quatro cards de
 * provider `cline` carregavam TODOS `AGENT_CANVAS_CARD_ID=97924181`, e
 * `SELECT COUNT(*) FROM cards WHERE id='97924181'` devolvia 0. O id foi de
 * um card REAL (o dono o abriu pela UI às 12:45:02 e depois o fechou;
 * fechar APAGA a linha de `cards`), e `report` só exigia um `requesterId`
 * NÃO-VAZIO — então os relatórios seguintes foram gravados sob esse id
 * fantasma (seq 666..671, `ok:true` de volta) e os autores acreditaram ter
 * reportado. Dois cards diferentes, indistinguíveis um do outro.
 *
 * A CAUSA está a montante e é de TRANSPORTE, não de alocação de id:
 * `pty-registry.ts:858` grava `AGENT_CANVAS_CARD_ID: id` CORRETAMENTE por
 * card. Medido em `/proc/<pid>/environ` + `PPid` (2026-09-22):
 *
 *   card cline 97924182 (pid 84957)  CARD_ID=97924182  pai=83237  CORRETO
 *   card cline 97924195 (pid 148946) CARD_ID=97924195  pai=83237  CORRETO
 *   shim stellar-mcp (pid 85039)     CARD_ID=97924181  pai=84421  <- daemon
 *   shim stellar-mcp (pid 149058)    CARD_ID=97924181  pai=84421  <- MESMO pai
 *   shim stellar-mcp (pid 141487)    CARD_ID=97924064  pai=83597  <- claude, OK
 *
 * Ou seja: o processo do CARD tem o id certo; quem não tem é o processo do
 * SHIM, que o daemon compartilhado (`cline --cline-hub-daemon`, PID 84421)
 * cria com o SEU ambiente congelado no primeiro card. O transporte cria UM
 * PROCESSO POR SESSÃO (cinco cards cline, cinco shims), mas NÃO carrega
 * nenhum byte que distinga as sessões: os cinco ambientes são byte a byte
 * IDÊNTICOS — 77 variáveis, `diff` vazio — e o cwd também. `argv` e fds
 * não nomeiam card nenhum. A identidade chega por HERANÇA, e herança de um
 * processo compartilhado é a identidade do primeiro card, não a sua.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: não tenta consertar a herança. "Reescrever o
 * env a cada card" falha pelo mesmo motivo (o processo é um só, o último a
 * escrever vence), e resolver a identidade NO MOMENTO DA CONEXÃO não é
 * possível a partir do shim: nada do que ele observa distingue a sessão.
 * O que é do Stellar, e é o que torna o defeito SILENCIOSO, é a porta de
 * escrita aceitar uma identidade que não corresponde a nenhum card vivo.
 * Uma identidade assim não pode produzir registro nenhum: RECUSAR é o
 * resultado honesto — um registro que mente é pior que um erro.
 */

export type DeclaredCardExistenceDecision =
  | { action: "accept" }
  | { action: "refuse"; error: string };

/**
 * Regras, e por que cada uma:
 *   - SEM id declarado: `accept`. Conexão anônima é um estado legítimo
 *     (cliente MCP externo, smoke que disca a porta direto), e quem exige
 *     identidade recusa por conta própria, com a mensagem dele
 *     ("missing requesterId"). Fundir os dois casos apagaria a diferença
 *     entre "não declarou" e "declarou um card que não existe" — que é
 *     exatamente a distinção que este defeito precisava.
 *   - id declarado E confirmado vivo: `accept`.
 *   - id declarado e NÃO confirmado: `refuse`, nomeando o id. Nunca
 *     "aceita mesmo assim": era esse o caminho que gravava sob fantasma.
 */
export function decideDeclaredCardExistence(input: {
  /** O `requesterId` da chamada — carimbo da URL do MCP ou identidade do
   * ambiente no `acbridge`. `null`/vazio/ausente é anônimo. */
  declaredCardId?: string | null;
  /** `true` só quando o app CONFIRMA um card vivo com esse id
   * (`pty-registry.ts`'s `isAlive`: existe entrada de PTY). Não é "o id é
   * bem formado", é "existe". */
  cardExists: boolean;
}): DeclaredCardExistenceDecision {
  const declared = typeof input.declaredCardId === "string" ? input.declaredCardId.trim() : "";
  if (!declared) return { action: "accept" };
  if (input.cardExists) return { action: "accept" };
  return { action: "refuse", error: describeNonexistentDeclaredCardRefusal(declared) };
}

/**
 * AGENT-FACING — DO NOT TRANSLATE. O agente lê esta frase; traduzi-la
 * mudaria o contrato que ele já aprendeu a seguir (mesma convenção de
 * `report-task-link-decision.ts`).
 *
 * Ela diz três coisas, e nesta ordem: (1) a recusa e o id exato; (2) a
 * promessa que importa — NADA foi gravado, ao contrário do que acontecia
 * antes, quando o `ok:true` voltava e o registro ia para o id fantasma;
 * (3) a causa, porque ela NÃO é do agente e não se conserta do lado dele:
 * sem isso o próximo card tenta o mesmo id de novo em loop.
 */
export function describeNonexistentDeclaredCardRefusal(declaredCardId: string): string {
  return (
    `[de: stellar] report recusado: o card que você declara (${declaredCardId}) NÃO existe — nenhum card vivo tem esse id. ` +
    `Nada foi gravado. ` +
    `Isto não é um erro do seu payload: a identidade que o seu processo carrega vem do AMBIENTE do processo, e um provider ` +
    `cujo processo é compartilhado (um daemon que hospeda vários cards, medido no cline) faz todos os cards herdarem o id do ` +
    `PRIMEIRO card — que pode já ter sido fechado e apagado. Repetir a chamada com este mesmo id não vai funcionar. ` +
    `Deixe o resultado num arquivo (ou num card que você conseguiu identificar) e avise quem te pediu o trabalho; o vínculo da ` +
    `task continua existindo, mas o relatório não pode ser atribuído por um id que não é seu.`
  );
}
