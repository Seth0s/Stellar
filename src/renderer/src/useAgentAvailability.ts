import { useSyncExternalStore } from "react";
import type { TurnEndProjection } from "../../main/agent-availability-projection";

export type AgentAvailability = {
  id: string;
  label: string;
  installed: boolean;
  installCommand: string | null;
  /** PRONTO? (task 1777060e) — ver `main/provider-readiness-decision.ts`. Quatro
   *  estados: `missing`/`ready`/`not-ready`/`unknown`. `unknown` é o honesto de
   *  um provider que não declara probe (instalado e NÃO verificado). */
  readiness: "missing" | "ready" | "not-ready" | "unknown";
  /** O que sustenta o estado (viaja para a tela e para o relato). */
  readinessEvidence: string;
  /** O comando que o humano roda para sair do estado, declarado pelo provider. */
  readinessHint: string | null;
  /** PROJEÇÃO de `capacity.effort.values` (ver o handler de
   * `agents:check-availability` e `main/agent-availability-projection.ts`):
   * os valores oferecíveis, NA ORDEM DECLARADA. Vazio = este provider não
   * declara esforço, e aí a UI não oferece o controle. Campo obrigatório de
   * propósito: o main SEMPRE o manda, e um tipo que subdeclara o que o
   * produtor garante faz o próximo leitor programar contra um `undefined`
   * que não existe. */
  effortValues: string[];
  /** PROJEÇÃO de `capacity.delivery.turnEnd` (ver o handler de
   * `agents:check-availability` e `main/agent-availability-projection.ts`):
   * como este provider sinaliza o FIM de um turno. `null` = não sinaliza, e a
   * UI NÃO promete — mesma regra do `effortValues` vazio. Os dois mecanismos
   * não são equivalentes (`hook` é evento, `screen` é texto), e quem decide o
   * que fazer com cada um é `terminal-turn-signal.ts` / `TerminalCard.tsx`. */
  turnEndSignal: TurnEndProjection;
};

/**
 * Achado ao vivo, 2026-09-03 — pedido explícito do usuário: um aviso de
 * "CLI de agente não instalada" ANTES mesmo de tentar abrir um agente, não
 * mais no meio do fluxo de spawn de um card (onde vivia até aqui —
 * `installHint` em useTerminal.ts/TerminalCard.tsx, removido). Mesmo
 * padrão de módulo-singleton que `useUpdateStatus.ts` já usa: checagem
 * roda uma vez por vida do app (não uma vez por componente que monta),
 * Topbar consulta o resultado só pra decidir se mostra o aviso.
 *
 * 2026-09-19 — o canal `agents:check-availability` SEMPRE devolveu a lista
 * COMPLETA (`main/providers.ts`'s `checkAgentAvailability`, derivada do
 * registro vivo: nativos + CLIs dinâmicos carregados no boot). O que este
 * módulo fazia era jogar a lista fora e guardar só os NÃO instalados — e é
 * isso que deixava o resto do renderer sem como saber que um provider
 * dinâmico existe (App.tsx tinha a lista 6 ids literal; TerminalCard tinha
 * dois Sets). Agora o snapshot preserva as duas coisas: `missing` (API de
 * sempre, intocada para o aviso da Topbar) e `all`, que é o que os pickers
 * e o TerminalCard leem. Mesma checagem, mesmo `onAvailabilityStale` —
 * nenhum canal novo.
 */
let snapshot: { all: AgentAvailability[]; missing: AgentAvailability[] } = { all: [], missing: [] };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  void recheck();
  // A primeira checagem pode ter rodado antes de o processo principal
  // resolver o PATH real da login shell (main/user-env.ts) — num `.app`
  // aberto pelo Finder no macOS, o PATH até então é o mínimo do launchd e
  // NENHUMA CLI instalada pelo usuário aparece nele. Sem esta re-checagem,
  // o aviso "não instalado" ficaria congelado dizendo o contrário do que é
  // verdade.
  window.agents.onAvailabilityStale(() => void recheck());
}

async function recheck() {
  const all = await window.agents.checkAvailability();
  snapshot = { all, missing: all.filter((a) => !a.installed) };
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAgentAvailability(): { missing: AgentAvailability[]; recheck: () => void } {
  ensureInitialized();
  const m = useSyncExternalStore(subscribe, () => snapshot.missing);
  return { missing: m, recheck: () => void recheck() };
}

/** A lista COMPLETA (instalados e não instalados) do mesmo canal — é dela
 * que saem os ids oferecidos pelos pickers e as capacidades do
 * TerminalCard. Vazia até a primeira resposta do main: quem consome decide
 * o que mostrar nesse intervalo, nunca inventa uma lista paralela. */
export function useAvailableAgentProviders(): AgentAvailability[] {
  ensureInitialized();
  return useSyncExternalStore(subscribe, () => snapshot.all);
}
