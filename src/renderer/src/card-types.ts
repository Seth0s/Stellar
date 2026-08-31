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
  systemPrompt: string | null;
  /** One-shot text typed into the PTY right after spawn (item 57 ponto
   * 13) — same never-persisted spirit as `continueLast`, always null for
   * a card restored from the store. */
  initialInput: string | null;
};

export type FilesCardData = BaseCard & { kind: "files"; root: string };
export type ChangesCardData = BaseCard & { kind: "changes"; root: string };
export type StickyCardData = BaseCard & { kind: "sticky"; content: string; color: string };
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

export type Card =
  | TerminalCardData
  | FilesCardData
  | ChangesCardData
  | StickyCardData
  | BrowserCardData
  | RemoteWindowCardData
  | StrokeCardData
  | ChatCardData
  | MediaCardData;

export type Connector = { id: string; fromCardId: string; toCardId: string };
// Item 57.8 — "export" desenha um recorte retangular livre (não snapado a
// cards, ver App.tsx's onBackgroundPointerDown) e exporta os pixels reais
// daquela área da janela pra um arquivo (PNG/JPEG/PDF).
export type Tool = "pointer" | "pen" | "connector" | "select" | "export";
