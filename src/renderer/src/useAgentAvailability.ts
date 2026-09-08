import { useSyncExternalStore } from "react";

export type AgentAvailability = { id: string; label: string; installed: boolean; installCommand: string | null };

/**
 * Achado ao vivo, 2026-09-03 — pedido explícito do usuário: um aviso de
 * "CLI de agente não instalada" ANTES mesmo de tentar abrir um agente, não
 * mais no meio do fluxo de spawn de um card (onde vivia até aqui —
 * `installHint` em useTerminal.ts/TerminalCard.tsx, removido). Mesmo
 * padrão de módulo-singleton que `useUpdateStatus.ts` já usa: checagem
 * roda uma vez por vida do app (não uma vez por componente que monta),
 * Topbar consulta o resultado só pra decidir se mostra o aviso.
 */
let missing: AgentAvailability[] = [];
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
  missing = all.filter((a) => !a.installed);
  emit();
}

export function useAgentAvailability(): { missing: AgentAvailability[]; recheck: () => void } {
  ensureInitialized();
  const m = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => missing,
  );
  return { missing: m, recheck: () => void recheck() };
}
