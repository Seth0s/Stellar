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
export type ChatMessage = { role: "user" | "assistant"; content: string };
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

export type Card =
  | TerminalCardData
  | FilesCardData
  | ChangesCardData
  | StickyCardData
  | BrowserCardData
  | RemoteWindowCardData
  | StrokeCardData
  | ChatCardData;

export type Connector = { id: string; fromCardId: string; toCardId: string };
export type Tool = "pointer" | "pen" | "connector" | "select";
