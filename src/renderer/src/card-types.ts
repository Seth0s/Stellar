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

/** DESIGN-BACKLOG.md item 12, Fase B — a chat card talking straight to an
 * API (Anthropic for now), not a PTY. `provider` is the API vendor
 * ("anthropic" today, "openai" from Fase C), never a CLI binary id the
 * way `TerminalCardData.provider` is. `messages` is the full turn history
 * (Anthropic's API is stateless per request — no server-side session to
 * resume), persisted as JSON in the generic `cwd` column (see App.tsx's
 * toRow/fromRow, same reuse trick `StrokeCardData` already established
 * for its own JSON blob) rather than a new sqlite table — no tool-use/
 * diff data to structure yet at this phase. */
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatCardData = BaseCard & {
  kind: "chat";
  provider: "anthropic";
  model: string;
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
