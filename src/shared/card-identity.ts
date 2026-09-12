/**
 * DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
 * "Nome utilizável de card". Até aqui existiam TRÊS derivações
 * independentes do mesmo fato ("como chamar este card quando ele não tem
 * label?"), já divergentes entre si antes mesmo desta tarefa:
 *
 * 1. `main/index.ts`'s `describeCardLabel` (notificações, prefixo de
 *    `send_to_card`) — só cobria `kind === "terminal"` corretamente;
 *    qualquer outro kind computava um ordinal contra `card.provider`
 *    (`""` pra quase todo non-terminal), produzindo um texto quebrado tipo
 *    `" 1°"`.
 * 2. `App.tsx`'s `describeCard` (tooltips, resumo de conector, modal de
 *    permissão) — tratava `kind !== "terminal"` corretamente com
 *    `${CARD_LABEL[kind]} #${id}`, mas main nunca soube disso.
 * 3. O PRÓPRIO header de cada card (`TerminalCard`/`FilesCard`/
 *    `StickyCard`/etc.) — cada um escrevia seu PRÓPRIO fallback embutido
 *    (`label ?? providerId`, `label ?? "arquivos"`, `label ?? "Fila"`,
 *    `label ?? filename`...), nunca chamando nem 1 nem 2.
 *
 * `list_cards` (MCP) só tinha acesso a (1) — quebrado — e o header só
 * usava (3), then o usuário via um nome no card e outro (ou um id cru)
 * quando um agente citava o mesmo card de volta. Achado ao vivo: "o
 * orquestrador não tem nome pra citar e cai no id numérico".
 *
 * Este módulo é a ÚNICA fonte a partir de agora — main (`describeCardLabel`
 * → `list_cards`/notificações) e renderer (`App.tsx`'s `describeCard` →
 * header de cada card) chamam a MESMA função pura. Vive em `src/shared/`
 * (primeiro módulo cross-processo deste app — main e renderer são bundles
 * SEPARADOS, mas nada aqui é Node- ou DOM-específico: puro TypeScript,
 * cada bundler o inclui na sua própria saída independentemente, sem
 * precisar de runtime compartilhado nenhum. Precedente local antigo
 * — `STICKY_COLORS`, message-bus.ts — duplicava um array de 4 strings
 * achando cross-import "impossível"; não é, só nunca tinha sido tentado
 * pra algo que valesse a pena compartilhar de verdade).
 *
 * Cuidado real, citado explicitamente no briefing desta tarefa: o ordinal
 * do ramo `terminal` depende da lista de cards NO MOMENTO da chamada —
 * fechar um card renumera os outros. Serve só para EXIBIÇÃO; nunca use o
 * resultado desta função como chave de nada (o `id` do card continua
 * sendo isso).
 */

/**
 * AGENT-FACING — do not put these nouns through `t()` / catalogs.ts.
 *
 * `deriveCardDisplayName` is what `list_cards` returns as `displayName`,
 * what `send_to_card` prefixes as the sender, and what the card header
 * shows when nobody renamed the card. Agents resolve targets by that
 * string. Translating it (or swapping "fila" for "task") breaks
 * recognition between cards — a locale sweep would look like a rename.
 * Portuguese here is the stable protocol surface, not UI copy.
 *
 * CONNECTOR_KIND_LABEL (App.tsx) is a different map: hover tooltips only,
 * never returned by list_cards. See docs/SYSTEM_DESIGN.md §2.4.
 *
 * `as const` preserva as chaves literais: quem precisa de checagem
 * exaustiva contra `Card["kind"]` (renderer's `cards/registry.ts`)
 * atribui `CARD_KIND_LABEL` a um `Record<Card["kind"], string>` tipado —
 * se um kind novo aparecer em `Card["kind"]` sem entrada aqui, essa
 * atribuição vira erro de compilação, não silêncio.
 */
export const CARD_KIND_LABEL = {
  terminal: "terminal",
  files: "arquivos",
  changes: "changes",
  sticky: "nota adesiva",
  browser: "navegador",
  "remote-window": "janela externa",
  stroke: "desenho",
  chat: "chatbox",
  media: "mídia",
  // DESIGN-BACKLOG.md §2.1 "Card `task`", decisão 1 — "Fila" é o título
  // pedido pelo dono do repo, não "tarefa"/"task". Minúsculo aqui (prosa,
  // ex. toasts) — `deriveCardDisplayName` capitaliza pra virar NOME, o que
  // reproduz "Fila" exatamente sem precisar de um caso especial por kind.
  task: "fila",
} as const;

export type CardKind = keyof typeof CARD_KIND_LABEL;

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** O que a derivação precisa saber sobre UM card. `provider` é `""` pra
 * qualquer kind sem noção de provider — só o ramo `terminal` abaixo olha
 * pra ele. */
export interface CardIdentitySnapshot {
  id: string;
  kind: string;
  label: string | null;
  provider: string;
  /** Pista de identidade mais específica que o substantivo genérico do
   * `kind`, quando o próprio card já tem uma (hoje: o filename de um
   * `media` sem label — mais útil que "Mídia" genérico). `null`/omitido
   * pra qualquer kind sem nada melhor a oferecer; cada lado (main lendo
   * `cwd` como JSON, renderer lendo `assetPath` direto) computa isto por
   * conta própria a partir do MESMO dado bruto — este módulo só decide o
   * que fazer com o resultado, nunca como extraí-lo (isso é per-process,
   * como qualquer outro parse de coluna). */
  fallbackHint?: string | null;
}

/**
 * "Como chamar este card quando ninguém deu um nome a ele?" — a única
 * pergunta que este módulo responde. `sameBoardCards` deve conter só cards
 * do MESMO board que `card` (nunca a lista inteira do app) — um card de
 * outro board jamais deveria influenciar o ordinal deste.
 */
export function deriveCardDisplayName(card: CardIdentitySnapshot, sameBoardCards: readonly CardIdentitySnapshot[]): string {
  if (card.label) return card.label;

  if (card.kind === "terminal") {
    const sameProviderTerminals = sameBoardCards
      .filter((c) => c.kind === "terminal" && c.provider === card.provider)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const ordinal = sameProviderTerminals.findIndex((c) => c.id === card.id) + 1;
    return `${capitalize(card.provider)} ${ordinal}°`;
  }

  if (card.fallbackHint) return card.fallbackHint;

  const noun = CARD_KIND_LABEL[card.kind as CardKind] ?? card.kind;
  return capitalize(noun);
}
