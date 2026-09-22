/**
 * O QUE O `card_status` DEVE DIZER — decidido a partir de FATOS, num lugar só.
 *
 * POR QUE ESTE MÓDULO EXISTE (task 4245c6f5). Medido no código de produção:
 *
 *   - `pty-registry.ts:1004` faz `proc.onData(() => { entry.lastActivityAt =
 *     Date.now() })` — ou seja `lastActivityAt` significa "chegou QUALQUER
 *     byte do PTY". O comentário do próprio campo diz que ele existe para
 *     "distinguir 'trabalhando' de 'vivo mas parado no prompt'"; medido, ele
 *     não distingue: um TUI parado que REPINTA (cursor piscando, linha de
 *     status) emite bytes para sempre e nunca envelhece.
 *   - `card_status` decidia só com `Date.now() - lastActivityAt >= 5s`.
 *
 * As duas direções do defeito, ambas observadas:
 *   - TUI parado no prompt → parece `running` para sempre (o dono do repo viu
 *     cinco cards assim, todos parados em "Ask your question...");
 *   - shell bash parado no prompt → `idle` em 5s, sem sentido, porque num
 *     shell não existe "turno" para ter terminado.
 *
 * A RAIZ NÃO É O LIMIAR, É A GRANDEZA. `lastActivityAt` mede bytes, e bytes
 * não são evidência de trabalho em NENHUM dos dois lados:
 *   - num TUI de agente há repintura (cursor, linha de status) — bytes para
 *     sempre, mesmo parado. Vale o FATO DE TURNO, e é por isso que ele passou
 *     a existir (`turnEndedAt`); sem ele, `unknown`;
 *   - num card `bash` pode haver um TUI DENTRO (o dono do repo abre cards
 *     bash à mão e digita `cmd --yolo`) — e um TUI repinta igual. MEDIDO ao
 *     vivo: dois cards de provider `bash`, um com shell puro e outro com o
 *     TUI, com status diferentes. Então byte chegando num bash também NÃO é
 *     evidência de comando rodando: é `unknown` (ver o comentário longo no
 *     ramo de shell abaixo, com as duas ideias já medidas e descartadas).
 *
 * O que sobrou de sólido para um card `bash` é o outro lado: QUIETO. Um shell
 * puro não repinta, então silêncio de bytes É o prompt livre → `at-prompt`.
 *
 * REGRA DE HONESTIDADE, que é o ponto inteiro: quando não houver fato, a
 * resposta é `unknown`. Um estado inventado seria PIOR que o status ruim de
 * hoje — o de hoje é obviamente errado quando se olha a tela; um inventado
 * seria plausível e errado, que é a pior combinação possível para quem decide
 * despacho com base nele.
 */

import { FIRST_OUTPUT_DEADLINE_MS } from "./silent-boot-decision";

export type CardStatus = "running" | "idle" | "at-prompt" | "unknown" | "waiting" | "exited" | "no-output";

export type CardStatusFacts = {
  /** Provider do card (`"bash"`, `"claude"`, ...). `null` = desconhecido. */
  provider: string | null;
  /** Há entry viva no registry. */
  alive: boolean;
  /** Bloqueado numa decisão de consentimento (modal aberto). */
  waitingOnConsent: boolean;
  /** Último byte recebido do PTY, ou `null` sem entry. */
  lastActivityAt: number | null;
  /**
   * Quando o agente DECLAROU o turno encerrado (`turn_complete`).
   * `null` = nunca declarou — e é isso que torna o estado `unknown` em vez
   * de um palpite entre running e idle.
   */
  turnEndedAt: number | null;
  /** Há uma linha de input humano pendente no card (registry). */
  hasPendingHumanInput: boolean;
  now: number;
  /** Silêncio de bytes que caracteriza "parado" num shell de linha. */
  idleThresholdMs: number;
  /**
   * Já chegou ALGUM byte deste PTY? (`hasReceivedData` do registry.) Ausente =
   * sem fato — e sem fato não se inventa o estado novo (task d77b524b).
   */
  hasEverProducedOutput?: boolean;
  /** Quando o PTY nasceu, para medir a idade contra o limite de primeira saída. */
  spawnedAtMs?: number | null;
  /** Limite de primeira saída; default `FIRST_OUTPUT_DEADLINE_MS` (30s, medido). */
  firstOutputDeadlineMs?: number;
};

/** `bash` é o único provider com semântica de shell de linha: não repinta.
 * Exportado para o teste anti-drift da descrição da tool poder citá-lo — e
 * para os caminhos que precisam perguntar "o leitor DECLARADO deste card é um
 * shell?" (task 14b8b224). Nenhum call site escreve `=== "bash"` à mão: a lista
 * mora aqui e `isShellProvider` responde por ela. */
export const SHELL_PROVIDER_IDS = ["bash"] as const;

export function isShellProvider(provider: string | null): boolean {
  return provider !== null && (SHELL_PROVIDER_IDS as readonly string[]).includes(provider);
}

/**
 * "TEM AGENTE LENDO A LINHA DESTE CARD?" — a pergunta que o watchdog de ocioso
 * não fazia, e a fonte ÚNICA para ela (task 14b8b224).
 *
 * O DEFEITO, medido no board (2026-09-22): quatro cards `provider: bash` VAZIOS
 * (tela em branco, nem prompt desenhado) receberam vínculo de task e, minutos
 * depois, os quatro foram acusados de "idle sem chamar report" — por um agente
 * que nunca existiu. No mesmo instante o aviso do vínculo respondia
 * `"skipped: bash has no agent reading the line"`: o app SABIA que não havia
 * leitor e cobrou o report dele mesmo assim. Duas respostas opostas para a
 * mesma pergunta, no mesmo boot — e a confusão custa caro porque a peça 7 do
 * rastreamento vai AGIR sobre estes sinais (propor respawn de trabalho que
 * nunca começou).
 *
 * A ASSIMETRIA É DELIBERADA: só a PROVA de ausência conta como ausência.
 *
 *   - provider de AGENTE (`claude`, `cursor`, `cline`, …): o processo do card É
 *     o agente → `true`, sem olhar a tela;
 *   - provider de SHELL (`bash`): `true` A NÃO SER que o app tenha a prova de um
 *     prompt de shell livre — o `at-prompt` de `decideCardStatus`. Um card bash
 *     COM um TUI dentro repinta (medido, ver o cabeçalho deste módulo) → não é
 *     `at-prompt` → tem leitor → alarme legítimo. A distinção é "tem agente
 *     lendo", NÃO "é bash".
 *
 * `shellStatus` é um THUNK de propósito: a resposta para um provider de agente
 * não depende da tela, e o scan de ocioso (que roda a cada 5s) não deve pagar a
 * leitura do write-readiness para perguntar por um card que já sabe a resposta.
 * O atalho é sobre QUANDO perguntar; a resposta continua morando aqui.
 *
 * OS DOIS ERROS QUE SOBRAM, declarados (nenhum dos dois é novo — os dois são o
 * que `card-status-decision.ts` já publica):
 *   - BARULHENTO: um card bash rodando um comando comum é INDISTINGUÍVEL de um
 *     TUI por estes fatos (o comentário do ramo de shell mede isso), então
 *     mantém o alarme. Preferir o erro barulhento é o que impede este sinal de
 *     morrer por silêncio errado;
 *   - MUDO: um TUI que fique quieto além de `idleThresholdMs` lê `at-prompt` e
 *     é tratado como sem leitor — herdado do modelo de `card_status`, que só
 *     afirma `unknown` enquanto há bytes.
 */
export function hasAgentReadingLine(provider: string | null, shellStatus: () => CardStatus): boolean {
  if (!isShellProvider(provider)) return true;
  return shellStatus() !== "at-prompt";
}

export function decideCardStatus(facts: CardStatusFacts): CardStatus {
  if (!facts.alive) return "exited";
  // Consentimento vem ANTES de tudo: um card bloqueado no modal ainda tem
  // processo vivo (isAlive true), e dizer "running" ali é exatamente a
  // ambiguidade que este estado existe para remover.
  if (facts.waitingOnConsent) return "waiting";
  // O CARD QUE NUNCA FALOU (task d77b524b): nenhum byte desde o nascimento e o
  // limite de primeira saída já passou. Vem antes de tudo o que fala de turno
  // porque nenhum fato de turno pode ser verdade sem uma primeira saída — e
  // porque `unknown` (a resposta de hoje para este caso) é indistinguível de
  // "está trabalhando", que é a mentira que o dono decidiu trocar por um aviso.
  // AUSÊNCIA DE FATO NÃO ENTRA: só com `hasEverProducedOutput === false`
  // EXPLÍCITO, e com idade datável. Sem isso, o caminho antigo responde.
  if (facts.hasEverProducedOutput === false && typeof facts.spawnedAtMs === "number") {
    const deadlineMs = facts.firstOutputDeadlineMs ?? FIRST_OUTPUT_DEADLINE_MS;
    if (facts.now - facts.spawnedAtMs >= deadlineMs) return "no-output";
  }

  const quietFor =
    facts.lastActivityAt === null ? null : facts.now - facts.lastActivityAt;
  const quiet = quietFor === null ? true : quietFor >= facts.idleThresholdMs;

  if (isShellProvider(facts.provider)) {
    // Shell de linha: se está QUIETO, byte parado É o prompt livre (um shell
    // puro não repinta). "idle" fica FORA do vocabulário — num shell não
    // existe turno para ter terminado, e chamar isso de idle foi o que fez um
    // agente mandar brief de agente para um card bash.
    if (quiet) return "at-prompt";
    // MAS com bytes chegando num card bash, `unknown`. O motivo é MEDIDO e
    // não é teórico: um card `bash` pode ter um TUI DENTRO (o dono do repo
    // abre cards bash à mão e digita `cmd --yolo`), e um TUI REPINTA. Os dois
    // cards abaixo são provider `bash` — medido ao vivo no board em
    // 2026-09-20: `97924083` mostra `lucas@fedora:~/Projects$ ` e responde
    // `idle` (shell puro), `97924119` mostra `❯ Ask your question...` e
    // responde `running` (TUI dentro). Reportar `running` aqui é a mentira
    // que esta task existe para matar, e ela é INDISTINGUÍVEL de um comando
    // de verdade produzindo saída com os fatos que o main tem.
    //
    // DUAS IDEIAS FORAM TESTADAS CONTRA ESTE CASO E DESCARTADAS — não
    // reabra sem medir de novo:
    //
    // 1. TELA ALTERNATIVA (DECSET 1049/1047/47) como discriminador, que seria
    //    o marcador padrão de aplicação de tela cheia. NÃO SERVE: medido no
    //    binário instalado (`command-code/dist/index.mjs`), há ZERO
    //    ocorrências de `1049` e ZERO de `alternat`; o pacote traz o
    //    `ansi-escapes` com `enterAlternativeScreen`, mas NADA no bundle o
    //    importa. O TUI é feito com Ink, que renderiza INLINE no fluxo
    //    normal — não troca de tela. Um fato que nunca liga não discrimina.
    //
    // 2. BRACKETED PASTE como sinal positivo de shell (o registry já rastreia
    //    os eventos 2004; a ideia era manter `running` quando readline
    //    aceitasse uma linha). NÃO SERVE: o MESMO bundle tem ZERO ocorrências
    //    de `2004` e de `bracketedPaste`, então o TUI não mexe nesse modo e o
    //    estado observável é o que o SHELL deixou (desligado ao aceitar a
    //    linha do `cmd --yolo`) — indistinguível de "comando rodando". O
    //    `bracketedPasteMode` LIGADO também não separaria nada, porque bash
    //    moderno liga no prompt interativo.
    return "unknown";
  }

  // TUI de agente: bytes não provam trabalho. Manda o fato de turno.
  if (facts.turnEndedAt !== null) {
    const outputAfterTurn =
      facts.lastActivityAt !== null && facts.lastActivityAt > facts.turnEndedAt;
    if (outputAfterTurn) return "running";
    return "idle";
  }
  // Sem turno declarado, resta um sinal positivo: a linha de input pendente
  // diz que o card está parado esperando digitação — isso É "waiting on you".
  if (facts.hasPendingHumanInput) return "idle";
  // Nada disso: não inventamos. Um card que repinta sem nunca ter declarado
  // turno é indistinguível de um que trabalha.
  return "unknown";
}

/** AGENT-FACING — DO NOT TRANSLATE. A frase que o agente lê para entender um
 * estado que não é `running`/`idle` (`at-prompt`, `unknown`). */
export function describeCardStatus(status: CardStatus): string {
  switch (status) {
    case "at-prompt":
      return "shell no prompt, livre para receber comando (não é um agente: não tem turno)";
    case "unknown":
      return "não dá para dizer: a saída não distingue trabalho de repintura (TUI parado repinta, e um TUI pode estar dentro de um card bash) — confira na tela antes de decidir despacho";
    case "idle":
      return "turno encerrado ou parado esperando você";
    case "running":
      return "turno declarado encerrado e saída chegando DEPOIS disso — um turno novo começou";
    case "waiting":
      return "bloqueado numa decisão de consentimento";
    case "exited":
      return "processo encerrado";
    case "no-output":
      return "subiu e não produziu NENHUM byte desde o nascimento (nem a moldura do TUI) — o processo está vivo e calado; nada foi encerrado. Confira a tela: credencial faltando, prompt de login, ou binário preso antes do primeiro desenho";
  }
}
