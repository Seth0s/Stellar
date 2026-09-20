/**
 * Territory CONFLICT — mecanismo (b) do sticky de consolidação
 * (2026-09-20, itens 6+10): recusar `spawn_agent`/auto-dispatch de uma
 * task cujo `territory` declarado colide com o de outra task ATIVA
 * (participação viva, nunca julgada — ver `task-status-derive.ts`) no
 * MESMO board. Duas tasks diferentes, não a mesma task recebendo um
 * segundo card — isso já é `hasLiveLinkedCard` em message-bus.ts.
 *
 * Motivo medido: nesta mesma sessão, no board real, três tasks estavam
 * ATIVAS ao mesmo tempo com território sobreposto —
 * `vhosts/Backend/app/**`/`vhosts/Backend/tests/**` declarado em DUAS
 * tasks simultâneas, e `vhosts/Admin/src/**` numa terceira que também
 * aparece dentro da segunda. Nenhuma recusa existia; nada avisou. É
 * exatamente a classe do incidente relatado no sticky (guard temporal
 * mexido por duas tasks que não sabiam uma da outra, conflito só no
 * merge).
 *
 * MECANISMO ESCOLHIDO — overlap de PREFIXO de segmentos de path, não
 * glob exato. Medido nas 111 tasks (de 270) com `territory` preenchido
 * no board real: a coluna mistura globs limpos (`vhosts/Admin/src/**`),
 * caminhos crus sem wildcard (`docs/`, `src/main/store.ts`), anotação
 * livre colada no path (`src/main/store.ts (actor)`), e prosa pura sem
 * nenhuma estrutura de caminho (`leitura de ~/.config/stellar e
 * ~/.config/agent-canvas`). Um comparador de glob exato teria dado falso
 * negativo na maioria — a mesma classe de falha (aceitar em silêncio)
 * que este mecanismo existe para fechar. Prefixo por segmento cobre os
 * dois formatos reais mais comuns (glob com `**` e path cru) sem
 * inventar significado para o que não é path — ver `normalizeTerritoryEntry`.
 *
 * NÃO coberto, declarado em vez de fingido: um wildcard DENTRO de um
 * segmento (`tests/unit/*task*` — 36 das 111 declarações usam essa
 * forma) é comparado como string literal, então só colide com outra
 * declaração com o mesmo segmento literal. Um motor de glob completo
 * resolveria isso; o escopo aqui é overlap de prefixo, não intersecção
 * de glob geral — mesma disciplina de escopo que `spawn-profile-decision.ts`
 * usa para o catálogo do opencode (medido, não implementado).
 *
 * Puro de propósito: sem I/O, sem `git`, sem watch de filesystem — a
 * própria task-contract-decision.ts já veda isso ("Never invent
 * territory by watching the filesystem, never intercept git add, never
 * judge gate output"). Este módulo só compara o que já está declarado.
 */

import { normalizeStringList } from "./task-contract-decision";

export type ActiveTaskTerritory = {
  taskId: string;
  /** Território já normalizado (SQL → lista), como `task-contract-decision`
   * devolve. `null`/vazio = não declarado — nunca usado como evidência. */
  territory: string[] | null;
};

export type TerritoryConflictInput = {
  taskId: string;
  territory: string[] | null;
  /** Toda task ATIVA no MESMO board, exceto a própria (o chamador já
   * filtrou por board_id e por "não é a própria task" — este módulo não
   * sabe o que é board). */
  activeTasks: ActiveTaskTerritory[];
};

export type TerritoryConflictDecision =
  | { ok: true }
  | {
      ok: false;
      /** Task ativa cujo território colidiu — nomeada para quem chamou
       * poder investigar sem re-rodar a comparação. */
      conflictingTaskId: string;
      /** A entrada do território pedido que colidiu. */
      mine: string;
      /** A entrada declarada da task ativa que colidiu com `mine`. */
      theirs: string;
      /** Recusa pronta, mesmo canal de toda outra recusa de spawn — AGENT-FACING. */
      error: string;
    };

/**
 * Decide se `territory` (do candidato a spawnar) colide com o de alguma
 * task em `activeTasks`. Território ausente em QUALQUER um dos dois lados
 * do par não é evidência — nunca inventa colisão a partir do que não foi
 * declarado (mesma regra de `task-contract-decision.ts`).
 */
export function decideTerritoryConflict(input: TerritoryConflictInput): TerritoryConflictDecision {
  const mineList = normalizeStringList(input.territory);
  if (!mineList) return { ok: true };

  for (const other of input.activeTasks) {
    if (other.taskId === input.taskId) continue;
    const theirsList = normalizeStringList(other.territory);
    if (!theirsList) continue;
    for (const mine of mineList) {
      for (const theirs of theirsList) {
        if (territoryEntriesOverlap(mine, theirs)) {
          return {
            ok: false,
            conflictingTaskId: other.taskId,
            mine,
            theirs,
            error:
              `territory "${mine}" overlaps task ${other.taskId}'s declared "${theirs}", and that task is ACTIVE right now ` +
              "— refusing to spawn a second live implementer over territory another running task already claims",
          };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * Duas entradas de território colidem quando seus segmentos de path
 * concordam até um wildcard, ou até o mais curto acabar (prefixo). `"*"`
 * casa exatamente um segmento; `"**"` (ou um `"/"` final, normalizado
 * abaixo) casa o resto. Uma entrada que não lê como path (prosa, ver
 * `normalizeTerritoryEntry`) nunca colide — não há estrutura pra comparar.
 */
export function territoryEntriesOverlap(a: string, b: string): boolean {
  const segA = normalizeTerritoryEntry(a);
  const segB = normalizeTerritoryEntry(b);
  if (segA === null || segB === null) return false;
  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    if (segA[i] === "**" || segB[i] === "**") return true;
    if (segA[i] === "*" || segB[i] === "*") continue;
    if (segA[i] !== segB[i]) return false;
  }
  return true;
}

/**
 * Segmentos de path de uma entrada declarada, ou `null` quando a entrada
 * não lê como path — medido no board real: algumas declarações são prosa
 * ("leitura de ~/.config/stellar e ~/.config/agent-canvas"), nunca uma
 * lista de caminhos. Refusa inventar estrutura em vez de comparar prosa
 * como se fosse path (mesmo espírito honesto de `task-contract-decision`).
 *
 * Uma anotação `" (nota)"` colada no final é removida antes de tudo —
 * medido: `"src/main/store.ts (actor)"` é comentário grudado num path
 * real, não parte dele. Um `"/"` final vira `"**"` explícito: declarar
 * `"docs/"` é declarar "tudo dentro daqui", do mesmo jeito que `"docs/**"`.
 */
function normalizeTerritoryEntry(raw: string): string[] | null {
  const withoutNote = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutNote.length === 0) return null;
  if (/\s/.test(withoutNote)) return null;
  const withStar = withoutNote.endsWith("/") ? `${withoutNote}**` : withoutNote;
  return withStar.split("/").filter((s) => s.length > 0);
}
