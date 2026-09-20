import { useSyncExternalStore } from "react";
import type { ProvidersPageView } from "../../preload/index";

/**
 * Os ids que o MAIN registrou pelo caminho dinâmico — o mesmo dado que
 * `providers.ts`'s `dynamicProviderIds` mantém, lido pelo canal que já
 * existe (`app:read-providers-config` → `ProvidersPageView.rows`). Nenhum
 * canal novo, nenhuma segunda lista de providers nativos no renderer: ver
 * `provider-groups.ts` para por que a classificação é consumida, não
 * reinventada.
 *
 * Por que um store de módulo (mesmo padrão de `useAgentAvailability.ts` /
 * `useUpdateStatus.ts`): o rail monta uma vez e o modal de Settings monta
 * quando abre; a leitura é a MESMA para os dois, e ler de novo a cada
 * componente que monta só multiplicaria um round-trip de IPC com efeito
 * colateral no main (`readProvidersConfig` recarrega o registro).
 *
 * `ready` existe para a UI poder ser HONESTA: antes da primeira resposta não
 * se sabe quem é genérico, e o que não se sabe não se afirma — as telas
 * mostram a lista sem rótulo de grupo nesse intervalo (ver `ProviderPicker`).
 *
 * PONTO DE INTEGRAÇÃO (ainda não fiado): o main já emite
 * `providers:config-changed` quando `providers.json` muda por fora (o watcher
 * de `providers-dynamic.ts`). Quando esse canal chegar ao renderer (hoje não
 * passa pelo preload), este é o store que deve escutá-lo — hoje a atualização
 * vem do boot, do reload da tela de Settings (focus + botão) e das próprias
 * mutações feitas por ela.
 */
export type ProviderFlagInfo = {
  /** Flags fixas declaradas no spec (task c857539c) — vazio é legítimo. */
  baseArgs: string[];
  /** DECLARADO e medido por quem declarou; false = sem claim. */
  bypassesPermissionPrompts: boolean;
};

export type ProviderClassification = {
  ready: boolean;
  dynamicIds: string[];
  skippedIds: string[];
  /** A identidade que o picker expõe no title do botão (o momento do
   * spawn) e a página de providers mostra na linha: com que flags fixas o
   * provider sobe e o efeito declarado nelas. Por id; só genéricos têm
   * rows — nativo não entra aqui. Vazio até a primeira resposta do main. */
  flagsById: Record<string, ProviderFlagInfo>;
  error: string | null;
};

let snapshot: ProviderClassification = {
  ready: false,
  dynamicIds: [],
  skippedIds: [],
  flagsById: {},
  error: null,
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  void refreshProviderClassification();
}

/** Re-lê a classificação do main. Chamado depois de qualquer mutação de
 * provider (o modal de Settings relê a visão no mesmo gesto) e pelo boot.
 * Aceita uma visão JÁ lida para não pagar um segundo round-trip de IPC —
 * quem acabou de chamar `readProvidersConfig` passa a sua. */
export async function refreshProviderClassification(view?: ProvidersPageView): Promise<void> {
  try {
    const resolved: ProvidersPageView = view ?? (await window.system.readProvidersConfig());
    snapshot = {
      ready: true,
      dynamicIds: resolved.rows.map((row) => row.id),
      skippedIds: [...resolved.skipped],
      flagsById: Object.fromEntries(
        resolved.rows.map((row) => [
          row.id,
          { baseArgs: row.baseArgs, bypassesPermissionPrompts: row.bypassesPermissionPrompts },
        ]),
      ),
      error: null,
    };
  } catch (err) {
    // Falha de leitura não vira "não há genéricos": vira ausência de
    // resposta. Sem `ready`, a UI não separa nada em vez de mentir.
    snapshot = { ...snapshot, error: err instanceof Error ? err.message : String(err) };
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProviderClassification(): ProviderClassification {
  ensureInitialized();
  return useSyncExternalStore(subscribe, () => snapshot);
}
