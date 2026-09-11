import type { IconName } from "../icons";
import type { Card, ChatMessage, ChatProvider } from "../card-types";
import { DEFAULT_CHAT_MODEL } from "../ChatCard";
import { CARD_KIND_LABEL } from "../../../shared/card-identity";

/**
 * DESIGN-BACKLOG.md item "4 (deferida)" — adding one card kind used to
 * touch ~7-8 scattered spots in App.tsx/Rail.tsx/icons.tsx (a union-type
 * arm, KIND_LABEL, KIND_ICON, toRow, fromRow, an addXCard function, a
 * render branch, a Rail button) — real source of build breaks this
 * session (adding "remote-window" broke the build 3 times, each on a
 * different forgotten spot, only ever caught by `tsc`).
 *
 * This file doesn't erase every one of those spots — each card component
 * genuinely has different props, so App.tsx's render switch and each
 * addXCard-equivalent still exist — but it collapses every *shared,
 * mechanical* per-kind fact (label, icon, default field values, which
 * kinds get a one-click Rail button) into one place, and turns the two
 * spots that used to fail *silently* on a forgotten kind (App.tsx's old
 * render if/else chain, which fell through to rendering a BrowserCard for
 * anything unmatched) into real `switch` statements over `Card["kind"]`
 * that TypeScript checks are exhaustive via `assertNeverCardKind` below.
 */

/** DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
 * dados movidos pra `shared/card-identity.ts` (única fonte, compartilhada
 * com main/index.ts's `describeCardLabel` e a derivação de nome de card em
 * geral — ver o doc comment daquele arquivo). Esta atribuição continua
 * verificando exaustividade contra `Card["kind"]`: se um kind novo entrar
 * na union sem ganhar entrada em `CARD_KIND_LABEL`, isto vira erro de
 * compilação aqui, não um `undefined` silencioso em runtime — a mesma
 * garantia que este arquivo já documenta pro resto de si mesmo. */
export const CARD_LABEL: Record<Card["kind"], string> = CARD_KIND_LABEL;

export const CARD_ICON: Record<Card["kind"], IconName> = {
  terminal: "terminal",
  files: "files",
  changes: "changes",
  sticky: "sticky",
  browser: "browser",
  "remote-window": "remoteWindow",
  stroke: "pen",
  chat: "chat",
  media: "fileImage",
  task: "task",
};

/** Every kind the Rail's linear button strip spawns with a single click —
 * "terminal" keeps its own dedicated popover (provider/resume/model
 * fields no other kind has) and "stroke" has no button at all (it's only
 * ever created by finishing a pen drawing), so both stay out of this
 * list. Order here is the order the buttons render in. "media" (item
 * 57.9) is excluded too — it só nasce de paste/drop no canvas vazio,
 * nunca de um botão de "card em branco". */
export const RAIL_CREATE_ORDER: Exclude<Card["kind"], "terminal" | "stroke" | "media">[] = [
  "files",
  "changes",
  "sticky",
  "browser",
  "chat",
  "remote-window",
  "task",
];

export const RAIL_CREATE_TITLE: Record<(typeof RAIL_CREATE_ORDER)[number], string> = {
  // Pedido ao vivo (2026-08-29, item 57 ponto 11) — "Nova pasta de
  // arquivos" como legenda do botão do Rail lia estranho/impreciso;
  // "Explorador" é o termo que o próprio VSCode usa pro mesmo conceito
  // (árvore de arquivos do projeto). Só a legenda deste botão — o
  // rótulo do card em si (CARD_LABEL, acima) continua "arquivos" (toast
  // de criação, popover de localizar card, etc. — não era o que foi
  // reportado).
  files: "Explorador",
  changes: "Novo card de changes",
  sticky: "Nova nota adesiva",
  browser: "Novo navegador",
  chat: "Novo chatbox",
  "remote-window": "Controlar janela externa",
  task: "Nova fila de tasks",
};

/** Throws with a useful message if ever actually reached at runtime — its
 * real job is the `never` parameter type, which makes every `default:`
 * branch that calls it a compile error the moment `Card["kind"]` grows a
 * member this switch doesn't handle yet. */
export function assertNeverCardKind(x: never): never {
  throw new Error(`unhandled card kind: ${JSON.stringify(x)}`);
}

/** Every field a fresh card of this kind needs besides the ones every
 * kind shares (`id`/`rect`/`groupId`/`label`, added by the caller) —
 * `cwd` is the active board's working directory, the same default every
 * one of the old addXCard functions used. Centralizes what used to be 6
 * near-identical addXCard functions in App.tsx down to one factory + one
 * thin per-kind creator that only differs in signature (terminal's own
 * addTerminalCard, with its provider/resume/model fields, stays separate
 * — it isn't one-click-with-no-config the way these are). */
// `Omit<Card, ...>` alone would collapse the union to its *common* keys
// only (`keyof` a union is the intersection of its members' keys) — this
// distributes the `Omit` over each member first so the return type still
// keeps each kind's own extra fields (`root`, `content`, `messages`, ...).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type NonTerminalKind = (typeof RAIL_CREATE_ORDER)[number];
type NonTerminalCard = Extract<Card, { kind: NonTerminalKind }>;

export function defaultCardFields(
  kind: NonTerminalKind,
  cwd: string,
): DistributiveOmit<NonTerminalCard, "id" | "rect" | "groupId" | "label"> {
  switch (kind) {
    case "files":
      return { kind: "files", root: cwd };
    case "changes":
      return { kind: "changes", root: cwd };
    case "sticky":
      return { kind: "sticky", content: "", color: "yellow", mode: "edit" };
    case "browser":
      return { kind: "browser", url: "https://google.com", ownerCardId: null };
    case "chat":
      return {
        kind: "chat",
        provider: "anthropic" as ChatProvider,
        model: DEFAULT_CHAT_MODEL,
        cwd,
        systemPrompt: null,
        messages: [] as ChatMessage[],
      };
    case "remote-window":
      return { kind: "remote-window" };
    case "task":
      // Ver TaskCardData's doc comment (card-types.ts) — sem campo próprio
      // a inicializar, os dados vivem em `tasks`/`task_transitions`/
      // `task_cards`, não no card.
      return { kind: "task" };
    default:
      return assertNeverCardKind(kind);
  }
}
