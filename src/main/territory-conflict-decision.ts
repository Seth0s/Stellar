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

import { posix } from "node:path";
import { normalizeStringList } from "./task-contract-decision";

export type ActiveTaskTerritory = {
  taskId: string;
  /** Território já normalizado (SQL → lista), como `task-contract-decision`
   * devolve. `null`/vazio = não declarado — nunca usado como evidência. */
  territory: string[] | null;
  /** Base que uma entrada RELATIVA resolve contra: o `cwd` da própria task
   * quando declarado, senão a raiz do board (o chamador resolve esse
   * fallback). Entrada absoluta ignora. `null`/ausente = sem base: o relativo
   * fica relativo (comportamento do comparador antigo). Ver
   * `resolveTerritoryEntry`. */
  cwd?: string | null;
};

export type TerritoryConflictInput = {
  taskId: string;
  territory: string[] | null;
  /** `cwd` da task candidata (ou raiz do board) — mesma regra de
   * `ActiveTaskTerritory.cwd`. */
  cwd?: string | null;
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
      /** A entrada do território pedido que colidiu, COMO DECLARADA. */
      mine: string;
      /** A entrada declarada da task ativa que colidiu com `mine`. */
      theirs: string;
      /** `mine` resolvida contra a base da própria task (cwd/raiz do board)
       * — o caminho que de fato foi comparado. */
      mineResolved: string;
      /** `theirs` resolvida contra a base da própria task ativa. */
      theirsResolved: string;
      /** Recusa pronta, mesmo canal de toda outra recusa de spawn — AGENT-FACING. */
      error: string;
    };

/**
 * Decide se `territory` (do candidato a spawnar) colide com o de alguma
 * task em `activeTasks`. Território ausente em QUALQUER um dos dois lados
 * do par não é evidência — nunca inventa colisão a partir do que não foi
 * declarado (mesma regra de `task-contract-decision.ts`).
 *
 * Cada entrada é RESOLVIDA contra a base da própria task antes de comparar
 * (ver `resolveTerritoryEntry`): dois repos diferentes na mesma sessão
 * declaram `tests/unit/**` e `tests/unit/x.test.ts` e NÃO colidem, porque a
 * base difere. Mesma base continua colidindo como sempre.
 */
export function decideTerritoryConflict(input: TerritoryConflictInput): TerritoryConflictDecision {
  const mineList = normalizeStringList(input.territory);
  if (!mineList) return { ok: true };

  for (const other of input.activeTasks) {
    if (other.taskId === input.taskId) continue;
    const theirsList = normalizeStringList(other.territory);
    if (!theirsList) continue;
    for (const mine of mineList) {
      const resolvedMine = resolveTerritoryEntry(mine, input.cwd);
      if (!resolvedMine) continue;
      for (const theirs of theirsList) {
        const resolvedTheirs = resolveTerritoryEntry(theirs, other.cwd);
        if (!resolvedTheirs) continue;
        if (!segmentsOverlap(resolvedMine.segments, resolvedTheirs.segments)) continue;
        return {
          ok: false,
          conflictingTaskId: other.taskId,
          mine,
          theirs,
          mineResolved: resolvedMine.display,
          theirsResolved: resolvedTheirs.display,
          error:
            `territory "${mine}" (resolved: "${resolvedMine.display}") overlaps task ${other.taskId}'s declared "${theirs}" (resolved: "${resolvedTheirs.display}"), and that task is ACTIVE right now ` +
            "— refusing to spawn a second live implementer over territory another running task already claims",
        };
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
 * `resolveTerritoryEntry`) nunca colide — não há estrutura pra comparar.
 *
 * `baseA`/`baseB` resolvem entradas RELATIVAS contra a pasta da própria
 * task antes da comparação (ausente = relativo fica relativo, o
 * comportamento histórico de duas entradas soltas).
 */
export function territoryEntriesOverlap(a: string, b: string, baseA?: string | null, baseB?: string | null): boolean {
  const segA = resolveTerritoryEntry(a, baseA);
  const segB = resolveTerritoryEntry(b, baseB);
  if (segA === null || segB === null) return false;
  return segmentsOverlap(segA.segments, segB.segments);
}

/** O miolo do comparador: prefixo por segmento com `*`/`**`. */
function segmentsOverlap(segA: readonly string[], segB: readonly string[]): boolean {
  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    if (segA[i] === "**" || segB[i] === "**") return true;
    if (segA[i] === "*" || segB[i] === "*") continue;
    if (segA[i] !== segB[i]) return false;
  }
  return true;
}

/** Uma entrada de território já resolvida: os segmentos que o comparador usa
 * e o caminho resolvido (para nomear cada lado na recusa). */
export type ResolvedTerritoryEntry = { segments: string[]; display: string };

/**
 * A ÚNICA resolução de uma entrada de território — usada tanto pelo guard de
 * colisão quanto pelo CONTRACT CROSSING, para as duas não divergirem.
 *
 * Entrada ABSOLUTA fica como está (normalizada). Entrada RELATIVA resolve
 * contra `base` (o `cwd` da própria task, ou a raiz do board). SEM base, o
 * relativo fica relativo — o comparador antigo não tinha como ancorar.
 *
 * `posix` de propósito: território usa `/`. `..` que ESCAPA a base é recusado
 * (`null`, não comparável) em vez de virar um caminho de outro repo.
 *
 * Uma anotação `" (nota)"` colada no final é removida antes de tudo — medido:
 * `"src/main/store.ts (actor)"` é comentário grudado num path real, não parte
 * dele. Um `"/"` final vira `"**"` explícito: declarar `"docs/"` é declarar
 * "tudo dentro daqui", do mesmo jeito que `"docs/**"`. Entrada com espaço
 * (prosa) não lê como path.
 */
export function resolveTerritoryEntry(raw: string, base?: string | null): ResolvedTerritoryEntry | null {
  const withoutNote = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutNote.length === 0) return null;
  if (/\s/.test(withoutNote)) return null;
  const withStar = withoutNote.endsWith("/") ? `${withoutNote}**` : withoutNote;

  let path: string;
  if (withStar.startsWith("/")) {
    path = posix.normalize(withStar);
  } else {
    const relative = posix.normalize(withStar);
    if (relative === ".." || relative.startsWith("../")) return null;
    const basePath = normalizeTerritoryBase(base);
    path = basePath ? posix.resolve(basePath, relative) : relative;
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return { segments, display: path };
}

/** Base não-vazia (trim), ou `null` — ausência de base é dado, não erro. */
function normalizeTerritoryBase(base: string | null | undefined): string | null {
  const trimmed = typeof base === "string" ? base.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
