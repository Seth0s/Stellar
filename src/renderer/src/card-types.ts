import type { Rect } from "./board-model";

/** `label` is a user-set display name (header rename) — null means "use the
 * kind-specific default" (provider id for terminals, KIND_LABEL for
 * everything else), never re-derived once set. */
export type BaseCard = { id: string; rect: Rect; groupId: string | null; label: string | null };

export type TerminalCardData = BaseCard & {
  kind: "terminal";
  provider: string;
  cwd: string;
  resumeId: string | null;
  /** One-shot launch preference, never persisted (see AGENTS.md) — always false for a card restored from the store. */
  continueLast: boolean;
  model: string | null;
  /** Sticky item "spawn_agent effort" (2026-09-03) — started as an
   * Antigravity-only companion to `model` (`providers.ts`'s
   * `SpawnOpts.effort`), one-shot and deliberately NEVER persisted: it
   * only mattered at the exact moment the PTY was spawned, never re-read
   * afterward, so a card restored from the store always got `null` here.
   * That was a fine default while effort only affected which Antigravity
   * model actually ran (worst case: a cheap silent fallback to Low).
   *
   * Reversed 2026-09-09 (DESIGN-BACKLOG.md §2.1, real cost to the repo's
   * owner — "a sessão era um opus medium, mas após reinício do app
   * voltei como high e custou muito"): `claude` also takes `--effort`
   * (confirmed via its own `--help`, low/medium/high/xhigh/max — not
   * assumed), and there a lost effort doesn't degrade gracefully, it
   * silently reverts to whatever effort the CLI defaults to, which can
   * be a MORE expensive one than what was actually chosen. `effort` is
   * now a real column (store.ts's `CardRow.effort`), round-tripped by
   * `toRow`/`fromRow` (App.tsx) exactly like `model` — no longer
   * one-shot.
   *
   * Widened to plain `string | null` (review adversarial, 2026-09-09,
   * achado 2 — SAME class of bug as the one this whole fix is for): a
   * first pass kept this narrowed to `"low" | "high"` and had
   * `fromRow` coerce anything else to `null`. That's destructive, not
   * defensive — a row already holding `"medium"` (claude's real range)
   * gets read back as `null`, and the very next unrelated `toRow` write
   * (drag/resize/rename, anything) then persists that `null` right over
   * the real value, erasing it for good. `model` right above never had
   * this problem because it was never enum-narrowed in the first place.
   * The app's own write paths (still only `spawn_agent`, still
   * low/high-only per its own zod schema — see mcp-server.ts, untouched
   * here on purpose) don't need the wider range YET; task `a54269c1`
   * covers actually exposing `medium`/`xhigh`/`max` end to end. This
   * widening is scoped narrower than that: just stop the round-trip
   * from destroying a value it doesn't recognize, exactly like `model`
   * already never destroys anything.
   *
   * No live-in-session-change detection, on purpose, same doctrine as
   * `resumeId`'s own limitation (session-watch.ts's
   * `RESUME_TRIGGER_COMMANDS` doc comment): running e.g. `/model` or an
   * effort-changing command INSIDE an already-open session changes that
   * CLI's live state, but this app has no confirmed hook into it for
   * effort on ANY provider (only claude's `/resume` trigger is
   * confirmed-live, and that's a different command). The persisted
   * value is always the one that was true at SPAWN time, and it wins
   * silently on restart — a guessed trigger command would be worse than
   * documenting this, not better. */
  effort: string | null;
  systemPrompt: string | null;
  /** One-shot text typed into the PTY right after spawn (item 57 ponto
   * 13) — same never-persisted spirit as `continueLast`, always null for
   * a card restored from the store. */
  initialInput: string | null;
};

/** DESIGN-BACKLOG.md §2.1 "effort do card não é persistido", 2026-09-10 —
 * per-provider effort ranges, confirmed live against each CLI's own
 * `--help`/error output (not assumed — see providers.ts's `SpawnOpts.
 * effort` doc comment). Used by Rail.tsx's terminal-creation popover to
 * only ever OFFER a value a provider actually accepts, instead of letting
 * a human pick e.g. "medium" for antigravity and finding out later it was
 * refused (message-bus.ts's `spawn_agent` handler enforces the same
 * antigravity range for agent-driven spawns, which don't go through this
 * popover at all). Every provider not listed here doesn't read `effort`
 * — no options offered, same as before this map existed. */
export const PROVIDER_EFFORT_VALUES: Record<string, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  antigravity: ["low", "high"],
};

export type FilesCardData = BaseCard & { kind: "files"; root: string };
export type ChangesCardData = BaseCard & { kind: "changes"; root: string };
/** `mode` (2026-09-02) — controlável via MCP (`set_sticky_mode`), mesmo
 * padrão de `color` (`set_sticky_color`): persistido, não estado de UI
 * local, pra um agente conseguir alternar a nota sem depender de clique
 * humano. Reaproveita a coluna genérica `model` do row (App.tsx's
 * toRow/fromRow), livre pra este kind — mesmo truque de `content`→`cwd`
 * e `color`→`provider` logo abaixo, sem migração de schema. */
export type StickyCardData = BaseCard & { kind: "sticky"; content: string; color: string; mode: "edit" | "preview" };
export type BrowserCardData = BaseCard & { kind: "browser"; url: string; ownerCardId: string | null };
/** No meaningful state to persist — which window/screen it shows comes
 * from a live OS picker at open time (DESIGN-BACKLOG.md item 3, phase 1),
 * never restored across reloads. Mirrors files/changes' minimal treatment. */
export type RemoteWindowCardData = BaseCard & { kind: "remote-window" };
export type StrokeCardData = BaseCard & {
  kind: "stroke";
  points: [number, number][];
  color: string;
  width: number;
  style: "solid" | "marker";
};

/** DESIGN-BACKLOG.md item 12 — a chat card talking straight to an API, not
 * a PTY. `provider` is the API vendor, never a CLI binary id the way
 * `TerminalCardData.provider` is. `cwd` is the project root file tools
 * (Fase C) are confined to — same meaning as `FilesCardData.root`, just
 * named `cwd` for consistency with every other kind's toRow/fromRow.
 * `messages` is the full turn history (both APIs are stateless per
 * request — no server-side session to resume), persisted in its own
 * `messages_json` column (store.ts) as of Fase C — Fase B originally
 * squeezed this into the generic `cwd` column (stroke's reuse trick),
 * which stopped fitting once chat needed `cwd` back for its normal
 * meaning. */
/** Item 66 — anexo de imagem numa mensagem do usuário. Guarda uma
 * REFERÊNCIA (`path` em disco, mesmo diretório `stellar-pastes` que
 * `useTerminal.ts` já usa pra colar imagem no terminal), nunca o base64
 * cru — `messages_json` (store.ts) é uma coluna TEXT só, e manter cada
 * imagem colada como base64 ali infla o banco e o JSON reparseado a cada
 * render por um fator ~1.33x, pra sempre, mesmo depois que a imagem some
 * do composer. O main process (anthropic-client.ts/openai-client.ts) lê
 * o arquivo e converte pra base64 só na hora de montar a request —
 * nunca persistido em base64. `mediaType` restrito aos 4 formatos que a
 * Anthropic aceita nativamente (`Base64ImageSource`) — interseção segura
 * com o que a OpenAI/Gemini também aceitam via `image_url` com data URI.
 */
export type ChatImageBlock = {
  type: "image";
  path: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};
export type ChatTextBlock = { type: "text"; text: string };
export type ChatContentBlock = ChatTextBlock | ChatImageBlock;
export type ChatMessage = { role: "user" | "assistant"; content: string | ChatContentBlock[] };
// DESIGN-BACKLOG.md item 28 — "gemini" (fixed OpenAI-compatible endpoint)
// and "generic" (user-supplied OpenAI-compatible endpoint, covers local
// models — Ollama/llama.cpp/vLLM — and any other hosted provider without
// dedicated UI here) both reuse the OpenAI Chat Completions client.
export type ChatProvider = "anthropic" | "openai" | "gemini" | "generic";
export type ChatCardData = BaseCard & {
  kind: "chat";
  provider: ChatProvider;
  model: string;
  cwd: string;
  systemPrompt: string | null;
  messages: ChatMessage[];
};

/** Item 57.9 — colar/arrastar uma imagem ou PDF no canvas VAZIO (não em
 * cima de um card) cria isto — um card de visualização com resize
 * proporcional, rotação e zoom interno, ao contrário de um attachment de
 * chat (item 66, `ChatImageBlock`) que é conteúdo de conversa efêmero.
 * `assetPath` aponta pra dentro da pasta de assets PERSISTENTE do board
 * (`main/board-assets.ts`, `app.getPath("userData")/board-assets/
 * <boardId>/`), nunca o diretório temporário `stellar-pastes` que chat/
 * terminal usam — este conteúdo é pra durar, não pra sumir com uma
 * limpeza de temp do SO. `view` é o pan+zoom interno da mídia dentro dos
 * limites fixos do card (mini-viewport/crop), independente do zoom do
 * canvas inteiro. */
export type MediaCardData = BaseCard & {
  kind: "media";
  assetPath: string;
  mediaType: "image" | "pdf";
  rotation: 0 | 90 | 180 | 270;
  view: { zoom: number; panX: number; panY: number };
};

/** DESIGN-BACKLOG.md §2.1 "Card `task` — a fila de tasks vira superfície",
 * decisão 1 — card kind no mesmo molde de sticky/files/changes, não um
 * painel flutuante: as dependências e o vínculo task↔card usam o mesmo
 * sistema de CONECTORES que já existe, em vez de um segundo paradigma de
 * layout. Nenhum campo próprio pra persistir além do que `BaseCard` já
 * cobre — ao contrário de files/changes (que reaproveitam `cwd` pra um
 * "root"), o card `task` não tem raiz nenhuma: seus dados (as tasks em
 * si) já vivem inteiramente em `tasks`/`task_transitions`/`task_cards`
 * (store.ts), escopados por `board_id` — o card é só a VITRINE, sem
 * estado próprio que precise de uma coluna nova em `cards`. Decisão 7 —
 * "um card por board" é uma guarda de superfície: Rail e `spawn_card`
 * reutilizam o primeiro card live existente e não criam um segundo; o schema
 * continua tolerando dados legados duplicados, que não são apagados. */
export type TaskCardData = BaseCard & { kind: "task" };

export type Card =
  | TerminalCardData
  | FilesCardData
  | ChangesCardData
  | StickyCardData
  | BrowserCardData
  | RemoteWindowCardData
  | StrokeCardData
  | ChatCardData
  | MediaCardData
  | TaskCardData;

export type Connector = { id: string; fromCardId: string; toCardId: string; kind?: string | null; label?: string | null };
// Item 57.8 — "export" desenha um recorte retangular livre (não snapado a
// cards, ver App.tsx's onBackgroundPointerDown) e exporta os pixels reais
// daquela área da janela pra um arquivo (PNG/JPEG/PDF).
export type Tool = "pointer" | "pen" | "connector" | "select" | "export";
