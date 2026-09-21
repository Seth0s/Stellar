// Shared between Topbar.tsx's switcher popover and Home.tsx (DESIGN-
// BACKLOG.md item 8) — both render the same "sessions grouped by project"
// list + status dot, just at different scales/density.

import { t } from "../../shared/i18n";
import type { BoardCounts } from "../../preload/index";

export type Board = {
  id: string;
  name: string;
  project: string;
  cwd: string;
  autonomous: boolean;
  concurrency_cap: number | null;
  orchestrator_card_id: string | null;
};
/** O tipo vem do CONTRATO (`preload/index.ts`), não de uma terceira cópia
 * (task 49de95ce): esta era a segunda declaração da mesma forma, e as três
 * (store, preload, aqui) podiam divergir em silêncio. */
export type { BoardCounts };

/** @deprecated Use t("session.ungrouped") at display sites; kept for grouping key compatibility. */
export const UNGROUPED_LABEL = "sem projeto";

function ungroupedKey(): string {
  return t("session.ungrouped");
}

/** Groups boards by `project`, preserving each group's first-seen order —
 * boards are already fetched ordered by created_at, so this reads as
 * "oldest project first", matching the artifact's CENTRAL/IDYPLATFORM
 * layout without a separate sort pass. */
export function groupByProject<T extends Board>(boards: T[]): [string, T[]][] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  const ungrouped = ungroupedKey();
  for (const b of boards) {
    const key = b.project || ungrouped;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(b);
  }
  return order.map((k) => [k, groups.get(k)!]);
}

// O `StatusDot` MORREU AQUI (task 49de95ce) — e a ordem importa para quem vier
// depois: primeiro ele perdeu a semântica de atividade (o rótulo saía de
// `counts.active > 0`, e `active` era a MESMA expressão SQL de `agents`:
// medido, 11 e 11 — o verde era inalcançável de desligar e o tooltip afirmava
// "N agente(s) em execução" sem que nada tivesse medido isso), e o que sobrou
// não tinha ESTADO NENHUM que variasse: um bullet sempre neutro ao lado de um
// número que já diz tudo. Não existe sinal de atividade por BOARD — todo card
// na tabela tem PTY vivo (fechar apaga a linha) e o `card_status` de provider
// genérico devolve `unknown`, porque a saída não distingue trabalho de
// repintura. Decoração que finge ser indicador é a mesma família do contador
// "N ativos" que esta task removeu; a contagem (e o dropdown de papéis) diz o
// fato, e o indicador de verdade de cada card continua sendo o do PRÓPRIO card
// (`.card-status-dot`, com os estados que ele tem de fato, em cards.css).
//
// O que fica de lição para o próximo indicador de board: se ele não tem dois
// estados OBSERVÁVEIS, ele não é indicador.
