import { createServer, createConnection, type Server, type Socket } from "node:net";
import { unlinkSync, statSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TaskCardRow, TaskRow, ConnectorRow, ReportRow, ReportIngressChannel, SpawnRow } from "./store";
import { decideReportNotifyTarget, pickLatestDirectiveSender } from "./report-notify-routing";
import {
  formatAgentFacingAuthorship,
  REPORT_AVAILABLE_POINTER_BODY,
  unreportedExitPointerBody,
  unreportedIdlePointerBody,
} from "./agent-facing-authorship";
import { decideConnectorKindWrite } from "./connector-kind-authorization";
import { decideDeliveryGate, decideWriteReadiness, decideSubmitCheck, decideSteerCheck, shouldPressEnterOnAttempt, shouldSteerAfterPark, composerClearSequence, deliveryTextBytes, deliveryWriteOpensTurn, inspectDeliveryHold, decideDeliveryOutcome, deliveryNeedle, readlineAcceptedSince, type CardDeliveryHoldReason, type CardDeliveryReceipt, type CardDeliveryState, type DeliveryConfirmation, type DeliveryTargetRole, type DeliveryWriteKind } from "./type-and-submit-decision";
import {
  cancelPendingFromRequester,
  decideOriginDeliveryRate,
  filterDeliveryRecords,
  pruneOriginDeliveryRateSamples,
  type OriginDeliveryRateSample,
} from "./delivery-lifecycle-decision";
import { decideTaskCardSpawn, type TaskCardGuardCard } from "../task-card-guard";
import type { StatusWriteDecision } from "./status-write-decision";
import {
  decideStatusAsk,
  describeStatusAskAlready,
  describeStatusAskApplied,
  describeStatusAskParked,
  describeStatusHeldWarning,
  retainStatusAsk,
} from "./status-write-decision";
import {
  decideCloseCardTaskEffect,
  decideJudgmentWrite,
  decideReportVerdictWrite,
  roleOnTask,
  type CloseCardLinkedTask,
} from "./judgment-write-decision";
import { decideFailureKind, decideFailureWrite, stampFailureKindJson, failureKindFromResultJson, resolveFailureKind, mergeAgentResultJson, interruptionReasonFromResultJson, type FailureSource } from "./failure-kind-decision";
import { decideExitWithoutReportWrite } from "./exit-lifetime-decision";
import {
  decideIdleWithoutReport,
  IDLE_WITHOUT_REPORT_POLL_MS,
} from "./idle-without-report-decision";
import { decideCardStatus, describeCardStatus } from "./card-status-decision";
import {
  decideReportAcceptance,
  errorFromReportPayload,
  stashLastRefusedReport,
  clearLastRefusedStash,
  lastRefusedReasonFromResultJson,
  describeExitWithoutAcceptedReport,
  decodeReportArgument,
} from "./report-retry-decision";
import {
  resolveTaskDispatchCwd,
  resolveTaskDispatchLabel,
  decideTaskDispatchProvider,
  decideTaskDispatchCwd,
  type AncestorCwdNode,
} from "./task-dispatch-decision";
import { appendDepPointer, depIdsFromJson, summarizeReport, type DepPointerSource, type DepReportSummary } from "./dep-pointer-decision";
import { briefFromTaskPrompt, resolveSpawnBrief } from "./spawn-brief-decision";
import {
  appendTaskContract,
  contractFromTaskRow,
  parseTaskContractInput,
  territoryToSql,
  territoryFromSql,
  gatesToSql,
  reportSchemaToSql,
  allowCommitToSql,
} from "./task-contract-decision";
import { decideTerritoryConflict, type ActiveTaskTerritory } from "./territory-conflict-decision";
import { profileFromSpawnArgs, profileFromCardRow } from "./participation-profile-decision";
import { carryGateEvidence, runTaskGates, stampGateEvidenceJson, stripAgentGateEvidence } from "./gate-runner";
import { decideSpawnReason, deriveSpawnDepth } from "./spawn-record-decision";
import { decideSpawnMediaPath, type SpawnMediaType } from "./spawn-media-decision";
import {
  TASK_CARD_IMPLEMENTER_ROLE,
  TASK_CARD_REVIEWER_ROLE,
  TASK_CARD_ROLES,
  TASK_PURPOSES,
  TASK_REVIEW_VALUES,
  isReviewWanted,
  normalizeTaskCardRole,
  normalizeTaskPurpose,
  normalizeTaskReview,
  type TaskPurpose,
} from "../task-purpose";
// A pill do conector fala o MESMO vocabulário da Fila (task 5b173f00): os
// rótulos derivam do catálogo em vez de uma cópia pt-BR escrita à mão. O
// main já resolve a mesma locale do renderer (`index.ts`'s
// `setLocale(resolveLocale(...))`) e sete módulos do main já importam daqui.
import { t, type MessageKey } from "../shared/i18n";
import { fillReportTaskId } from "./card-spawn-env-decision";
import {
  decideReportTaskLink,
  declaredTaskIdFromReportBody,
  describeAmbiguousTaskRefusal,
  describeDeclaredTaskNotLinkedRefusal,
} from "./report-task-link-decision";
import { promoteReportVerdict, resolveReporterRole } from "./report-verdict-decision";
import { decideSpawnIsolation } from "./worktree-isolation-decision";
import { prepareIsolatedWorktree, removeIsolatedWorktree } from "./worktree-prep";
import {
  ACBRIDGE_PROTOCOL,
  checkAcbridgeProtocol,
  decideAcbridgeProtocol,
  stripProtocolStamp,
  type ProtocolCheck,
} from "./acbridge-protocol-decision";
import { applyTaskPromptWrite, type TaskPromptWriteMode } from "../task-prompt-decision";
import { navigationUrlError } from "./browser-registry";
import { MAX_FILE_BYTES, PathEscapeError, readFileAllowingAbsolute } from "./fs-tools";
import { argvCarriesDeclaredBrief, providerCapacity } from "./providers";
import { decideSpawnProfile } from "./spawn-profile-decision";
import { filterListedTasks, parseListTasksQuery, projectListedTask, type ListedTask } from "./list-tasks-query";
import {
  deriveParticipationDivergence,
  deriveTaskStatus,
  isJudgmentStatus,
  storedStatusAfterImplementerLink,
  type StatusActor,
} from "../task-status-derive";

export type SockIdentity = { dev: number; ino: number };

/** Achado 2 (review adversarial, 2026-09-09) — a decisão "o que está no
 * path agora ainda é o MESMO arquivo que eu vi antes?" é usada em dois
 * lugares deste arquivo (a sonda de EADDRINUSE antes do unlink, e o guard
 * de ownership de `close()`): mesma pergunta, mesmos dois campos (`dev` +
 * `ino`, o par que identifica um arquivo de verdade em POSIX — nome/path
 * não serve, é só onde ele mora agora). Extraída aqui, exportada, pra dar
 * pra testar a lógica em isolamento: forçar de verdade a corrida real
 * entre duas instâncias (o cenário que motiva o uso desta função na sonda)
 * não é reproduzível de forma confiável num teste automatizado — o que dá
 * pra travar é que ESTA comparação, a peça que decide "seguro apagar" vs.
 * "não mexe, notifica", está certa. `null` de qualquer lado (sem baseline,
 * ou path já sumiu) sempre conta como "não é o mesmo arquivo" — o lado que
 * chama isto trata ambos com a mesma cautela: não tem prova, não apaga. */
export function sameSockIdentity(a: SockIdentity | null, b: SockIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * O envelope do `report` que NÃO dá para normalizar (task 10cf58d0).
 *
 * Uma string LIVRE é um relatório legal (prosa) e não é tocada aqui. O alvo é
 * a string que começa por `{` — o chamador tentou mandar um OBJETO — e não
 * parseia: aí não existe objeto para gravar, e persistir guardaria a string
 * crua, deixando TODOS os campos dela inalcançáveis por consulta, em silêncio
 * (medido: `reports` seq 515, um `verdict` dentro de string malformada,
 * coluna `verdict` gravada NULL, o revisor convicto de que tinha assinado).
 *
 * NÃO varre a string atrás de chave nenhuma — decisão da entrega irmã
 * (a477f3d4): um relatório SOBRE este defeito CITA `"verdict"` e seria recusado
 * se a varredura existisse. Esta checagem só pergunta "parece envelope de
 * objeto e não parseia"; prosa que cite a chave passa intacta.
 *
 * `null` = sem problema (todo objeto, toda prosa, e toda string que decodifica).
 */
export function describeUndecodableReportEnvelope(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed[0] !== "{") return null;
  // `decodeReportArgument` devolve a MESMA referência quando não decodifica.
  if (decodeReportArgument(raw) !== raw) return null;
  let why = "not valid JSON";
  try {
    JSON.parse(trimmed);
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  return (
    `report arrived as a STRING that starts with "{" but is not valid JSON (${why}). ` +
    "Send it as an OBJECT — the `report` field is a JSON object, e.g. " +
    `{"ok": true, ...} — or as a valid JSON string. If the text is intentional ` +
    `free-form, wrap it: {"resumo": "…"}. Nothing was stored, so no field of ` +
    "this payload (including any verdict) was applied."
  );
}

const OPEN_TIMEOUT_MS = 120_000;
// Shorter than OPEN_TIMEOUT_MS on purpose — a snapshot needs no human
// decision, just a renderer round-trip + a capturePage() call. If it's
// still pending after 10s something's actually wrong (window not
// responding), not a person thinking it over.
const SNAPSHOT_TIMEOUT_MS = 10_000;
// Same reasoning as OPEN_TIMEOUT_MS — spawning a card is a human decision.
const SPAWN_TIMEOUT_MS = 120_000;
// Sticky item "close_card" (2026-09-03) — same reasoning as OPEN_TIMEOUT_MS:
// closing a card (killing a real process, for a terminal) is a human
// decision, not a bug-detection backstop.
const CLOSE_TIMEOUT_MS = 120_000;
// Sticky item "card_status idle" (2026-09-03) — "card_status nunca
// retorna idle, só waiting/running/exited". No PTY output for this long
// reads as "sitting at a prompt, not actively working" — same imprecision
// as `useTerminal.ts`'s own `isActive` (item 6, sticky: can't distinguish
// a long "thinking" pause from real idle without understanding each
// provider's own UI), picked deliberately LONGER than that 900ms client
// heuristic so a normal generation pause doesn't misreport as idle here.
const IDLE_THRESHOLD_MS = 5_000;
// Reading a page's text is exactly as sensitive as a pixel snapshot (an
// already-open page an agent already has a card reference to) — no human
// decision needed, same short backstop-only timeout as snapshot.
const PAGE_TEXT_TIMEOUT_MS = 10_000;
// DESIGN-BACKLOG.md item 58, M1 — same risk class as snapshot/get_page_text
// (an already-open terminal card an agent already has a reference to): no
// human decision needed, just a renderer round-trip to read the live
// xterm.js buffer. Short backstop-only timeout.
const READ_CARD_TIMEOUT_MS = 10_000;
// DESIGN-BACKLOG.md item 58, M4 — default backstop for spawn_agent's
// `wait: true`, when the caller doesn't pass its own `waitTimeoutMs`.
// Unlike every other timeout in this file, waiting for a real agent to
// finish a real task is not a "something's wrong" case — 10 minutes is a
// reasonable default for that, not a bug-detection backstop.
const DEFAULT_WAIT_EXIT_TIMEOUT_MS = 600_000;
// DESIGN-BACKLOG.md item 58, M2 — above a CLI's bracketed-paste threshold,
// a `\r` appended to the same write as the text is swallowed as part of
// the pasted content instead of submitting it. Sending it as a separate
// write, after the target's readline has had a beat to settle, submits
// reliably MOST of the time — but not always. Achado ao vivo (2026-08-30,
// reportado diretamente pelo usuário): under real system load this fixed
// delay is a bet, not a guarantee — it can still fire before the paste
// buffer has actually settled, leaving the Enter swallowed same as
// before the M2 fix. SEND_ENTER_MAX_ATTEMPTS/SEND_ENTER_CONFIRM_DELAY_MS
// below turn this from "hope the delay was enough" into "check, and
// retry the Enter (never the text) if it wasn't".
const SEND_ENTER_DELAY_MS = 80;
// DESIGN-BACKLOG.md item 60-adjacent (send_to_card follow-up) — how long
// to wait after writing `\r` before reading back the card's own text to
// confirm it actually submitted, and how many times to retry just the
// `\r` (never the original text again — resending that would duplicate
// it) if it didn't. Bounded so a card that's genuinely just slow to
// render never gets stuck retrying forever.
const SEND_ENTER_CONFIRM_DELAY_MS = 250;
const SEND_ENTER_MAX_ATTEMPTS = 4;
// DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
// caixa sem submeter" — só o intervalo de poll do portão de prontidão
// (`waitForWriteReadiness` abaixo); os limiares que de fato decidem
// "pronto ou não" (quiescência, teto de segurança) vivem em
// `type-and-submit-decision.ts`, testados puros. Curto de propósito: o
// caso comum (card já pronto há muito tempo) resolve na 1ª checagem, sem
// nenhum `delay` — isto só afeta quantas vezes por segundo um card
// GENUINAMENTE ainda subindo é reconsultado.
const WRITE_READY_POLL_MS = 40;
// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — same
// reasoning as DEFAULT_WAIT_EXIT_TIMEOUT_MS: waiting for a real agent's
// real result is not a bug-detection backstop, it's the actual point.
const DEFAULT_REPORT_TIMEOUT_MS = 600_000;
// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 6 — the
// audit's own "corte mínimo honesto" default, used only when a caller
// doesn't pass its own `cap`. Purely advisory (see `concurrency_status`
// below) — nothing here queues or refuses a spawn.
const DEFAULT_CONCURRENCY_CAP = 3;
// DESIGN-BACKLOG.md item 60, peça 1 — reversal of peça 6's "no queue"
// decision, scoped to autonomous boards only: a spawn_agent that hits the
// board's cap now waits here instead of being refused outright. Long
// default on purpose — the same "waiting for a real result is the actual
// point" reasoning as DEFAULT_REPORT_TIMEOUT_MS above, not a bug backstop.
const DEFAULT_QUEUE_TIMEOUT_MS = 600_000;
// In-line `report` retry budget for the same agent (not a new spawn).
// Small on purpose: a loop that never gives up is worse than one that
// accepts the declared failure and leaves a clearly `failed` task.
const DEFAULT_MAX_RETRIES = 2;

// DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — an agent spawning another
// agent, which spawns another... with zero guard, is an unbounded fork
// bomb. `depth` travels with every spawned process's env
// (AGENT_CANVAS_SPAWN_DEPTH, see pty-registry.ts) purely for that
// process's own introspection/display — it increments by 1 on every
// agent-initiated (not human-initiated) spawn, and a human spawning from
// the rail/radial menu always starts a fresh chain at depth 0. Pre-release
// audit S4 — the guard itself no longer trusts a caller-supplied depth
// back; see `cardSpawnDepth` further down for the server-side record it
// actually checks against. This is a hard cap enforced BEFORE any consent
// modal even shows — asking a human to approve something structurally
// disallowed is just noise.
export const MAX_SPAWN_DEPTH = 3;

// (2026-09-15) The per-provider effort ranges that used to live here as
// `CLAUDE_EFFORT_VALUES` / `ANTIGRAVITY_EFFORT_VALUES` moved to where the
// rest of the capacity contract lives: each provider's
// `ProviderCapacity.effort` declaration in providers.ts, together with
// the measured evidence and the full refuse-never-silently-remap
// decision writeup. The gate below reads that declaration via
// `decideSpawnProfile` (spawn-profile-decision.ts) — no per-provider
// `if` grows in this file again.

/** DESIGN-BACKLOG.md item 21 ponto 9 / achado ao vivo (2026-09-01) —
 * `kind` e `label` são novos. Antes esta lista era filtrada para
 * `kind === "terminal"` lá no `index.ts`, o que deixava um card de
 * navegador (ou sticky, ou arquivos) literalmente inendereçável: o agente
 * precisava do id pra `get_page_text`/`browser_click`/`snapshot`, e o único
 * jeito de descobri-lo era o valor de retorno do `spawn_card` que o
 * criou — inútil pra qualquer card que um humano abriu. `label` entra pelo
 * mesmo motivo do outro achado da mesma sessão: renomear o card ("Stellar")
 * era puramente decorativo porque nada no bus sabia do nome. Com ele aqui,
 * `resolveTargetId` abaixo aceita o rótulo como alvo. */
export type CardSummary = {
  id: string;
  kind: string;
  provider: string;
  cwd: string;
  label: string | null;
  url?: string;
  /** DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
   * o nome que um humano veria no header deste card AGORA, mesmo sem
   * `label`: `label` quando existe, senão a mesma derivação
   * (`deriveCardDisplayName`, shared/card-identity.ts) que o header do
   * card usa. Antes disto, um agente sem `label` só tinha o `id` numérico
   * pra citar o card de volta — reportado ao vivo pelo dono do repo
   * ("estranho... 'card 321'"). Só pra EXIBIÇÃO: o ordinal embutido nele
   * (cards `terminal` sem label) muda se outro card do mesmo provider for
   * fechado — nunca use isto como chave, `id` continua sendo isso. */
  displayName: string;
};
export type SnapshotResult = { ok: true; path: string } | { ok: false; error: string };
export type PageTextResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };
export type ReadCardResult = { ok: true; text: string } | { ok: false; error: string };
/** Mesma paleta de `StickyCard.tsx` — duplicada aqui de propósito, não
 * importada: main e renderer são bundles separados neste app Electron
 * (ver AGENTS.md), sem import cross-processo possível. Exportada (não só
 * interna a este arquivo) porque mcp-server.ts, no MESMO processo main,
 * reusa o valor pro enum do zod em `set_sticky_color`. */
export const STICKY_COLORS = ["yellow", "green", "blue", "pink"] as const;

export type StickyResult =
  | { ok: true; content: string }
  | { ok: true; content: string; appended: true; totalLines: number }
  | { ok: true; color: string }
  | { ok: true; mode: "edit" | "preview" }
  | { ok: false; error: string };
/** `requesterId` (2026-09-02) em toda variante que MUTA a nota — nunca em
 * `read` (leitura não conecta card nenhum) — é o que deixa a regra geral
 * de auto-conector (App.tsx's `autoConnect`, chamada do `offSticky`)
 * saber QUEM pediu a mutação, sem precisar de um round-trip extra só pra
 * descobrir isso. */
export type StickyOp =
  | { op: "read" }
  | { op: "write"; content: string; mode: "replace" | "append"; requesterId?: string }
  | { op: "set_color"; color: string; requesterId?: string }
  | { op: "set_mode"; mode: "edit" | "preview"; requesterId?: string };
export type CardStatusResult = { ok: true; status: "running" | "waiting" | "exited" } | { ok: false; error: string };
export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window" | "task" | "media";
export type SpawnAgentResult =
  | {
      ok: true;
      cardId: string;
      exited?: boolean;
      exitCode?: number;
      /** Nota informativa, nunca impedimento (task 095158e9, item b):
       * despachar fora de ordem é decisão LEGÍTIMA do orquestrador — o
       * brief já carrega o estado de cada dep, e isto só evita que quem
       * despacha precise abrir o brief pra saber. Presente apenas quando a
       * task tem deps não-done no momento do despacho. */
      note?: string;
    }
  | { ok: false; error: string };
export type SpawnCardResult = { ok: true; cardId: string } | { ok: false; error: string };

/** 2026-09-19 — recusa do `create_task` quando nenhum board resolve: mesma
 * classe da recusa de `provider não declarado` no `spawn_agent`. Uma task
 * sem board nasce fora da Fila (que é indexada por board) e não tem
 * `delete_task` — tasks são imortais por design, então o erro é
 * irreversível. Medido: 23 tasks numa única sessão de orquestração, todas
 * criadas a partir de um card que ESTAVA num board (o contexto existia e
 * não era lido). Exportado pra teste e pra Fila ler o motivo sem copiar. */
export const TASK_BOARD_UNDECLARED_REASON =
  "board não resolvido: sem boardId, sem cardId e sem um card chamador em board (requesterId), a task nasceria fora da Fila e não existe delete_task — passe boardId, ou um cardId/requesterId cujo board exista";

export type BusRequest =
  | { cmd: "list" }
  | { cmd: "send"; target?: string; text?: string; requesterId?: string; steer?: boolean }
  | { cmd: "get_delivery"; id?: string }
  | { cmd: "list_deliveries"; target?: string; requesterId?: string; delivery?: string }
  | { cmd: "cancel_deliveries"; id?: string; requesterId?: string }
  | { cmd: "open"; url?: string; requesterId?: string; reason?: string }
  | { cmd: "close_card"; target?: string; requesterId?: string; reason?: string }
  | {
      cmd: "snapshot";
      target?: string;
      rect?: { x: number; y: number; w: number; h: number };
    }
  | { cmd: "get_page_text"; target?: string }
  // `ref` (achado ao vivo 2026-09-01): um id vindo do `browser_snapshot`,
  // pra mirar um elemento sem já saber um seletor CSS. Tem precedência
  // sobre `selector`; a tradução ref→seletor vive em index.ts, junto do
  // registry que carimba o atributo, pra não haver dois lugares sabendo o
  // nome dele.
  // `requesterId` (2026-09-02) nos 4 mutantes — regra geral de
  // auto-conector, ver `AUTO_CONNECT_CMDS` abaixo. Ausente em
  // `browser_query` (leitura, nunca conecta nada).
  | { cmd: "browser_click"; target?: string; x?: number; y?: number; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_type"; target?: string; text?: string; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_scroll"; target?: string; dx?: number; dy?: number; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_query"; target?: string; selector?: string; ref?: string }
  | { cmd: "browser_eval"; target?: string; js?: string; requesterId?: string }
  | { cmd: "browser_snapshot"; target?: string }
  | { cmd: "browser_console"; target?: string; level?: string; limit?: number }
  | { cmd: "browser_network"; target?: string; status?: number; failedOnly?: boolean; urlContains?: string; limit?: number }
  | { cmd: "browser_wait_for"; target?: string; selector?: string; text?: string; gone?: boolean; timeoutMs?: number }
  | { cmd: "read_card"; target?: string; lines?: number }
  // Achado ao vivo (2026-09-01): "o send_to_card só escreve em card de
  // terminal — sticky é editável só por você (SEM LEITURA TAMBEM)".
  // Tools próprias em vez de estender send_to_card/read_card: "digitar num
  // terminal e apertar Enter" e "substituir o texto de uma nota" são
  // operações diferentes o suficiente pra que sobrecarregar o mesmo nome
  // só produza erro de uso (não há Enter, não há scrollback, `lines` não
  // significa nada). Decidido com o usuário.
  | { cmd: "read_sticky"; target?: string }
  | { cmd: "write_sticky"; target?: string; content?: string; path?: string; mode?: string; requesterId?: string }
  // Regra geral de auto-conector (2026-09-02) — controle de cor/categoria
  // e modo edição/preview, mesma identidade de chamador que write_sticky
  // já carrega.
  | { cmd: "set_sticky_color"; target?: string; color?: string; requesterId?: string }
  | { cmd: "set_sticky_mode"; target?: string; mode?: string; requesterId?: string }
  // Pendentes #188 ("delete_card"/"update_card_content") — close_card and
  // write_sticky/read_sticky only ever look at `callbacks.listCards()`,
  // which is scoped to whichever ONE board is currently loaded (every
  // other board's cards only exist as DB rows, no live PTY/DOM at all —
  // see AGENTS.md). These two reach a card on ANY board, loaded or not:
  // for the loaded one they delegate straight to close_card/write_sticky
  // (identical behavior, not a second implementation); for any other
  // board — no live UI to ever show a human a consent modal — they
  // require that board's OWN autonomous flag, same "no human in the
  // loop, but explicitly told this is fine" contract spawn_card/open_url
  // already use.
  | { cmd: "delete_card"; target?: string; requesterId?: string; reason?: string }
  | { cmd: "update_card_content"; target?: string; content?: string; path?: string; mode?: string; requesterId?: string }
  | { cmd: "card_status"; target?: string }
  /** Prototipo (2026-09-06) — "unificar detecção de turno" pedido pelo
   * usuário: hoje `isActive` (useTerminal.ts) é só uma aproximação por
   * silêncio de bytes (900ms sem nada = "parou"), que faz a barra de
   * atividade sumir mesmo com o agente ainda genuinamente trabalhando
   * (pensando, chamando ferramenta). Sinal real pro provider `claude`:
   * um hook `Stop` (`--settings` efêmero, providers.ts) chama `acbridge
   * turn-complete` exatamente quando o turno acaba de verdade — sem
   * `target`/`requesterId` explícitos porque `acbridge`'s CLI já
   * preenche `cardId` sozinho a partir do próprio `AGENT_CANVAS_CARD_ID`
   * do processo que roda o hook, mesmo padrão de auto-fill de `report`. */
  | { cmd: "turn_complete"; cardId?: string }
  /** Handshake de versão (`acbridge version`). Só existe no caminho do
   * socket — resolvido antes do dispatcher, ver acbridge-protocol-decision.ts. */
  | { cmd: "hello" }
  /** Build identity of the running Electron process (commit/builtAt/mode).
   * Passive — no consent. Same payload hello carries for acbridge version. */
  | { cmd: "build_identity" }
  // `verdict` — DESIGN-BACKLOG.md §2.1 decisão 9: campo real e opcional
  // do protocolo (não mais só uma convenção informal dentro do JSON livre
  // de `report`), para não quebrar quem já reporta sem mandar nada.
  | { cmd: "report"; requesterId?: string; report?: unknown; verdict?: "aprovado" | "reprovado" }
  // `afterSeq` — Parte 2b, "quatro rodadas do mesmo diff, a 4a chamada
  // devolvia a 3a instantaneamente": com `wait: true` e `afterSeq` dado,
  // só resolve quando existir um relatório de sequência MAIOR que essa
  // (nunca o que já estava lá). Omitido, comportamento de sempre: devolve
  // o último já presente.
  | { cmd: "get_report"; target?: string; wait?: boolean; timeoutMs?: number; afterSeq?: number }
  | {
      cmd: "create_task";
      prompt?: string;
      provider?: string;
      cardId?: string;
      /** Board resolution order (2026-09-19): this explicit value, else the
       * `cardId`'s board, else the CALLER card's board (`requesterId`) —
       * context that existed all along and was never read here. Resolvendo
       * nada, a criação é RECUSADA (`TASK_BOARD_UNDECLARED_REASON`): a task
       * nasceria fora da Fila e sem `delete_task` pra desfazer. Um board
       * explícito que não existe continua recusado. */
      boardId?: string;
      /** Working directory for auto-dispatch/retry. Omit/`undefined` =
       * task carries `cwd: null` and spawn falls back to the board root
       * (same as before — declared, not inferred from a repo heuristic). */
      cwd?: string;
      deps?: string[];
      maxRetries?: number;
      fallbackProviders?: string[];
      // DESIGN-BACKLOG.md §2.1 decisão 6 — só o palpite do AGENTE. `order`
      // (o humano arrastando) não tem parâmetro em nenhum cmd desta fase
      // — nenhuma UI ainda o escreve, de propósito (ver o relatório
      // final).
      suggestedOrder?: number;
      /** `tasks.purpose` — what the task IS: one of `TASK_PURPOSES`
       * (`src/task-purpose.ts`; não enumere os valores aqui — esta linha
       * listava quatro e ficou mentirosa quando `integrate` entrou), written
       * ONCE here. Deliberately absent from
       * `update_task`: the store's ON CONFLICT omits the column, so no
       * later write can relabel it. Omitted = `null` (NORMAL, empty chip).
       * An unknown value is REFUSED, never normalized to null or to a
       * default — same principle as `spawn_agent`'s effort check. */
      purpose?: string;
      /** Layer-1 contract — `"wanted"` means agent judgment (`done`/
       * `failed`) requires a linked reviewer; `null`/omit = never
       * declared. MUTABLE via update_task (unlike purpose). Does NOT
       * spawn a reviewer. Unknown value REFUSED. */
      review?: string;
      /** Task CONTRACT — structured judgment (not a paragraph). Optional;
       * absence is NORMAL. Consumer: delivered brief + reportSchema refusal. */
      territory?: string[];
      gates?: string[];
      allowCommit?: boolean;
      reportSchema?: string[];
      /** Who called — stamped on the create transition as subject card.
       * Same field update_task already carried; create_task used to drop it. */
      requesterId?: string;
    }
  | {
      cmd: "update_task";
      taskId?: string;
      status?: string;
      cardId?: string | null;
      /** Set/clear the task's own cwd for later auto-dispatch. `null`
       * clears back to board-root fallback; omit leaves unchanged. */
      cwd?: string | null;
      /** Repair path (2026-09-19) for a board-less task: the resolver that
       * `create_task` refuses to leave empty can be filled in here. Só para
       * task com `board_id` NULL e board que EXISTE — re-apontar uma task
       * que já tem board é recusado (`board_id` é escrito uma vez; é a
       * mesma classe de erro silencioso que este campo fecha). Omitido =
       * não mexe. Alcançável pelo `acbridge update-task <id> <json>`, que
       * espalha o JSON cru no request. */
      boardId?: string;
      result?: unknown;
      incrementRetry?: boolean;
      attemptedProvider?: string;
      suggestedOrder?: number;
      /** Briefing text. Omitted = leave the stored prompt unchanged.
       * Default write is append (original statement stays); `promptMode:
       * "replace"` is required to overwrite. Does NOT type into a live
       * card — spawn is the only path that delivers `prompt` to a PTY. */
      prompt?: string;
      /** Default `"append"`. `"replace"` is explicit intent only. */
      promptMode?: TaskPromptWriteMode;
      /** DESIGN-BACKLOG.md §2.1 Decisão 8 — quem chamou, pra o aviso de
       * status retido (typeAndSubmit) chegar no PTY certo. Ausente em
       * chamadas antigas / bookkeeping externo: o aviso ainda volta no
       * envelope MCP (`warning`), e cai no `card_id` da task se houver. */
      requesterId?: string;
      /** Layer-1 `review` — set `"wanted"` or clear with `null`. Omit =
       * leave unchanged. Unknown string REFUSED. */
      review?: string | null;
      /** Contract fields — same shape as create_task. Omit = leave; null = clear. */
      territory?: string[] | null;
      gates?: string[] | null;
      allowCommit?: boolean | null;
      reportSchema?: string[] | null;
    }
  // DESIGN-BACKLOG.md §2.1 item 6 — `boardId` opcional: omitido, devolve
  // exatamente a lista sem filtro de sempre (nenhum comportamento
  // existente muda). `status`/`since`/`hasCard`/`view` — filtros e
  // projeção do orquestrador (list-tasks-query.ts); omitidos = firehose
  // de sempre, para não quebrar quem já chama sem args.
  | {
      cmd: "list_tasks";
      boardId?: string;
      status?: string | string[];
      since?: number;
      hasCard?: boolean;
      view?: "summary" | "full";
    }
  | { cmd: "get_task"; taskId?: string }
  /** `task_cards.role` for a card that ALREADY exists (the other write
   * path is `spawn_agent({taskId, role})`, for a card born for the task).
   * `implementer` also makes the card the task's principal `card_id`
   * (the one `report`'s retry/failure mechanics key off); `reviewer`
   * only adds the role row and leaves `card_id` alone — a reviewer's
   * `{ok:false}` report is a verdict, not the task failing. Role omitted
   * = implementer; unknown role = REFUSED. */
  | { cmd: "link_task_card"; taskId?: string; cardId?: string; role?: string; requesterId?: string }
  | {
      cmd: "request_task_status";
      taskId?: string;
      status?: string;
      reason?: string;
      requesterId?: string;
    }
  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — fechamento explícito
  // por agente (MCP). Nunca por data. `boardId` obrigatório: sprint é
  // por board, não global.
  | { cmd: "close_sprint"; boardId?: string }
  | { cmd: "open_sprint"; boardId?: string }
  | { cmd: "list_sprints"; boardId?: string }
  | { cmd: "rename_sprint"; sprintId?: string; name?: string | null }
  | { cmd: "delete_sprint"; sprintId?: string }
  | { cmd: "list_connectors" }
  | { cmd: "spawn_lineage"; cardId?: string }
  | { cmd: "set_connector_kind"; connectorId?: string; kind?: string | null; requesterId?: string }
  | { cmd: "set_connector_label"; connectorId?: string; label?: string | null }
  | { cmd: "concurrency_status"; cap?: number }
  | { cmd: "board_mode"; target?: string }
  | {
      cmd: "spawn_agent";
      provider?: string;
      cwd?: string;
      /** "worktree" = nasce numa git worktree descartável do repo em `cwd`
       * (ou do cwd do card chamador), não na árvore compartilhada. A
       * worktree só tem o que o git rastreia; os caminhos que o
       * `.gitignore` esconde e o projeto precisa para rodar são declarados
       * por ele em `.stellar/worktree.json` (lido do checkout de origem) e
       * copiados — ver `worktree-isolation-decision.ts`. Omitido = árvore
       * compartilhada, como sempre. Valor desconhecido é RECUSADO. */
      isolation?: string;
      resumeId?: string;
      requesterId?: string;
      reason?: string;
      model?: string;
      /** Sticky item "spawn_agent effort" (2026-09-03) — Antigravity needs
       * this alongside `model` (`providers.ts`'s `SpawnOpts.effort`) or it
       * silently falls back to a different model with only a warning, no
       * error. NOT "ignored" by the others: since 2026-09-15, passing
       * `effort` for a provider that cannot honor it is REFUSED here
       * (`decideSpawnProfile`), the same refuse-never-silently-remap rule
       * as an out-of-range value for one that can. Each provider's range
       * and mechanism are declared in `ProviderCapacity.effort`
       * (providers.ts, measured evidence in `EffortCapability`'s
       * comment), re-measured 2026-09-12 against the live CLIs. */
      effort?: string;
      /** DESIGN-BACKLOG.md item 62 — same free-text label a human sets via
       * CardTag rename; `describeCardLabel`/the renderer's `describeCard`
       * already prefer it over the "Bash 2°" ordinal when present. */
      label?: string;
      wait?: boolean;
      waitTimeoutMs?: number;
      brief?: string;
      /** Optional. When set, the delivered brief is that task's stored
       * `prompt` — same source auto-dispatch already uses. Omit to keep
       * free `brief` (or no brief) as a first-class path. Refused together
       * with `brief`; a missing id is refused, not ignored. */
      taskId?: string;
      /** `task_cards.role` of the new card on `taskId` (2026-09-13 —
       * before this, 91/91 rows were the silent `implementer` default
       * because no tool could say otherwise). Omitted = `implementer`
       * (today's behavior: card becomes `card_id`, brief = task prompt).
       * `reviewer` = role row only, `card_id` untouched, brief = the free
       * `brief` (the review order), never the task prompt — see
       * spawn-brief-decision.ts. Without `taskId`, or with an unknown
       * value, the spawn is REFUSED. */
      role?: string;
    }
  | {
      cmd: "spawn_card";
      kind?: string;
      cwd?: string;
      url?: string;
      /** Absolute or cwd-relative path — required for `kind: "media"`.
       * Validated + copied into board-assets before consent (MediaCard
       * only loads via stellar-asset://). */
      path?: string;
      requesterId?: string;
      reason?: string;
      /** Pendentes #188 ("spawn_card por coordenadas") — place the new
       * card right next to an existing one instead of `centeredSlot`'s
       * viewport-center placement. `side` defaults to "right" when
       * `anchorCardId` is given without it. */
      anchorCardId?: string;
      side?: "left" | "right" | "top" | "bottom";
    };

export type BusResponse = Record<string, unknown> & { ok: boolean };

/**
 * Optional second arg to `handleRequest`. `channel` is stamped by the
 * frontend that received the bytes (HTTP vs Unix socket) — never by the
 * agent payload. See `ReportRow.channel`.
 */
export type HandleRequestOpts = { channel?: ReportIngressChannel | null };

/**
 * A local Unix socket bridge letting a spawned provider CLI act on the
 * board via its own shell tool — none of claude/codex/cursor-agent expose
 * any channel for one session to reach another, so `acbridge` (the CLI
 * script this listens for) is the only realistic bridge that works
 * unconditionally across all three vendors. `handleRequest` below is ALSO
 * the backend for `mcp-server.ts` (DESIGN-BACKLOG.md item 21, ponto 9) —
 * one dispatcher, two frontends (a raw JSON-line socket for `acbridge`,
 * an MCP tool call for a provider that speaks MCP), so a consent flow or
 * a new capability is written once and both frontends get it for free.
 */
export function createMessageBus(
  sockPath: string,
  callbacks: {
    listCards: () => CardSummary[];
    writeToCard: (id: string, text: string) => void;
    /** Internal delivery path: the registry records this write as agent
     * delivery rather than human keystrokes, so the delivery itself cannot
     * trip the human-input gate or rearm session discovery. Optional keeps
     * existing test doubles and external integrations source-compatible. */
    writeToCardWithOrigin?: (id: string, text: string, origin: "delivery") => void;
    /** Small critical section around one delivery's text + Enter + check.
     * Human bytes arriving during it are retained by the PTY registry and
     * replayed afterward in order. */
    beginCardDelivery?: (id: string) => boolean;
    /**
     * Closes the delivery critical section and replays any human bytes
     * that arrived while it was held. When those bytes flushed, the
     * return says so — deliverCard then emits `notifyCardInput`, the
     * same notice as a live keystroke. `void` keeps older test doubles
     * source-compatible (no flush signal → no extra notice).
     */
    endCardDelivery?: (id: string) => void | { flushedHumanInput: boolean };
    /** DESIGN-BACKLOG.md item 61 — same "Bash 2°" ordinal-per-provider
     * convention App.tsx's `describeCard` already uses for
     * `AgentAskModal`'s requester label, reimplemented here against
     * `store.ts` directly (this is main-process code, no renderer
     * `cardsRef` to read) so `send_to_card` can prefix delivered text
     * with who sent it — no MCP tool had a caller-identity param at all
     * before this (unlike open_url/spawn_agent/spawn_card, which always
     * did). Falls back to a human-set `label` when the card has one,
     * same priority order as the renderer's version. */
    describeCardLabel: (cardId: string) => string;
    /** `reason` — DESIGN-BACKLOG.md item 21, ponto 9, "motivo" in the
     * generic ask-permission component: only ever set by an MCP tool call
     * (a real, typed, optional param there); acbridge's CLI never sets it
     * (would need an awkward extra positional arg) — the consent modal
     * just shows nothing for that line when absent. */
    onOpenRequest: (requestId: string, requesterId: string, url: string, reason?: string, autoApprove?: boolean) => void;
    /** Sticky item "close_card" (2026-09-03) — same ask/consent/resolve
     * shape as `onOpenRequest` above, generalized to closing ANY existing
     * card (not just terminal — a stuck files/browser/sticky card is just
     * as legitimate a target). `closeCard()`'s own live-terminal
     * "are you sure" gate (App.tsx) is skipped on this path — the human's
     * approval of THIS request already covers it, asking twice would be
     * pure friction. */
    onCloseCardRequest: (requestId: string, requesterId: string, target: string, reason?: string, autoApprove?: boolean) => void;
    /** cardId set: that card's current on-screen rect. rect set: an
     * explicit world-space rect. Neither: the whole window. Resolving
     * either into actual capturePage() screen pixels lives in
     * main/index.ts — this module only relays the parsed request. */
    onSnapshotRequest: (
      requestId: string,
      target: { cardId: string } | { rect: { x: number; y: number; w: number; h: number } } | null,
    ) => void;
    /** Pre-release audit B6 — `onSnapshotRequest`/`onReadCardRequest`
     * below each register their own one-shot `ipcMain` reply listener in
     * main/index.ts, cleaned up when the renderer actually replies. If it
     * never does (unresponsive window), this module's own timeout below
     * resolves the caller anyway — but nothing told main/index.ts to give
     * up too, so its listener stayed registered forever. Called right
     * before resolving on timeout so index.ts can remove its listener for
     * this exact `requestId`. */
    onSnapshotTimeout: (requestId: string) => void;
    /** No consent gate (see PAGE_TEXT_TIMEOUT_MS) — reads an already-open
     * browser card's rendered text, same risk class as `snapshot`. */
    onPageTextRequest: (requestId: string, cardId: string) => void;
    /** DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa"
     * — the 5 browser control tools, all resolving synchronously (well,
     * async, but 100% local to this process — see the doc comment on
     * `browser_click`'s handler below for why these don't need the
     * pending-map+timeout ceremony `onSnapshotRequest`/`onPageTextRequest`
     * use). Same no-consent-gate reasoning as `onPageTextRequest` — these
     * only act inside a browser card the human already approved creating
     * (`open_url`), never create/navigate anything new themselves.
     * `browserEval` is the one exception worth calling out: it runs
     * arbitrary agent-supplied JS in the page's real context (cookies/
     * session/localStorage reachable) — accepted risk, documented in the
     * MCP tool's own `description` (mcp-server.ts), not hidden here. */
    browserClick: (cardId: string, x?: number, y?: number, selector?: string, ref?: string) => Promise<BusResponse>;
    browserType: (cardId: string, text: string, selector?: string, ref?: string) => Promise<BusResponse>;
    browserScroll: (cardId: string, dx: number, dy: number, selector?: string, ref?: string) => Promise<BusResponse>;
    browserQuery: (cardId: string, selector?: string, ref?: string) => Promise<BusResponse>;
    browserEval: (cardId: string, js: string) => Promise<BusResponse>;
    browserSnapshot: (cardId: string) => Promise<BusResponse>;
    browserConsole: (cardId: string, level?: string, limit?: number) => BusResponse;
    browserNetwork: (cardId: string, opts: { status?: number; failedOnly?: boolean; urlContains?: string; limit?: number }) => BusResponse;
    browserWaitFor: (cardId: string, opts: { selector?: string; text?: string; gone?: boolean; timeoutMs?: number }) => Promise<BusResponse>;

    /** DESIGN-BACKLOG.md item 58, M1 — only the renderer holds the live
     * xterm.js Terminal instance for a terminal card (main never sees
     * terminal content, only raw pty bytes flowing through). */
    onReadCardRequest: (requestId: string, cardId: string, lines?: number) => void;
    /** Mesma forma de request/reply do `onReadCardRequest` acima, e pelo
     * mesmo motivo: o `<textarea>` montado no renderer é a fonte da verdade
     * enquanto o card existe. Ler do SQLite devolveria texto velho no meio
     * de uma digitação (o commit só acontece no blur), e escrever só no
     * SQLite seria sobrescrito pelo próximo commit de digitação. */
    onStickyRequest: (requestId: string, cardId: string, op: StickyOp) => void;
    onStickyTimeout: (requestId: string) => void;
    /** Pre-release audit B6 — same listener-leak-on-timeout fix as
     * `onSnapshotTimeout` above, for `readcard:reply`. */
    onReadCardTimeout: (requestId: string) => void;
    /** Regra geral de auto-conector (2026-09-02) — push fire-and-forget
     * pro renderer (única fonte de verdade do `connectors` visível no
     * board aberto) sempre que uma mutação cross-card identifica quem a
     * pediu. Só o "send" cmd chama isso hoje — write_sticky/
     * set_sticky_color/set_sticky_mode já round-trip pro renderer por
     * outro motivo (o `<textarea>` é a fonte de verdade do conteúdo) e
     * chamam App.tsx's `autoConnect` direto de lá, sem precisar deste
     * push. Dedup/idempotência vivem inteiramente do lado do renderer. */
    onAutoConnect: (fromCardId: string, toCardId: string, kind: string, label?: string | null) => void;
    /** DESIGN-BACKLOG.md item 58, M4 — pty-registry.ts's own `isAlive`,
     * threaded straight through: no round trip needed, main already knows. */
    isCardAlive: (cardId: string) => boolean;
    /** Sticky item "card_status idle" — `null` for a card with no live
     * PTY entry (never spawned/exited/error), matching `isCardAlive`'s
     * own "no entry" convention. */
    getCardLastActivityAt: (cardId: string) => number | null;
    /**
     * O FATO DE TURNO (task 4245c6f5) — quando o card declarou `turn_complete`,
     * ou `null` se nunca declarou. `null` é resposta: é o que faz
     * `card_status` devolver `unknown` em vez de escolher entre running e
     * idle por conta própria.
     */
    getCardTurnEndedAt: (cardId: string) => number | null;
    /** Registra o fim de turno (o MESMO instante do relay pro renderer).
     * Separado do relay de propósito: o push é UI, isto é o FATO. */
    markCardTurnComplete: (cardId: string) => void;
    /**
     * A ÂNCORA DO EPISÓDIO (task a1201078) — quando este card recebeu
     * trabalho pela última vez: spawn com brief, input humano ou `delivery`;
     * `auto` (mouse/CPR/focus) não conta. Vem de
     * `pty-registry.ts`'s `getLastWorkGrantedAt`.
     *
     * É o que o SINAL 3 usa para perguntar "existe report NESTE episódio?" em
     * vez de "existe report na vida?" — a pergunta errada que desarmava o
     * watchdog no PRIMEIRO report de um card e deixava passar todas as falhas
     * seguintes.
     *
     * OBRIGATÓRIO. Ele nasceu opcional por uma janela datada — o repasse de
     * uma linha em `index.ts` estava fora do território daquela rodada, e
     * enquanto isso o scan caía no fato ABSOLUTO deprecado `hasReport`. O
     * repasse entrou, a janela fechou, e o fallback foi removido junto: um
     * watchdog que PARECE vigiar e não vigia é o pior dos dois mundos, e era
     * exatamente o risco de entregar isto pela metade.
     */
    getCardLastWorkGrantedAt: (cardId: string) => number | null;
    /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica
     * na caixa sem submeter" — `typeAndSubmit`'s portão de prontidão
     * (`type-and-submit-decision.ts`'s `decideWriteReadiness`) precisa dos
     * 3 campos juntos pra uma decisão só; `null` com a mesma convenção de
     * `isCardAlive`/`getCardLastActivityAt` (sem entry, nada a esperar). */
    getCardWriteReadiness: (cardId: string) => {
      spawnedAtMs: number;
      hasReceivedData: boolean;
      lastActivityAtMs: number;
      hasPendingHumanInput?: boolean;
      inputLineLastAtMs?: number | null;
      /** Peer requested DECSET 2004h. Absent/false → deliver raw bytes. */
      bracketedPasteMode?: boolean;
      /** Monotonic `2004l` count — shell "line accepted" signal for the
       * confirm loop (`readlineAcceptedSince`). Absent → no signal. */
      bracketedPasteOffEvents?: number;
    } | null;
    /** Prototipo (2026-09-06) — ver o comentário de `turn_complete` no
     * `BusRequest` acima. Push fire-and-forget pro renderer, keyed pelo
     * mesmo id unificado card/PTY (pty-registry.ts); `useTerminal.ts`
     * escuta e, só pro provider `claude`, usa isto como o sinal
     * DEFINITIVO de fim de turno em vez do timer de silêncio de 900ms. */
    notifyTurnComplete: (cardId: string) => void;
    /**
     * Activity bar (1fcd36b limit): a programmatic delivery just wrote
     * the BODY into this card. Same semantic as a keystroke — the
     * renderer applies `"input"` and opens the turn window. Optional:
     * test doubles stay source-compatible. Must NOT be invoked on
     * retry Enter or composer clear — see `deliveryWriteOpensTurn`.
     */
    notifyCardInput?: (cardId: string) => void;
    /** Bug real relatado (Pop!_OS, 2026-09-09) — `server.on("error")`
     * abaixo só fazia `console.error`: uma falha de bind (2ª instância que
     * já roubou o socket, ver `app.requestSingleInstanceLock()` em
     * index.ts, ou qualquer outra causa) deixava o acbridge indisponível
     * de um jeito 100% invisível pro usuário E pro agente — o próximo
     * sintoma era o Stop hook explodindo com `connect ENOENT` bem depois,
     * sem nenhum sinal no meio. Mesmo padrão fire-and-forget de
     * `notifyTurnComplete` acima: relay simples pro renderer, nenhum
     * estado novo aqui no bus. */
    notifyBusUnavailable: (message: string) => void;
    /** DESIGN-BACKLOG.md item 59 — which board a card lives on, and
     * whether that board's opt-in autonomous mode is on. Only ever read
     * here, never written — the only write path is a human's toggle in
     * the UI (App.tsx's session UI → `setBoardAutonomous`), never an
     * MCP/acbridge cmd (see AGENTS.md's architecture entry). */
    getCardBoardId: (cardId: string) => string | undefined;
    /** Currently loaded board — optional so existing test doubles stay
     * source-compatible. Used as a last-resort board id for `kind:
     * "media"` asset copies when the caller is anonymous (no card stamp)
     * but the spawn still lands on the open board. */
    getActiveBoardId?: () => string | undefined;
    /** Card rows for one board in the store's live-card universe. The
     * archivedAt field remains explicit in the shared guard input so callers
     * that do have historical rows can ignore them rather than treating
     * history as an occupied queue. */
    listCardsForBoard: (boardId: string) => TaskCardGuardCard[];
    isBoardAutonomous: (boardId: string) => boolean;
    /** Board orchestrator mark — read-only here. Only the renderer UI
     * writes `boards.orchestrator_card_id`. `null`/undefined = unmarked. */
    getBoardOrchestratorCardId: (boardId: string) => string | null | undefined;
    /** RODADA 4 (DESIGN-BACKLOG.md §2.3, fechar a classe do board órfão)
     * — `create_task` valida contra isto antes de gravar: um `boardId`
     * que não existe é recusado (erro explícito ao chamador), nunca
     * gravado em silêncio. Mesmo princípio que fechou o bug do `effort`
     * do antigravity — falhar alto é melhor que gravar lixo quieto, e
     * falha silenciosa nesta base já custou dinheiro uma vez. */
    boardExists: (boardId: string) => boolean;
    /** Pendentes #188 ("delete_card"/"update_card_content") — unlike
     * `listCards()` (only the currently loaded board's live cards), this
     * reads straight from the store across EVERY board — the only way to
     * even validate a target that isn't on the loaded board at all. */
    /** `provider` — DESIGN-BACKLOG.md §2.1 "SINAL 2", achado de review
     * adversarial (achado 3): acrescentado a este callback já existente
     * (não um novo) pra `resolveCardExit` conseguir distinguir um card
     * `bash` (que nunca chama `report` — não tem MCP/conceito de
     * relatório, mesma convenção "bash não é agente" de
     * `countRunningAgentsOnBoard`) de um agente de verdade, mesmo quando
     * o card já saiu do board carregado. `null` pros kinds sem provider
     * (files/changes/browser/sticky/etc.) e pra um card sem linha (já
     * coberto pelo `undefined` do retorno inteiro). */
    getAnyCard: (
      cardId: string,
    ) =>
      | {
          boardId: string;
          kind: string;
          provider: string | null;
          model?: string | null;
          effort?: string | null;
          resume_id?: string | null;
        }
      | undefined;
    /** Direct store mutation, no live renderer/IPC round-trip at all —
     * dispatchRequest only ever calls these for a card whose board ISN'T
     * the one currently loaded (nothing live to keep in sync there; a
     * loaded-board card goes through close_card/write_sticky's normal
     * live path instead). */
    deleteCardDirect: (cardId: string) => void;
    updateStickyContentDirect: (
      cardId: string,
      content: string,
      mode: "replace" | "append",
    ) => { ok: true; content: string } | { ok: false; error: string };
    /** DESIGN-BACKLOG.md item 60, peça 2 — per-board override of
     * DEFAULT_CONCURRENCY_CAP below. `null`/`undefined` means "use the
     * default", never "zero". */
    getBoardConcurrencyCap: (boardId: string) => number | null | undefined;
    /** DESIGN-BACKLOG.md item 60, peça 1 — pushed to the renderer every
     * time a board's spawn queue changes (enqueue, dequeue, dispatch,
     * timeout) so a live panel can render position/board/provider without
     * polling. `queue` is already in FIFO order — index is position. */
    onQueueChanged: (
      boardId: string,
      queue: Array<{ id: string; requesterId: string; provider: string; reason?: string; requestedAt: number }>,
    ) => void;
    /** Live (isCardAlive-backed) count of non-bash terminal cards on one
     * board — the same "bash isn't an agent" convention as M4/peça 6's
     * concurrency_status, but board-scoped instead of global, since
     * autonomous mode's cap is enforced per board. */
    countRunningAgentsOnBoard: (boardId: string) => number;
    /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — direct
     * pass-through to store.ts (better-sqlite3 is synchronous, no round
     * trip needed here either). */
    listTasks: () => TaskRow[];
    /** DESIGN-BACKLOG.md §2.1 item 6 — board-scoped counterpart to
     * `listTasks` above, backed by `store.listTasksByBoard`
     * (`idx_tasks_board_id`). Lets `list_tasks` (this file) filter by
     * board at the SQLite layer instead of loading the whole table into
     * Node just to `.filter()` it. */
    listTasksByBoard: (boardId: string) => TaskRow[];
    /**
     * PERF (task c9db1d86, medido na 41813ab3 seq 447) — par de `summary`
     * dos dois callbacks acima: MESMAS linhas, com `prompt`/`result_json`
     * em `null` já no SELECT, em vez de selecioná-los e descartá-los no
     * `projectListedTask` no fim. Backed by `store.listTasksSummary` /
     * `store.listTasksSummaryByBoard`.
     *
     * Obrigatórios (não opcionais) de propósito: `tsc` passa a recusar uma
     * fiação que esqueça um dos dois, em vez do modo de falha silenciosa —
     * o handler cairia no caminho `full` e o `view:"summary"` voltaria a
     * não economizar nada sem ninguém perceber.
     */
    listTasksSummary: () => TaskRow[];
    listTasksSummaryByBoard: (boardId: string) => TaskRow[];
    /**
     * PERF (task 9dd877c8, medido na 41813ab3 seq 447) — linha mínima
     * (`id`, `card_id`, `status`) para `scanIdleWithoutReport`, que roda num
     * timer de 5s para sempre e consumia a tabela inteira, com
     * `prompt`/`result_json`, para ler dois campos.
     *
     * Backed by `store.listTasksForIdleScan`. Obrigatório pelo mesmo motivo
     * dos dois acima: um callback que o wiring esqueça vira no-op silencioso
     * (`Array.isArray(undefined)` → lista vazia → o scan para de achar task
     * vinculada sem nenhum erro aparecer).
     */
    listTasksForIdleScan: () => import("./store").TaskIdleRow[];
    getTask: (id: string) => TaskRow | undefined;
    upsertTask: (task: TaskRow) => StatusWriteDecision;
    /** Third path — park/clear a status ask without touching status.
     * Optional so existing test doubles stay source-compatible. */
    setStatusAsk?: (
      taskId: string,
      ask: { status: string; reason: string | null; requesterId: string | null; at: number } | null,
    ) => { ok: true } | { ok: false; error: string };
    /** DESIGN-BACKLOG.md §2.1 "Historico de sprints" — pass-through pro
     * store (snapshot congelado no close). O renderer usa IPC próprio;
     * estes callbacks existem só pro MCP/acbridge. */
    listSprints: (boardId: string) => import("./store").SprintRow[];
    openSprint: (boardId: string) => { ok: true; sprint: import("./store").SprintRow } | { ok: false; error: string };
    closeSprint: (
      boardId: string,
      isCardAlive?: (cardId: string) => boolean,
    ) =>
      | { ok: true; closed: import("./store").SprintRow; opened: import("./store").SprintRow }
      | { ok: false; error: string };
    renameSprint: (
      sprintId: string,
      name: string | null,
    ) => { ok: true; sprint: import("./store").SprintRow } | { ok: false; error: string };
    deleteSprint: (sprintId: string) =>
      | { ok: true; deleted: import("./store").SprintRow; restored: import("./store").SprintRow | null; movedTaskCount: number }
      | { ok: false; error: string };
    /** Notify the Fila card after an MCP close/open so the history panel
     * refreshes. Optional — tests that don't mount a window omit it. */
    onSprintsChanged?: (boardId: string) => void;
    /** Current task_cards links from the card side. A secondary reviewer
     * card can close a participation round without being the principal
     * card of the task. */
    listTaskCardsForCard: (cardId: string) => TaskCardRow[];
    /** Every `task_cards` row for one task (Fila chips / judgment gate).
     * Unfiltered by terminal status — membership for "may this card
     * write done/failed" must still see the link on a live task. */
    getTaskCards: (taskId: string) => TaskCardRow[];
    /** Explicit role write (`store.linkTaskCard`, the upsert that DOES
     * overwrite an existing role — unlike `upsertTask`'s if-absent
     * implementer). Called by `spawn_agent({taskId, role:"reviewer"})`
     * and `link_task_card`; the wiring in index.ts also pushes the Fila
     * so the ` ↔ review` chip updates without a reload. */
    linkTaskCard: (
      taskId: string,
      cardId: string,
      role: string,
      profile?: {
        provider?: string | null;
        model?: string | null;
        effort?: string | null;
        requestedResumeId?: string | null;
        sessionId?: string | null;
      },
    ) => void;
    /** DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — mesmo
     * pass-through direto pro store das 3 linhas acima, mesmo motivo. O
     * cmd `report`/`get_report` (mais abaixo) continua sendo quem faz
     * JSON.stringify/parse do valor do relatório — a mesma divisão de
     * responsabilidade que `serializeTask` já usa pra `result_json`, não
     * uma segunda convenção. Ver o comentário grande de `ReportRow` em
     * store.ts (append-only por `seq`; `getReport` sem `afterSeq` = mais
     * recente; com `afterSeq` = próximo). */
    getReport: (cardId: string, afterSeq?: number) => ReportRow | undefined;
    upsertReport: (row: ReportRow) => void;
    /** DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" —
     * pass-through síncrono pro `store.ts`'s `recordParticipationRound`
     * (ver o comentário grande lá pro modelo completo). Chamado de DOIS
     * lugares neste arquivo, os dois já choke points existentes: o cmd
     * `report` abaixo (toda vez que um card reporta, com ou sem
     * `verdict`) e o ramo "Sinal 2" de `resolveCardExit` (saída sem
     * NUNCA ter chamado `report` — `verdict: null` pela causa oposta).
     * Nenhum terceiro lugar chama isto — não existe tool de MCP nem cmd
     * de bus que escreva aqui além destes dois, por decisão explícita
     * (MCP só leitura para este dado, via `get_task`). */
    recordParticipationRound: (cardId: string, verdict: string | null, at: number) => void;
    /** Seeda `reportSeqCounter` (abaixo) do que já está persistido — sem
     * isto, um restart zeraria o contador e o PRÓXIMO relatório sairia com
     * seq baixa (1, 2, ...) enquanto relatórios de ANTES do restart ainda
     * têm seq alta persistida: o `afterSeq` do `read_report` passaria a
     * mentir (relatório novo com seq menor que um antigo, consumidor pula
     * o novo). `0` numa tabela vazia — primeiro `++reportSeqCounter`
     * continua começando em 1, igual ao contador em memória de sempre. */
    nextReportSeqSeed: () => number;
    /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — data
     * model only: this exposes the connector graph and lets kind be
     * tagged on an existing connector, but nothing in this app dispatches
     * off it. Deciding WHEN a `depends` edge means "go" is left to an
     * external orchestrating agent, driving spawn_agent itself (which
     * still goes through its own human consent gate, same as ever) —
     * see AGENTS.md's positioning entry on this. */
    listAllConnectors: () => ConnectorRow[];
    /** Spawn registry — append-only; see store.recordSpawn / SpawnRow. */
    recordSpawn: (input: {
      boardId: string;
      fromCardId: string | null;
      toCardId: string;
      reason: string | null;
      taskId?: string | null;
      provider?: string | null;
      cardKind?: string | null;
      cwd?: string | null;
      origin: string;
      createdAt?: number;
    }) => SpawnRow;
    findSpawnByChild: (toCardId: string) => SpawnRow | undefined;
    listSpawnsByParent: (fromCardId: string) => SpawnRow[];
    setConnectorKind: (id: string, kind: string | null) => boolean;
    /** Same contract as setConnectorKind, `label` column instead — backs
     * `set_connector_label` below (2026-09-09, "label em tempo real"). */
    setConnectorLabel: (id: string, label: string | null) => boolean;
    /** Achado 2 (review adversarial, 2026-09-09) — the push below needs
     * the connector's OWN board to let index.ts filter against the
     * currently open one before `safeSend`ing (same idea as `listCards`'s
     * `board_id === activeBoardId` filter there); a connector's two card
     * ids aren't enough on their own without another lookup, and the
     * connector row already carries `board_id` directly. */
    getConnectorBoardId: (id: string) => string | undefined;
    /** Push side of `set_connector_label`: `set_connector_kind` has NO
     * live push today (confirmed while building this — its doc comment
     * above implies parity with the render state, but there just isn't
     * one; an open board only ever sees a `kind` set at creation time via
     * `onAutoConnect`'s own `addConnector`, never a later change made
     * through the cmd). `label` needs to actually update the pill on an
     * OPEN board without reload — that's the whole point of "tempo real"
     * — so this is new plumbing, not a copy of an existing push. Modeled
     * directly on `onAutoConnect`'s shape (id + new value, safeSend to the
     * renderer) since that's the one real precedent for "main pushes a
     * connector change to the renderer" in this codebase.
     * `boardId` (achado 2 above) is the connector's own board, `undefined`
     * only if it vanished between the UPDATE and this lookup — index.ts
     * decides what to do with it (filter against the open board), this
     * cmd handler just always passes it along. */
    onConnectorLabelChanged: (id: string, label: string | null, boardId: string | undefined) => void;
    /** Same push, `kind` instead of `label`. This one closed the gap the
     * comment above used to DESCRIBE and leave open (DESIGN-BACKLOG.md
     * §2.1, "`set_connector_kind` grava no banco e não avisa o board"):
     * `set_connector_kind` persisted and pushed nothing, so an open board
     * only ever showed a `kind` set at creation time via `onAutoConnect`,
     * and a later change through the cmd stayed invisible until reload.
     * Identical shape and identical `boardId` contract to the label push
     * on purpose — the two cmds are siblings on the same row, and having
     * them behave differently is what made the gap easy to miss. */
    onConnectorKindChanged: (id: string, kind: string | null, boardId: string | undefined) => void;
    onSpawnAgentRequest: (
      requestId: string,
      requesterId: string,
      params: {
        provider: string;
        cwd?: string;
        resumeId?: string;
        depth: number;
        reason?: string;
        model?: string;
        /** Sticky item "spawn_agent effort" — see the `spawn_agent` cmd's
         * own field above. Widened from `"low" | "high"`, same reasoning. */
        effort?: string;
        /** DESIGN-BACKLOG.md item 62 — same free-text label CardTag
         * rename sets; `undefined` leaves the new card unlabeled (the
         * ordinal "Bash 2°" convention applies), same as before this
         * item existed. */
        label?: string;
        /** DESIGN-BACKLOG.md item 59 — set only when the requester's own
         * board is in autonomous mode and under its concurrency cap; the
         * renderer creates the card and resolves immediately, with no
         * `AgentAskModal` shown at all. */
        autoApprove?: boolean;
        brief?: string;
        /** Optional. Present when this spawn is tied to a task — renderer threads it into SpawnOpts / AGENT_CANVAS_TASK_ID. Omitted for a first-class task-less spawn. */
        taskId?: string;
        /**
         * Connector pill for the spawned lineage arrow — the ONE source.
         * Computed by `deriveAutoConnectLabel` (purpose + role). `reason`
         * stays consent-modal text only; the renderer must not invent a
         * second label from it (2026-09-14). Already through
         * `truncateForLabel`; `null` = no pill.
         */
        connectorLabel?: string | null;
      },
    ) => void;
    onSpawnCardRequest: (
      requestId: string,
      requesterId: string,
      params: {
        kind: SpawnCardKind;
        cwd?: string;
        url?: string;
        reason?: string;
        /** DESIGN-BACKLOG.md item 60, peça 5 — same meaning as
         * spawn_agent's `autoApprove` above, extended to non-terminal
         * cards. True for the requester's own autonomous board (no
         * concurrency cap applies here, only spawn_agent counts against
         * it) — OR, achado ao vivo 2026-09-06, for `kind: "sticky"`
         * regardless of autonomous mode: same risk class as
         * `write_sticky` (already gate-free), reversible, no disk/process
         * side effect, unlike every other `spawn_card` kind. `media`
         * stays gated: copying into board-assets is a disk write. */
        autoApprove?: boolean;
        /** Pendentes #188 ("spawn_card por coordenadas") — already
         * validated against `callbacks.listCards()` by the time this
         * fires, so the renderer can trust it names a real live card. */
        anchorCardId?: string;
        side?: "left" | "right" | "top" | "bottom";
        /** `kind: "media"` only — already copied into board-assets. */
        assetPath?: string;
        mediaType?: SpawnMediaType;
        /** Original source path (consent dialog display). */
        path?: string;
      },
    ) => void;
    /**
     * Copy a validated source file into the board's persistent assets
     * folder (`board-assets.ts`). Optional so unit doubles stay source-
     * compatible; required at runtime for `kind: "media"`.
     */
    prepareMediaAsset?: (
      boardId: string,
      sourcePath: string,
    ) => { ok: true; path: string } | { ok: false; error: string };
    /**
     * Build identity of THIS Electron process (see build-identity.ts).
     * Optional so existing test doubles stay source-compatible; when
     * absent, `build_identity` / `hello` omit the fields.
     */
    getBuildIdentity?: () => {
      mode: "dev" | "packaged";
      version: string;
      commit: string | null;
      builtAt: string | null;
      dirty: boolean;
      busProtocol: number;
      label: string;
    };
  },
) {
  // Bug real relatado (Pop!_OS, 2026-09-09; achado seguinte do coordenador,
  // mesmo dia) — este bloco fazia `unlinkSync(sockPath)` INCONDICIONAL
  // aqui na entrada, antes de sequer tentar bindar. Com o lock de instância
  // única em index.ts gated em `app.isPackaged` (proteger só o app
  // instalado sem quebrar o fluxo de dev — ver o comentário lá), o cenário
  // real é: o Stellar EMPACOTADO está aberto e escutando; o dev roda
  // `electron-vite dev`, que não pega lock nenhum; o dev chega aqui e
  // apaga o `.sock` da instância empacotada VIVA só porque o arquivo
  // existia, binda o seu; quando o dev fecha, `close()` vê (corretamente)
  // que o socket é dele e remove — sobra a instância empacotada viva e
  // ZERO `.sock` no filesystem. É o bug original inteiro, reproduzido pelo
  // próprio fluxo de dev que o gate `isPackaged` foi feito pra proteger.
  //
  // A remoção agora só acontece DEPOIS de provar que não tem ninguém do
  // outro lado — dentro do `server.on("error")` abaixo. `server.listen`
  // roda direto aqui, sem tocar no filesystem antes.
  //
  // Achado ao vivo (2026-09-01, relato de um agente): `open_url` devolvia
  // só `{ok:true}` e nunca o id do card que acabou de abrir, então não
  // havia caminho nenhum do `open_url` pro `browser_click`/`get_page_text`
  // daquele mesmo card — o agente acabou sondando ids numéricos em
  // sequência (121 a 155) até achar. O renderer SEMPRE soube o id
  // (`openBrowserFor` já o retornava, e o `spawn_card` de navegador já o
  // reportava); ele só era descartado no caminho de volta do `open`. O
  // `cardId` aqui é o que fecha essa lacuna.
  const pendingOpens = new Map<string, { resolve: (allowed: boolean, cardId?: string) => void; timer: NodeJS.Timeout }>();
  const pendingCloseCards = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();
  const pendingSnapshots = new Map<string, { resolve: (result: SnapshotResult) => void; timer: NodeJS.Timeout }>();
  const pendingPageTexts = new Map<string, { resolve: (result: PageTextResult) => void; timer: NodeJS.Timeout }>();
  const pendingReadCards = new Map<string, { resolve: (result: ReadCardResult) => void; timer: NodeJS.Timeout }>();
  const pendingStickyOps = new Map<string, { resolve: (result: StickyResult) => void; timer: NodeJS.Timeout }>();
  // DESIGN-BACKLOG.md item 58, M4 — waiters for `spawn_agent`'s
  // `wait: true`, keyed by the spawned card's id. Several waiters could in
  // principle exist for the same card (two callers both waiting on it),
  // so each entry is a list, not a single resolver.
  const pendingCardExits = new Map<string, Array<(exitCode: number) => void>>();
  // Pre-release audit S4 — `req.depth` used to be trusted straight from
  // the CLIENT (an MCP/acbridge caller could just re-declare `depth: 0`
  // on every call and the fork-bomb guard below would never fire). The
  // main process already knows each card's real depth — it's the one
  // that set AGENT_CANVAS_SPAWN_DEPTH in that card's own env when IT was
  // spawned (pty-registry.ts) — so this map is the server-side record,
  // keyed by cardId, that the client can no longer talk its way around.
  // A card absent from this map (human-initiated, or the task engine's
  // own internal dispatch — see onTaskDone) is depth 0.
  const cardSpawnDepth = new Map<string, number>();
  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — a
  // dedicated result channel, decoupled from process exit (an agent might
  // report a result and keep running, e.g. an interactive session): the
  // last report a card sent (for a caller polling after the fact) plus
  // waiters for one still pending (same shape as pendingCardExits above).
  /** Parte 2b (achado ao vivo, depois do briefing inicial) — "um card de
   * review que revisou 4 rodadas do mesmo diff devolveu o relatório da 3a
   * rodada instantaneamente na 4a chamada": o protocolo precisa distinguir
   * "relatório novo" de "o mesmo de sempre". `seq` é atribuída AQUI, pelo
   * bus, nunca aceita do chamador — monotônica por processo, seedada do
   * persistido. A tabela `reports` é append-only por `seq` (store.ts);
   * `get_report` sem `afterSeq` devolve o mais recente, com `afterSeq` o
   * próximo — quem lê rodada a rodada não perde conteúdo quando o card
   * reporta de novo.
   *
   * DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" (achado ao
   * vivo, 2026-09-09) — o `Map` que vivia aqui (`cardReports`) e o
   * contador acima eram 100% em memória: um restart do Electron apagava
   * TODOS os relatórios. Persistência via `callbacks.getReport`/
   * `upsertReport`. `reportSeqCounter` continua em memória, SEEDADO do
   * que já está persistido (`nextReportSeqSeed()`). */
  let reportSeqCounter = callbacks.nextReportSeqSeed();
  // `role` — `task_cards.role` do card que reportou, resolvido no
  // `report` (ver `resolveReporterRole`); `null` = desconhecido, nunca
  // um default. Viaja junto com `verdict` pra quem lê (`get_report`).
  type StoredReport = { report: unknown; seq: number; verdict?: string | null; role?: string | null };
  const pendingReportWaiters = new Map<string, Array<{ afterSeq: number; resolve: (stored: StoredReport) => void }>>();
  const pendingSpawnAgents = new Map<string, { resolve: (result: SpawnAgentResult) => void; timer: NodeJS.Timeout }>();
  const pendingSpawnCards = new Map<string, { resolve: (result: SpawnCardResult) => void; timer: NodeJS.Timeout }>();
  // DESIGN-BACKLOG.md item 60, peça 1 — one FIFO queue per autonomous
  // board. `params` is exactly what `onSpawnAgentRequest` needs, captured
  // here so the entry can be dispatched later with no information lost.
  type SpawnQueueEntry = {
    id: string;
    requesterId: string;
    provider: string;
    reason?: string;
    requestedAt: number;
    timer: NodeJS.Timeout;
    resolve: (result: SpawnAgentResult) => void;
    params: {
      provider: string;
      cwd?: string;
      resumeId?: string;
      depth: number;
      reason?: string;
      model?: string;
      effort?: string;
      label?: string;
      brief?: string;
      taskId?: string;
      /** See onSpawnAgentRequest — single source for the spawned arrow pill. */
      connectorLabel?: string | null;
    };
  };
  const spawnQueue = new Map<string, SpawnQueueEntry[]>();
  /** CAMADA 3 — in-flight auto-dispatch without writing `running`. */
  const dispatchingTaskIds = new Set<string>();
  /**
   * retry-sem-freio — clock for the lifetime floor in `markTaskFailed`.
   * PTY deletes its entry BEFORE `onExit` (pty-registry), so
   * `getCardWriteReadiness` is already null when `resolveCardExit` runs;
   * we stamp the implementer link time here instead. Cleared on exit.
   */
  const implementerStartedAt = new Map<string, number>();
  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 2 — a card
  // blocked on a consent modal (open/spawn_agent/spawn_card) looks
  // identical to one still working, from the outside. Ref-counted (not a
  // Set) since the same requester could in principle have more than one
  // consent gate open at once. Cleared on resolve AND on the request's own
  // timeout — never left stuck past whichever comes first.
  const waitingOnConsent = new Map<string, number>();
  /**
   * Once-only POR EPISÓDIO (task a1201078): card id → a âncora do episódio
   * que já foi cutucado. Era um `Set` por VIDA do card, o que combinava com o
   * `hasReport` absoluto de então — e junto com ele produzia a doença que
   * esta task consertou: um card que reportou uma vez nunca mais era
   * observado, mesmo recebendo trabalho novo.
   *
   * Agora a entrada vale para UMA âncora (a de `getLastWorkGrantedAt`, ou o
   * fim de turno declarado): quando o card recebe trabalho novo, a âncora
   * muda e o episódio re-arma sozinho. As duas limpezas que já existiam
   * continuam sendo aposentadoria explícita da entrada (report aceito e
   * `resolveCardExit`), e o sentinela cobre o caso sem âncora nenhuma.
   */
  const NO_EPISODE_ANCHOR = 0;
  const idleWithoutReportNotified = new Map<string, number>();
  /** Every programmatic message to one PTY shares one FIFO. Reports, task
   * notices, and explicit `send_to_card` calls must not overtake each other,
   * and none may be dropped just because another delivery is in flight. */
  const deliveryQueues = new Map<string, Promise<void>>();
  /** Status index over `deliveryQueues` — not a second queue. `send` returns
   * the id immediately; `get_delivery` reads this after the FIFO item settles.
   * `confirm` is the loop's own verdict (see `DeliveryConfirmation`) — the
   * settled `delivery` is derived from it, never a blanket "delivered". */
  type TrackedDelivery = {
    id: string;
    target: string;
    /** Agent `send` only — system pointers omit so cancel-on-death leaves them. */
    requesterId?: string;
    delivery: CardDeliveryState;
    reason?: CardDeliveryHoldReason;
    confirm?: DeliveryConfirmation;
    /** True once this FIFO item entered `deliverCard` (cancel must not touch). */
    started?: boolean;
  };
  const deliveryRecords = new Map<string, TrackedDelivery>();
  /** Sliding-window samples for agent `send` rate ceiling (requester × target). */
  let originDeliveryRateSamples: OriginDeliveryRateSample[] = [];

  /**
   * Mark queued, not-yet-started deliveries from `requesterId` as cancelled.
   * FIFO chain stays intact (next item still runs); cancelled slots no-op.
   * Called from `resolveCardExit` BEFORE exit-pointer enqueue so the pointer
   * (no requesterId) survives. Same helper backs `cancel_deliveries`.
   */
  function applyCancelPendingFromRequester(requesterId: string): string[] {
    const { cancelledIds } = cancelPendingFromRequester({
      records: deliveryRecords.values(),
      requesterId,
    });
    for (const id of cancelledIds) {
      const record = deliveryRecords.get(id);
      if (!record) continue;
      record.delivery = "cancelled";
      delete record.reason;
    }
    return cancelledIds;
  }
  function markWaiting(requesterId: string) {
    if (!requesterId) return;
    waitingOnConsent.set(requesterId, (waitingOnConsent.get(requesterId) ?? 0) + 1);
  }
  function unmarkWaiting(requesterId: string) {
    if (!requesterId) return;
    const n = (waitingOnConsent.get(requesterId) ?? 1) - 1;
    if (n <= 0) waitingOnConsent.delete(requesterId);
    else waitingOnConsent.set(requesterId, n);
  }

  function lastStatusActorFromRow(row: TaskRow): StatusActor | null {
    const transitions = row.transitions;
    if (!transitions?.length) return null;
    for (let i = transitions.length - 1; i >= 0; i--) {
      if (transitions[i]!.kind === "status") return transitions[i]!.actor as StatusActor;
    }
    return null;
  }

  function effectiveTaskStatus(row: TaskRow): string {
    const hasLiveImplementer = !!(row.card_id && callbacks.isCardAlive(row.card_id));
    return deriveTaskStatus(row.status, hasLiveImplementer);
  }

  /**
   * FATOS (não decisão) para `decideCloseCardTaskEffect`: toda task ABERTA
   * a que este card está ligado — pela `task_cards` E por `tasks.card_id`
   * (os dois existem: medido, há task com card_id e sem nenhuma linha em
   * `task_cards`, uma das 7 órfãs). Task já julgada (`done`/`failed`) fica
   * de fora: não há mais nada a proteger.
   */
  function collectCloseCardLinkedTasks(targetCardId: string, requesterId: string): CloseCardLinkedTask[] {
    const taskIds = new Set<string>();
    for (const link of callbacks.listTaskCardsForCard(targetCardId) ?? []) taskIds.add(link.task_id);
    for (const t of callbacks.listTasks()) if (t.card_id === targetCardId) taskIds.add(t.id);

    const linked: CloseCardLinkedTask[] = [];
    for (const taskId of taskIds) {
      const task = callbacks.getTask(taskId);
      if (!task || isJudgmentStatus(task.status)) continue;
      const cards = task.cards ?? callbacks.getTaskCards(taskId) ?? [];
      linked.push({
        taskId,
        targetCardId,
        reviewWanted: isReviewWanted(task.review),
        // `null` num card que É o principal é implementer de fato (é o que
        // `tasks.card_id` significa) — sem isso, um dos 7 órfãos passaria
        // como "papel desconhecido".
        targetRole:
          roleOnTask(cards, targetCardId) ?? (task.card_id === targetCardId ? TASK_CARD_IMPLEMENTER_ROLE : null),
        requesterRoleOnTask: roleOnTask(cards, requesterId),
        otherLiveReviewers: cards.filter(
          (c) =>
            c.role === TASK_CARD_REVIEWER_ROLE && c.card_id !== targetCardId && callbacks.isCardAlive(c.card_id),
        ).length,
        lastReportOk: lastAcceptedReportOk(targetCardId),
        targetVerdicts: (task.verdicts ?? [])
          .filter((v) => v.card_id === targetCardId)
          .map((v) => ({ role: v.role, verdict: v.verdict })),
      });
    }
    return linked;
  }

  /** O último report ACEITO do card declara sucesso? `undefined` quando
   * nunca reportou ou o payload não é objeto — nunca "true por ausência". */
  function lastAcceptedReportOk(cardId: string): boolean {
    const row = callbacks.getReport(cardId);
    if (!row) return false;
    try {
      // Lido pelo MESMO decodificador da entrada (task 10cf58d0): uma linha
      // legada gravada como string-de-JSON passa a valer o objeto que sempre
      // foi — não é reinterpretar, é desfazer o duplo-encode na leitura.
      const parsed: unknown = decodeReportArgument(JSON.parse(row.report_json));
      return (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { ok?: unknown }).ok === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Conclui a task como PARTE do fechamento do card — a operação única
   * pedida ("fechar card + fechar task"). A escrita é a mesma que
   * `update_task status=done` faria e passa pelo MESMO funil
   * (`callbacks.upsertTask` é o `persistTask` de task-write-funnel.ts), então
   * dependentes desbloqueiam pelo caminho de sempre e a precedência humana
   * continua sendo decidida no store. Um store que RETÉM a escrita (humano
   * mexeu por último) devolve `warning`: o card fecha, a task fica aberta, e
   * o motivo volta tipado em vez de virar silêncio — o mesmo contrato que
   * `update_task` já usa.
   */
  function concludeTaskOnCardClose(taskId: string, requesterId: string): { ok: boolean; warning?: string } {
    const task = callbacks.getTask(taskId);
    if (!task) return { ok: false };
    const boardId = task.board_id ?? callbacks.getCardBoardId(requesterId);
    const orchestratorId = boardId ? callbacks.getBoardOrchestratorCardId(boardId) : null;
    const decision = callbacks.upsertTask({
      ...task,
      status: "done",
      updated_at: Date.now(),
      actor: orchestratorId && orchestratorId === requesterId ? "orchestrator" : "agent",
      actorCardId: requesterId || null,
      statusProposed: true,
    });
    if (decision.warnAgent) {
      return { ok: false, warning: describeStatusHeldWarning(decision.status, decision.declaredStatus ?? "done") };
    }
    return { ok: decision.status === "done" };
  }

  function linkImplementerToTask(
    task: TaskRow,
    cardId: string,
    actor: StatusActor,
    profile?: {
      provider?: string | null;
      model?: string | null;
      effort?: string | null;
      requestedResumeId?: string | null;
      sessionId?: string | null;
    },
  ) {
    const latest = callbacks.getTask(task.id) ?? task;
    const newStoredStatus = storedStatusAfterImplementerLink(latest.status);
    const reopeningFailed = latest.status === "failed";
    callbacks.linkTaskCard(task.id, cardId, TASK_CARD_IMPLEMENTER_ROLE, profile);
    // Lifetime floor for exit_without_report (exit-lifetime-decision.ts).
    implementerStartedAt.set(cardId, Date.now());
    callbacks.upsertTask({
      ...latest,
      card_id: cardId,
      status: newStoredStatus,
      updated_at: Date.now(),
      actor,
      statusProposed: true,
      applyStatusDespiteHold: reopeningFailed,
    });
  }

  /**
   * Gate runner (2026-09-19) — o APP roda os gates declarados da task e
   * carimba a evidência MEDIDA (stdout/stderr/exit-code reais) em
   * `result_json.gateRun`. O número deixa de vir do agente: um
   * implementador reportou "373 passed, 1 failed" e o revisor reproduziu
   * 371 com 2-3 falhas — divergência invisível atrás de uma flake.
   *
   * Disparo fire-and-forget a partir do `report` ACEITO: o relatório
   * responde agora; a suíte roda em subprocesso isolado, serializada pelo
   * lock por repositório (`gate-runner.ts`), e a evidência aparece no
   * próximo `get_task`/`list_tasks` (view `full`), não no retorno imediato.
   *
   * Um gate que FALHA não muda status nem veredito — o app registra o que
   * mediu e a decisão continua humana/revisora (auto-`done` é decidido
   * contra, DESIGN-BACKLOG). Sem `cwd` ou sem gates declarados: nada roda,
   * nada é inventado. Se a task sumir antes do fim, a evidência é
   * descartada com ela — não há onde carimbar.
   */
  function startTaskGates(task: TaskRow | undefined): void {
    if (!task) return;
    const gates = contractFromTaskRow(task).gates;
    if (!gates || gates.length === 0) return;
    if (!task.cwd) return;
    void runTaskGates({
      taskId: task.id,
      cwd: task.cwd,
      gates,
      // O território vai só para ROTULAR o diff capturado (dentro/fora) —
      // nunca para filtrar. Medido: 75,5% dos arquivos que os agentes
      // declaram caem fora do território, e o desvio é o que mais interessa
      // ver no diff (task 7096e8af).
      territory: contractFromTaskRow(task).territory,
    })
      .then((evidence) => {
        const latest = callbacks.getTask(task.id);
        if (!latest) return;
        callbacks.upsertTask({
          ...latest,
          result_json: stampGateEvidenceJson(latest.result_json, evidence),
          updated_at: Date.now(),
          actor: "app",
          statusProposed: false,
        });
      })
      .catch(() => {
        // Nem chegou a executar (erro de resolução/spawn fora do
        // subprocesso): isso não é evidência de gate nenhum. Não carimba.
      });
  }

  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — the
  // stored row keeps deps/result as opaque JSON text (same convention as
  // cards.messages_json); this is the one place that turns it back into
  // real values for a caller. CAMADA 3 — `status`/`diverged*` derived
  // from `tasks.card_id` + isCardAlive on read.
  function serializeTask(row: TaskRow, lastStatusActor?: StatusActor | null) {
    const storedStatus = row.status;
    const effectiveStatus = effectiveTaskStatus(row);
    const lastActor = lastStatusActor ?? lastStatusActorFromRow(row);
    const { divergedStatus, divergedActor } = deriveParticipationDivergence({
      storedStatus,
      effectiveStatus,
      lastStatusActor: lastActor,
      existingDivergedStatus: row.diverged_status,
      existingDivergedActor: row.diverged_actor as StatusActor | null,
    });
    const contract = contractFromTaskRow(row);
    return {
      id: row.id,
      prompt: row.prompt,
      provider: row.provider,
      status: effectiveStatus,
      cardId: row.card_id,
      boardId: row.board_id,
      cwd: row.cwd,
      // What the task IS (`create_task.purpose`, write-once). `null` is
      // the normal "not declared" — a reader must not infer one.
      purpose: normalizeTaskPurpose(row.purpose),
      // Layer-1 review requirement. `null` = never declared.
      review: normalizeTaskReview(row.review),
      // Contract — structured judgment on the task (brief + reportSchema).
      territory: contract.territory,
      gates: contract.gates,
      allowCommit: contract.allowCommit,
      reportSchema: contract.reportSchema,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      deps: row.deps_json ? JSON.parse(row.deps_json) : [],
      retryCount: row.retry_count,
      attemptedProviders: row.attempted_providers_json ? JSON.parse(row.attempted_providers_json) : [],
      // DESIGN-BACKLOG.md item 60, peça 4 — EFFECTIVE value, same
      // "never null, resolve the fallback here" convention as
      // board_mode's concurrencyCap.
      maxRetries: row.max_retries ?? DEFAULT_MAX_RETRIES,
      fallbackProviders: row.fallback_providers_json ? JSON.parse(row.fallback_providers_json) : [],
      order: row.order,
      suggestedOrder: row.suggested_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal vivo (não histórico).
      // Presente em list/get pra o agente ver a mesma divergência que o
      // quadro Fila mostra (derived on read for participation holds).
      divergedStatus,
      divergedActor,
      requestedStatus: row.requested_status ?? null,
      requestedReason: row.requested_reason ?? null,
      requestedBy: row.requested_by ?? null,
      requestedAt: row.requested_at ?? null,
      // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — membership vivo.
      sprintId: row.sprint_id ?? null,
      // DESIGN-BACKLOG.md §2.1 "no get_task, por exemplo" — só presentes
      // quando `row` veio de `callbacks.getTask` (que os anexa); ausentes
      // (undefined, somem do JSON) numa linha de `listTasks`, de
      // propósito, pra manter a listagem em massa barata.
      transitions: row.transitions?.map((t) => ({
        kind: t.kind,
        from: t.from_value,
        to: t.to_value,
        actor: t.actor,
        cardId: t.card_id,
        at: t.at,
      })),
      cards: row.cards?.map((c) => ({
        cardId: c.card_id,
        role: c.role,
        // Participation profile — fact recorded at spawn/link.
        provider: c.provider ?? null,
        model: c.model ?? null,
        effort: c.effort ?? null,
        // Session identity — same Camada 2 fact; survives card close.
        // Prefer sessionId for spawn_agent({ resumeId }); fall back to
        // requestedResumeId when discovery never fired (see
        // resumeTargetFromParticipation). list_tasks deliberately omits
        // cards[] entirely — do not add these there (payload size).
        requestedResumeId: c.requested_resume_id ?? null,
        sessionId: c.session_id ?? null,
      })),
      // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação"
      // — mesma condição de presença que `transitions`/`cards` acima:
      // só existe quando `row` veio de `getTask`, e é SÓ LEITURA por
      // aqui (nenhum cmd deste arquivo escreve verdict/rodada a partir
      // do que um chamador manda de volta — a escrita mora só em
      // `recordParticipationRound`, chamada pelos dois choke points).
      verdicts: row.verdicts?.map((v) => ({ cardId: v.card_id, role: v.role, verdict: v.verdict, at: v.at })),
    };
  }

  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** DESIGN-BACKLOG.md item 58, M1 — factored out of the `read_card` cmd
   * handler so `send`'s self-verifying submit (below) can reuse the exact
   * same round-trip instead of a second, divergent implementation. */
  function readCardText(target: string, lines?: number): Promise<ReadCardResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingReadCards.delete(requestId);
        callbacks.onReadCardTimeout(requestId);
        resolve({ ok: false, error: "timed out reading card" });
      }, READ_CARD_TIMEOUT_MS);
      pendingReadCards.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingReadCards.delete(requestId);
          resolve(result);
        },
        timer,
      });
      callbacks.onReadCardRequest(requestId, target, lines);
    });
  }

  /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
   * caixa sem submeter" — portão de prontidão antes de digitar QUALQUER
   * coisa. Poll síncrono e barato (`callbacks.getCardWriteReadiness`, sem
   * round-trip pro renderer) em volta da decisão pura
   * `decideWriteReadiness` (type-and-submit-decision.ts) — ver o doc
   * comment daquele arquivo pra por que os dois achados (portão +
   * confirmação tri-state, em `deliverCard` abaixo) precisam andar
   * juntos. Card sem entry (já morto, ou nunca existiu) devolve
   * imediatamente: nada a esperar, `writeToCard`/o resto do fluxo já
   * lidam com card morto do jeito de sempre. */
  async function waitForWriteReadiness(target: string): Promise<void> {
    for (;;) {
      const snapshot = callbacks.getCardWriteReadiness(target);
      if (!snapshot) return;
      const now = Date.now();
      const decision = decideWriteReadiness({
        hasReceivedData: snapshot.hasReceivedData,
        msSinceLastActivity: now - snapshot.lastActivityAtMs,
        msSinceSpawn: now - snapshot.spawnedAtMs,
      });
      if (decision.action === "proceed") return;
      await delay(WRITE_READY_POLL_MS);
    }
  }

  /** A live PTY can be ready while its human is midway through a line. The
   * registry exposes that cheap signal without exposing terminal contents;
   * wait until the line is submitted or idle since the last human keystroke
   * exceeds the bounded expiry. The latter deliberately lets the queued
   * notice through so delivery is never lost, while the registry keeps the
   * human bytes intact. */
  async function waitForHumanInputGate(target: string): Promise<void> {
    for (;;) {
      const snapshot = callbacks.getCardWriteReadiness(target);
      if (!snapshot) return;
      const decision = decideDeliveryGate({
        hasPendingHumanInput: snapshot.hasPendingHumanInput === true,
        pendingHumanInputLastAtMs: snapshot.inputLineLastAtMs ?? null,
        nowMs: Date.now(),
      });
      if (decision.action === "proceed") return;
      await delay(WRITE_READY_POLL_MS);
    }
  }

  /** Extraído do cmd `send` (correção pós-revisão, 2026-09-09) — ANTES
   * disto um caller escrevia via `writeToCard` e parava aí, sem apertar
   * Enter, achando (errado — apontado em revisão) que não submeter era
   * mais seguro. É o oposto: `writeToCard` termina em `entry.proc.write(data)`
   * no PTY (pty-registry.ts) — é digitação simulada, não uma mensagem de
   * canal programático. Texto NÃO submetido fica pendurado no buffer de
   * input de quem estiver do outro lado e é concatenado (ou pior,
   * executado) junto da PRÓXIMA coisa que esse card digitar — exatamente
   * o dano que se queria evitar. `send_to_card` já resolve isso
   * corretamente pra mensagem agente-pra-agente: escreve o texto, aperta
   * Enter, e CONFIRMA que submeteu de verdade (relendo o card e
   * comparando com um prefixo do que foi escrito), retentando só o Enter
   * (nunca o texto de novo) até `SEND_ENTER_MAX_ATTEMPTS`. Extraído aqui
   * pra todo caller que ainda digita (`send`, ponteiro de report /
   * saída-sem-report / status-ask Allow/Deny via `enqueueCardDelivery`)
   * usar o MESMO mecanismo — nunca uma segunda variante que "quase" faz
   * a mesma coisa. Idle NÃO passa por aqui (nem popup de SO): o
   * orquestrador polla `card_status`. O corpo do relatório também não —
   * só o ponteiro curto. Drag humano na Fila também não: gravar status é
   * suficiente; a Fila mostra a marca.
   *
   * DESIGN-BACKLOG.md §0 (2026-09-11, relatado 2x com `codex`) — 2 achados
   * que se somavam: (1) nada aqui esperava a TUI do CLI terminar de subir
   * antes de digitar (corrigido acima, `waitForWriteReadiness`); (2) a
   * confirmação (antiga `looksUnsent`, booleana) tratava "prefixo ausente
   * da tela" como "enviado", sem distinguir de "tela ainda não desenhou
   * nada" — durante o boot lento do `codex` isso derrubava o laço inteiro
   * na 1ª tentativa, exatamente no caso que mais precisava das outras 3.
   * `decideSubmitCheck` (type-and-submit-decision.ts) resolve isso com um
   * terceiro estado ("unknown"), gated por `hasNewActivitySinceWrite` —
   * `activityAtWrite` abaixo é o baseline ANTES da escrita (sinal de
   * silêncio de boot apenas). Eco vs resposta real NÃO usam esse
   * timestamp: a distinção é por conteúdo (`looksLikeSubmitStarted`).
   * Entrega que desiste limpa o composer (`composerClearSequence`).
   *
   * Devolve a `DeliveryConfirmation` (2026-09-13) em vez de `void`: o
   * veredito do laço era descartado aqui e `get_delivery` dizia
   * "delivered" pra tudo — inclusive pra entrega que desistiu, limpou o
   * composer e perdeu o texto. Quem chama `send_to_card` é o único que
   * pode reenviar, e era exatamente quem não ficava sabendo. */
  async function deliverCard(
    target: string,
    text: string,
    opts: { steer?: boolean } = {},
  ): Promise<DeliveryConfirmation> {
    const confirm: DeliveryConfirmation = { result: "unknown", attempts: 0, enters: 0, composerCleared: false };
    // send_to_card defaults steer on; internal notices pass steer:false.
    const steer = opts.steer === true;
    await waitForWriteReadiness(target);
    await waitForHumanInputGate(target);

    let deliveryStarted = false;
    const hasDeliverySection = Object.prototype.hasOwnProperty.call(callbacks, "beginCardDelivery");
    if (hasDeliverySection && callbacks.beginCardDelivery) {
      while (!deliveryStarted) {
        if (!callbacks.isCardAlive(target)) return { ...confirm, result: "card-gone" };
        const result = callbacks.beginCardDelivery(target);
        // Existing unit-test doubles use a Proxy that returns a no-op
        // function for unknown callbacks. `undefined` therefore means the
        // optional production hook is absent, not "delivery is busy".
        if (typeof result !== "boolean") break;
        deliveryStarted = result;
        if (!deliveryStarted) await delay(WRITE_READY_POLL_MS);
      }
    }

    const writeDelivery = (data: string, kind: DeliveryWriteKind) => {
      if (Object.prototype.hasOwnProperty.call(callbacks, "writeToCardWithOrigin") && callbacks.writeToCardWithOrigin) {
        callbacks.writeToCardWithOrigin(target, data, "delivery");
      }
      else callbacks.writeToCard(target, data);
      // Body only — retry Enter / composer clear share this write path
      // but must not reopen the turn window (1fcd36b). Not
      // `pty-registry.write` (too low: every delivery byte) and not
      // `typeAndSubmit` (too early/late: the FIFO, not the body).
      if (deliveryWriteOpensTurn(kind)) callbacks.notifyCardInput?.(target);
    };

    try {
      // Screen + activity baselines BEFORE the write. Content signals
      // (Working / follow-ups) only count when a match's neighborhood is
      // new vs screenTextBeforeWrite — leftover prose/chrome from the
      // prior turn must not mark a swallowed Enter as "sent", and a
      // sliding 8-line window that swaps one Working for another must
      // not flatten the delta into a false "unsent".
      const activityAtWrite = callbacks.getCardLastActivityAt(target);
      const beforeSnap = await readCardText(target, 8);
      const screenTextBeforeWrite = beforeSnap.ok ? beforeSnap.text : "";
      // Bracketed Paste only when the peer requested DECSET 2004h
      // (tracked on the PTY stream). Blind CSI 200~/201~ poisons CLIs
      // that never asked — they echo the escapes as text. Short notices
      // stay raw regardless (see shouldUseBracketedPaste).
      const readinessForPaste = callbacks.getCardWriteReadiness(target);
      const bracketedPasteMode = readinessForPaste?.bracketedPasteMode === true;
      // Shell submit signal baseline: was readline at a bracketed-paste
      // prompt, and how many `2004l` had the stream carried so far. A
      // later delta means the line was accepted, whatever the screen
      // shows (silent commands). See `readlineAcceptedSince`.
      const pasteStateBefore =
        typeof readinessForPaste?.bracketedPasteOffEvents === "number"
          ? { enabled: bracketedPasteMode, offEvents: readinessForPaste.bracketedPasteOffEvents }
          : null;
      writeDelivery(deliveryTextBytes(text, bracketedPasteMode), "body");
      // Sticky item "send_to_card não confirma envio" (2026-09-03) — a
      // regex de placeholder sozinha só cobre UM sintoma (CLI que colapsa
      // um paste grande num chip "[Pasted text ...]"); uma mensagem curta
      // simplesmente fica CRUA na caixa, nunca colapsa, então checar só o
      // placeholder deixaria passar como "enviado" um caso que não foi.
      // Needle + rule depend on WHO reads the PTY: a TUI composer (agent)
      // or readline (bash). Resolved once, before the loop — the card's
      // provider does not change mid-delivery. Unknown provider → agent
      // rule, the conservative one (never invents a shell).
      const targetCard = callbacks.listCards().find((c) => c.id === target);
      const capacity = targetCard?.provider ? providerCapacity(targetCard.provider) : undefined;
      const targetRole: DeliveryTargetRole = capacity?.role === "shell" ? "shell" : "agent";
      const submitStartedPattern = capacity?.delivery.submitStartedPattern;
      // Derived from capacity — never `if (provider === "cursor")` here.
      const midTurnQueue = capacity?.delivery.midTurnQueue;
      const midTurnParkedPattern = midTurnQueue?.parkedPattern;
      const sentNeedle = deliveryNeedle(text, targetRole);
      // Previous confirm result drives whether the NEXT iteration presses
      // Enter. `null` before attempt 0 → always press once. `"unknown"` /
      // `"parked"` never press in this loop (steer is a separate single key).
      let previousResult: ReturnType<typeof decideSubmitCheck> | null = null;
      for (let attempt = 0; attempt < SEND_ENTER_MAX_ATTEMPTS; attempt++) {
        confirm.attempts = attempt + 1;
        await delay(SEND_ENTER_DELAY_MS);
        if (shouldPressEnterOnAttempt(attempt, previousResult)) {
          writeDelivery("\r", "enter");
          confirm.enters++;
        }
        await delay(SEND_ENTER_CONFIRM_DELAY_MS);
        const check = await readCardText(target, 8);
        // Falha de leitura (timeout, card sumiu) não é evidência de que o
        // submit falhou — para de retentar em vez de adivinhar. Único
        // `break` fora da decisão pura — inalterado, não regride. O que
        // muda é que o caller passa a saber que foi ISSO que encerrou.
        if (!check.ok) {
          confirm.result = "read-failed";
          break;
        }
        const currentActivity = callbacks.getCardLastActivityAt(target);
        const pasteStateNow = callbacks.getCardWriteReadiness(target);
        const readlineAccepted =
          targetRole === "shell" && typeof pasteStateNow?.bracketedPasteOffEvents === "number"
            ? readlineAcceptedSince(pasteStateBefore, { offEvents: pasteStateNow.bracketedPasteOffEvents })
            : null;

        previousResult = decideSubmitCheck({
          screenText: check.text,
          screenTextBeforeWrite,
          sentNeedle,
          // Timestamp ausente tratado como "houve atividade" de propósito —
          // não travar o laço num "unknown" eterno por timestamp ausente.
          hasNewActivitySinceWrite:
            typeof activityAtWrite !== "number" || typeof currentActivity !== "number" || currentActivity > activityAtWrite,
          submitStartedPattern,
          midTurnParkedPattern,
          targetRole,
          readlineAccepted,
        });
        confirm.result = previousResult;
        if (previousResult === "sent" || previousResult === "parked") break;
        // "unsent" → next iteration presses Enter again.
        // "unknown" → next iteration waits/re-reads only (no Enter).
      }

      // Mid-turn steer: at most ONE provider-declared key after park.
      // Not part of the unsent-retry loop (owner 2026-09-11: 5× → exit 143).
      if (
        previousResult === "parked" &&
        shouldSteerAfterPark({ result: previousResult, steer, steerKey: midTurnQueue?.steerKey })
      ) {
        const steerKey = midTurnQueue!.steerKey;
        writeDelivery(steerKey, "enter");
        confirm.enters++;
        confirm.steered = true;
        await delay(SEND_ENTER_CONFIRM_DELAY_MS);
        const afterSteer = await readCardText(target, 8);
        if (afterSteer.ok) {
          previousResult = decideSteerCheck({
            screenTextAfterSteer: afterSteer.text,
            parkedPattern: midTurnParkedPattern!,
            sentNeedle,
          });
          confirm.result = previousResult;
        }
      }

      // Achado 4 — delivery that gave up must not leave text in the
      // composer for the next delivery to concatenate with. Ctrl+U×2.
      // Do NOT clear on `"parked"`: text is already out of the composer
      // and into the provider queue; Ctrl+U cannot dequeue it and would
      // only risk collateral. `"sent"` keeps the composer intact.
      if (previousResult !== "sent" && previousResult !== "parked") {
        writeDelivery(composerClearSequence(), "composer_clear");
        confirm.composerCleared = true;
        // §0: "falha silenciosa foi o que fez isso passar despercebido".
        // The verdict also travels back through `get_delivery`; this line
        // is for the human reading the main-process log.
        console.warn(
          `[message-bus] delivery to card ${target} not confirmed (${confirm.result}) after ${confirm.attempts} attempt(s), ${confirm.enters} Enter(s); composer cleared`,
        );
      }
    } catch (err) {
      confirm.result = "error";
      console.warn(`[message-bus] delivery to card ${target} threw:`, err);
    } finally {
      if (deliveryStarted) {
        const ended = callbacks.endCardDelivery?.(target);
        // Deferred human keys are still human. The previous turn may
        // already have closed; without this notice the flush lands as
        // bare PTY bytes, echo arrives as `"data"`, and the bar stays
        // off while the shell works. Body notify already fired above —
        // this is a different turn, the one the human typed.
        if (ended && typeof ended === "object" && ended.flushedHumanInput) {
          callbacks.notifyCardInput?.(target);
        }
      }
    }
    return confirm;
  }

  /** Peek why THIS enqueue would sit at human/TUI rhythm. Does not wait.
   * `queueAhead` is another FIFO item already chained for this card. */
  function peekDeliveryHold(target: string, queueAhead: boolean): CardDeliveryHoldReason | undefined {
    const snapshot = callbacks.getCardWriteReadiness(target);
    if (!snapshot) {
      return inspectDeliveryHold({
        writeReadiness: { action: "proceed", reason: "timeout" },
        deliveryGate: { action: "proceed", reason: "empty" },
        queueAhead,
      });
    }
    const now = Date.now();
    return inspectDeliveryHold({
      writeReadiness: decideWriteReadiness({
        hasReceivedData: snapshot.hasReceivedData,
        msSinceLastActivity: now - snapshot.lastActivityAtMs,
        msSinceSpawn: now - snapshot.spawnedAtMs,
      }),
      deliveryGate: decideDeliveryGate({
        hasPendingHumanInput: snapshot.hasPendingHumanInput === true,
        pendingHumanInputLastAtMs: snapshot.inputLineLastAtMs ?? null,
        nowMs: now,
      }),
      queueAhead,
    });
  }

  /**
   * Unified form for any tool whose job is to accept a PTY message, not
   * to sit in the human-input / write-readiness gates. Chains onto the
   * existing per-card FIFO (`deliveryQueues`) and returns immediately.
   * Callers that still want to wait (internal, not a tool RPC) can
   * `await` the returned `done` promise.
   *
   * `steer` (default false here): when the provider parks mid-turn, press
   * its declared steer key once. `send_to_card` and status-ask Allow/Deny
   * pass true (answer / correction the peer asked for). Report pointer and
   * unreported-exit keep false so a system ping does not inject into a
   * live turn.
   *
   * `requesterId` (optional): agent `send` stamps the author so close/exit
   * can cancel not-yet-started items. System enqueues omit it — a final
   * report/exit pointer must still deliver after the author process dies.
   */
  function enqueueCardDelivery(
    target: string,
    text: string,
    opts: { steer?: boolean; requesterId?: string } = {},
  ): { receipt: CardDeliveryReceipt; done: Promise<void> } | { ok: false; error: string } {
    const requesterId = opts.requesterId;
    if (requesterId) {
      const nowMs = Date.now();
      originDeliveryRateSamples = pruneOriginDeliveryRateSamples(originDeliveryRateSamples, nowMs);
      const rate = decideOriginDeliveryRate({
        samples: originDeliveryRateSamples,
        requesterId,
        target,
        nowMs,
      });
      if (rate.action === "refuse") return { ok: false, error: rate.error };
      originDeliveryRateSamples.push({ requesterId, target, atMs: nowMs });
    }

    const id = randomUUID();
    const queueAhead = deliveryQueues.has(target);
    const reason = peekDeliveryHold(target, queueAhead);
    const record: TrackedDelivery = {
      id,
      target,
      delivery: "queued",
      ...(requesterId ? { requesterId } : {}),
      ...(reason ? { reason } : {}),
    };
    deliveryRecords.set(id, record);

    const previous = deliveryQueues.get(target) ?? Promise.resolve();
    // Settled state comes from the loop's verdict. `deliverCard` already
    // converts its own throws into `result: "error"`; the rejection arm
    // here only guards the FIFO itself from ever wedging on a surprise.
    // Cancel-before-write: if the author died while this item waited, skip
    // `deliverCard` entirely — FIFO still advances for everyone else.
    const done: Promise<void> = previous
      .catch(() => undefined)
      .then(() => {
        if (record.delivery === "cancelled") return undefined;
        record.started = true;
        return deliverCard(target, text, { steer: opts.steer === true });
      })
      .then(
        (confirm) => {
          if (record.delivery === "cancelled" || confirm === undefined) return;
          record.confirm = confirm;
          record.delivery = decideDeliveryOutcome(confirm.result);
        },
        () => {
          if (record.delivery === "cancelled") return;
          record.confirm = { result: "error", attempts: 0, enters: 0, composerCleared: false };
          record.delivery = "unconfirmed";
        },
      )
      .finally(() => {
        delete record.reason;
        if (deliveryQueues.get(target) === done) deliveryQueues.delete(target);
      });
    deliveryQueues.set(target, done);

    return {
      receipt: { ok: true, delivery: "queued", ...(reason ? { reason } : {}), id },
      done,
    };
  }

  /** Round-trip de sticky — mesmo timeout e mesma forma do `readCardText`
   * acima, um helper só pras duas operações porque só o `op` muda. */
  function stickyOp(target: string, op: StickyOp): Promise<StickyResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingStickyOps.delete(requestId);
        callbacks.onStickyTimeout(requestId);
        resolve({ ok: false, error: `timed out on sticky ${op.op}` });
      }, READ_CARD_TIMEOUT_MS);
      pendingStickyOps.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingStickyOps.delete(requestId);
          resolve(result);
        },
        timer,
      });
      callbacks.onStickyRequest(requestId, target, op);
    });
  }

  /**
   * Inline `content` stays the default. `path` is the alternative that
   * keeps a large roster/PII block out of the tool-call itself: main
   * reads the file the agent already had on disk. Same access policy as
   * FilesCard and chat `read_file` — `readFileAllowingAbsolute` →
   * `asRootRelativePath` + `confine` + `MAX_FILE_BYTES`. Root is the
   * caller's card cwd (terminal/chat/files/changes); no cwd means no
   * root, so path form is refused rather than reading an unbounded
   * absolute path.
   */
  async function resolveStickyWriteContent(req: {
    content?: string;
    path?: string;
    requesterId?: string;
  }): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const hasContent = req.content !== undefined;
    const path = typeof req.path === "string" ? req.path.trim() : "";
    const hasPath = path.length > 0;
    if (hasContent && hasPath) return { ok: false, error: "pass content or path, not both" };
    if (hasContent) return { ok: true, content: req.content as string };
    if (!hasPath) return { ok: false, error: "missing content or path" };
    const root = (req.requesterId && callbacks.listCards().find((c) => c.id === req.requesterId)?.cwd?.trim()) || "";
    if (!root) {
      return {
        ok: false,
        error:
          "path form requires a caller card with a project root (cwd); pass content inline instead, or call from a terminal/chat/files/changes card",
      };
    }
    try {
      const res = await readFileAllowingAbsolute(root, path);
      if ("tooLarge" in res) {
        return { ok: false, error: `file larger than ${MAX_FILE_BYTES / 1024}KB, not read` };
      }
      return { ok: true, content: res.content };
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { ok: false, error: `path escapes the caller's project root: ${path}` };
      }
      return { ok: false, error: `could not read path: ${String(err)}` };
    }
  }

  /** Só os cards que têm um PTY vivo por trás — o subconjunto que
   * `writeToCard`/`readCardText`/`isCardAlive` sabem operar. `listCards()`
   * passou a devolver TODOS os cards (ver `CardSummary`), então cada
   * validação que realmente exige um terminal filtra aqui em vez de
   * confiar no filtro que antes acontecia no `index.ts`. */
  function listTerminalCards(): CardSummary[] {
    return callbacks.listCards().filter((c) => c.kind === "terminal");
  }

  /** Who spawned `cardId` (`kind === "spawned"`, most recent by
   * `updated_at`) — only if that spawner is still alive. `null` is the
   * quiet no-op for both "opened by a human" and "spawner already gone". */
  function resolveLiveSpawner(cardId: string): string | null {
    const spawnedBy = callbacks
      .listAllConnectors()
      .filter((c) => c.kind === "spawned" && c.to_card_id === cardId)
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (!spawnedBy) return null;
    const spawnerId = spawnedBy.from_card_id;
    if (!callbacks.isCardAlive(spawnerId)) return null;
    return spawnerId;
  }

  /** Feeds `decideReportNotifyTarget` (report-notify-routing.ts) — board
   * orchestrator mark wins when alive; dead mark escalates to human
   * (`none`); unmarked keeps live `spawned` / inbound `modified`. This
   * is the production caller that module exists for; do not leave the
   * pure function without a feeder again. */
  function resolveNotifyTarget(cardId: string): string | null {
    const boardId = callbacks.getCardBoardId(cardId);
    const orchId = boardId ? (callbacks.getBoardOrchestratorCardId(boardId) ?? null) : null;
    const connectors = callbacks.listAllConnectors();
    const spawnedById = resolveLiveSpawner(cardId);
    const directiveFromId = pickLatestDirectiveSender(connectors, cardId);
    return decideReportNotifyTarget({
      orchestratorCardId: orchId,
      orchestratorAlive: orchId !== null && callbacks.isCardAlive(orchId),
      directiveFromId,
      directiveFromAlive: directiveFromId !== null && callbacks.isCardAlive(directiveFromId),
      spawnedById,
      spawnedByAlive: spawnedById !== null,
    }).targetId;
  }

  /**
   * AGENT half of "a report arrived" — short pointer typed into the
   * orchestrator's PTY via `enqueueCardDelivery` (FIFO + human-input
   * gate + receipt). OS popup stays gone (owner ask, 6239269).
   *
   * Always fires, including when a `read_report {wait:true}` waiter just
   * got the JSON: the waiter is the agent RPC; the human watching the
   * orchestrator card is not that waiter. Skipping the pointer left the
   * screen silent (measured 2026-09-13: seq 221+ after the dual-channel
   * removal). `wait:true` is also a known MCP-host trap (~2 min abort vs
   * 10 min tool), so the pointer is not redundant in practice.
   *
   * Does NOT `await` delivery — `report` must return as soon as the row
   * is persisted (f073f59 / message-bus-report-does-not-await-pty). The
   * enqueue form from 5206f7e is what makes that safe again: the old
   * `await typeAndSubmit` blocked the tool and corrupted turns.
   */
  function notifySpawnerOfReport(cardId: string): void {
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) {
      console.warn(
        `[report] ${callbacks.describeCardLabel(cardId)} produziu um relatório mas não há card vivo pra empurrar (sem diretiva recente nem spawner vivo) — use read_report pra consultar manualmente.`,
      );
      return;
    }
    if (!listTerminalCards().some((c) => c.id === spawnerId)) return;
    const label = callbacks.describeCardLabel(cardId);
    // Authorship form lives in agent-facing-authorship.ts — same helper as `send`.
    enqueueCardDelivery(spawnerId, formatAgentFacingAuthorship(label, REPORT_AVAILABLE_POINTER_BODY));
  }

  /**
   * AGENT half of "exit without report" (DESIGN-BACKLOG.md §2.1 SINAL 2).
   * Same lineage resolver and same `enqueueCardDelivery` path as report —
   * no OS popup. Queued (not fire-and-forget `await` on a sync exit
   * hook): the receipt/FIFO from 5206f7e is what retires the old
   * corruption objection against `notifySpawnerOfUnreportedExit`.
   */
  function notifySpawnerOfUnreportedExit(cardId: string, exitCode: number): void {
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) return;
    if (!listTerminalCards().some((c) => c.id === spawnerId)) return;
    const label = callbacks.describeCardLabel(cardId);
    // Authorship form lives in agent-facing-authorship.ts — same helper as `send`.
    enqueueCardDelivery(spawnerId, formatAgentFacingAuthorship(label, unreportedExitPointerBody(exitCode)));
  }

  /**
   * AGENT half of SINAL 3 (idle without report). Same lineage resolver and
   * `enqueueCardDelivery` path as report / exit — no OS popup, no poke of
   * the idle card itself (that would inject into a possibly-thinking turn).
   * Caller stamps `idleWithoutReportNotified` so this fires once per episode.
   */
  function notifySpawnerOfUnreportedIdle(cardId: string): void {
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) return;
    if (!listTerminalCards().some((c) => c.id === spawnerId)) return;
    const label = callbacks.describeCardLabel(cardId);
    enqueueCardDelivery(spawnerId, formatAgentFacingAuthorship(label, unreportedIdlePointerBody()));
  }

  /**
   * Scan alive terminals for SINAL 3. Pure gate in
   * idle-without-report-decision.ts; this only feeds facts and fires the
   * pointer. Exported as a test seam (same pattern as resolveCardExit).
   */
  function scanIdleWithoutReport(): void {
    // PERF (task 9dd877c8) — este scan roda a cada 5s para sempre, e usava
    // `callbacks.listTasks()` (31 colunas, `prompt`+`result_json` inclusos)
    // para ler dois campos. Agora lê `id`/`card_id`/`status`. O
    // `Array.isArray` continua: duble de teste que não implemente o callback
    // devolve `undefined`, e uma lista vazia é o resultado seguro (nada
    // notifica), não um crash.
    const listed = callbacks.listTasksForIdleScan();
    const tasks = Array.isArray(listed) ? listed : [];
    for (const card of listTerminalCards()) {
      const cardId = card.id;
      const linkedTask = tasks.find((t) => t.card_id === cardId);
      const lastActivityAt = callbacks.getCardLastActivityAt(cardId);
      const turnEndedAt = callbacks.getCardTurnEndedAt(cardId);
      // A ÂNCORA DO EPISÓDIO (task a1201078): desde quando este card deve um
      // report. Muda a cada trabalho concedido — e é isso que faz a SEGUNDA
      // falha do mesmo card ser visível, o que o `Set` por id (por vida) não
      // fazia. Sem âncora de trabalho, o turno declarado serve; sem nenhum dos
      // dois, o sentinela (uma vez até report/exit limparem, nunca um cutucão
      // por poll).
      const workGrantedAt = callbacks.getCardLastWorkGrantedAt(cardId);
      const episodeAnchor = workGrantedAt ?? turnEndedAt ?? NO_EPISODE_ANCHOR;
      // O report mais recente do card. `updated_at` é o instante em que a
      // linha entrou (`reports` é append-only por `seq`), então a comparação
      // com a âncora responde "houve report NESTE episódio?".
      const lastReportAt = callbacks.getReport(cardId)?.updated_at ?? null;
      const decision = decideIdleWithoutReport({
        alive: callbacks.isCardAlive(cardId),
        waitingOnConsent: waitingOnConsent.has(cardId),
        // Um card VIVO sempre tem a âncora: o fato nasce com o entry, no
        // spawn. O `?? 0` cobre a corrida de um entry que sumiu entre o
        // `listTerminalCards()` e esta leitura — e nesse caso "não dá para
        // datar o trabalho" NÃO pode virar cutucão, então qualquer report já
        // gravado conta como este episódio cumprido.
        reportedSinceWorkGranted: lastReportAt !== null && lastReportAt > (workGrantedAt ?? 0),
        // O `idle` de `card-status-decision.ts`, com os MESMOS fatos: turno
        // DECLARADO encerrado e nenhuma saída depois dele. Fato declarado, não
        // silêncio — por isso o portão não espera o piso quando isto é true.
        declaredIdle: turnEndedAt !== null && (lastActivityAt === null || lastActivityAt <= turnEndedAt),
        hasLinkedRunningTask: !!linkedTask && !isJudgmentStatus(linkedTask.status),
        alreadyNotified: idleWithoutReportNotified.get(cardId) === episodeAnchor,
        msSinceLastActivity: lastActivityAt === null ? null : Date.now() - lastActivityAt,
      });
      if (decision.action !== "notify") continue;
      // Stamp BEFORE enqueue so a slow FIFO cannot double-fire on the next poll.
      idleWithoutReportNotified.set(cardId, episodeAnchor);
      notifySpawnerOfUnreportedIdle(cardId);
    }
  }

  /** Allow/Deny on a `request_task_status` ask — resume of a request the
   * agent made, not an unsolicited drag interrupt. Human drag no longer
   * calls this (Fila mark + `get_task` are enough). Hold of `update_task`
   * also does not: the tool return already carries
   * `warning`/`status`/`divergedStatus`.
   *
   * Delivery: `enqueueCardDelivery` with `steer: true` (0b728f1) — same
   * physics as `send_to_card`. The asker is waiting on this answer; if
   * the provider parked mid-turn, inject once. Report/exit pointers keep
   * steer false; this path does not.
   *
   * Fire-and-forget: status is already persisted in `index.ts` before
   * this runs. No-op when the card is gone, not a terminal, or bash
   * (bash has no agent reading the line — same exclusion as report
   * notify). */
  function notifyHumanMovedTask(cardId: string, message: string): void {
    if (!callbacks.isCardAlive(cardId)) return;
    const card = listTerminalCards().find((c) => c.id === cardId);
    if (!card || card.provider === "bash") return;
    enqueueCardDelivery(cardId, message, { steer: true });
  }

  /**
   * Aviso CURTO ao card que acabou de ser ligado a uma task (task 618d179a,
   * `link_task_card`). Ele NÃO é o enunciado: o enunciado vive no `prompt` da
   * task e o agente o lê com `get_task`. Repetir o texto aqui só mudaria quem
   * duplica. O revisor recebe uma variante — o que ele tem em mãos é algo para
   * REVISAR, não uma ordem de trabalho: é o mesmo motivo que faz
   * `resolveSpawnBrief` não entregar o `prompt` ao reviewer (ver o doc daquele
   * módulo), só que aqui a alternativa não é silêncio, é um ponteiro.
   */
  function linkedCardNoticeBody(taskId: string, role: string): string {
    const alvo = role === TASK_CARD_REVIEWER_ROLE ? "task para você revisar" : "task para você";
    return `${alvo}: ${taskId} (papel: ${role}) — leia o enunciado com get_task.`;
  }

  /**
   * Entrega o aviso pelo MESMO caminho dos outros ponteiros: `enqueueCardDelivery`,
   * o FIFO que `spawn_agent`/report/exit já usam — não uma segunda entrega.
   * `steer: false`: é recado de sistema, não correção — não injeta no meio de um
   * turno em andamento; entra na fila e é digitado quando o card volta a aceitar
   * escrita (o mesmo `steer:false` dos ponteiros de report/saída).
   *
   * Devolve o que aconteceu, porque o chamador precisa poder dizer: falhar em
   * silêncio recriaria o defeito que esta task conserta, e derrubar o LINK por
   * causa do aviso seria pior (o vínculo é o contrato; o aviso é o extra).
   */
  function notifyLinkedCard(cardId: string, taskId: string, role: string, requesterId?: string): string {
    if (!callbacks.isCardAlive(cardId)) {
      return "skipped: card has no live terminal — linked, but nothing to read the notice";
    }
    const card = listTerminalCards().find((c) => c.id === cardId);
    if (!card) return `skipped: card "${cardId}" is not a terminal — a notice has no reader`;
    if (card.provider === "bash") return "skipped: bash has no agent reading the line";
    const label = requesterId ? callbacks.describeCardLabel(requesterId) : null;
    const body = formatAgentFacingAuthorship(label, linkedCardNoticeBody(taskId, role));
    const enqueued = enqueueCardDelivery(cardId, body, { steer: false });
    if (!("receipt" in enqueued)) return `failed: ${enqueued.error}`;
    return "queued";
  }

  /** Achado ao vivo (2026-09-01): "eu renomeio os card dos agentes para
   * Stellar, isso só está visual em vez de funcional". Renomear escrevia
   * `cards.label` e parava aí — todo `target` do bus era comparado só
   * contra `c.id`, então o nome que o humano vê no header não servia pra
   * endereçar nada. Aqui o rótulo vira um alias real de id, resolvido uma
   * única vez na entrada do dispatcher (e não em cada `cmd`), de forma que
   * send, read_card, card_status, snapshot, os browser_ e report ganham
   * o alias todos de uma vez.
   *
   * Ordem deliberada: id exato SEMPRE primeiro. Um rótulo que por acaso
   * seja igual ao id de outro card nunca pode sequestrar aquele id — a
   * comparação por id é a que tem que ser inambígua, o rótulo é livre e
   * digitado por humano. Comparação de rótulo é case-insensitive e sem
   * espaços nas pontas (é um campo de texto livre); dois cards com o
   * mesmo rótulo viram erro explícito em vez de um "escolhi a primeira"
   * silencioso, que seria exatamente o tipo de acerto ao acaso que essa
   * feature não pode ter. */
  function resolveTargetId(raw: string): { id: string } | { error: string } {
    const cards = callbacks.listCards();
    if (cards.some((c) => c.id === raw)) return { id: raw };
    const needle = raw.trim().toLowerCase();
    if (!needle) return { id: raw };
    const byLabel = cards.filter((c) => (c.label ?? "").trim().toLowerCase() === needle);
    if (byLabel.length === 1) return { id: byLabel[0].id };
    if (byLabel.length > 1) {
      return { error: `"${raw}" matches ${byLabel.length} cards (${byLabel.map((c) => c.id).join(", ")}) — use the id instead` };
    }
    // Nem id nem rótulo: devolve cru, pra cada cmd emitir o próprio erro
    // ("no open terminal card with id ...") como sempre fez.
    return { id: raw };
  }

  /** Regra geral de auto-conector (2026-09-02) — "qualquer interação entre
   * cards via MCP conecta os dois, não só sticky": todo cmd que MUTA um
   * card que já existe (identificado por `target`) e carrega `requesterId`
   * entra aqui, mapeado pro `kind` gravado no conector. Um lugar só, não
   * uma chamada repetida em cada handler — cobre o cmd de hoje e qualquer
   * um que um tool novo adicionar amanhã, sem precisar lembrar de tocar
   * aqui toda vez (o jeito antigo, um `if` manual dentro do handler de
   * "send", já tinha ficado pra trás assim que `browser_*` ganhou os
   * mesmos 4 tools). Deliberadamente ausente: leituras (`list`, `read_*`,
   * `browser_query`/`snapshot`/`browser_console`/`browser_network`/
   * `browser_wait_for`, `card_status`, `get_report`, `list_tasks`,
   * `get_task`, `list_connectors`, `concurrency_status`, `board_mode`,
   * `build_identity`) — olhar pra um card não é interagir com ele.
   * Também ausente de propósito:
   * `write_sticky`/`set_sticky_color`/`set_sticky_mode` — essas 3 já
   * chamam `autoConnect` direto no `offSticky` do App.tsx (é lá que
   * `content`/`color`/`mode` realmente vivem, round-trip que já existia
   * por outro motivo); incluí-las aqui também dispararia um 2º push
   * redundante pro mesmo par (inofensivo — dedup do outro lado — mas sem
   * propósito). E `open`/`spawn_agent`/`spawn_card`: essas CRIAM um card
   * novo em vez de mutar um existente, `target` não é o card afetado (é
   * a URL/provider/kind pedido) — já têm seu próprio mecanismo mais
   * antigo (`kind: "spawned"`, App.tsx's spawnAgentFor/openBrowserFor/
   * spawnCardFor callers), não o generalizado aqui. */
  const AUTO_CONNECT_CMDS: Partial<Record<BusRequest["cmd"], string>> = {
    send: "modified",
    browser_click: "modified",
    browser_type: "modified",
    browser_scroll: "modified",
    browser_eval: "modified",
  };

  // Achado 3 (review adversarial, 2026-09-09) — C0/C1 control characters
  // plus the Unicode bidi override/embedding/isolate controls (LRE/RLE/
  // PDF/LRO/RLO and the newer LRI/RLI/FSI/PDI, plus the plain LRM/RLM
  // marks) stripped BEFORE truncation, not after: any of these dropped
  // into an SVG `<text>` (App.tsx's connector pill) can reorder or corrupt
  // the rendered line, and a label reaching this function came from
  // whatever an agent typed — never trusted as plain text before this.
  // Known, deliberately untreated gap (review adversarial rodada 2,
  // 2026-09-09) — combining marks (e.g. Zalgo-style stacks) aren't
  // filtered and can overflow the pill vertically. Low-probability
  // hostile input, and a filter here risks mangling ordinary accented
  // text (café, São Paulo) — left alone on purpose, not missed.
  // eslint-disable-next-line no-control-regex -- deliberate: this IS the sanitizer that strips C0/C1 control characters from an agent-supplied label (achado 3 above).
  const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

  /** Short one-line context for the connector's `label` (store.ts) — the
   * "why" behind an auto-connect, from whatever text was already in scope
   * for that mutation. Truncated here, once, so callers never have to
   * think about length; `null` when the request has no natural short text
   * (e.g. a scroll with no selector).
   * Achado 3 (review adversarial, 2026-09-09) — truncates by Unicode CODE
   * POINT (`Array.from`, which iterates a string per code point, not per
   * UTF-16 code unit), not by `.slice`: a raw `.slice(0, max)` can land
   * inside a surrogate pair and split an emoji/astral character in half,
   * leaving a broken/replacement glyph in the pill. This is the single
   * choke point every label passes through before reaching `store.ts`
   * (`deriveAutoConnectLabel` below, the `write_sticky` modified-label
   * call, and `set_connector_label`'s cmd handler all call this — none
   * truncate on their own), so the fix covers every label an agent can
   * set, not just spawn's.
   * Achado 1 (review adversarial RODADA 2, 2026-09-09) — ORDER bug: `\n`/
   * `\r`/`\t` are C0 controls, so the first version's
   * `.replace(CONTROL_AND_BIDI_RE, "")` deleted them outright, BEFORE
   * `/\s+/g` ever got a chance to collapse them into a separator — a
   * label like "ls -la\n/tmp" came out "ls -la/tmp", words glued
   * together. Fixed by converting real whitespace controls to a plain
   * space FIRST (so they survive as a separator), stripping the rest of
   * the C0/C1/bidi set second, THEN collapsing whitespace runs and
   * truncating — same final steps as before, just no longer racing the
   * control-strip against them. */
  function truncateForLabel(text: string, max = 60): string {
    const withRealWhitespace = text.replace(/[\n\r\t]/g, " ");
    const stripped = withRealWhitespace.replace(CONTROL_AND_BIDI_RE, "");
    const flat = stripped.trim().replace(/\s+/g, " ");
    const codePoints = Array.from(flat);
    return codePoints.length > max ? `${codePoints.slice(0, max - 1).join("")}…` : flat;
  }
  /**
   * purpose → a CHAVE do catálogo (task 5b173f00). O `Record` é tipado pelo
   * union: um sexto purpose NÃO COMPILA aqui — a mesma muralha das outras
   * cópias do vocabulário. E o TEXTO passa a ter uma fonte só: esta função
   * carregava uma cadeia de ternários com os quatro rótulos pt-BR escritos à
   * mão, então (a) `integrate` caía em `null` e a pill do conector ficava
   * SEM rótulo enquanto a Fila mostrava o chip, e (b) em INGLÊS a
   * divergência já existia antes do `integrate`: a Fila dizia
   * "implementation" e a pill dizia "implementação". O comentário acima
   * prometia que a pill e a Fila falam o mesmo vocabulário; agora as duas
   * derivam do mesmo lugar, nas duas locales.
   */
  const PURPOSE_CHIP_KEY: Record<TaskPurpose, MessageKey> = {
    investigate: "task.purpose.investigate",
    implement: "task.purpose.implement",
    measure: "task.purpose.measure",
    fix: "task.purpose.fix",
    integrate: "task.purpose.integrate",
  };

  function deriveAutoConnectLabel(req: BusRequest): string | null {
    switch (req.cmd) {
      case "send":
        return req.text ? truncateForLabel(req.text) : null;
      case "browser_type":
        return req.text ? truncateForLabel(req.text) : req.selector ? truncateForLabel(req.selector) : null;
      case "browser_click":
      case "browser_scroll":
        return req.selector ? truncateForLabel(req.selector) : null;
      case "browser_eval":
        return req.js ? truncateForLabel(req.js) : null;
      // Spawn lineage: the arrow is the RELATION (what role this card
      // plays on the task), not a second copy of the card title. The
      // card name already carries `resolveTaskDispatchLabel` / an
      // explicit `label` (often the prompt's first 48 chars) — repeating
      // that on the pill is visual noise. `purpose` is the Fila chip the
      // owner asked for ("tags that show the task's proposal"); same
      // question applies here. No taskId → null (spawn without a task is
      // first-class; inventing a label would lie). No purpose → null for
      // an implementer (absence is normal, never invent). Reviewer is the
      // relation that was invisible: always name it, and keep purpose
      // when declared. Strings match catalogs.ts's pt-BR purpose/role
      // chips so the pill and the Fila speak the same vocabulary.
      case "spawn_agent": {
        if (!req.taskId) return null;
        const task = callbacks.getTask(req.taskId);
        if (!task) return null;
        const purpose = normalizeTaskPurpose(task.purpose);
        const role =
          req.role === undefined ? TASK_CARD_IMPLEMENTER_ROLE : normalizeTaskCardRole(req.role);
        if (req.role !== undefined && role === null) return null;
        const purposeLabel = purpose ? t(PURPOSE_CHIP_KEY[purpose]) : null;
        if (role === TASK_CARD_REVIEWER_ROLE) {
          // Substantivo próprio da pill (`task.role.reviewerPill`) — NÃO o
          // `task.role.reviewer` ("revisa"), que é verbo flexionado para
          // outra frase: reusar por proximidade semântica é como o texto
          // divergiria na próxima vez.
          const reviewPill = t("task.role.reviewerPill");
          return truncateForLabel(purposeLabel ? `${reviewPill} · ${purposeLabel}` : reviewPill);
        }
        return purposeLabel ? truncateForLabel(purposeLabel) : null;
      }
      default:
        return null;
    }
  }

  /**
   * Ingress stamp — set ONLY by the two real frontends (HTTP MCP wrapper
   * in index.ts, Unix-socket server below). Never read from the request
   * body: an agent declaring its own channel is self-reported noise.
   * Tests pass it explicitly to simulate each porta. Omitted → null on
   * the reports row (unknown ingress), same honesty as role/verdict.
   */
  async function handleRequest(request: BusRequest, opts?: HandleRequestOpts): Promise<BusResponse> {
    let req = request;
    if ("target" in req && typeof req.target === "string") {
      const resolved = resolveTargetId(req.target);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      if (resolved.id !== req.target) req = { ...req, target: resolved.id };
    }
    const res = await dispatchRequest(req, opts?.channel ?? null);
    const kind = AUTO_CONNECT_CMDS[req.cmd];
    if (kind && res.ok && "target" in req && req.target && "requesterId" in req && req.requesterId) {
      // `send` → kind "modified" is the persisted auto-connect edge.
      // No separate in-memory Map: the connector row is the source of truth.
      callbacks.onAutoConnect(req.requesterId, req.target, kind, deriveAutoConnectLabel(req));
    }
    return res;
  }

  async function dispatchRequest(req: BusRequest, ingressChannel: ReportIngressChannel | null): Promise<BusResponse> {
    if (req.cmd === "list") {
      return { ok: true, cards: callbacks.listCards() };
    }

    if (req.cmd === "send") {
      const cards = listTerminalCards();
      if (!req.target || !cards.some((c) => c.id === req.target)) {
        // Distingue "não existe" de "existe mas não é um terminal": o
        // segundo caso (mandar texto pra um sticky/navegador) é um pedido
        // legítimo que este cmd simplesmente não atende, e dizer só "no
        // open terminal card with id X" mandava o agente procurar um id
        // que ele já tinha certo.
        const any = callbacks.listCards().find((c) => c.id === req.target);
        if (any) return { ok: false, error: `card "${req.target}" is a ${any.kind} card — send_to_card only types into terminal cards` };
        return { ok: false, error: `no open terminal card with id "${req.target}"` };
      }
      const target = req.target;
      // DESIGN-BACKLOG.md item 61 — prefix with a human-friendly sender
      // label whenever the caller identifies itself. Optional and
      // additive: a caller that doesn't pass `requesterId` still delivers
      // exactly as before this item, unprefixed. Never for a `bash`
      // target: `send_to_card` doubles as "run this shell command" there
      // (the far more common use, see M2/M4's own examples) — a prefix
      // would be interpreted as the start of the command itself and
      // break it, not read as a header the way it does in a chat/agent
      // CLI's prose input.
      const targetProvider = cards.find((c) => c.id === target)?.provider;
      const senderLabel = req.requesterId && targetProvider !== "bash" ? callbacks.describeCardLabel(req.requesterId) : null;
      // Single authorship form (agent-facing-authorship.ts) — same helper as
      // notifySpawnerOfReport / notifySpawnerOfUnreportedExit. Does not
      // restamp a body that already opens with `[de: …]`.
      const text = formatAgentFacingAuthorship(senderLabel, req.text ?? "");
      // Regra geral de auto-conector (2026-09-02, generalizada a QUALQUER
      // interação entre cards via MCP — ver `AUTO_CONNECT_CMDS` no fim
      // deste arquivo, chamado de dentro do `handleRequest` wrapper) —
      // nada a fazer aqui, o wrapper cuida disso depois que este bloco
      // devolver `{ok:true}`.
      // The tool's job is to enqueue. Typing (and the 30s human-input
      // gate) happens on the existing FIFO; awaiting it here is the
      // MCP-timeout / duplicate-send class that `report` already left.
      // No content dedupe here either: two byte-identical texts can be
      // intentional (card 469, seq 222+223); identity is the delivery id.
      // `steer` defaults TRUE for send_to_card (owner: real-time in-turn
      // correction). Explicit `steer:false` parks mid-turn without injecting.
      const steer = req.steer !== false;
      const enqueued = enqueueCardDelivery(target, text, {
        steer,
        ...(req.requesterId ? { requesterId: req.requesterId } : {}),
      });
      if (!("receipt" in enqueued)) return enqueued;
      return enqueued.receipt;
    }

    if (req.cmd === "get_delivery") {
      if (!req.id) return { ok: false, error: "missing delivery id" };
      const record = deliveryRecords.get(req.id);
      if (!record) return { ok: false, error: `no delivery with id "${req.id}"` };
      return {
        ok: true,
        delivery: record.delivery,
        ...(record.reason ? { reason: record.reason } : {}),
        ...(record.confirm ? { confirm: record.confirm } : {}),
        ...(record.requesterId ? { requesterId: record.requesterId } : {}),
        id: record.id,
        target: record.target,
      };
    }

    if (req.cmd === "list_deliveries") {
      const filtered = filterDeliveryRecords(deliveryRecords.values(), {
        ...(req.requesterId !== undefined ? { requesterId: req.requesterId } : {}),
        ...(req.target !== undefined ? { target: req.target } : {}),
        ...(req.delivery !== undefined ? { delivery: req.delivery } : {}),
      });
      return {
        ok: true,
        deliveries: filtered.map((r) => ({
          id: r.id,
          target: r.target,
          delivery: r.delivery,
          ...(r.requesterId ? { requesterId: r.requesterId } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.started ? { started: true } : {}),
        })),
      };
    }

    if (req.cmd === "cancel_deliveries") {
      if (req.id) {
        const record = deliveryRecords.get(req.id);
        if (!record) return { ok: false, error: `no delivery with id "${req.id}"` };
        if (record.delivery !== "queued" || record.started) {
          return {
            ok: false,
            error: `delivery "${req.id}" is ${record.delivery}${record.started ? " (started)" : ""} — only queued not-yet-started items cancel`,
          };
        }
        record.delivery = "cancelled";
        delete record.reason;
        return { ok: true, cancelledIds: [req.id] };
      }
      if (req.requesterId) {
        const cancelledIds = applyCancelPendingFromRequester(req.requesterId);
        return { ok: true, cancelledIds };
      }
      return { ok: false, error: "pass id or requesterId" };
    }

    if (req.cmd === "open") {
      if (!req.url) return { ok: false, error: "missing url" };
      const openUrlError = navigationUrlError(req.url);
      if (openUrlError) return { ok: false, error: openUrlError };
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // DESIGN-BACKLOG.md item 60, peça 5 — modo autônomo completo:
      // auto-approve extended here too, same board-scoped opt-in as
      // spawn_agent (item 59). No concurrency cap involved — that only
      // ever gates spawn_agent.
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingOpens.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, OPEN_TIMEOUT_MS);
        pendingOpens.set(requestId, {
          resolve: (allowed, cardId) => {
            clearTimeout(timer);
            pendingOpens.delete(requestId);
            unmarkWaiting(requesterId);
            // `cardId` é opcional na assinatura só por robustez (um
            // renderer antigo, ou uma recusa, não tem id nenhum pra
            // mandar) — no caminho de permitir ele vem sempre.
            resolve(allowed ? { ok: true, ...(cardId ? { cardId } : {}) } : { ok: false, error: "denied by user" });
          },
          timer,
        });
        callbacks.onOpenRequest(requestId, requesterId, req.url as string, req.reason, autonomous);
      });
    }

    // Sticky item "close_card" (2026-09-03) — "o orquestrador não consegue
    // fechar o card ou qualquer outro card, sem poder" — `closeCard()`
    // (App.tsx) always existed but only ever behind the UI's own X button,
    // no MCP/acbridge path reached it. Same ask/consent/resolve shape as
    // `open` above, generalized to any card kind (not just terminal — see
    // `onCloseCardRequest`'s own doc comment).
    if (req.cmd === "close_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      if (!callbacks.listCards().some((c) => c.id === target)) return { ok: false, error: `no open card with id "${target}"` };
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // CAMADA 4, TERCEIRA PORTA (2026-09-19) — fechar um card era a única
      // porta que ninguém vigiava, e a mais irreversível: o card morre, o
      // link morre com ele, e a task ficava aberta sem ninguém. MEDIDO no
      // banco real: 38 tasks abertas, 28 já sem card principal, 7 delas com
      // review="wanted" e ZERO reviewer (os 7 órfãos). A regra é pura
      // (`decideCloseCardTaskEffect`) e roda ANTES do pedido de
      // consentimento — pedir a um humano para fechar algo que vai ser
      // recusado seria pior que recusar. Ver o módulo puro pra medição que
      // escolheu recusar vs auto-fechar.
      const conclusions: string[] = [];
      for (const linked of collectCloseCardLinkedTasks(target, requesterId)) {
        const effect = decideCloseCardTaskEffect(linked);
        if (effect.action === "refuse") return { ok: false, error: effect.error };
        if (effect.action === "conclude-task") conclusions.push(effect.taskId);
      }
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCloseCards.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, CLOSE_TIMEOUT_MS);
        pendingCloseCards.set(requestId, {
          resolve: (allowed) => {
            clearTimeout(timer);
            pendingCloseCards.delete(requestId);
            unmarkWaiting(requesterId);
            if (!allowed) {
              resolve({ ok: false, error: "denied by user" });
              return;
            }
            // A conclusão só é aplicada DEPOIS do consentimento: um close
            // negado não pode concluir task nenhuma.
            const concludedTasks: string[] = [];
            const warnings: string[] = [];
            for (const taskId of conclusions) {
              const result = concludeTaskOnCardClose(taskId, requesterId);
              if (result.warning) warnings.push(result.warning);
              else if (result.ok) concludedTasks.push(taskId);
            }
            resolve({
              ok: true,
              ...(concludedTasks.length > 0 ? { concludedTasks } : {}),
              ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
            });
          },
          timer,
        });
        callbacks.onCloseCardRequest(requestId, requesterId, target, req.reason, autonomous);
      });
    }

    if (req.cmd === "delete_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      // Already on the loaded board — close_card handles this exact card
      // today (live-terminal reconfirm, consent modal/autonomous gate);
      // delegate instead of a second, subtly different implementation.
      if (callbacks.listCards().some((c) => c.id === target)) {
        return handleRequest({ cmd: "close_card", target, requesterId: req.requesterId, reason: req.reason });
      }
      const any = callbacks.getAnyCard(target);
      if (!any) return { ok: false, error: `no card with id "${target}"` };
      // No loaded board means no live UI to ever show a human a consent
      // modal through — the only safe path left is the same contract
      // spawn_card/open_url already use for "no human in the loop, but
      // this board is explicitly fine with it": THAT card's own board
      // being autonomous, not the requester's.
      if (!callbacks.isBoardAutonomous(any.boardId)) {
        return {
          ok: false,
          error: `card "${target}" is on board "${any.boardId}", which isn't currently loaded — load that board and use close_card, or turn on autonomous mode for it first`,
        };
      }
      callbacks.deleteCardDirect(target);
      return { ok: true };
    }

    if (req.cmd === "update_card_content") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const mode = req.mode ?? "replace";
      if (mode !== "replace" && mode !== "append") return { ok: false, error: `mode must be "replace" or "append"` };
      const resolved = await resolveStickyWriteContent(req);
      if (!resolved.ok) return resolved;
      const target = req.target;
      if (callbacks.listCards().some((c) => c.id === target)) {
        return handleRequest({
          cmd: "write_sticky",
          target,
          content: resolved.content,
          mode,
          requesterId: req.requesterId,
        });
      }
      const any = callbacks.getAnyCard(target);
      if (!any) return { ok: false, error: `no card with id "${target}"` };
      if (any.kind !== "sticky") {
        return { ok: false, error: `card "${target}" is a ${any.kind} card — update_card_content only works on sticky notes` };
      }
      if (!callbacks.isBoardAutonomous(any.boardId)) {
        return {
          ok: false,
          error: `card "${target}" is on board "${any.boardId}", which isn't currently loaded — load that board and use write_sticky, or turn on autonomous mode for it first`,
        };
      }
      const result = callbacks.updateStickyContentDirect(target, resolved.content, mode);
      if (result.ok && req.requesterId) {
        callbacks.onAutoConnect(
          req.requesterId,
          target,
          "modified",
          truncateForLabel(req.path?.trim() ? req.path : resolved.content),
        );
      }
      return result;
    }

    if (req.cmd === "snapshot") {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSnapshots.delete(requestId);
          callbacks.onSnapshotTimeout(requestId);
          resolve({ ok: false, error: "timed out capturing snapshot" });
        }, SNAPSHOT_TIMEOUT_MS);
        pendingSnapshots.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSnapshots.delete(requestId);
            resolve(result);
          },
          timer,
        });
        const target = req.rect ? { rect: req.rect } : req.target ? { cardId: req.target } : null;
        callbacks.onSnapshotRequest(requestId, target);
      });
    }

    if (req.cmd === "get_page_text") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingPageTexts.delete(requestId);
          resolve({ ok: false, error: "timed out reading page text" });
        }, PAGE_TEXT_TIMEOUT_MS);
        pendingPageTexts.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingPageTexts.delete(requestId);
            resolve(result);
          },
          timer,
        });
        callbacks.onPageTextRequest(requestId, req.target as string);
      });
    }

    if (req.cmd === "read_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return readCardText(req.target, req.lines);
    }

    // Sem modal de consentimento, decidido com o usuário (2026-09-01): uma
    // nota é conteúdo do board, não um efeito colateral em disco ou
    // processo — a categoria que a política de consentimento cobre
    // (`write_file`, `bash`, `spawn_agent`, `open_url`, ver AGENTS.md §3).
    // A proteção que importa aqui é outra e vive no renderer: uma nota que
    // um humano está editando NAQUELE instante recusa a escrita em vez de
    // apagar o que a pessoa está digitando.
    if (
      req.cmd === "read_sticky" ||
      req.cmd === "write_sticky" ||
      req.cmd === "set_sticky_color" ||
      req.cmd === "set_sticky_mode"
    ) {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const card = callbacks.listCards().find((c) => c.id === req.target);
      if (!card) return { ok: false, error: `no card with id "${req.target}"` };
      if (card.kind !== "sticky") {
        return { ok: false, error: `card "${req.target}" is a ${card.kind} card — ${req.cmd} only works on sticky notes` };
      }
      if (req.cmd === "read_sticky") return stickyOp(req.target, { op: "read" });
      if (req.cmd === "set_sticky_color") {
        if (!req.color || !STICKY_COLORS.includes(req.color as (typeof STICKY_COLORS)[number])) {
          return { ok: false, error: `color must be one of ${STICKY_COLORS.join(", ")}` };
        }
        return stickyOp(req.target, { op: "set_color", color: req.color, requesterId: req.requesterId });
      }
      if (req.cmd === "set_sticky_mode") {
        if (req.mode !== "edit" && req.mode !== "preview") {
          return { ok: false, error: `mode must be "edit" or "preview"` };
        }
        return stickyOp(req.target, { op: "set_mode", mode: req.mode, requesterId: req.requesterId });
      }
      const mode = req.mode ?? "replace";
      if (mode !== "replace" && mode !== "append") return { ok: false, error: `mode must be "replace" or "append"` };
      const resolved = await resolveStickyWriteContent(req);
      if (!resolved.ok) return resolved;
      return stickyOp(req.target, { op: "write", content: resolved.content, mode, requesterId: req.requesterId });
    }

    // DESIGN-BACKLOG.md §2.1 — the 5 browser control cmds. Unlike
    // `snapshot`/`get_page_text` above, resolution here is 100% local to
    // THIS process (`browser-registry.ts`'s methods, called straight
    // from index.ts's callbacks, no round trip to the renderer) — no
    // pending-map/timeout ceremony needed, same shape as `card_status`/
    // `board_mode` below: call the callback, return what it resolves to.
    if (req.cmd === "browser_click") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.ref && !req.selector && (req.x === undefined || req.y === undefined)) {
        return { ok: false, error: "need a ref (from browser_snapshot), a selector, or both x and y" };
      }
      return callbacks.browserClick(req.target, req.x, req.y, req.selector, req.ref);
    }

    if (req.cmd === "browser_type") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (req.text === undefined) return { ok: false, error: "missing text" };
      return callbacks.browserType(req.target, req.text, req.selector, req.ref);
    }

    if (req.cmd === "browser_scroll") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserScroll(req.target, req.dx ?? 0, req.dy ?? 0, req.selector, req.ref);
    }

    if (req.cmd === "browser_query") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.selector && !req.ref) return { ok: false, error: "need a selector or a ref (from browser_snapshot)" };
      return callbacks.browserQuery(req.target, req.selector, req.ref);
    }

    if (req.cmd === "browser_eval") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.js) return { ok: false, error: "missing js" };
      return callbacks.browserEval(req.target, req.js);
    }

    if (req.cmd === "browser_snapshot") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserSnapshot(req.target);
    }

    if (req.cmd === "browser_console") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserConsole(req.target, req.level, req.limit);
    }

    if (req.cmd === "browser_network") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserNetwork(req.target, {
        status: req.status,
        failedOnly: req.failedOnly,
        urlContains: req.urlContains,
        limit: req.limit,
      });
    }

    if (req.cmd === "browser_wait_for") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.selector && !req.text) return { ok: false, error: "need either selector or text" };
      return callbacks.browserWaitFor(req.target, {
        selector: req.selector,
        text: req.text,
        gone: req.gone,
        timeoutMs: req.timeoutMs,
      });
    }

    if (req.cmd === "card_status") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      const card = listTerminalCards().find((c) => c.id === target);
      if (!card) return { ok: false, error: `no open terminal card with id "${target}"` };
      // O status é DECIDIDO por fatos (`card-status-decision.ts`), não por
      // "sem bytes por N segundos" (task 4245c6f5). Aqui só se coleta o que
      // existe e se devolve — inclusive `unknown`, quando não há fato
      // suficiente. `provider` vai na resposta de propósito: foi mandar um
      // brief de agente para um card bash que produziu
      // `bash: erro de sintaxe próximo ao token inesperado '('`.
      const status = decideCardStatus({
        provider: card.provider ?? null,
        alive: callbacks.isCardAlive(target),
        waitingOnConsent: waitingOnConsent.has(target),
        lastActivityAt: callbacks.getCardLastActivityAt(target),
        turnEndedAt: callbacks.getCardTurnEndedAt(target) ?? null,
        hasPendingHumanInput: callbacks.getCardWriteReadiness(target)?.hasPendingHumanInput === true,
        now: Date.now(),
        idleThresholdMs: IDLE_THRESHOLD_MS,
      });
      return {
        ok: true,
        status,
        provider: card.provider ?? null,
        note: describeCardStatus(status),
      };
    }

    if (req.cmd === "turn_complete") {
      if (!req.cardId) return { ok: false, error: "missing cardId (your own card id)" };
      // O FATO primeiro (task 4245c6f5): é ele que `card_status` lê depois.
      // O relay abaixo continua sendo só UI — até esta task, era só isso que
      // existia, e o main não tinha nenhuma noção de turno.
      callbacks.markCardTurnComplete(req.cardId);
      callbacks.notifyTurnComplete(req.cardId);
      return { ok: true };
    }

    if (req.cmd === "report") {
      // ENVELOPE (task 10cf58d0) — UM ponto de decodificação, antes de qualquer
      // efeito. `report` é campo LIVRE na superfície MCP, então um cliente pode
      // mandar o payload como STRING de JSON. `acbridge` já faz `JSON.parse`
      // local (`report: argument must be valid JSON`) e NUNCA manda string —
      // medido: 48/48 linhas do canal `socket` são objeto —, e o handler MCP
      // também decodifica; mas o BUS não decodificava, então uma string que
      // chegasse aqui era persistida como string (`JSON.stringify` de string =
      // valor string em `report_json`) e todos os campos dela ficavam
      // inalcançáveis por consulta. Decodificar AQUI faz do bus o ponto único,
      // qualquer que seja a porta.
      const incomingReport = decodeReportArgument(req.report);
      // O caso que MOTIVOU a task: string que PARECE envelope (`{`) e não
      // decodifica — não há o que normalizar, e persistir gravaria em silêncio
      // uma linha cujos campos ninguém lê. Recusa ANTES de qualquer escrita,
      // com a mensagem que ensina (ver `describeUndecodableReportEnvelope`).
      const envelopeProblem = describeUndecodableReportEnvelope(req.report);
      if (envelopeProblem) return { ok: false, error: envelopeProblem, field: "report" };
      const listed = callbacks.listTasks();
      const tasks = Array.isArray(listed) ? listed : [];
      // CAMADA 4 — a task deste report é resolvida UMA vez, antes de
      // qualquer efeito (task 4fee76d5).
      //
      // Antes disto, este handler pegava `tasks.find(t => t.card_id ===
      // requesterId)` — a task MAIS ANTIGA cujo principal é o card, sem
      // olhar para a declaração do agente nem para os vínculos de
      // `task_cards` — e, quando não conseguia decidir, seguia com
      // `reportTaskId` undefined. Lá embaixo isso virava papel `null`, que
      // já significava "sem vínculo nenhum", e outsider PODE emitir
      // veredito: um card com 2+ vínculos deixava de ser implementer e
      // passava a poder assinar o próprio trabalho. MEDIDO no teste de
      // caracterização, com o veredito ACEITO nas duas portas.
      //
      // O mesmo desempate silencioso decidia também o `reportSchema`
      // aceito, o orçamento de retry, o carimbo de `taskId` no payload e os
      // gates disparados — todos passam a seguir a task RESOLVIDA.
      const taskCardLinks = req.requesterId ? (callbacks.listTaskCardsForCard(req.requesterId) ?? []) : [];
      const link = decideReportTaskLink({
        declaredTaskId: declaredTaskIdFromReportBody(incomingReport),
        principalTaskIds: req.requesterId ? tasks.filter((t) => t.card_id === req.requesterId).map((t) => t.id) : [],
        linkTaskIds: taskCardLinks.map((l) => l.task_id),
      });
      if (link.action === "ambiguous") {
        return { ok: false, error: describeAmbiguousTaskRefusal(link.candidates) };
      }
      if (link.action === "declared-not-linked") {
        return { ok: false, error: describeDeclaredTaskNotLinkedRefusal(link.declared, link.candidates) };
      }
      const linkedTask = link.action === "resolve" ? tasks.find((t) => t.id === link.taskId) : undefined;
      const runningTask =
        linkedTask && effectiveTaskStatus(linkedTask) === "running" ? linkedTask : undefined;
      const decision = decideReportAcceptance({
        requesterId: req.requesterId,
        report: incomingReport,
        linkedTask: runningTask
          ? {
              status: runningTask.status,
              retry_count: runningTask.retry_count,
              max_retries: runningTask.max_retries,
              reportSchema: contractFromTaskRow(runningTask).reportSchema,
            }
          : undefined,
        defaultMaxRetries: DEFAULT_MAX_RETRIES,
      });
      if (decision.action === "structural") {
        return { ok: false, error: decision.error, field: decision.field };
      }
      // Requester identity and the task this report is ABOUT are resolved
      // here, above the retryable branch, because the verdict gate below
      // must be able to refuse BEFORE any state changes. Both reads are
      // pure store reads (no mutation), so moving them up changes nothing
      // for any path that already ran — the retryable branch itself
      // requires a `linkedTask`, which requires a requesterId, so no
      // request that used to reach it can now stop at the guard.
      if (!req.requesterId) return { ok: false, error: "missing requesterId (your own card id)" };
      const reportTaskId = link.action === "resolve" ? link.taskId : undefined;
      // CAMADA 4, SEGUNDA PORTA — o choke point DE VERDADE (2026-09-19).
      //
      // Um `verdict` no payload é julgamento escrito sem `update_task`, e
      // `decideReportVerdictWrite` é a MESMA função pura que o handler MCP
      // consulta — chamada de um segundo lugar, nunca copiada. O handler
      // MCP é só uma das portas: `acbridge report` vai direto por unix
      // socket até AQUI e nunca passa por lá, então a regra só valia para
      // metade dos autores de veredito (medido: o card implementer mandava
      // `aprovado` e o reviewer reprovava tudo — pelo caminho do acbridge
      // ele nem era barrado).
      //
      // Os FATOS vêm dos VÍNCULOS VIVOS (`taskCardLinks`), não do dump
      // histórico por task nem de `tasks.card_id`. O motivo é medido e é o
      // mesmo que o resto deste handler já protege: `tasks.card_id` (e
      // portanto o `reportTaskId` acima, que o prefere) SOBREVIVE ao
      // delete/recycle do card, então ele pode apontar para uma task MORTA.
      // Ler o papel por lá fazia o gate julgar o veredito de hoje com o papel
      // de ontem — um reviewer legítimo era recusado por um vínculo velho de
      // implementer numa task done (achado ao estender
      // card-id-recycle-participation). `taskCardLinks` é justamente a lista
      // epoch-filtrada (`linked_at >= cards.created_at`) que a linha
      // `reporterRole` logo abaixo usa para carimbar: gate e carimbo passam a
      // olhar a MESMA verdade, "quem este card é, agora". Quando o
      // `reportTaskId` não é um vínculo vivo, cai no único vínculo vivo (mesma
      // postura de `resolveDeclaredTaskId`: um só é inequívoco, dois são
      // desconhecido — nunca um palpite).
      //
      // A evidência julgada é `incomingReport` (o payload como o chamador
      // mandou, decodificado — ver o topo do handler), não o `filled`:
      // `fillReportTaskId` roda depois e carimba
      // `taskId` por conta do servidor — deixar esse carimbo satisfazer uma
      // chave declarada no `reportSchema` seria o próprio furo que este
      // gate existe para fechar (uma chave preenchida por nós não é
      // evidência de quem julgou). A checagem estrutural de schema acima
      // também usa o payload pré-carimbo, pela mesma razão.
      //
      // Sem veredito não há leitura nenhuma: report comum segue como
      // sempre. Recusa acontece ANTES do `upsertReport` e antes de subir
      // `retry_count` — como na porta MCP, que barra antes de chamar o bus.
      const formalVerdict = promoteReportVerdict(incomingReport, req.verdict).verdict;
      if (formalVerdict) {
        const liveLink =
          taskCardLinks.find((l) => l.task_id === reportTaskId) ??
          (taskCardLinks.length === 1 ? taskCardLinks[0] : undefined);
        const gateTask = liveLink ? callbacks.getTask(liveLink.task_id) : undefined;
        const gate = decideReportVerdictWrite({
          verdict: formalVerdict,
          requesterRoleOnTask: liveLink ? liveLink.role : null,
          reviewWanted: isReviewWanted(gateTask?.review ?? null),
          report: incomingReport,
          reportSchema: gateTask ? contractFromTaskRow(gateTask).reportSchema : null,
        });
        if (gate.action === "refuse") return { ok: false, error: gate.error };
      }
      if (decision.action === "refuse_retryable") {
        // In-line retry: same session, same card. Increment + stash the
        // declared reason on the task (not a report row, not a status).
        // Never spawn, never persist this report, never wake waiters.
        if (runningTask) {
          callbacks.upsertTask({
            ...runningTask,
            retry_count: decision.retryCount,
            result_json: stashLastRefusedReport(runningTask.result_json, incomingReport),
            updated_at: Date.now(),
            actor: "app",
            statusProposed: false,
          });
        }
        return {
          ok: false,
          error: decision.error,
          retryCount: decision.retryCount,
          retriesRemaining: decision.retriesRemaining,
        };
      }
      // Stamp the linked task onto the report body when the caller omitted
      // it — same auto-fill class as acbridge's AGENT_CANVAS_TASK_ID, from
      // the store fact (tasks.card_id / task_cards) so MCP callers that
      // never read env still don't copy a truncated id from a briefing.
      // Acceptance already ran on the original payload; this does not
      // invent a task when the card is not linked.
      const filled = fillReportTaskId(incomingReport, reportTaskId);
      // acbridge `report <json>` has no separate flag — a formal
      // `verdict` inside that JSON is the typed column. Lift it off
      // the payload so `report_json` and `reports.verdict` are not
      // two copies of the same fact. MCP's explicit `req.verdict` wins.
      const promoted = promoteReportVerdict(filled, req.verdict);
      const report = promoted.report;
      // Who is saying it — the caller's LIVE `task_cards.role`, stamped next
      // to the verdict from the SAME links `recordParticipationRound`
      // reads below (one source, two rows). Live = link epoch matches the
      // living card (`linked_at >= cards.created_at`); missing clocks fall
      // back to dropping done/failed — so a recycled id cannot stamp old
      // history, and a reviewer linked onto an already-done task still
      // counts. Ambiguity across roles is a separate guard inside
      // `resolveReporterRole`. `null` when the card has no live link, or
      // live links with different roles: unknown is a fact to record, not
      // a value to guess — never `implementer` by default. The completion
      // proposal (task-board-model.ts) only trusts an `aprovado` whose
      // role is `reviewer`.
      //
      // 2026-09-19: um veredito de implementer normalmente NÃO chega mais
      // aqui — o gate do veredito, acima, já recusou. As duas checagens não
      // são a mesma, de propósito: o gate pergunta "papel na task DE QUE
      // este report fala" (`getTaskCards(reportTaskId)`), enquanto esta
      // linha grava o papel VIVO do card entre todos os vínculos
      // (`resolveReporterRole`). Elas só divergem nos casos ambíguos/sem
      // task que o gate deliberadamente deixa passar (desconhecido é um
      // fato, não um palpite) — e quando divergem, a linha continua
      // dizendo honestamente quem escreveu.
      const reporterRole = resolveReporterRole(taskCardLinks);
      const stored: StoredReport = { report, seq: ++reportSeqCounter, verdict: promoted.verdict ?? null, role: reporterRole };
      // DESIGN-BACKLOG.md §2.1 — persiste ANTES de resolver waiters/avisar
      // o spawner: se o processo morrer bem aqui no meio (mesma classe de
      // evento que motivou esta tarefa), o pior caso agora é um waiter que
      // não foi acordado desta vez — não um relatório que nunca existiu.
      // `report_json` é o mesmo `JSON.stringify` que `update_task` já faz
      // pra `result_json` (mesma convenção, não uma nova).
      const now = Date.now();
      callbacks.upsertReport({
        card_id: req.requesterId,
        seq: stored.seq,
        report_json: JSON.stringify(stored.report),
        verdict: stored.verdict,
        role: stored.role,
        channel: ingressChannel,
        updated_at: now,
      });
      // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" —
      // todo `report` fecha uma RODADA de participação, tenha `verdict`
      // ou não (`verdict: null` é "esta rodada terminou sem veredito
      // nenhum", tão real quanto "aprovado"/"reprovado"). Choke point:
      // este é o único lugar que grava um report vindo de fora, então é
      // o único lugar que precisa lembrar de chamar isto — ver o
      // comentário grande de `recordParticipationRound` no callback.
      callbacks.recordParticipationRound(req.requesterId, stored.verdict ?? null, now);
      // Parte 2b — cada waiter carrega o próprio `afterSeq`; só resolve
      // (e sai da fila) quem esse relatório novo de fato satisfaz. Os que
      // sobram (raro — normalmente há no máximo um waiter por card)
      // continuam esperando um `seq` ainda maior.
      const waiters = pendingReportWaiters.get(req.requesterId);
      if (waiters) {
        const remaining = waiters.filter((w) => {
          if (stored.seq <= w.afterSeq) return true;
          w.resolve(stored);
          return false;
        });
        if (remaining.length === 0) pendingReportWaiters.delete(req.requesterId);
        else pendingReportWaiters.set(req.requesterId, remaining);
      }
      // AGENT half: pointer into the orchestrator's PTY (enqueue, never
      // await — report must return now). OS popup stays removed. Fires
      // even when a wait:true waiter already got the JSON — that waiter
      // is the agent RPC; the human on the orchestrator card is not.
      notifySpawnerOfReport(req.requesterId);
      // Accepted report ends the SINAL 3 episode — a later idle wait for
      // follow-up must not re-fire the "idle sem report" pointer.
      idleWithoutReportNotified.delete(req.requesterId);
      // An accepted report supersedes any refused-round stash. Clear it
      // here so a later exit cannot revive a reason that was already
      // replaced. Status is untouched on a plain accept.
      if (runningTask) {
        const clearedJson = clearLastRefusedStash(runningTask.result_json);
        if (decision.action === "accept_failure") {
          markTaskFailed({ ...runningTask, result_json: clearedJson }, errorFromReportPayload(incomingReport), "explicit_failed");
        } else if (clearedJson !== runningTask.result_json) {
          callbacks.upsertTask({
            ...runningTask,
            result_json: clearedJson,
            updated_at: Date.now(),
            actor: "app",
            statusProposed: false,
          });
        }
      }
      // Gate runner — um report ACEITO (sucesso declarado) de uma task com
      // gates declarados dispara a execução MEDIDA pelo app, em vez de o
      // orquestrador confiar no número que o agente digitou. `accept_failure`
      // fica de fora por definição: o agente já declarou que NÃO entregou.
      if (decision.action === "accept") startTaskGates(runningTask);
      return { ok: true, seq: stored.seq };
    }

    if (req.cmd === "get_report") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      const afterSeq = req.afterSeq;
      // Sem afterSeq: mais recente. Com afterSeq: próximo (seq > afterSeq),
      // para caminhar histórico append-only depois do fato.
      const storedRow = callbacks.getReport(target, afterSeq);
      // Normaliza na LEITURA (task 10cf58d0): as linhas antigas gravadas como
      // string-de-JSON são lidas como o objeto que sempre foram. Conserta o
      // passado sem tocar no passado — nenhuma escrita em dado histórico, sem
      // backup e sem migração. As que NÃO decodificam (4 malformadas + 1 prosa
      // legítima) continuam chegando como string, que é a verdade do que está
      // gravado; quem consulta em lote deve perguntar a forma antes de assumir
      // objeto (o próprio `json_type(report_json)` responde).
      const current: StoredReport | undefined = storedRow
        ? { report: decodeReportArgument(JSON.parse(storedRow.report_json)), seq: storedRow.seq, verdict: storedRow.verdict ?? null, role: storedRow.role ?? null }
        : undefined;
      if (current) {
        return { ok: true, report: current.report, seq: current.seq, verdict: current.verdict ?? null, role: current.role ?? null };
      }
      if (!req.wait) return { ok: false, error: afterSeq === undefined ? "no report yet" : "no report newer than the given sequence yet" };
      const timeoutMs = req.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
      // `afterSeq ?? -1`: sem valor informado, qualquer relatório que
      // chegue (seq sempre >= 1) já satisfaz — mesmo "espera o primeiro
      // que vier" de sempre.
      const threshold = afterSeq ?? -1;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const waiters = pendingReportWaiters.get(target);
          if (waiters) {
            const idx = waiters.indexOf(entry);
            if (idx !== -1) waiters.splice(idx, 1);
            if (waiters.length === 0) pendingReportWaiters.delete(target);
          }
          resolve({ ok: false, error: "timed out waiting for report" });
        }, timeoutMs);
        const entry = {
          afterSeq: threshold,
          resolve: (stored: StoredReport) => {
            clearTimeout(timer);
            resolve({ ok: true, report: stored.report, seq: stored.seq, verdict: stored.verdict ?? null, role: stored.role ?? null });
          },
        };
        const waiters = pendingReportWaiters.get(target) ?? [];
        waiters.push(entry);
        pendingReportWaiters.set(target, waiters);
      });
    }

    if (req.cmd === "create_task") {
      const now = Date.now();
      const id = randomUUID();
      // DESIGN-BACKLOG.md item 60, peça 3 — explicit `boardId` wins (the
      // only way to scope a task that has no `cardId` yet, e.g. one
      // meant to sit `pending` until its deps finish); then the `cardId`'s
      // own board; then the CALLER's own card (`requesterId`) — context
      // that existed all along and this handler never read. 2026-09-19:
      // an agent created 23 board-less tasks in one session, every one of
      // them from a calling card that WAS on a board. Empty/whitespace
      // `boardId` collapses to absent, same convention as `cwd`.
      const explicitBoardId =
        typeof req.boardId === "string" && req.boardId.trim().length > 0 ? req.boardId.trim() : undefined;
      const boardId =
        explicitBoardId ??
        (req.cardId ? callbacks.getCardBoardId(req.cardId) : undefined) ??
        (req.requesterId ? callbacks.getCardBoardId(req.requesterId) : undefined) ??
        null;
      // RODADA 4 — recusa em vez de gravar em silêncio: um `boardId` que não
      // resolve a nenhum board é erro do chamador, não bookkeeping.
      if (boardId !== null && !callbacks.boardExists(boardId)) {
        return { ok: false, error: `no such board "${boardId}" — check the board list and pass an existing boardId, a cardId on a live board, or call from the card on the board you want (requesterId)` };
      }
      // `purpose` is write-once (the store's ON CONFLICT omits it), so
      // this is the ONLY place a value can enter — which is exactly why
      // a typo must be refused here, not normalized to null: the store's
      // `normalizeTaskPurpose` fallback exists for legacy rows, and
      // letting `"banana"` reach it would silently create a task with an
      // empty chip that can never be corrected. Checked before anything
      // is written (same shape as the boardId refusal above). Absent is
      // still NORMAL and persists `null`.
      if (req.purpose !== undefined && normalizeTaskPurpose(req.purpose) === null) {
        return {
          ok: false,
          error: `purpose must be one of ${TASK_PURPOSES.map((p) => `"${p}"`).join(", ")} (or omitted), got "${String(req.purpose)}" — refusing to create rather than silently dropping the value; purpose cannot be fixed later`,
        };
      }
      if (req.review !== undefined && normalizeTaskReview(req.review) === null) {
        return {
          ok: false,
          error: `review must be ${TASK_REVIEW_VALUES.map((v) => `"${v}"`).join(" or ")} (or omitted), got "${String(req.review)}" — refusing to create rather than silently dropping the value`,
        };
      }
      const contractParse = parseTaskContractInput({
        territory: req.territory,
        gates: req.gates,
        allowCommit: req.allowCommit,
        reportSchema: req.reportSchema,
      });
      if (!contractParse.ok) {
        return { ok: false, error: contractParse.error, field: contractParse.field };
      }
      // 2026-09-19 — nenhum board resolvido: RECUSA, nunca grava em
      // silêncio. A Fila é indexada por board, `board_id` NULL só é
      // reatribuído quando um board é DELETADO (store), e não existe
      // `delete_task` (tasks são imortais por design) — a task órfã fica
      // invisível e presa pra sempre. Mesma classe da recusa de `provider
      // não declarado`: recusa explícita, com o caminho de conserto no
      // texto. Depois das validações de valor acima, de propósito: um
      // `purpose`/`review` inválido continua sendo o erro reportado (é o
      // dado que o chamador mandou, não a ausência de board).
      if (boardId === null) {
        return { ok: false, error: TASK_BOARD_UNDECLARED_REASON };
      }
      const created: TaskRow = {
        id,
        prompt: req.prompt ?? null,
        provider: req.provider ?? null,
        status: "pending",
        card_id: req.cardId ?? null,
        board_id: boardId,
        // Explicit only — never inferred from card/board/repo. Empty string
        // collapses to null (same as omitted): board-root fallback at dispatch.
        cwd: resolveTaskDispatchCwd(req.cwd) ?? null,
        purpose: req.purpose ?? null,
        review: req.review ?? null,
        territory_json: territoryToSql(contractParse.contract.territory),
        gates_json: gatesToSql(contractParse.contract.gates),
        allow_commit: allowCommitToSql(contractParse.contract.allowCommit),
        report_schema_json: reportSchemaToSql(contractParse.contract.reportSchema),
        result_json: null,
        deps_json: req.deps ? JSON.stringify(req.deps) : null,
        retry_count: 0,
        attempted_providers_json: req.provider ? JSON.stringify([req.provider]) : null,
        max_retries: req.maxRetries ?? null,
        fallback_providers_json: req.fallbackProviders ? JSON.stringify(req.fallbackProviders) : null,
        order: null,
        suggested_order: req.suggestedOrder ?? null,
        implicit_order: null,
        diverged_status: null,
        diverged_actor: null,
        created_at: now,
        updated_at: now,
        // create_task só existe como MCP tool hoje — todo chamador é um
        // agente. Explícito aqui em vez de deixar pro default do store,
        // pelo mesmo motivo de "não adivinhar": este ponto SABE quem é.
        actor: "agent",
        // Subject of the write — not the task's implementer cardId.
        // Null when the call was anonymous (no URL stamp / no env).
        actorCardId: req.requesterId ?? null,
      };
      callbacks.upsertTask(created);
      // Born already unblocked (2026-09-13): `deps` naming tasks that are
      // ALL `done` at creation. The child's prompt is usually written
      // after reading the parent's report, so this is the common shape —
      // and until now nothing happened: `onTaskDone` fires on the dep's
      // transition, which is in the past. Same dispatch path as that
      // transition (`dispatchIfUnblocked`), never a second one; the same
      // autonomous-board gate applies, so on a human-in-the-loop board the
      // task simply stays `pending` as before. `listTasks()` is read AFTER
      // the upsert so the check sees the deps' current status.
      const dispatched = created.status === "pending" && created.deps_json ? dispatchIfUnblocked(created, callbacks.listTasks()) : false;
      return { ok: true, taskId: id, dispatched };
    }

    if (req.cmd === "update_task") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      const existing = callbacks.getTask(req.taskId);
      if (!existing) return { ok: false, error: `no such task "${req.taskId}"` };
      // CAMADA 4 — implementer linked to THIS task cannot write
      // done/failed (judgment). Refuse and name `request_task_status`
      // (teaching refusal, same class as report-retry-decision). Outsider
      // and reviewer may write; anonymous requesterId = outsider.
      // Human/app paths never enter this handler. Board-orchestrator
      // mark does not widen this gate — participation still wins.
      // When `review="wanted"`, ONLY a linked reviewer may write —
      // outsider and orchestrator lose (delegated signature loses).
      // Effective review for THIS request: a same-call `review:"wanted"`
      // must already gate judgment (cannot sneak done past a new latch).
      const statusProposed = req.status !== undefined;
      let reviewForGate = existing.review ?? null;
      if (req.review !== undefined) {
        if (req.review === null) reviewForGate = null;
        else if (normalizeTaskReview(req.review) === null) {
          return {
            ok: false,
            error: `review must be ${TASK_REVIEW_VALUES.map((v) => `"${v}"`).join(" or ")} (or null to clear), got "${String(req.review)}"`,
          };
        } else {
          reviewForGate = normalizeTaskReview(req.review);
        }
      }
      if (statusProposed && req.status !== undefined) {
        const cards = callbacks.getTaskCards(req.taskId) ?? [];
        const judgment = decideJudgmentWrite({
          proposedStatus: req.status,
          requesterRoleOnTask: roleOnTask(cards, req.requesterId),
          reviewWanted: isReviewWanted(reviewForGate),
        });
        if (judgment.action === "refuse") return { ok: false, error: judgment.error };
      }
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 — pure
      // bookkeeping an external orchestrator's own retry/reassignment loop
      // can lean on instead of tracking this itself: `incrementRetry`
      // bumps the counter, `attemptedProvider` appends to the list (both
      // additive, never overwritten wholesale like the other fields).
      const attemptedProviders: string[] = existing.attempted_providers_json ? JSON.parse(existing.attempted_providers_json) : [];
      if (req.attemptedProvider) attemptedProviders.push(req.attemptedProvider);
      // Decisão 8 / review adversarial achado 3 — `statusProposed: false`
      // when the agent omitted `status`: the bus must NOT inject
      // `existing.status` as if it were an alignment proposal (that used
      // to clear a live divergence in silence). Other fields still update.
      // DESIGN-BACKLOG.md §2.1 "Falha TIPADA" — failureKind is always
      // derived by the app, never accepted from an agent's `result`.
      // Strip forged kinds; keep any server stamp already on the row.
      let result_json =
        req.result !== undefined
          ? mergeAgentResultJson(stripAgentGateEvidence(req.result), existing.result_json)
          : existing.result_json;
      // 2026-09-19 — mesma classe do `failureKind` logo acima, para a
      // evidência de GATE: `mergeAgentResultJson` reconstrói o objeto a
      // partir do payload do agente e só preserva `failureKind`, então um
      // `update_task.result` posterior APAGAVA o `gateRun` que o app mediu
      // (contrariando o "nem forjar nem apagar" do gate-runner). Testado em
      // tests/unit/message-bus-gate-evidence.test.ts.
      result_json = carryGateEvidence(existing.result_json, result_json) ?? result_json;
      // Explicit agent fail is julgada (stays in "falhou", counts in sprint).
      if (statusProposed && req.status === "failed") {
        result_json = stampFailureKindJson(result_json, decideFailureKind("explicit_failed"));
      }
      const now = Date.now();
      let prompt = existing.prompt;
      if (req.prompt !== undefined) {
        const mode = req.promptMode ?? "append";
        if (mode !== "append" && mode !== "replace") {
          return { ok: false, error: `promptMode must be "append" or "replace"` };
        }
        const applied = applyTaskPromptWrite({ existing: existing.prompt, incoming: req.prompt, mode, at: now });
        if (!applied.ok) return applied;
        prompt = applied.prompt;
      }
      // `purpose` is NOT read from `req` on purpose (acbridge spreads raw
      // JSON into this request, so the key CAN arrive): the row keeps
      // `existing.purpose`, and the store's ON CONFLICT omits the column
      // anyway. Write-once means create_task is the only writer.
      // Contract fields ARE updatable (unlike purpose): omit keeps,
      // null clears, bad shape refuses before write.
      let territory_json = existing.territory_json ?? null;
      let gates_json = existing.gates_json ?? null;
      let allow_commit = existing.allow_commit ?? null;
      let report_schema_json = existing.report_schema_json ?? null;
      if (
        req.territory !== undefined ||
        req.gates !== undefined ||
        req.allowCommit !== undefined ||
        req.reportSchema !== undefined
      ) {
        const partial: {
          territory?: unknown;
          gates?: unknown;
          allowCommit?: unknown;
          reportSchema?: unknown;
        } = {};
        if (req.territory !== undefined) partial.territory = req.territory;
        if (req.gates !== undefined) partial.gates = req.gates;
        if (req.allowCommit !== undefined) partial.allowCommit = req.allowCommit;
        if (req.reportSchema !== undefined) partial.reportSchema = req.reportSchema;
        const contractParse = parseTaskContractInput(partial);
        if (!contractParse.ok) {
          return { ok: false, error: contractParse.error, field: contractParse.field };
        }
        if (req.territory !== undefined) territory_json = territoryToSql(contractParse.contract.territory);
        if (req.gates !== undefined) gates_json = gatesToSql(contractParse.contract.gates);
        if (req.allowCommit !== undefined) allow_commit = allowCommitToSql(contractParse.contract.allowCommit);
        if (req.reportSchema !== undefined) report_schema_json = reportSchemaToSql(contractParse.contract.reportSchema);
      }
      // Layer-1 `review` — already validated above into reviewForGate.
      const review = reviewForGate;
      // Delegated signature: marked board orchestrator writing judgment
      // stamps `orchestrator`, never `human` (false trail) and never
      // plain `agent` (would lose the audit distinction). Non-judgment
      // updates and unmarked callers stay `agent`.
      let writeActor: "agent" | "orchestrator" = "agent";
      if (statusProposed && req.status !== undefined && isJudgmentStatus(req.status) && req.requesterId) {
        const taskBoardId = existing.board_id ?? callbacks.getCardBoardId(req.requesterId);
        const orchId = taskBoardId ? callbacks.getBoardOrchestratorCardId(taskBoardId) : null;
        if (orchId && orchId === req.requesterId) writeActor = "orchestrator";
      }
      // CAMINHO DE CONSERTO (2026-09-19) — a task órfã que `create_task`
      // deixou de produzir existe no banco (23 nesta sessão), invisível na
      // Fila e sem `delete_task`. Aqui ela é pendurada num board de verdade.
      // `board_id` é escrito UMA vez: re-apontar uma task que já tem board
      // é recusado (seria a re-derivação silenciosa que a coluna evita);
      // este caminho só preenche o NULL. Board inexistente recusa, não
      // grava lixo — mesma classe do check do `create_task`.
      let board_id = existing.board_id;
      if (req.boardId !== undefined) {
        const requested = req.boardId.trim();
        if (existing.board_id !== null) {
          return { ok: false, error: `task "${req.taskId}" already belongs to board "${existing.board_id}" — board_id is written once; refusing to re-point it (create a task on the other board instead)` };
        }
        if (requested.length === 0 || !callbacks.boardExists(requested)) {
          return { ok: false, error: `no such board "${requested}"` };
        }
        board_id = requested;
      }
      const updated: TaskRow = {
        ...existing,
        prompt,
        status: statusProposed ? req.status! : existing.status,
        card_id: req.cardId !== undefined ? req.cardId : existing.card_id,
        board_id,
        cwd: req.cwd !== undefined ? (resolveTaskDispatchCwd(req.cwd) ?? null) : existing.cwd,
        review,
        territory_json,
        gates_json,
        allow_commit,
        report_schema_json,
        result_json,
        retry_count: existing.retry_count + (req.incrementRetry ? 1 : 0),
        attempted_providers_json: attemptedProviders.length > 0 ? JSON.stringify(attemptedProviders) : existing.attempted_providers_json,
        suggested_order: req.suggestedOrder !== undefined ? req.suggestedOrder : existing.suggested_order,
        updated_at: now,
        actor: writeActor,
        // Writer card (requester), not the task's implementer — was
        // discarded before 2026-09-14; setStatusAsk already kept it.
        actorCardId: req.requesterId ?? null,
        statusProposed,
      };
      // DESIGN-BACKLOG.md §2.1 Decisão 8 — a precedência mora no choke
      // point (`upsertTask` → `decideStatusWrite`). `done` → dependentes
      // NÃO é decidido aqui (2026-09-13): `callbacks.upsertTask` É o funil
      // de index.ts (task-write-funnel.ts), que observa `statusChanged &&
      // status === "done"` na decisão e chama `onTaskDone` — o MESMO
      // gatilho que aprovar por botão, arrastar pra "concluído" e Allow
      // recebem. Um hold humano continua não desbloqueando ninguém (a
      // decisão vem com `statusChanged: false`). Chamar `onTaskDone` daqui
      // também seria despachar duas vezes. The app never reassigns or
      // respawns on fail.
      const decision = callbacks.upsertTask(updated);
      const promptWritten = req.prompt !== undefined ? { prompt } : {};
      if (decision.warnAgent) {
        const warning = describeStatusHeldWarning(decision.status, decision.declaredStatus ?? req.status ?? decision.status);
        // Same shape as report's in-line refusal (2023a74): the tool
        // return already carries warning/status/divergedStatus. Typing
        // the same text into a PTY was a second channel for the same
        // fact — and when requesterId is missing the code already
        // fell through to this JSON alone, which is the proof it
        // suffices. Do not type.
        return { ok: true, warning, status: decision.status, divergedStatus: decision.divergedStatus, ...promptWritten };
      }
      // Same retainStatusAsk the store already ran: a live request for X
      // plus a write that made X authoritative closes the question.
      // Tell the writer so get_task is not the only place the orphan dies.
      const askAfter = retainStatusAsk({
        existing: {
          requestedStatus: existing.requested_status ?? null,
          requestedReason: existing.requested_reason ?? null,
          requestedBy: existing.requested_by ?? null,
          requestedAt: existing.requested_at ?? null,
        },
        newActor: writeActor,
        proposedStatus: statusProposed ? (req.status ?? null) : null,
        resultingStatus: decision.status,
      });
      if (askAfter.resolvedBy === "applied-ask" && existing.requested_status) {
        return { ok: true, message: describeStatusAskApplied(existing.requested_status), status: decision.status, ...promptWritten };
      }
      return { ok: true, ...promptWritten };
    }

    if (req.cmd === "list_tasks") {
      // DESIGN-BACKLOG.md §2.1 item 6 — review adversarial achado
      // (2026-09-10): a versão anterior filtrava em JS sobre o resultado
      // COMPLETO de `callbacks.listTasks()` mesmo quando `boardId` era
      // passado, carregando a tabela inteira pra memória do Node só pra
      // descartar a maior parte dela. `index.ts` estava travado por outro
      // agente quando esse gap foi documentado — agora liberado, a fiação
      // é ligada de verdade: `callbacks.listTasksByBoard` chama
      // `store.listTasksByBoard` (usa `idx_tasks_board_id`), o mesmo
      // statement já coberto por teste direto contra o store. Sem
      // `boardId`: idêntico a antes (`listTasks()` sem filtro).
      //
      // status/since/hasCard/view (2026-09-14): filtros do orquestrador
      // derivados do uso real em sqlite — ver list-tasks-query.ts.
      // Aplicados DEPOIS do corte por board. hasCard usa isCardAlive (PTY),
      // não só "card_id preenchido" — card fechado deixa id stale.
      const parsed = parseListTasksQuery(req);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      // PERF (task c9db1d86) — a `view` decide a COLUNA no SELECT, não só o
      // descarte no fim. Antes desta linha, `view:"summary"` selecionava
      // `prompt`+`result_json` (82% dos bytes medidos na 41813ab3 seq 447) e
      // só os jogava fora em `projectListedTask` — o parâmetro que existe pra
      // economizar economizava só o fio do IPC. `serializeTask` e
      // `projectListedTask` abaixo ficam intocados: a linha do summary já
      // chega com as duas em `null`.
      const tasks =
        parsed.view === "summary"
          ? req.boardId
            ? callbacks.listTasksSummaryByBoard(req.boardId)
            : callbacks.listTasksSummary()
          : req.boardId
            ? callbacks.listTasksByBoard(req.boardId)
            : callbacks.listTasks();
      const aliveCardIds = new Set(
        tasks
          .map((t) => t.card_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0 && callbacks.isCardAlive(id)),
      );
      const listed = filterListedTasks(
        tasks.map((row) => serializeTask(row) as ListedTask),
        parsed,
        aliveCardIds,
      );
      return { ok: true, tasks: listed.map((t) => projectListedTask(t, parsed.view)) };
    }

    if (req.cmd === "get_task") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      const task = callbacks.getTask(req.taskId);
      if (!task) return { ok: false, error: `no such task "${req.taskId}"` };
      return { ok: true, task: serializeTask(task, lastStatusActorFromRow(task)) };
    }

    if (req.cmd === "link_task_card") {
      // Second writer of `task_cards.role` (the first is `spawn_agent`
      // with `role`), for the pattern "reuse a card that is already
      // alive as this task's reviewer". Every refusal happens before any
      // write; nothing is normalized in silence (acbridge reaches this
      // without zod, so the enum is re-checked here).
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      if (!req.cardId) return { ok: false, error: "missing cardId" };
      const task = callbacks.getTask(req.taskId);
      if (!task) return { ok: false, error: `no such task "${req.taskId}"` };
      if (!callbacks.listCards().some((c) => c.id === req.cardId)) {
        return { ok: false, error: `no open card with id "${req.cardId}"` };
      }
      const role = req.role === undefined ? TASK_CARD_IMPLEMENTER_ROLE : normalizeTaskCardRole(req.role);
      if (role === null) {
        return {
          ok: false,
          error: `role must be one of ${TASK_CARD_ROLES.map((r) => `"${r}"`).join(", ")} (or omitted for implementer), got "${String(req.role)}" — refusing to link rather than silently substituting a role`,
        };
      }
      // Presos em `const` (não lidos de `req` dentro do closure abaixo): o
      // estreitamento de `req.cardId`/`req.taskId` não sobrevive ao escopo.
      const taskId = req.taskId;
      const cardId = req.cardId;
      // Papel ANTERIOR deste card NESTA task, lido ANTES da escrita. Um re-link
      // com o MESMO papel não é informação nova (o handler faz upsert — avisar
      // seria ruído); um papel DIFERENTE é fato novo e vira aviso.
      const previousRole =
        (callbacks.listTaskCardsForCard(cardId) ?? []).find((l) => l.task_id === taskId)?.role ?? null;
      const decideNotice = () =>
        previousRole === role
          ? `skipped: already linked as ${role} — a repeated link is not new information`
          : notifyLinkedCard(cardId, taskId, role, req.requesterId);
      if (role === TASK_CARD_REVIEWER_ROLE) {
        // A reviewer must not be the principal card: `report` keys the
        // in-line retry budget and `accept_failure` → task failed off
        // `tasks.card_id`, and a reviewer's `{ok:false}` is a verdict on
        // someone else's work, not this task failing. Refuse instead of
        // leaving the two tables disagreeing about the same card.
        if (task.card_id === cardId) {
          return {
            ok: false,
            error: `card "${cardId}" is task "${taskId}"'s principal card (cardId) — detach it first (update_task cardId: null) before linking it as reviewer`,
          };
        }
        const profile = profileFromCardRow(callbacks.getAnyCard(cardId));
        callbacks.linkTaskCard(taskId, cardId, role, profile);
        // O aviso sai DEPOIS da escrita: o card que acorda com ele vai chamar
        // `get_task` e precisa que a linha de papel já exista.
        return { ok: true, taskId, cardId, role, notice: decideNotice() };
      }
      const profile = profileFromCardRow(callbacks.getAnyCard(cardId));
      linkImplementerToTask(task, cardId, "agent", profile);
      return { ok: true, taskId, cardId, role, notice: decideNotice() };
    }

    if (req.cmd === "request_task_status") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      if (!req.status) return { ok: false, error: "missing status" };
      const existing = callbacks.getTask(req.taskId);
      if (!existing) return { ok: false, error: `no such task "${req.taskId}"` };
      const requesterBoardId = req.requesterId ? callbacks.getCardBoardId(req.requesterId) : undefined;
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      const decision = decideStatusAsk({
        currentStatus: existing.status,
        requestedStatus: req.status,
        existingDivergedStatus: existing.diverged_status,
        existingDivergedActor: existing.diverged_actor,
        boardAutonomous: autonomous,
      });
      if (decision.outcome === "already") {
        return {
          ok: true,
          pending: false,
          already: true,
          status: existing.status,
          message: describeStatusAskAlready(existing.status),
        };
      }
      if (!callbacks.setStatusAsk) {
        return { ok: false, error: "status ask is unavailable in this session" };
      }
      const parked = callbacks.setStatusAsk(req.taskId, {
        status: req.status,
        reason: req.reason?.trim() ? req.reason.trim() : null,
        requesterId: req.requesterId ?? null,
        at: Date.now(),
      });
      if (!parked.ok) return parked;
      return {
        ok: true,
        pending: true,
        already: false,
        status: existing.status,
        requestedStatus: req.status,
        divergedStatus: decision.divergedStatus,
        message: describeStatusAskParked(req.status, existing.status),
      };
    }

    function serializeSprint(s: import("./store").SprintRow) {
      return {
        id: s.id,
        boardId: s.board_id,
        number: s.number,
        name: s.name,
        startedAt: s.started_at,
        closedAt: s.closed_at,
        countTodo: s.count_todo,
        countDoing: s.count_doing,
        countDone: s.count_done,
        countFailed: s.count_failed,
        migratedIn: s.migrated_in,
        migratedOut: s.migrated_out,
        hasSnapshot: s.snapshot_json != null,
      };
    }

    if (req.cmd === "list_sprints") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      if (!callbacks.boardExists(req.boardId)) return { ok: false, error: `no such board "${req.boardId}"` };
      return { ok: true, sprints: callbacks.listSprints(req.boardId).map(serializeSprint) };
    }

    if (req.cmd === "open_sprint") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      const result = callbacks.openSprint(req.boardId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(req.boardId);
      return { ok: true, sprint: serializeSprint(result.sprint) };
    }

    if (req.cmd === "close_sprint") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      const result = callbacks.closeSprint(req.boardId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(req.boardId);
      return { ok: true, closed: serializeSprint(result.closed), opened: serializeSprint(result.opened) };
    }

    if (req.cmd === "rename_sprint") {
      if (!req.sprintId) return { ok: false, error: "missing sprintId" };
      const name = req.name === undefined ? null : req.name;
      const result = callbacks.renameSprint(req.sprintId, name);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(result.sprint.board_id);
      return { ok: true, sprint: serializeSprint(result.sprint) };
    }

    if (req.cmd === "delete_sprint") {
      if (!req.sprintId) return { ok: false, error: "missing sprintId" };
      const result = callbacks.deleteSprint(req.sprintId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(result.deleted.board_id);
      return {
        ok: true,
        deleted: serializeSprint(result.deleted),
        restored: result.restored ? serializeSprint(result.restored) : null,
        movedTaskCount: result.movedTaskCount,
      };
    }

    if (req.cmd === "list_connectors") {
      return {
        ok: true,
        connectors: callbacks.listAllConnectors().map((c) => ({
          id: c.id,
          fromCardId: c.from_card_id,
          toCardId: c.to_card_id,
          kind: c.kind,
          label: c.label,
        })),
      };
    }

    // Spawn registry read — parent + children + depth. No push; poll when
    // you need lineage (owner 2026-09-14: register always, notify never).
    if (req.cmd === "spawn_lineage") {
      if (!req.cardId) return { ok: false, error: "missing cardId" };
      const parentOf = (id: string) => callbacks.findSpawnByChild(id) ?? null;
      const serialize = (row: SpawnRow) => ({
        id: row.id,
        boardId: row.board_id,
        fromCardId: row.from_card_id,
        toCardId: row.to_card_id,
        reason: row.reason,
        taskId: row.task_id,
        provider: row.provider,
        cardKind: row.card_kind,
        cwd: row.cwd,
        origin: row.origin,
        createdAt: row.created_at,
        depth: deriveSpawnDepth(row.to_card_id, parentOf),
      });
      const parentRow = callbacks.findSpawnByChild(req.cardId);
      const children = callbacks.listSpawnsByParent(req.cardId).map(serialize);
      return {
        ok: true,
        cardId: req.cardId,
        depth: deriveSpawnDepth(req.cardId, parentOf),
        parent: parentRow ? serialize(parentRow) : null,
        children,
      };
    }

    if (req.cmd === "set_connector_kind") {
      if (!req.connectorId) return { ok: false, error: "missing connectorId" };
      // DESIGN-BACKLOG.md item 62 — "spawned" included here so an
      // orchestrator/human can also manually apply or clear it, even
      // though the app itself only ever sets it automatically (see
      // `addConnector` in App.tsx) — this cmd never sets it on its own.
      const validKinds = ["context", "depends", "spawned", null];
      if (req.kind !== undefined && !validKinds.includes(req.kind)) {
        return { ok: false, error: `kind must be one of context, depends, spawned, or null` };
      }
      const kind = req.kind ?? null;
      // Guarda de autoria — RODADA 2 (card 337, "fila 85975417"):
      // estreitada pra só se aplicar quando a escrita afeta linhagem
      // `spawned` (setar `spawned`, ou mexer num conector que JÁ era
      // `spawned`); qualquer outra (context/depends/null advisory) é
      // livre — ver `connector-kind-authorization.ts` pro porquê e pro
      // que isso destrava. Roda ANTES do write: recusar depois de gravar
      // não recusaria nada. Lê o conector pelo id, sem callback novo.
      const endpoints = callbacks
        .listAllConnectors()
        .find((c) => c.id === req.connectorId);
      // Conector inexistente responde com a MESMA mensagem (id incluso) de
      // antes desta guarda — quem depura um id errado precisa ver qual id
      // foi. A guarda de autoria só opina sobre conector que existe.
      if (!endpoints) return { ok: false, error: `no such connector "${req.connectorId}"` };
      const decision = decideConnectorKindWrite(
        req.requesterId,
        { fromCardId: endpoints.from_card_id, toCardId: endpoints.to_card_id, currentKind: endpoints.kind },
        kind,
      );
      if (!decision.allowed) return { ok: false, error: decision.error };
      const found = callbacks.setConnectorKind(req.connectorId, kind);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
      // Ver `onConnectorKindChanged` — mesma ordem do irmão
      // `set_connector_label` logo abaixo: só empurra DEPOIS de o UPDATE
      // ter confirmado que a linha existe, senão um id inválido faria o
      // renderer receber push de um conector que não está lá.
      callbacks.onConnectorKindChanged(req.connectorId, kind, callbacks.getConnectorBoardId(req.connectorId));
      return { ok: true };
    }

    if (req.cmd === "set_connector_label") {
      // 2026-09-09 — "contextualizar em tempo real": the explicit-update
      // half of the feature (the automatic half lives in App.tsx's
      // `autoConnect`, which refreshes an EXISTING connector's label on a
      // later `send`/etc. between the same pair). This is for a caller
      // that wants to set it directly — e.g. an orchestrator annotating
      // what a dependent card is doing right now, same spirit as
      // `set_connector_kind` letting it tag `depends`/`context` by hand.
      if (!req.connectorId) return { ok: false, error: "missing connectorId" };
      const label = req.label ? truncateForLabel(req.label) : null;
      const found = callbacks.setConnectorLabel(req.connectorId, label);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
      // Achado 2 (review adversarial, 2026-09-09) — passes the connector's
      // OWN board along so index.ts can filter against whichever board is
      // actually open before pushing; this cmd handler doesn't know or
      // care which board that is, it just always looks the connector's up
      // and hands it over (`getConnectorBoardId` returns `undefined` in
      // the unlikely case the row vanished between the UPDATE above and
      // this lookup — index.ts's filter naturally drops that too, since
      // `undefined !== activeBoardId`).
      callbacks.onConnectorLabelChanged(req.connectorId, label, callbacks.getConnectorBoardId(req.connectorId));
      return { ok: true };
    }

    if (req.cmd === "concurrency_status") {
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 6 — a
      // real count (`isCardAlive`, not just "has a card row"), same
      // "bash isn't an agent" convention `store.ts`'s cardCounts already
      // uses. Purely advisory — this app doesn't queue or refuse a spawn
      // over this. Deciding what to do with the number is up to whoever
      // calls it.
      const running = listTerminalCards().filter((c) => c.provider !== "bash" && callbacks.isCardAlive(c.id)).length;
      const cap = req.cap ?? DEFAULT_CONCURRENCY_CAP;
      return { ok: true, running, cap, atCap: running >= cap };
    }

    if (req.cmd === "board_mode") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const boardId = callbacks.getCardBoardId(req.target);
      if (!boardId) return { ok: false, error: `no such card "${req.target}"` };
      // DESIGN-BACKLOG.md item 60, peça 2 — `concurrencyCap` always
      // reports the EFFECTIVE cap (board override, else the global
      // default), never null, so a caller never has to know the fallback
      // constant itself.
      return {
        ok: true,
        autonomous: callbacks.isBoardAutonomous(boardId),
        concurrencyCap: callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP,
        // DESIGN-BACKLOG.md item 60, peça 1 — lets a caller introspect
        // queue depth without a dedicated tool; 0 for every board that
        // isn't autonomous (the queue only ever applies there).
        queueLength: (spawnQueue.get(boardId) ?? []).length,
      };
    }

    if (req.cmd === "build_identity") {
      // Passive: which binary is holding the socket. No consent. Same
      // fields `hello` already carries for `acbridge version`.
      const identity = callbacks.getBuildIdentity?.();
      if (!identity) return { ok: false, error: "build identity unavailable" };
      return { ok: true, ...identity };
    }

    if (req.cmd === "spawn_agent") {
      if (!req.provider) return { ok: false, error: "missing provider" };
      // Spawn registry (2026-09-14): agent must declare reason — refuse
      // naming the field (same class as report-retry-decision). Not a
      // spawn gate otherwise; human/system paths skip this.
      const reasonDecision = decideSpawnReason({ requesterId: req.requesterId, reason: req.reason });
      if (reasonDecision.action === "refuse") return { ok: false, error: reasonDecision.error };
      // effort/model vs provider capacity — the gate is DERIVED, not
      // hardcoded per provider (2026-09-15): which providers honor
      // `effort` (and with which measured range) and `model` is declared
      // in `ProviderCapacity` (providers.ts), and the pure decision in
      // spawn-profile-decision.ts turns that declaration into a refusal
      // sentence. Same refuse-never-silently-remap rule the two
      // per-provider ifs here used to enforce (writeup moved with the
      // ranges to `EffortCapability`'s comment in providers.ts) — now
      // with the second half the old gate didn't have: a provider that
      // CANNOT honor the field refuses it instead of accepting it and
      // dropping it in silence. Checked before the spawn-depth budget
      // below is touched — an invalid request shouldn't cost the caller
      // part of its recursion allowance.
      const profileDecision = decideSpawnProfile({
        providerId: req.provider,
        model: req.model,
        effort: req.effort,
      });
      if (!profileDecision.ok) return { ok: false, error: profileDecision.error };
      // `role` (task_cards.role) — same refuse-don't-remap rule as effort,
      // and checked before depth is spent. `undefined` keeps today's
      // default (implementer); only an unknown string is refused.
      const role = req.role === undefined ? null : normalizeTaskCardRole(req.role);
      if (req.role !== undefined && role === null) {
        return {
          ok: false,
          error: `role must be one of ${TASK_CARD_ROLES.map((r) => `"${r}"`).join(", ")} (or omitted for implementer), got "${String(req.role)}" — refusing to spawn rather than silently substituting a role`,
        };
      }
      // isolation (2026-09-19) — `worktree` = o card nasce numa worktree
      // descartável do projeto, nunca na árvore compartilhada (AGENTS.md
      // §3.5). Puro e sem efeito; o preparo (git + cópia do declarado) roda
      // mais abaixo, depois do teto de profundidade. Valor desconhecido é
      // RECUSADO: um `isolation` não honrado deixaria o card na árvore
      // compartilhada achando que está isolado.
      const isolationDecision = decideSpawnIsolation(req.isolation);
      if (!isolationDecision.ok) return { ok: false, error: isolationDecision.error };
      const isolation = isolationDecision.isolation;
      // taskId vs brief is resolved here, before depth is spent and
      // before dispatch — a missing task or an ambiguous pair must not
      // open a mute card. The delivered text then goes through
      // `dispatchSpawnAgentRequest` (the one argv-vs-type split).
      const briefDecision = resolveSpawnBrief(
        { taskId: req.taskId, brief: req.brief, role },
        { findTask: (id) => callbacks.getTask(id) },
      );
      if (!briefDecision.ok) return { ok: false, error: briefDecision.error };
      // Implementer tied to a task: same brief as auto-dispatch (prompt +
      // dep pointer + contract). Reviewer keeps the free review order.
      const taskForBrief = briefDecision.taskId ? callbacks.getTask(briefDecision.taskId) : undefined;
      // Regra (b), sticky de território (2026-09-20) — um implementador
      // amarrado a uma task não nasce sobre território que outra task
      // ATIVA do MESMO board já reivindica. Reviewer fica de fora: revisão
      // lê o trabalho alheio, não escreve o território declarado dele.
      // Território ausente na candidata é o caso comum (não declarado é
      // normal) — checado ANTES de tocar `listTasks`, para não pedir aos
      // callbacks algo que uma task sem território nunca precisou.
      const territoryForConflict = taskForBrief ? territoryFromSql(taskForBrief.territory_json) : null;
      if (taskForBrief && territoryForConflict && role !== TASK_CARD_REVIEWER_ROLE && taskForBrief.board_id) {
        const conflict = decideTerritoryConflict({
          taskId: taskForBrief.id,
          territory: territoryForConflict,
          activeTasks: activeTaskTerritories(taskForBrief.board_id, taskForBrief.id),
        });
        if (!conflict.ok) return { ok: false, error: conflict.error };
      }
      const deliveredBrief =
        briefDecision.taskId && role !== TASK_CARD_REVIEWER_ROLE && taskForBrief
          ? briefForTask(taskForBrief)
          : briefDecision.brief;
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // Pre-release audit S4 — ignores `req.depth` entirely; see
      // `cardSpawnDepth`'s own comment above for why.
      const requesterDepth = requesterId ? (cardSpawnDepth.get(requesterId) ?? 0) : 0;
      if (requesterDepth >= MAX_SPAWN_DEPTH) {
        return { ok: false, error: `spawn depth limit reached (max ${MAX_SPAWN_DEPTH}) — refusing to spawn another agent` };
      }
      const depth = requesterDepth + 1;
      // isolation:"worktree" — a worktree é criada AQUI, antes do dispatch,
      // porque o renderer cria o card com o cwd que chega neste ponto. O
      // checkout de origem é o cwd do request, ou o do card chamador; sem
      // nenhum dos dois, RECUSA em vez de adivinhar. Recusa/expiração do
      // consentimento faz rollback (ver `spawnResult` abaixo).
      let worktree: { path: string; sourceRoot: string } | undefined;
      if (isolation === "worktree") {
        const requesterCwd = requesterId ? callbacks.listCards().find((c) => c.id === requesterId)?.cwd : undefined;
        const prep = await prepareIsolatedWorktree({
          sourceCwd: (req.cwd ?? "").trim() || (requesterCwd ?? "").trim(),
        });
        if (!prep.ok) return { ok: false, error: prep.error };
        worktree = { path: prep.path, sourceRoot: prep.sourceRoot };
        // Declarado e ausente é dado, não falha — mas VISÍVEL: uma worktree
        // sem `.env` pode falhar um gate por um motivo que o card sozinho
        // não consegue ver.
        if (prep.missing.length > 0) {
          console.error(
            `worktree isolation: declared paths absent in ${prep.sourceRoot}: ${prep.missing.join(", ")}`,
          );
        }
      }
      // DESIGN-BACKLOG.md item 59 — the ONE place `autoApprove` can ever
      // become true: the requester's own board opted in via the human-
      // only UI toggle. No MCP/acbridge cmd reaches this flag.
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      // Connector pill: ONE source — `deriveAutoConnectLabel` here, before
      // the renderer draws the arrow. `reason` is consent-modal text only
      // (measured 2026-09-14: every filled `kind=spawned` label was a
      // free-text reason — board rules, stop orders — never the relation).
      // Use the resolved taskId (briefDecision) so a refused/missing task
      // never reaches this line with a stale id.
      const connectorLabel = deriveAutoConnectLabel({
        ...req,
        cmd: "spawn_agent",
        taskId: briefDecision.taskId,
        role: role ?? undefined,
      });
      const spawnParams = {
        provider: req.provider as string,
        // The worktree path wins when isolation ran — the renderer creates
        // the card with THIS cwd, and the PTY is spawned there.
        cwd: worktree?.path ?? req.cwd,
        resumeId: req.resumeId,
        depth,
        reason: reasonDecision.reason ?? undefined,
        model: req.model,
        effort: req.effort,
        label: req.label,
        brief: deliveredBrief,
        taskId: briefDecision.taskId,
        connectorLabel,
      };
      const spawnResult: SpawnAgentResult =
        autonomous && requesterBoardId
          ? await autonomousSpawn(requesterBoardId, requestId, requesterId, spawnParams)
          : await dispatchSpawnAgentRequest(requestId, requesterId, spawnParams, false);
      // Consent refused/didn't arrive, or the card creation itself failed:
      // NO card will ever run in this worktree, so it must not survive. A
      // successful spawn keeps it (the card's own cwd points at it).
      if (!spawnResult.ok && worktree) {
        void removeIsolatedWorktree(worktree);
      }
      if (spawnResult.ok) {
        cardSpawnDepth.set(spawnResult.cardId, depth);
        // Spawn registry — derived fields only; reason already decided.
        // No notification (register always, notify never).
        const boardId =
          requesterBoardId ??
          callbacks.getCardBoardId(spawnResult.cardId) ??
          taskForBrief?.board_id ??
          undefined;
        if (boardId) {
          try {
            callbacks.recordSpawn({
              boardId,
              fromCardId: requesterId || null,
              toCardId: spawnResult.cardId,
              reason: reasonDecision.reason,
              taskId: briefDecision.taskId ?? null,
              provider: req.provider,
              cardKind: "terminal",
              // The EFFECTIVE cwd — a worktree path when isolation ran, not
              // the source repo the request named.
              cwd: spawnParams.cwd ?? null,
              origin: reasonDecision.origin,
            });
          } catch (e) {
            // UNIQUE(to_card_id) collision is a logic bug; surface in logs
            // but do not undo a successful spawn.
            console.error("recordSpawn failed after spawn_agent:", e);
          }
        }
        // Fact on the participation: what actually went to argv.
        const profile = profileFromSpawnArgs({
          provider: req.provider,
          model: req.model,
          effort: req.effort,
          resumeId: req.resumeId,
        });
        if (briefDecision.taskId && role === TASK_CARD_REVIEWER_ROLE) {
          // Reviewer: role row ONLY. `tasks.card_id` stays on whoever is
          // implementing — `report` derives the in-line retry budget and
          // `accept_failure` → task failed from `card_id`, and a
          // reviewer's `{ok:false}` is a verdict on someone else's work,
          // not this task failing. `recordParticipationRound` fans out
          // through task_cards, so the reviewer's rounds/verdicts land
          // with role "reviewer" (the Fila ` ↔ review` arrow reads this).
          callbacks.linkTaskCard(briefDecision.taskId, spawnResult.cardId, role, profile);
        } else if (briefDecision.taskId) {
          const latest = callbacks.getTask(briefDecision.taskId);
          if (latest) linkImplementerToTask(latest, spawnResult.cardId, "agent", profile);
        }
      }
      // Nota de deps no RETORNO (task 095158e9, item b) — INFORMAR não é
      // IMPEDIR: despachar fora de ordem é decisão legítima do orquestrador
      // (uma medição num território travado, por exemplo), e o brief já
      // carrega o estado de cada dep. A nota só antecipa o fato para quem
      // despacha, no momento em que despacha. Lê só o stored (sem reports,
      // sem I/O); reviewer não recebe dep pointer, então a nota também não
      // se aplica a ele.
      const depIds = taskForBrief && role !== TASK_CARD_REVIEWER_ROLE ? depIdsFromJson(taskForBrief.deps_json) : [];
      const pendingDeps = depIds.filter((depId) => callbacks.getTask(depId)?.status !== "done").length;
      const withDepNote = (result: SpawnAgentResult): SpawnAgentResult =>
        result.ok && pendingDeps > 0
          ? {
              ...result,
              note: `${pendingDeps} of ${depIds.length} dep(s) of this task are not done yet — the card's brief carries each dependency's status and its latest report`,
            }
          : result;

      // DESIGN-BACKLOG.md item 58, M4 — `wait: true` holds this call open
      // past "the human approved and the card exists" (spawnResult above)
      // until the process actually exits, so the caller gets a real
      // completion signal instead of having to poll card_status/snapshot
      // in a loop. Not an error if the wait window runs out first — the
      // spawn itself still succeeded, it's just still running.
      if (!req.wait || !spawnResult.ok) return withDepNote(spawnResult);
      const cardId = spawnResult.cardId;
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          const waiters = pendingCardExits.get(cardId);
          if (waiters) {
            const idx = waiters.indexOf(onExit);
            if (idx !== -1) waiters.splice(idx, 1);
            if (waiters.length === 0) pendingCardExits.delete(cardId);
          }
          resolve(null);
        }, req.waitTimeoutMs ?? DEFAULT_WAIT_EXIT_TIMEOUT_MS);
        const onExit = (code: number) => {
          clearTimeout(timer);
          resolve(code);
        };
        const waiters = pendingCardExits.get(cardId) ?? [];
        waiters.push(onExit);
        pendingCardExits.set(cardId, waiters);
      });
      return exitCode === null ? withDepNote(spawnResult) : withDepNote({ ...spawnResult, exited: true, exitCode });
    }

    if (req.cmd === "spawn_card") {
      const validKinds: SpawnCardKind[] = ["files", "changes", "sticky", "browser", "remote-window", "task", "media"];
      if (!req.kind || !validKinds.includes(req.kind as SpawnCardKind)) {
        return { ok: false, error: `kind must be one of ${validKinds.join(", ")}` };
      }
      const reasonDecision = decideSpawnReason({ requesterId: req.requesterId, reason: req.reason });
      if (reasonDecision.action === "refuse") return { ok: false, error: reasonDecision.error };
      // Pendentes #188 ("spawn_card por coordenadas") — validated here, not
      // just by mcp-server.ts's zod schema: acbridge talks to this bus
      // directly over the socket, no zod in that path at all (same reason
      // write_sticky's `mode` is re-checked here too).
      const validSides = ["left", "right", "top", "bottom"] as const;
      if (req.side !== undefined && !validSides.includes(req.side)) {
        return { ok: false, error: `side must be one of ${validSides.join(", ")}` };
      }
      if (req.anchorCardId !== undefined && !callbacks.listCards().some((c) => c.id === req.anchorCardId)) {
        return { ok: false, error: `no open card with id "${req.anchorCardId}"` };
      }
      const requesterId = req.requesterId ?? "";
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      // A task card is a singleton per board. This main-process check makes
      // an MCP/acbridge request reuse the live queue immediately, without a
      // needless consent dialog. The anchor is a useful fallback for a
      // caller that names no card; the renderer repeats the guard at the
      // actual creation point to cover two requests approved concurrently.
      const taskBoardId = requesterBoardId ?? (req.anchorCardId ? callbacks.getCardBoardId(req.anchorCardId) : undefined);
      if (req.kind === "task" && taskBoardId) {
        const taskDecision = decideTaskCardSpawn(callbacks.listCardsForBoard(taskBoardId), taskBoardId);
        if (taskDecision.action === "reuse") return { ok: true, cardId: taskDecision.cardId };
      }
      if (req.kind === "browser" && req.url) {
        const spawnUrlError = navigationUrlError(req.url);
        if (spawnUrlError) return { ok: false, error: spawnUrlError };
      }
      // `kind: "media"` — validate + COPY into board-assets before consent
      // (MediaCard only loads stellar-asset://; a bare reference would
      // 404). Same permanence as human paste/drop (board-assets.ts).
      let mediaAssetPath: string | undefined;
      let mediaType: SpawnMediaType | undefined;
      let mediaSourcePath: string | undefined;
      if (req.kind === "media") {
        const callerCwd = requesterId
          ? callbacks.listCards().find((c) => c.id === requesterId)?.cwd
          : undefined;
        const pathDecision = decideSpawnMediaPath({ path: req.path, cwd: callerCwd });
        if (pathDecision.action === "refuse") return { ok: false, error: pathDecision.error };
        const boardIdForAsset =
          requesterBoardId ?? taskBoardId ?? callbacks.getActiveBoardId?.() ?? undefined;
        if (!boardIdForAsset) {
          return { ok: false, error: 'kind "media" needs a board (caller card must belong to one, or a board must be open)' };
        }
        if (!callbacks.prepareMediaAsset) {
          return { ok: false, error: "media spawn is unavailable in this process" };
        }
        const prepared = callbacks.prepareMediaAsset(boardIdForAsset, pathDecision.resolvedPath);
        if (!prepared.ok) return { ok: false, error: prepared.error };
        mediaAssetPath = prepared.path;
        mediaType = pathDecision.mediaType;
        mediaSourcePath = pathDecision.resolvedPath;
      }
      const requestId = randomUUID();
      // DESIGN-BACKLOG.md item 60, peça 5 — same board-scoped auto-approve
      // as `open` above.
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      // Ideia registrada no sticky "Ideias/Brainstorm" (192), verificada e
      // aplicada 2026-09-06 — `spawn_card` de uma sticky é a MESMA classe
      // de risco de `write_sticky` (já sem gate humano nenhum): reversível
      // com um clique, sem side-effect de disco ou de processo (ao
      // contrário de `browser`/`remote-window`/`files`/`changes`, que
      // abrem uma página real, um processo remoto, ou expõem o
      // filesystem). Numa sessão remota sem humano no PC, o modal de
      // consentimento simplesmente trava o agente pra sempre nesse caso —
      // isentar só `sticky`, isolado dos outros kinds, que continuam
      // exigindo o modal normalmente fora de um board autônomo.
      // `media` stays gated: it writes a durable copy under board-assets.
      const autoApprove = autonomous || req.kind === "sticky";
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawnCards.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, SPAWN_TIMEOUT_MS);
        pendingSpawnCards.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSpawnCards.delete(requestId);
            unmarkWaiting(requesterId);
            if (result.ok) {
              const boardId =
                requesterBoardId ?? callbacks.getCardBoardId(result.cardId) ?? taskBoardId ?? undefined;
              // Reuse paths (task singleton, etc.) resolve ok with an
              // existing cardId — do not invent a second birth.
              if (boardId && !callbacks.findSpawnByChild(result.cardId)) {
                try {
                  callbacks.recordSpawn({
                    boardId,
                    fromCardId: requesterId || null,
                    toCardId: result.cardId,
                    reason: reasonDecision.reason,
                    taskId: null,
                    provider: null,
                    cardKind: req.kind as string,
                    cwd: req.kind === "media" ? mediaSourcePath ?? null : req.cwd ?? null,
                    origin: reasonDecision.origin,
                  });
                } catch (e) {
                  console.error("recordSpawn failed after spawn_card:", e);
                }
              }
            }
            resolve(result);
          },
          timer,
        });
        callbacks.onSpawnCardRequest(requestId, requesterId, {
          kind: req.kind as SpawnCardKind,
          cwd: req.cwd,
          url: req.url,
          reason: reasonDecision.reason ?? undefined,
          autoApprove,
          anchorCardId: req.anchorCardId,
          side: req.anchorCardId ? (req.side ?? "right") : undefined,
          assetPath: mediaAssetPath,
          mediaType,
          path: mediaSourcePath,
        });
      });
    }

    return { ok: false, error: `unknown cmd "${(req as { cmd?: string }).cmd}"` };
  }

  function resolveOpen(requestId: string, allowed: boolean, cardId?: string) {
    pendingOpens.get(requestId)?.resolve(allowed, cardId);
  }

  function resolveCloseCard(requestId: string, allowed: boolean) {
    pendingCloseCards.get(requestId)?.resolve(allowed);
  }

  function resolveSnapshot(requestId: string, result: SnapshotResult) {
    pendingSnapshots.get(requestId)?.resolve(result);
  }

  function resolvePageText(requestId: string, result: PageTextResult) {
    pendingPageTexts.get(requestId)?.resolve(result);
  }

  function resolveReadCard(requestId: string, result: ReadCardResult) {
    pendingReadCards.get(requestId)?.resolve(result);
  }

  function resolveSticky(requestId: string, result: StickyResult) {
    pendingStickyOps.get(requestId)?.resolve(result);
  }

  function resolveSpawnAgent(requestId: string, result: SpawnAgentResult) {
    pendingSpawnAgents.get(requestId)?.resolve(result);
  }

  /** DESIGN-BACKLOG.md §2.1 "SINAL 2", achado de review adversarial
   * (achado 3, MÉDIO) — avisar o spawner só quando havia trabalho
   * esperado: (a) task vinculada (qualquer status) OU (b) linhagem de
   * `spawn_agent` (`cardSpawnDepth`) e provider !== `bash`. Ruído de
   * card de apoio (`files`/`browser`/`bash`) ensina o orquestrador a
   * ignorar o sinal. */
  function cardWasExpectedToReport(cardId: string, linkedTask: TaskRow | undefined): boolean {
    if (linkedTask) return true;
    if (!cardSpawnDepth.has(cardId)) return false;
    return callbacks.getAnyCard(cardId)?.provider !== "bash";
  }

  /** DESIGN-BACKLOG.md item 58, M4 — called from pty-registry's own
   * `onExit`, unconditionally, for every card that exits (not just ones
   * with a waiter — cheap Map lookup, no-op when nothing's waiting). */
  function resolveCardExit(cardId: string, exitCode: number) {
    // Live 2026-09-14: origin died / was closed; destination FIFO kept
    // typing that author's queued probes. Cancel not-yet-started sends
    // stamped with this card as requester — BEFORE exit-pointer enqueue
    // (that pointer omits requesterId and must still deliver).
    applyCancelPendingFromRequester(cardId);
    // Exit owns the failure signal now — drop any idle-without-report stamp.
    idleWithoutReportNotified.delete(cardId);
    const waiters = pendingCardExits.get(cardId);
    if (waiters) {
      pendingCardExits.delete(cardId);
      for (const resolve of waiters) resolve(exitCode);
    }
    // DESIGN-BACKLOG.md item 60, peça 1 — a concurrency slot may have just
    // freed on this card's board; drain its queue if so. The card's row
    // (and board_id) still exists in store at this point — a process
    // exiting doesn't delete the card, only closing it does.
    const boardId = callbacks.getCardBoardId(cardId);
    if (boardId) tryDispatchQueued(boardId);
    // DESIGN-BACKLOG.md item 60, peça 4 — the OTHER failure path besides
    // an explicit `update_task({status:"failed"})`: an agent's process
    // exits having never called `report` at all. Achado ao vivo: killing
    // a card's process (`window.pty.kill`, node-pty on this platform)
    // reports `exitCode: 0` even for a signal-killed process — the exit
    // CODE isn't a reliable "it failed" signal at all, so this doesn't
    // gate on it (the doc draft assumed it would; verified live that it
    // doesn't). The real signal is simpler and more robust anyway: a task
    // still `running`, tied to exactly this card, that never got a
    // report — no report ever arriving IS the anomaly, regardless of
    // what exit code accompanied it. A report that DID arrive is not this
    // case — whatever it said is the real outcome, for whoever reads it
    // to call update_task, not this engine to guess.
    const listed = callbacks.listTasks();
    const linkedTask = Array.isArray(listed) ? listed.find((t) => t.card_id === cardId) : undefined;
    const hasReport = !!callbacks.getReport(cardId);
    if (!hasReport) {
      // CAMADA 3 — stored may be `pending` while participation was live;
      // exit without report on a linked non-judgment task is still failure.
      if (linkedTask && !isJudgmentStatus(linkedTask.status)) {
        const lastRefused = lastRefusedReasonFromResultJson(linkedTask.result_json);
        const startedAt = implementerStartedAt.get(cardId);
        implementerStartedAt.delete(cardId);
        const lifetimeMs = startedAt !== undefined ? Date.now() - startedAt : null;
        markTaskFailed(
          { ...linkedTask, result_json: clearLastRefusedStash(linkedTask.result_json) },
          describeExitWithoutAcceptedReport(exitCode, lastRefused),
          "exit_without_report",
          { lifetimeMs },
        );
      } else {
        implementerStartedAt.delete(cardId);
      }
      // Fechar histórico e avisar o spawner são critérios diferentes:
      // qualquer vínculo atual em task_cards fecha a participação, inclusive
      // um card secundário de review; apenas `cardWasExpectedToReport`
      // qualifica o aviso de entrega ao spawner. Card de apoio sem vínculo
      // nenhum não chama recordParticipationRound e não cria linha.
      const taskCardLinks = callbacks.listTaskCardsForCard(cardId) ?? [];
      if (taskCardLinks.length > 0) {
        callbacks.recordParticipationRound(cardId, null, Date.now());
      }
      if (cardWasExpectedToReport(cardId, linkedTask)) {
        // Enqueue (não await): resolveCardExit é síncrono no onExit do
        // pty-registry. A FIFO de 5206f7e segura a vez; sem popup de SO.
        notifySpawnerOfUnreportedExit(cardId, exitCode);
      }
    } else if (linkedTask) {
      // Card exited after reporting — refresh Fila derived status (PTY
      // already dead; participation drops to pending on read).
      callbacks.upsertTask({
        ...linkedTask,
        updated_at: Date.now(),
        actor: "app",
        statusProposed: false,
      });
    }
  }

  function notifyQueueChanged(boardId: string) {
    const list = spawnQueue.get(boardId) ?? [];
    callbacks.onQueueChanged(
      boardId,
      list.map((e) => ({ id: e.id, requesterId: e.requesterId, provider: e.provider, reason: e.reason, requestedAt: e.requestedAt })),
    );
  }

  function removeFromQueue(boardId: string, requestId: string) {
    const list = spawnQueue.get(boardId);
    if (!list) return;
    const idx = list.findIndex((e) => e.id === requestId);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — the actual dispatch, factored out
   * so both the direct-autonomous path and the queue-drain path share it
   * (previously inlined only in the direct path). */
  function dispatchSpawnAgentRequest(
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
    autoApprove: boolean,
  ) {
    let passedBrief = params.brief;
    let typedBrief: string | undefined;

    if (params.brief) {
      // Empirical, not the declaration alone: a stale `briefMechanism`
      // that buildArgs does not implement used to set canArgv=true, skip
      // the typing fallback, and drop the brief in silence. Probe the
      // actual argv. Declaration still answers HOW; this answers WHETHER.
      const canArgv = argvCarriesDeclaredBrief(params.provider, params.brief);
      // 131071 is ARG_MAX on typical Linux; leave some padding for other args/env
      const isTooLarge = Buffer.byteLength(params.brief, "utf8") > 130000;
      if (!canArgv || isTooLarge) {
        passedBrief = undefined;
        typedBrief = params.brief;
      }
    }

    return new Promise<SpawnAgentResult>((resolve) => {
      markWaiting(requesterId);
      const timer = setTimeout(() => {
        pendingSpawnAgents.delete(requestId);
        unmarkWaiting(requesterId);
        resolve({ ok: false, error: "timed out waiting for a decision" });
      }, SPAWN_TIMEOUT_MS);
      pendingSpawnAgents.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingSpawnAgents.delete(requestId);
          unmarkWaiting(requesterId);
          if (result.ok && typedBrief) {
            enqueueCardDelivery(result.cardId, typedBrief);
          }
          resolve(result);
        },
        timer,
      });
      callbacks.onSpawnAgentRequest(requestId, requesterId, { ...params, brief: passedBrief, autoApprove });
    });
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — enqueues instead of refusing when
   * an autonomous board is at its cap; the returned promise settles either
   * when `tryDispatchQueued` later dispatches it for real, or on its own
   * timeout (queue starvation — never left stuck forever). */
  function enqueueSpawn(
    boardId: string,
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
  ) {
    return new Promise<SpawnAgentResult>((resolveOuter) => {
      const timer = setTimeout(() => {
        removeFromQueue(boardId, requestId);
        notifyQueueChanged(boardId);
        resolveOuter({ ok: false, error: "queued spawn timed out waiting for a free slot" });
      }, DEFAULT_QUEUE_TIMEOUT_MS);
      const entry: SpawnQueueEntry = {
        id: requestId,
        requesterId,
        provider: params.provider,
        reason: params.reason,
        requestedAt: Date.now(),
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          resolveOuter(result);
        },
        params,
      };
      const list = spawnQueue.get(boardId) ?? [];
      list.push(entry);
      spawnQueue.set(boardId, list);
      notifyQueueChanged(boardId);
    });
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — called whenever a slot might have
   * freed (currently only from resolveCardExit above). No-op if the
   * queue's empty or the board's still at/over cap. FIFO: always the
   * oldest entry next. */
  function tryDispatchQueued(boardId: string) {
    const list = spawnQueue.get(boardId);
    if (!list || list.length === 0) return;
    const cap = callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP;
    const running = callbacks.countRunningAgentsOnBoard(boardId);
    if (running >= cap) return;
    const entry = list.shift()!;
    notifyQueueChanged(boardId);
    dispatchSpawnAgentRequest(entry.id, entry.requesterId, entry.params, true).then(entry.resolve);
  }

  /** DESIGN-BACKLOG.md item 60, peça 3 — the one entry point BOTH
   * `spawn_agent`'s autonomous branch and the task-dispatch engine below
   * use: cap check, then either straight dispatch or `enqueueSpawn`.
   * Nothing bypasses the cap/queue, whichever path asked for the spawn. */
  function autonomousSpawn(
    boardId: string,
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
  ) {
    const running = callbacks.countRunningAgentsOnBoard(boardId);
    const cap = callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP;
    if (running >= cap) return enqueueSpawn(boardId, requestId, requesterId, params);
    return dispatchSpawnAgentRequest(requestId, requesterId, params, true);
  }

  /** DESIGN-BACKLOG.md item 60, peça 3 — the dependents engine. A task
   * reaching `done` (never `failed` — a dependent shouldn't start on top
   * of a failed prerequisite) unblocks every OTHER pending task whose
   * `deps_json` names it and whose OWN deps are now all satisfied — but
   * only if that task's OWN board opted into autonomous mode; every other
   * task is left untouched, exactly as before this engine existed (pure
   * bookkeeping, an external orchestrator's problem). `onTaskDone` finds
   * the candidates; `dispatchIfUnblocked` is the one dispatch path. */
  /** Parent pointer for a dependent's brief (dep-pointer-decision.ts).
   * Reads only stored facts: each dep row via `getTask` (which carries
   * `task_cards`), and the latest report of every linked card. A dep
   * whose id matches nothing, or whose cards never reported, is stated
   * as such — never silently dropped. Empty deps → no pointer. */
  function depPointerSources(task: Pick<TaskRow, "deps_json">): DepPointerSource[] {
    return depIdsFromJson(task.deps_json).map((depId) => {
      const dep = callbacks.getTask(depId);
      if (!dep) return { id: depId, status: null, reports: [] };
      const cards = Array.isArray(dep.cards) ? dep.cards : [];
      const reports: Array<{ seq: number; summary: DepReportSummary }> = [];
      // Most recent card first: `task_cards` has no order column, so the
      // latest report `seq` stands in for recency.
      for (const card of cards) {
        const row = callbacks.getReport(card.card_id);
        if (row) reports.push({ seq: row.seq, summary: summarizeReport(card.card_id, row.report_json, row.verdict) });
      }
      reports.sort((a, b) => b.seq - a.seq);
      return { id: depId, status: dep.status, reports: reports.map((r) => r.summary) };
    });
  }

  /** The delivered brief for a task-tied implementer spawn: stored prompt
   * plus the parent pointer when the task has deps. Both task-tied spawn
   * paths (`spawn_agent({taskId})` and auto-dispatch) go through here so
   * a dependent never opens without knowing it has a parent, whichever
   * path spawned it. Reviewers do not: their brief is the review order. */
  function briefForTask(task: Pick<TaskRow, "prompt" | "deps_json" | "territory_json" | "gates_json" | "allow_commit" | "report_schema_json">): string | undefined {
    const withDeps = appendDepPointer(briefFromTaskPrompt(task.prompt), depPointerSources(task));
    return appendTaskContract(withDeps, contractFromTaskRow(task));
  }

  function buildTaskDispatchParams(
    task: TaskRow,
    provider: string,
    reason: string,
    cwd: string | undefined,
  ): SpawnQueueEntry["params"] {
    return {
      provider,
      // Resolved cwd (own or inherited); `undefined` keeps App.tsx's
      // `cwd || activeBoardCwd` board-root fallback. See task-dispatch-decision.ts.
      cwd,
      resumeId: undefined,
      depth: 0,
      reason,
      model: undefined,
      effort: undefined,
      label: resolveTaskDispatchLabel(task),
      brief: briefForTask(task),
      taskId: task.id,
      // Same single source as manual spawn_agent — auto-dispatch is still
      // a spawn; the arrow (when a requester exists) must not fall back
      // to `reason` ("auto-dispatch: task …").
      connectorLabel: deriveAutoConnectLabel({
        cmd: "spawn_agent",
        provider,
        taskId: task.id,
      } as BusRequest),
    };
  }

  /** Ancestor rows for cwd inheritance — same `getTask` lookup
   * `depPointerSources` already does per dep, walked for grandparents. */
  function ancestorCwdNodes(rootDepIds: string[], allTasks: TaskRow[]): AncestorCwdNode[] {
    const nodes: AncestorCwdNode[] = [];
    const seen = new Set<string>();
    const queue = [...rootDepIds];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = allTasks.find((t) => t.id === id) ?? callbacks.getTask(id);
      if (!dep) continue;
      const childDeps = depIdsFromJson(dep.deps_json);
      nodes.push({ id: dep.id, cwd: dep.cwd, depIds: childDeps });
      for (const child of childDeps) queue.push(child);
    }
    return nodes;
  }

  /** CAMADA 3 — refuse without writing status. Stamp `result_json` so the
   * Fila shows `interruptionReason`; participation stays derived pending. */
  function recordDispatchRefusal(task: TaskRow, reason: string) {
    const latest = callbacks.getTask(task.id) ?? task;
    if (interruptionReasonFromResultJson(latest.result_json) === reason) return;
    callbacks.upsertTask({
      ...latest,
      result_json: stampFailureKindJson(latest.result_json, "interrompida", reason),
      updated_at: Date.now(),
      actor: "app",
      statusProposed: false,
    });
  }

  /** Regra (b), 2026-09-19 — a task that ALREADY has a live card linked
   * must not be auto-dispatched a second time. The engine only ever looked
   * at `tasks.card_id`: a card the orchestrator spawned and linked through
   * `task_cards` (the role row, `card_id` untouched) was invisible to it,
   * so a dep closing opened another card on a task someone was already
   * implementing — measured: two phantom cards in one day, one of them
   * already working when it was noticed.
   *
   * "Live link" is the store's own criterion (`linked_at >= cards.created_at`,
   * the epoch `listTaskCardsForCard` already reads for the report-role
   * stamp), consulted through that same callback instead of a second
   * timestamp comparison here — one definition of live link, not two.
   * Recycling a dead card's id keeps the old `linked_at` and falls out;
   * the alive check on top covers a link whose card exited (rows survive
   * the close by design, `TaskCardRow`). The `task.card_id` check in
   * `dispatchIfUnblocked` stays: measured, there are tasks with a
   * principal card and NO `task_cards` row at all. */
  function hasLiveLinkedCard(task: TaskRow): boolean {
    const links = callbacks.getTaskCards(task.id) ?? task.cards ?? [];
    return links.some(
      (link) =>
        callbacks.isCardAlive(link.card_id) &&
        (callbacks.listTaskCardsForCard(link.card_id) ?? []).some((l) => l.task_id === task.id),
    );
  }

  /** Território de toda task ATIVA (nunca julgada + implementador vivo, por
   * `card_id` OU só por `task_cards` — mesmo critério de `hasLiveLinkedCard`
   * acima) no board dado, exceto `excludeTaskId`. A lista que
   * `decideTerritoryConflict` compara — mecanismo (b) do sticky de
   * território (2026-09-20). */
  function activeTaskTerritories(boardId: string, excludeTaskId: string): ActiveTaskTerritory[] {
    return callbacks
      .listTasks()
      .filter((t) => t.board_id === boardId && t.id !== excludeTaskId && !isJudgmentStatus(t.status))
      .filter((t) => (t.card_id !== null && callbacks.isCardAlive(t.card_id)) || hasLiveLinkedCard(t))
      .map((t) => ({ taskId: t.id, territory: territoryFromSql(t.territory_json) }));
  }

  /** Called by the write funnel (index.ts → task-write-funnel.ts) — the
   * ONE place that observes a task's status actually changing to `done`,
   * whatever wrote it: `update_task` from an agent, the approve button, a
   * drag to "concluído", Allow on a status ask. This function does not
   * decide *whether* the task reached done; it trusts the funnel's
   * `StatusWriteDecision` and only asks "who was waiting on this id?".
   * Exposed on the bus's public surface for exactly that caller. */
  function onTaskDone(taskId: string) {
    const allTasks = callbacks.listTasks();
    for (const task of allTasks) {
      const deps: string[] = task.deps_json ? JSON.parse(task.deps_json) : [];
      if (!deps.includes(taskId)) continue;
      dispatchIfUnblocked(task, allTasks);
    }
  }

  /** The single dispatch path for a dependent task. Two triggers reach
   * it, never a third copy: a dep transitioning to `done` (`onTaskDone`
   * above) and `create_task` with `deps` that are ALREADY done at birth
   * (2026-09-13 — the child's prompt is usually written AFTER reading the
   * parent's report, so this is the common case, and it used to declare
   * the edge and do nothing). Same checks in both: the task's own board
   * opted into autonomous mode, and EVERY dep is done. Depth is NOT
   * tracked — engine-initiated, never an agent asking to spawn another,
   * so MAX_SPAWN_DEPTH's fork-bomb guard doesn't apply; the DAG bounds it.
   *
   * Returns whether a spawn was actually issued (tests assert on it).
   * Missing provider / divergent cwd → refuse in place (pending + visible
   * reason), never invent `claude` or a path. */
  function dispatchIfUnblocked(task: TaskRow, allTasks: TaskRow[]): boolean {
    if (isJudgmentStatus(task.status) || task.status !== "pending" || !task.board_id) return false;
    if (task.card_id && callbacks.isCardAlive(task.card_id)) return false;
    // Regra (b) — a live card linked only through `task_cards` (no
    // `card_id` on the task) is just as much "someone is already on this".
    if (hasLiveLinkedCard(task)) return false;
    if (dispatchingTaskIds.has(task.id)) return false;
    const deps: string[] = task.deps_json ? JSON.parse(task.deps_json) : [];
    if (deps.length === 0) return false;
    if (!callbacks.isBoardAutonomous(task.board_id)) return false;
    const allDone = deps.every((depId) => allTasks.find((t) => t.id === depId)?.status === "done");
    if (!allDone) return false;
    // The authoritative row, not the caller's snapshot: `onTaskDone` builds
    // its list once and a concurrent write (the `update_task` that declares
    // the cwd, a status ask) can land after that.
    const latest = callbacks.getTask(task.id) ?? task;
    const lastActor = lastStatusActorFromRow(latest);
    if (lastActor === "human" || lastActor === "orchestrator") return false;
    if (
      (task.diverged_actor === "human" || task.diverged_actor === "orchestrator") &&
      task.diverged_status === "pending"
    ) {
      return false;
    }

    const providerDecision = decideTaskDispatchProvider(latest.provider);
    if (providerDecision.action === "refuse") {
      recordDispatchRefusal(latest, providerDecision.reason);
      return false;
    }
    // Regra (a) — `latest.cwd`, nunca a raiz do board em silêncio. The
    // declared cwd is read from the authoritative row above: a task whose
    // cwd was declared by an `update_task` that landed after the snapshot
    // reached here with `cwd: null`, `decideTaskDispatchCwd` returned
    // `undefined`, and the renderer's `cwd || activeBoardCwd` then opened
    // the card at the board root with nothing on the task saying so. A task
    // with no cwd anywhere still falls back to the board root — that
    // fallback is declared (task-dispatch-decision.ts), not silent.
    const cwdDecision = decideTaskDispatchCwd(latest.cwd, ancestorCwdNodes(deps, allTasks), deps);
    if (cwdDecision.action === "refuse") {
      recordDispatchRefusal(latest, cwdDecision.reason);
      return false;
    }
    // Regra (b), sticky de território (2026-09-20) — auto-dispatch é spawn
    // igual a `spawn_agent`; mesma recusa quando o território da task colide
    // com o de outra task ATIVA do mesmo board. Território ausente é o caso
    // comum — checado antes de tocar `listTasks`, mesma disciplina do
    // `spawn_agent` acima.
    const territoryForConflict = territoryFromSql(latest.territory_json);
    if (territoryForConflict) {
      const territoryConflict = decideTerritoryConflict({
        taskId: latest.id,
        territory: territoryForConflict,
        activeTasks: activeTaskTerritories(task.board_id, latest.id),
      });
      if (!territoryConflict.ok) {
        recordDispatchRefusal(latest, territoryConflict.error);
        return false;
      }
    }

    dispatchingTaskIds.add(task.id);
    const requestId = randomUUID();
    const params = buildTaskDispatchParams(
      task,
      providerDecision.provider,
      `auto-dispatch: task ${task.id} (deps satisfied)`,
      cwdDecision.cwd,
    );
    autonomousSpawn(task.board_id, requestId, "", params).then((result) => {
      dispatchingTaskIds.delete(task.id);
      if (result.ok) {
        linkImplementerToTask(
          task,
          result.cardId,
          "app",
          profileFromSpawnArgs({ provider: params.provider, model: params.model, effort: params.effort }),
        );
      } else {
        markTaskFailed(task, result.error, "spawn_failed");
      }
    });
    return true;
  }

  /** DESIGN-BACKLOG.md item 60, peça 4 + "Falha TIPADA" — cause is an
   * argument, never assumed. `exit_without_report` → interrompida (back
   * to "a fazer") UNLESS the card died under the lifetime floor
   * (exit-lifetime-decision.ts): that is a launch diagnosis → `failed`
   * with a visible reason, not a silent pending that invites another
   * spawn. `retry_spawn_failed` / `spawn_failed` stay interrompida.
   * A task that already carries `failureKind: julgada` is NEVER
   * downgraded. The app does not respawn after this write (2023a74). */
  function markTaskFailed(
    task: TaskRow,
    error: string,
    source: FailureSource,
    opts?: { lifetimeMs?: number | null },
  ) {
    // Always re-read: callers (e.g. dispatchIfUnblocked `.then`) may hold
    // a snapshot older than an intervening exit/human write.
    const latest = callbacks.getTask(task.id) ?? task;
    const existingKind = failureKindFromResultJson(latest.result_json);

    let status: string;
    let failureKind: "julgada" | "interrompida";
    let finalError = error;
    if (source === "exit_without_report" && existingKind !== "julgada") {
      const exitWrite = decideExitWithoutReportWrite({
        lifetimeMs: opts?.lifetimeMs ?? null,
        exitError: error,
      });
      status = exitWrite.status;
      failureKind = exitWrite.failureKind;
      finalError = exitWrite.error;
    } else {
      const kind = resolveFailureKind(existingKind, source);
      const write = decideFailureWrite(kind);
      status = write.status;
      failureKind = write.failureKind;
    }

    const next: TaskRow = {
      ...latest,
      status,
      result_json: stampFailureKindJson(latest.result_json, failureKind, finalError),
      updated_at: Date.now(),
      actor: "app",
    };
    const decision = callbacks.upsertTask(next);
    if (!decision.statusChanged) return;
    // Retry is in-line on `report` (same agent, same session). The app
    // never respawns or reassigns here — a human/orchestrator does that.
  }

  function resolveSpawnCard(requestId: string, result: SpawnCardResult) {
    pendingSpawnCards.get(requestId)?.resolve(result);
  }

  // Defasagem acbridge↔bus vai pro log do main UMA vez por forma
  // (kind+versão), não a cada request — o Stop hook do Claude Code chama
  // `acbridge turn-complete` a cada turno, e um acbridge antigo vivo
  // inundaria o stderr sem acrescentar informação. O aviso pro AGENTE vai
  // no `warning` da resposta, esse sim a cada request.
  const protocolDriftLogged = new Set<string>();
  function logProtocolDrift(check: ProtocolCheck, message: string) {
    const key = `${check.kind}:${"theirs" in check ? check.theirs : ""}`;
    if (protocolDriftLogged.has(key)) return;
    protocolDriftLogged.add(key);
    console.error("message-bus: protocolo acbridge —", message);
  }

  // allowHalfOpen: true — acbridge writes its request then immediately
  // calls socket.end() (half-closing its write side) while it waits to read
  // the reply. Node's default (false) would make the server echo that FIN
  // and fully close its own side right away, killing an "open" request
  // (which deliberately holds the socket for as long as the human takes to
  // decide) before resolveOpen() ever gets to write the reply.
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Pre-release audit B3 — used to be `buf = ""` after taking just the
      // FIRST line, silently discarding any bytes past the first `\n` in
      // this same chunk. `acbridge` only ever writes one line per
      // connection today, so this was unreachable in practice, but it's a
      // real correctness bug in the parser itself — collect every
      // complete line actually present in the chunk (`buf.slice(nl + 1)`
      // keeps the remainder instead of dropping it), dispatch all of
      // them, and reply with one JSON-line response per request, in
      // order, before closing.
      const lines: string[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (lines.length === 0) return;
      Promise.all(
        lines.map((line): Promise<unknown> => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return Promise.resolve({ ok: false, error: "invalid json" });
          }
          // Único ponto em que um acbridge (ou cliente cru) entra no bus —
          // é aqui, e só aqui, que a versão do protocolo é conferida. O
          // caminho MCP chama `handleRequest` direto no mesmo processo/
          // build e não tem defasagem possível. Ver o cabeçalho de
          // acbridge-protocol-decision.ts pela política (aceita+avisa
          // quando o acbridge é mais velho; recusa quando é mais novo).
          const check = checkAcbridgeProtocol(parsed);
          const decision = decideAcbridgeProtocol(check);
          if (!decision.accept) {
            logProtocolDrift(check, decision.error);
            return Promise.resolve({ ok: false, error: decision.error });
          }
          if (decision.warning) logProtocolDrift(check, decision.warning);
          const req = stripProtocolStamp(parsed) as BusRequest;
          if (req.cmd === "hello") {
            // Handshake explícito (`acbridge version`): devolve o
            // protocolo do bus pra quem quiser conferir sem esperar um
            // request real dar errado. Build identity rides along so the
            // same one-liner answers "which Stellar is listening?".
            const identity = callbacks.getBuildIdentity?.();
            return Promise.resolve({
              ok: true,
              protocol: ACBRIDGE_PROTOCOL,
              ...(identity ?? {}),
              ...(decision.warning ? { warning: decision.warning } : {}),
            });
          }
          return handleRequest(req, { channel: "socket" }).then((res) => (decision.warning ? { ...res, warning: decision.warning } : res));
        }),
      ).then((results) => {
        socket.end(results.map((r) => JSON.stringify(r)).join("\n") + "\n");
      });
    });
  });
  // Without this, a bind failure (stale non-socket file at sockPath, a
  // second instance already holding it — see AGENTS.md's dev+packaged
  // sharing the same userData note, or an overlong path) is an unhandled
  // `error` event on a Node EventEmitter, which Node rethrows as an
  // uncaught exception — crashing the ENTIRE main process (confirmed live:
  // "Uncaught Exception: Error: listen EINVAL ..." took down PTYs, the
  // board, everything, not just acbridge). Only acbridge messaging needs
  // this socket; failing to bind it should never be fatal to the rest of
  // the app.
  // Achado ao vivo (Pop!_OS, 2026-09-09, ponto seguinte do coordenador) —
  // provado com repro standalone (node -e, fora deste arquivo) antes de
  // implementar: bindar um `net.createServer()` sobre um `sockPath` já
  // ocupado falha com EADDRINUSE tanto quando há alguém VIVO escutando lá
  // quanto quando é um arquivo órfão de um shutdown sujo (socket morto ou
  // até um arquivo comum) — o código do erro sozinho NÃO distingue os dois
  // casos. O que distingue é tentar `connect()` nesse mesmo path depois:
  // `ECONNREFUSED` quando não tem ninguém do outro lado (seguro apagar e
  // rebindar), conexão aceita quando tem uma instância viva de verdade
  // (nunca apagar, nunca tentar rebindar — é exatamente o unlink cego que
  // causava o bug original, incluindo a variante dev-apaga-o-socket-do-
  // -packaged documentada no comentário da entrada desta função).
  // `bindRetried` garante no máximo UMA tentativa de rebind — sem isso, um
  // EADDRINUSE persistente (ex. a sonda de conexão também falhando por
  // outro motivo, ou uma corrida onde outra instância rebinda de novo entre
  // o unlink e o `listen` daqui) viraria um loop infinito de unlink/listen.
  let bindRetried = false;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !bindRetried) {
      bindRetried = true;
      // Achado 2 (review adversarial, 2026-09-09) — baseline pra checar de
      // novo logo antes do unlink no branch ECONNREFUSED abaixo. Sem isto,
      // duas instâncias subindo ao mesmo tempo sobre o MESMO socket órfão
      // tomam ECONNREFUSED as duas; se a primeira já apagou+rebindou antes
      // da segunda chegar no `unlinkSync`, a segunda apagaria o socket VIVO
      // da primeira. `null` (path já não existia quando o EADDRINUSE
      // chegou — improvável mas possível) é tratado como "sem base pra
      // provar que nada mudou", o mesmo jeito conservador do branch abaixo.
      let statAtProbeTime: SockIdentity | null = null;
      try {
        const st = statSync(sockPath);
        statAtProbeTime = { dev: st.dev, ino: st.ino };
      } catch {
        // Nada em sockPath agora — segue sem baseline.
      }
      const probe = createConnection(sockPath);
      probe.on("connect", () => {
        probe.end();
        console.error("message-bus: outro processo já escuta em", sockPath, "— acbridge desta instância fica indisponível (sem rebind, sem unlink).");
        try {
          callbacks.notifyBusUnavailable(`outro processo já escuta em ${sockPath}`);
        } catch {
          // Nunca deixar o próprio aviso derrubar o processo — mesma
          // garantia documentada abaixo pro bind em si.
        }
      });
      probe.on("error", (probeErr: NodeJS.ErrnoException) => {
        if (probeErr.code === "ECONNREFUSED") {
          // Ninguém do outro lado — socket órfão (ou arquivo comum, mesmo
          // tratamento: o comentário antigo desta função já cobria "stale
          // socket from an unclean previous shutdown", só que incondicional
          // demais).
          //
          // Achado 2 (review adversarial, 2026-09-09) — antes de apagar,
          // reconfirma que o path ainda é o MESMO arquivo sondado
          // (`statAtProbeTime`). Mitiga, não elimina, a corrida entre duas
          // instâncias sondando o mesmo órfão ao mesmo tempo: não existe
          // "unlink condicionado a inode" atômico em POSIX/Node, então
          // ainda sobra uma janela (bem menor) entre ESTE segundo stat e o
          // `unlinkSync` logo abaixo onde uma 3ª instância poderia entrar.
          // Aceito conscientemente — ver a resposta ao coordenador sobre a
          // alternativa considerada (bind num path temporário + rename
          // atômico sobre o alvo) e por que não foi essa a escolha aqui.
          let currentStat: SockIdentity | null = null;
          try {
            const st2 = statSync(sockPath);
            currentStat = { dev: st2.dev, ino: st2.ino };
          } catch {
            // Sumiu de novo entre os dois stats — outra instância deve
            // estar no meio do próprio dance dela agora mesmo.
          }
          if (!sameSockIdentity(statAtProbeTime, currentStat)) {
            console.error(
              "message-bus:",
              sockPath,
              "mudou entre a sonda e o unlink — outra instância deve ter assumido o path; não apago, não rebindo.",
            );
            try {
              callbacks.notifyBusUnavailable(`${sockPath} mudou entre a sonda e o unlink — outra instância assumiu o path`);
            } catch {
              // Idem — nunca derruba o processo.
            }
            return;
          }
          try {
            unlinkSync(sockPath);
          } catch {
            // Já sumiu — outra corrida qualquer resolveu antes da gente.
          }
          server.listen(sockPath);
        } else {
          console.error("message-bus: sonda de conexão em", sockPath, "falhou com", probeErr.code, "— não sei se é seguro remover, então não removo.");
          try {
            callbacks.notifyBusUnavailable(String(probeErr));
          } catch {
            // Idem — nunca derruba o processo.
          }
        }
      });
      return;
    }
    console.error("message-bus: failed to bind, acbridge will be unavailable:", err);
    try {
      callbacks.notifyBusUnavailable(String(err));
    } catch {
      // Nunca deixar o próprio aviso de indisponibilidade derrubar o
      // processo — mesma garantia documentada acima pro bind em si.
    }
  });
  // Bug real relatado (Pop!_OS, 2026-09-09) — o `close()` abaixo fazia
  // `unlinkSync(sockPath)` cego, sem checar se o arquivo no path ainda era
  // o socket deste server. Sequência confirmada: 2ª instância sobe (sem
  // `app.requestSingleInstanceLock()` em index.ts, na época), unlinka o
  // sock da 1ª (viva) na entrada de `createMessageBus` (linha acima),
  // binda o seu, a janela da 2ª fecha, `close()` roda e unlinka de novo —
  // a 1ª instância sobrevive com o server escutando num inode sem nome
  // nenhum no filesystem, e o Stop hook do Claude Code (`acbridge
  // turn-complete`) passa a falhar com ENOENT mesmo com o processo do
  // Stellar vivo. `index.ts` agora recusa a 2ª instância antes de chegar
  // aqui, mas esta guarda fica como segunda linha de defesa: só sabemos
  // que o socket é NOSSO se o dev+ino do path, checado no exato momento em
  // que o bind terminou (`listening`), ainda bater com o que está lá na
  // hora de fechar.
  let ownSockStat: SockIdentity | null = null;
  server.on("listening", () => {
    try {
      const st = statSync(sockPath);
      ownSockStat = { dev: st.dev, ino: st.ino };
    } catch {
      // Entre o listen() e este callback o arquivo já pode ter sumido de
      // novo (outro processo disputando o mesmo path) — sem stat aqui,
      // `close()` simplesmente não vai conseguir provar posse depois, e
      // por segurança não vai remover nada.
    }
  });
  server.listen(sockPath);

  // SINAL 3 — cheap rescan; the pure gate refuses until the 180s floor.
  const idleWithoutReportTimer = setInterval(() => {
    try {
      scanIdleWithoutReport();
    } catch (err) {
      console.error("message-bus: idle-without-report scan failed:", err);
    }
  }, IDLE_WITHOUT_REPORT_POLL_MS);
  // Unref so the timer alone cannot keep a draining process alive.
  idleWithoutReportTimer.unref?.();

  function close() {
    clearInterval(idleWithoutReportTimer);
    idleWithoutReportNotified.clear();
    for (const { timer } of pendingOpens.values()) clearTimeout(timer);
    pendingOpens.clear();
    for (const { timer } of pendingCloseCards.values()) clearTimeout(timer);
    pendingCloseCards.clear();
    for (const { timer } of pendingSnapshots.values()) clearTimeout(timer);
    pendingSnapshots.clear();
    for (const { timer } of pendingPageTexts.values()) clearTimeout(timer);
    pendingPageTexts.clear();
    for (const { timer } of pendingReadCards.values()) clearTimeout(timer);
    pendingReadCards.clear();
    for (const { timer } of pendingStickyOps.values()) clearTimeout(timer);
    pendingStickyOps.clear();
    pendingCardExits.clear();
    waitingOnConsent.clear();
    // DESIGN-BACKLOG.md §2.1 — `cardReports` (o `Map` em memória) morreu
    // com esta tarefa; o slot em si agora vive no SQLite (`ReportRow`,
    // store.ts) e NÃO é limpo aqui — `close()` derruba o socket/timers
    // deste bus, não apaga histórico persistido. `pendingReportWaiters`
    // continua em memória de propósito (ver o comentário grande acima de
    // `reportSeqCounter`) — waiters de UMA execução, corretamente
    // descartados quando o bus derruba.
    pendingReportWaiters.clear();
    for (const { timer } of pendingSpawnAgents.values()) clearTimeout(timer);
    pendingSpawnAgents.clear();
    for (const { timer } of pendingSpawnCards.values()) clearTimeout(timer);
    pendingSpawnCards.clear();
    for (const list of spawnQueue.values()) for (const { timer } of list) clearTimeout(timer);
    spawnQueue.clear();
    // Bug real relatado (Pop!_OS, 2026-09-09) — descoberta ao escrever o
    // teste desta guarda: `server.close()` ELE MESMO já faz um unlink cego
    // do que estiver em `sockPath` como parte da limpeza do bind AF_UNIX no
    // libuv, ANTES de qualquer checagem nossa depois dele rodar (confirmado
    // empiricamente: `server.close()` removeu até um arquivo comum que
    // tinha substituído o socket original). Um guard de dev/ino só DEPOIS
    // do `close()`, como este arquivo tinha antes, chega tarde demais — o
    // dano já foi feito por dentro do próprio Node. Por isso a checagem
    // roda ANTES: se o path não for mais o nosso (outra instância já
    // rebindou por cima), o que está lá é retirado do caminho (rename
    // atômico, mesmo filesystem) antes do `close()`, e devolvido depois —
    // o unlink interno do libuv passa a mirar um path vazio (sem efeito)
    // em vez do arquivo de outra instância viva.
    //
    // Achado 1 (review adversarial, 2026-09-09, severidade alta) — a
    // versão anterior comparava `st` contra `ownSockStat` mesmo quando
    // `ownSockStat` era `null` (esta instância NUNCA chegou a bindar —
    // exatamente o caso de uma instância de dev que toma EADDRINUSE porque
    // o app empacotado está vivo e dono do socket). `isOurs` dava `false`
    // por vacuidade, e o rename dance MOVIA O SOCKET VIVO DA OUTRA
    // INSTÂNCIA pra `.foreign-<uuid>` — durante a janela do dance, todo
    // `acbridge` da instância viva toma ENOENT (o bug reportado, causado
    // pelo próprio código escrito pra consertá-lo); se este processo morre
    // no meio do dance (SIGINT/crash/kill), o rename de volta nunca roda e
    // o bug fica PERMANENTE. A correção original tratava `ownSockStat ===
    // null` só como "nunca bindei" — errado, ver o achado seguinte.
    //
    // Achado seguinte (review adversarial, 2026-09-09, medido antes de
    // implementar — repro standalone, `node -e`, fora deste arquivo):
    // `ownSockStat` só é preenchido dentro do handler de `"listening"`, que
    // o Node dispara via um `process.nextTick` interno agendado DURANTE a
    // chamada síncrona de `server.listen()`. Medição: logo depois que
    // `server.listen(sockPath)` RETORNA, no MESMO tick síncrono — antes de
    // qualquer `nextTick`/`setImmediate`/`setTimeout` rodar — `server
    // .listening` já é `true` e o arquivo do socket já existe de verdade no
    // disco, mas o evento `"listening"` ainda não disparou. Ou seja: se
    // algo chamar `close()` sincronamente logo depois que
    // `createMessageBus()` retorna (sem `await` no meio — o padrão comum
    // de `index.ts`), essa instância JÁ bindou de verdade mas
    // `ownSockStat` ainda é `null`. Não é uma corrida rara — é uma janela
    // garantida em TODO bind bem-sucedido.
    //
    // A pergunta certa, portanto, não é "eu sei qual é o meu socket?"
    // (`ownSockStat`) sozinha — é duas perguntas separadas: "eu bindei?"
    // (`server.listening`, o getter síncrono do próprio Node, sempre
    // correto no instante em que `close()` roda) e, só se a resposta for
    // sim, "eu sei QUAL arquivo é o meu?" (`ownSockStat`). Três
    // combinações:
    //   1. `!server.listening` — nunca bindei (ou já não estou bindado).
    //      Nada pra proteger, `close()` não toca no filesystem.
    //   2. `server.listening && ownSockStat !== null` — bindei e sei qual é
    //      o meu. Dance de sempre: só move se o arquivo no path não for o
    //      meu.
    //   3. `server.listening && ownSockStat === null` — a janela nova:
    //      bindei de verdade, mas ainda não capturei qual arquivo é o meu.
    //      Sem baseline pra provar nada, ai postura conservadora: PROTEGE
    //      de qualquer forma, mesmo sem prova — o dance roda incondicional.
    //      Consequência aceita: se o arquivo no path era mesmo o nosso, o
    //      rename de volta (o mesmo bloco de restauração que já existe pro
    //      caso 2, logo depois do `server.close()`) devolve ele pro NOME
    //      original — só que agora como um socket comum órfão (ninguém
    //      mais escuta nele, este processo já fechou). Isso é
    //      autocurável: a sonda de EADDRINUSE da PRÓXIMA inicialização
    //      (deste ou de outro processo) o acha exatamente em `sockPath`,
    //      toma ECONNREFUSED contra ele, apaga e rebinda. Órfão que se
    //      cura sozinho é estritamente melhor que apagar o socket vivo de
    //      uma instância que não era esta.
    // Achado (review adversarial, 2026-09-09, encontrado ESCREVENDO o teste
    // do achado seguinte, não pedido diretamente) — a versão anterior fazia
    // o "park" com `renameSync(sockPath, parked)`, que REMOVE o nome
    // original imediatamente, deixando `sockPath` VAZIO pela duração
    // INTEIRA de "park → server.close() → restaura" — uma janela sob
    // controle nosso, maior do que precisa ser, durante a qual uma
    // instância B poderia bindar em `sockPath`. Pior: `server.close()`
    // ELE MESMO já faz um unlink incondicional de QUALQUER COISA que
    // esteja em `sockPath` no momento em que roda (achado bem mais antigo
    // deste arquivo) — então se B bindar nessa janela ampliada, é o
    // PRÓPRIO `server.close()` que destrói o socket de B, ANTES da nossa
    // restauração sequer rodar; nenhuma escolha de primitiva no passo de
    // restauração evita isso, porque o estrago já foi feito mais cedo.
    //
    // Provado com repro standalone (`node -e`, fora deste arquivo, antes de
    // implementar): trocar o park de `renameSync` (destrutivo, remove o
    // nome original na hora) por `linkSync` (cria um SEGUNDO nome pro
    // MESMO inode, sem tocar no original) elimina essa janela auto-
    // infligida por completo — `sockPath` continua com o conteúdo original
    // até o exato instante em que `server.close()` o remove por conta
    // própria (o mesmo instante que já existiria de qualquer forma, pra
    // QUALQUER server AF_UNIX fechando, com ou sem este código). Depois
    // disso, sobra só a janela residual mínima entre o retorno de
    // `server.close()` e a chamada de restauração logo abaixo — a MESMA
    // janela, curtíssima, que o `linkSync`-com-EEXIST da restauração já
    // protege (ver o comentário grande no bloco de restauração).
    let parkedForeignPath: string | null = null;
    // Junto de `parkedForeignPath`, registra QUAL combinação estacionou o
    // arquivo: decide, lá embaixo, o que fazer com ele se a restauração não
    // puder devolvê-lo ao nome original (ver o comentário grande antes do
    // `linkSync` de restauração).
    //   - Combinação 2: sabemos, por `ownSockStat`, que o arquivo NÃO é
    //     nosso — é de outra instância qualquer.
    //   - Combinação 3: não temos prova nenhuma — pode ser nosso.
    let parkedMightBeOurs = false;
    if (server.listening) {
      if (ownSockStat !== null) {
        // Combinação 2.
        try {
          const st = statSync(sockPath);
          const isOurs = sameSockIdentity(ownSockStat, { dev: st.dev, ino: st.ino });
          if (!isOurs) {
            parkedForeignPath = `${sockPath}.foreign-${randomUUID()}`;
            linkSync(sockPath, parkedForeignPath);
            parkedMightBeOurs = false;
          }
        } catch {
          // Nada em sockPath (ENOENT) — nada pra proteger, `close()` não
          // tem o que apagar. Ou o `linkSync` falhou por outro motivo —
          // segue sem backup, mesma postura conservadora de sempre.
        }
      } else {
        // Combinação 3 — bindei, mas sem baseline ainda. Protege sem
        // condição nenhuma, mesmo sem prova de que era necessário: o
        // bloco de restauração logo abaixo tenta devolver este arquivo pro
        // NOME original (`sockPath`) depois do `server.close()` — de
        // propósito, é isso que permite o autocura: se o arquivo era mesmo
        // nosso, ele volta a existir em `sockPath` como um socket comum
        // órfão (ninguém mais escutando nele), e a sonda de EADDRINUSE da
        // PRÓXIMA inicialização o acha exatamente lá, toma ECONNREFUSED e
        // limpa sozinha — ver o comentário grande acima.
        try {
          parkedForeignPath = `${sockPath}.foreign-${randomUUID()}`;
          linkSync(sockPath, parkedForeignPath);
          parkedMightBeOurs = true;
        } catch {
          // Nada em sockPath, ou `linkSync` falhou por outro motivo — nada
          // mais a fazer aqui.
        }
      }
    }
    server.close();
    if (parkedForeignPath) {
      // Achado (review adversarial, 2026-09-09, severidade média) — esta
      // restauração usava `renameSync(parkedForeignPath, sockPath)`, que
      // sobrescreve incondicionalmente (`rename()` POSIX clobbera o
      // destino se existir). Combinado com o park antigo (`renameSync` no
      // bloco acima, que já deixou de existir — ver o comentário grande
      // logo antes de `parkedForeignPath` ser declarado), a janela em que
      // uma instância B podia bindar em `sockPath` e ser destruída por
      // esta restauração cobria o `server.close()` inteiro. Encolhida a
      // janela do lado do park (via `linkSync` não-destrutivo), ainda sobra
      // uma janela residual mínima aqui — entre `server.close()` retornar
      // e esta restauração rodar — e é ESTA restauração, não o park, que
      // precisa ser à prova de sobrescrever o que quer que tenha aparecido
      // nesse intervalo.
      //
      // Provado com repro standalone (`node -e`, fora deste arquivo,
      // rodado antes de implementar) antes de escolher a primitiva:
      //   (a) `linkSync` cria um segundo nome apontando pro MESMO inode de
      //       um arquivo de socket AF_UNIX — funciona, o socket original
      //       não perde nada.
      //   (b) se `sockPath` já existe (B assumiu), `linkSync` FALHA com
      //       `EEXIST` em vez de sobrescrever — é o "crie este nome, mas
      //       nunca substitua" atômico do POSIX, ao contrário de `rename`.
      //   (c) o nome restaurado via `linkSync` continua servindo `connect()`
      //       normalmente — não é um link "morto", é o mesmo socket vivo
      //       sob o nome de volta.
      // `if (!existsSync(sockPath))` antes de um `rename` (a sugestão
      // original do reviewer) foi descartado por ser TOCTOU — só encurta a
      // janela entre o check e o rename, não fecha. `linkSync` não tem essa
      // janela: o próprio kernel recusa o `link()` atomicamente se o nome
      // já existir.
      try {
        linkSync(parkedForeignPath, sockPath);
        // Sucesso: `sockPath` agora é um segundo nome pro mesmo inode do
        // arquivo estacionado. Remove o nome temporário — o arquivo
        // continua vivo através do link novo criado em `sockPath`.
        unlinkSync(parkedForeignPath);
      } catch (linkErr) {
        const code = (linkErr as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Alguém assumiu `sockPath` durante a janela — exatamente o
          // cenário que o `linkSync` existe pra recusar. O que fazer com
          // `parkedForeignPath` agora depende de QUEM ele era
          // (`parkedMightBeOurs`, registrado lá em cima):
          if (parkedMightBeOurs) {
            // Combinação 3: não tínhamos prova de que não era nosso — e
            // agora que ninguém mais vai reclamar dele (já fechamos),
            // apagar é só limpeza. Mesmo raciocínio do autocura acima,
            // adiantado: em vez de deixar um `.foreign-*` órfão pra
            // sempre, remove direto.
            try {
              unlinkSync(parkedForeignPath);
            } catch {
              // Já sumiu — tudo bem.
            }
          } else {
            // Combinação 2: SABÍAMOS que não era nosso — é de uma terceira
            // instância (nem esta, nem a B que assumiu o path agora).
            // Apagar destruiria dado alheio sem necessidade nenhuma;
            // deixa o `.foreign-*` no diretório em vez de arriscar.
            console.error(
              "message-bus: outra instância assumiu",
              sockPath,
              "antes da restauração — preservando o arquivo estacionado em",
              parkedForeignPath,
              "em vez de apagar (não era nosso).",
            );
          }
        } else {
          // Erro de `link()` que não é EEXIST (ex. cross-device, embora
          // `parkedForeignPath` esteja sempre no mesmo diretório de
          // `sockPath`) — mesma cautela do resto do arquivo: loga, não
          // arrisca mexer em mais nada.
          console.error("message-bus: falha inesperada restaurando", sockPath, "de", parkedForeignPath, ":", linkErr);
        }
      }
    }
  }

  /** Sticky item "Fila de concorrência quebrada", achado 1 (2026-09-03) —
   * `tryDispatchQueued` só era chamado de `resolveCardExit`, nunca quando
   * um slot "libera" por outro motivo: subir `concurrency_cap` num board
   * com fila nunca reavaliava nada, a request ficava presa até o timeout
   * de 10min (`DEFAULT_QUEUE_TIMEOUT_MS`) mesmo com capacidade de sobra.
   * Fina camada pública só pra isso — `index.ts` chama depois de persistir
   * um cap novo, mesmo padrão de "avisa o motor, não deixa ele confiar só
   * em polling" que o resto deste arquivo já usa. */
  function notifyConcurrencyCapChanged(boardId: string) {
    tryDispatchQueued(boardId);
  }

  return {
    handleRequest,
    /** Test seam — `deriveAutoConnectLabel` is nested; unit tests call it here. */
    deriveAutoConnectLabel,
    resolveOpen,
    resolveCloseCard,
    resolveSnapshot,
    resolvePageText,
    resolveReadCard,
    resolveSticky,
    resolveSpawnAgent,
    resolveSpawnCard,
    resolveCardExit,
    /** Test seam — SINAL 3 scan (same pure gate the poller runs). */
    scanIdleWithoutReport,
    notifyConcurrencyCapChanged,
    notifyHumanMovedTask,
    // Dependents engine entry point for the write funnel (index.ts →
    // task-write-funnel.ts): the funnel detects `done` from the store's
    // decision, this runs the dispatch. Same "avisa o motor" surface as
    // `notifyConcurrencyCapChanged` above — index.ts never re-implements
    // dispatch on its side.
    onTaskDone,
    close,
  };
}
