/**
 * A CONFRONTAÇÃO entre o store do harness e o que o Stellar capturou
 * (task 5d47312c) — "o card trabalhou e não deixou rastro" tem de ser
 * DETECTÁVEL, e hoje ninguém pergunta.
 *
 * A ideia vem do `doctor` do `ai-memory`: não confiar na captura, CONFRONTAR a
 * captura com o rastro que o harness deixou por conta própria, e gritar quando
 * os dois discordam. Aqui os dois lados já existem:
 *
 *   LADO DO HARNESS — cada provider declara `capacity.session.store`
 *   (arquivos ou sqlite, com descoberta por cwd e tempo). Quem lê é o
 *   `session-watch.ts`, a MESMA declaração que o watcher de sessão usa.
 *   LADO DO STELLAR — `spawns` (quem nasceu, com provider e cwd; append-only,
 *   sobrevive ao fechamento do card), `reports` (quem contou) e `cards` (quem
 *   ainda está vivo).
 *
 * MEDIDO NO BOARD VIVO (2026-09-22, antes de escrever isto): 234 cards em
 * `spawns`, 100 sem relatório, 23 deles com sessão do harness começando até
 * 15min depois do nascimento. O delta medido (sessão − nascimento) tem p50 =
 * 4,98s e 73/122 abaixo de 60s: a janela de atribuição não é um chute.
 *
 * O QUE ESTE MÓDULO NÃO SABE, e declara (uma frase por veredito, não um
 * número confiante):
 *
 *  - "não reportou" NÃO diz POR QUÊ. Morrer por cota, ser fechado pelo humano,
 *    terminar e esquecer, e nunca ter começado são causas diferentes e o dado
 *    disponível NÃO as separa. O que o dado separa é: houve sessão com
 *    atividade depois do nascimento (→ trabalhou), ou não houve sessão
 *    nenhuma (→ não há como afirmar que trabalhou).
 *  - O CARIMBO DE TEMPO DO STORE NÃO É SEMPRE NASCIMENTO. `cursor` carimba
 *    `meta.createdAtMs` e `opencode` carimba `session.time_created`: nesses,
 *    "delta" é idade da sessão. `claude` e `antigravity` declaram `mtime` de um
 *    arquivo REESCRITO a cada turno — ali o carimbo é a ÚLTIMA ATIVIDADE, e um
 *    delta grande significa "a última atividade foi muito depois do
 *    nascimento", nunca "a sessão nasceu tarde". Por isso o veredito carrega
 *    `clock` em vez de só um número.
 *  - PROVIDER SEM STORE DECLARADO É INADMINISTRÁVEL, não culpado: sem âncora
 *    medida de cwd e de tempo, varrer o disco acharia o arquivo de outro card.
 *    O veredito é `unobservable` — declaração de limite, não acusação.
 *  - A CAPTURA PODE ESTAR ERRADA, e isso envenena o lado Stellar: medido neste
 *    board, `reports` tem 22 linhas sob o card `97924181` enquanto os cards
 *    cline que de fato trabalharam não têm nenhuma (o hub daemon do cline
 *    carrega o `AGENT_CANVAS_CARD_ID` dele). Um card acusado de silêncio aqui
 *    pode ter reportado — sob outro id. O campo `misattribution` do resultado
 *    existe para o leitor saber que essa possibilidade está aberta.
 */

/** O que o carimbo de tempo declarado no store significa. `none` = o provider
 * não declara store nenhum (ou não declara tempo). */
export type CoverageClock = "birth" | "last-activity" | "none";

/** Uma entrada do lado STELLAR da confrontação (uma linha por card que nasceu). */
export type CoverageCard = {
  cardId: string;
  provider: string;
  cwd: string | null;
  /** Nascimento do card (`spawns.created_at`). */
  createdAtMs: number;
  taskId: string | null;
  /** Existe linha em `reports` para ESTE card id? */
  hasReport: boolean;
  /** Ainda existe em `cards` (não foi fechado/apagado). */
  live: boolean;
  /** O provider declara `capacity.session.store`? */
  storeDeclared: boolean;
  clock: CoverageClock;
};

/** Um registro achado no store do harness, já com a evidência de escrita. */
export type CoverageSession = {
  sessionId: string;
  /** `null` quando o store não declara tempo. */
  timestampMs: number | null;
  /**
   * `null` em store de sqlite: linha não tem tamanho de arquivo.
   *
   * E onde ELE NÃO É O TAMANHO DA CONVERSA: `cursor` e `commandcode` declaram um
   * registro de METADADOS (`meta.json` / `*.meta.json`, 138-186 bytes medidos no
   * board vivo, com o conteúdo em `store.db`/`*.jsonl` ao lado). Ali um
   * `sizeBytes` pequeno é o normal de um card QUE TRABALHOU, e ler esse número
   * como "trabalhou pouco" seria exatamente o tipo de conclusão que este módulo
   * recusa. O que a evidência sustenta é a EXISTÊNCIA do registro e o momento da
   * escrita; o tamanho é indício, nunca veredito.
   */
  sizeBytes: number | null;
};

export type CoverageVerdict = "reported" | "worked_unreported" | "no_session" | "unobservable";

export type CoverageFinding = {
  cardId: string;
  provider: string;
  verdict: CoverageVerdict;
  live: boolean;
  taskId: string | null;
  clock: CoverageClock;
  sessionId?: string;
  /** `timestamp − createdAtMs`. Ver a nota sobre `clock`: só é "idade da
   * sessão" onde o carimbo é de nascimento. */
  deltaMs?: number;
  sizeBytes?: number | null;
  /** Agent-facing (inglês — o leitor é um modelo, ver agent-facing.ts). */
  why: string;
};


/**
 * A janela em que uma sessão é atribuída ao card que nasceu imediatamente
 * antes dela. MEDIDA, não escolhida: p50 = 4,98s e 73/122 abaixo de 60s no
 * board vivo; 300s cobre 88/122. 15min é o teto generoso que ainda evita o erro
 * que a primeira medição cometeu — atribuir a um card qualquer sessão de horas
 * depois, que é de um card mais novo do mesmo cwd.
 */
export const COVERAGE_ATTRIBUTION_WINDOW_MS = 900_000;

/**
 * Atribuição por VIZINHANÇA: um registro pertence ao card mais recente nascido
 * ANTES dele, e só se a distância couber na janela. Um registro anterior ao
 * primeiro card do store não pertence a ninguém.
 *
 * Todas as `cards` têm de ser do MESMO store (mesmo provider e mesmo cwd) — a
 * vizinhança só significa alguma coisa dentro de um store; misturar dois cwds
 * faria uma sessão de um projeto ser atribuída a um card de outro.
 *
 * Empate entre dois registros do mesmo card: fica o MAIOR (a evidência mais
 * forte de escrita), que é o que um aviso precisa mostrar.
 */
export function attributeSessionsToCards(input: {
  cards: CoverageCard[];
  candidates: CoverageSession[];
  windowMs?: number;
}): Map<string, { session: CoverageSession; deltaMs: number | null }> {
  const windowMs = input.windowMs ?? COVERAGE_ATTRIBUTION_WINDOW_MS;
  const ordered = [...input.cards].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const out = new Map<string, { session: CoverageSession; deltaMs: number | null }>();
  for (const candidate of input.candidates) {
    if (candidate.timestampMs === null) continue;
    let owner: CoverageCard | null = null;
    for (const card of ordered) {
      if (card.createdAtMs <= candidate.timestampMs) owner = card;
      else break;
    }
    if (!owner) continue;
    const deltaMs = candidate.timestampMs - owner.createdAtMs;
    if (deltaMs > windowMs) continue;
    const prev = out.get(owner.cardId);
    if (!prev || (candidate.sizeBytes ?? 0) > (prev.session.sizeBytes ?? 0)) {
      out.set(owner.cardId, { session: candidate, deltaMs });
    }
  }
  return out;
}

export type UnreportedWorkInput = {
  cards: CoverageCard[];
  /** Sessões já ATRIBUÍDAS por `attributeSessionsToCards`. */
  attributed: Map<string, { session: CoverageSession; deltaMs: number | null }>;
  /** `true` quando o lado Stellar tem indício de captura errada (reports sob um
   * id que não fez o trabalho) — ver `misattribution` no doc do módulo. */
  misattributionSuspected?: boolean;
};

export type UnreportedWorkCounts = {
  total: number;
  reported: number;
  worked_unreported: number;
  no_session: number;
  unobservable: number;
  /** Dos `worked_unreported` que ainda estão VIVOS (o aviso muda de peso). */
  worked_unreported_live: number;
  /** Dos `worked_unreported` amarrados a uma task (é a conta que o board faz). */
  worked_unreported_on_task: number;
};

const NO_SESSION_LIMIT =
  "a session that does not exist cannot be accused: the harness left no record in the cwd after this card was born. " +
  "It may never have started, or the provider may write its record somewhere this declaration does not cover";

const UNOBSERVABLE_LIMIT =
  "this provider declares no session store, so there is nothing to confront — absence of evidence here is a declared " +
  "limit, not a finding about the card";

function workedSilentWhy(card: CoverageCard, deltaMs: number | null, misattributionSuspected: boolean | undefined): string {
  const when = card.clock === "birth" ? "created" : "last written";
  return (
    `a session exists in this cwd and is attributed to this card (${when} ${Math.round((deltaMs ?? 0) / 1000)}s after the ` +
    `card was born) and Stellar has no report from it. WHY it stayed silent is NOT in this data: dying on quota, being ` +
    `closed by a human, finishing and forgetting, and never having started all look the same here.` +
    (misattributionSuspected
      ? " Also: some reports in this DB are attributed to a card id that did not do the work, so a report from THIS card may exist under another id."
      : "")
  );
}

/**
 * O veredito por card. Três perguntas, nesta ordem, e nenhuma delas inventa
 * causa: (1) o Stellar tem o relatório? (2) o provider é observável? (3) existe
 * rastro no store depois do nascimento?
 */
export function decideUnreportedWork(input: UnreportedWorkInput): {
  findings: CoverageFinding[];
  counts: UnreportedWorkCounts;
} {
  const findings: CoverageFinding[] = [];
  for (const card of input.cards) {
    if (card.hasReport) continue; // nada a dizer: o rastro existe do lado do Stellar
    const hit = input.attributed.get(card.cardId);
    const verdict: CoverageVerdict =
      !card.storeDeclared || card.clock === "none" ? "unobservable" : hit ? "worked_unreported" : "no_session";
    const why =
      verdict === "unobservable"
        ? UNOBSERVABLE_LIMIT
        : verdict === "no_session"
          ? NO_SESSION_LIMIT
          : workedSilentWhy(card, hit?.deltaMs ?? null, input.misattributionSuspected);
    const finding: CoverageFinding = {
      cardId: card.cardId,
      provider: card.provider,
      verdict,
      live: card.live,
      taskId: card.taskId,
      clock: card.clock,
      why,
    };
    if (hit) {
      finding.sessionId = hit.session.sessionId;
      if (hit.deltaMs !== null) finding.deltaMs = hit.deltaMs;
      finding.sizeBytes = hit.session.sizeBytes;
    }
    findings.push(finding);
  }

  // Ordem do mais acionável para o menos: trabalho que existe, vivo primeiro,
  // depois por sessão mais recente — quem lê isto está procurando o que salvar.
  const rank: Record<CoverageVerdict, number> = { worked_unreported: 0, no_session: 1, unobservable: 2, reported: 3 };
  findings.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.deltaMs ?? 0) - (a.deltaMs ?? 0);
  });

  const work = findings.filter((f) => f.verdict === "worked_unreported");
  return {
    findings,
    counts: {
      total: input.cards.length,
      reported: input.cards.filter((c) => c.hasReport).length,
      worked_unreported: work.length,
      no_session: findings.filter((f) => f.verdict === "no_session").length,
      unobservable: findings.filter((f) => f.verdict === "unobservable").length,
      worked_unreported_live: work.filter((f) => f.live).length,
      worked_unreported_on_task: work.filter((f) => f.taskId !== null).length,
    },
  };
}

/**
 * O que o carimbo de tempo DECLARADO no store significa. Derivado da declaração
 * (`capacity.session.store`), nunca de uma tabela paralela por provider:
 *
 *  - `time.from === "mtime"` é ÚLTIMA ATIVIDADE. Medido nesta task: o `.jsonl` do
 *    claude é reescrito a cada turno e o `.db` do antigravity é atualizado no
 *    lugar — o mtime de ambos anda para frente, então "delta" vira "quanto tempo
 *    depois do nascimento houve escrita", nunca "quando a sessão nasceu".
 *  - um carimbo de DENTRO do registro é nascimento: o `createdAtMs` do cursor e
 *    o `time_created` do opencode (ambos medidos, e os únicos com delta de
 *    segundos no board vivo).
 *  - store de sqlite declara a coluna na descoberta (`timeColumn`): as duas
 *    declaradas hoje — `time_created` do opencode e o `started_at` do cline —
 *    são de nascimento.
 */
export function clockFromSessionStore(store: { kind: string; time?: { from: string }; discovery?: unknown } | null | undefined): CoverageClock {
  if (!store) return "none";
  if (store.kind === "sqlite") return "birth";
  return store.time?.from === "mtime" ? "last-activity" : "birth";
}
