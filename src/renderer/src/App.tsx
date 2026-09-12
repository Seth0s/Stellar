import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TerminalCard } from "./TerminalCard";
import { FilesCard } from "./FilesCard";
import { ChangesCard } from "./ChangesCard";
import { StickyCard } from "./StickyCard";
import { BrowserCard } from "./BrowserCard";
import { RemoteWindowCard } from "./RemoteWindowCard";
import { StrokeCard, STROKE_COLORS } from "./StrokeCard";
import { MediaCard, type MediaView } from "./MediaCard";
import { TaskCard } from "./TaskCard";
import {
  ChatCard,
  DEFAULT_CHAT_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GENERIC_MODEL,
  type ChatSessionRow,
} from "./ChatCard";
import { AgentAskModal } from "./AgentAskModal";
import { SpawnQueuePanel } from "./SpawnQueuePanel";
import { ConfirmModal } from "./ConfirmModal";
import { SecretsSettingsModal } from "./SecretsSettingsModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { resolveGlobalShortcut, GLOBAL_SHORTCUTS_BY_ID, type ShortcutCombo, type ShortcutOverrides } from "./shortcut-registry";
import { loadShortcutOverrides, saveShortcutOverrides, setShortcutOverride, clearShortcutOverride } from "./shortcut-config";
import { t, setLocale, getLocale, type Locale } from "../../shared/i18n";
import { isAnyModalOpen } from "./modal-scope";
import { RadialMenu, type RadialAction } from "./RadialMenu";
import { RemotePairingModal } from "./RemotePairingModal";
import { Rail } from "./Rail";
import { Compass } from "./Compass";
import { Topbar } from "./Topbar";
import { Titlebar } from "./Titlebar";
import { UpdateBanner } from "./UpdateBanner";
import { Home } from "./Home";
import { ToastHost } from "./ToastHost";
import { toast } from "./useToast";
import { decideConnectorLabelSchedule } from "./connector-label-throttle";
import {
  anchoredSlot,
  bboxOf,
  cascadeSlot,
  centeredSlot,
  clipLineToRect,
  hierarchicalLayout,
  isInView,
  nearestFreeSlot,
  pointSlot,
  quadraticControlPoint,
  rectCenter,
  rectsOverlap,
  overlapArea,
  viewportWorldRect,
  worldRectToScreen,
  type AnchorSide,
  type Point,
  type Rect,
} from "./board-model";
import type { BoardCounts, CardRow, SaveBoardAssetResult, SpawnCardKind, SpawnQueueEntry, TaskBoardItem } from "../../preload/index";
import { useWorldTransform } from "./useWorldTransform";
import { useConnectorDrag } from "./useConnectorDrag";
import { useCardSelection } from "./useCardSelection";
import { useBoardStore } from "./useBoardStore";
import { useStableCardHandler, useStableCardIdHandler } from "./useStableCardHandler";
import type {
  BrowserCardData,
  Card,
  ChatCardData,
  ChatMessage,
  ChatProvider,
  Connector,
  MediaCardData,
  StickyCardData,
  Tool,
} from "./card-types";
import { PROVIDER_EFFORT_VALUES } from "./card-types";
import { CARD_ICON, CARD_LABEL, RAIL_CREATE_ORDER, assertNeverCardKind, defaultCardFields } from "./cards/registry";
import { getTerminalText } from "./terminal-registry";
import { decideTaskCardSpawn } from "../../task-card-guard";
import { deriveCardDisplayName, type CardIdentitySnapshot } from "../../shared/card-identity";
import "./app.css";

// Pendentes #188 — rótulo do tooltip por `kind` de conector (só leitura
// visual; nunca dispara nada, ver addConnector's doc comment acima de
// onde é usado).
const CONNECTOR_KIND_LABEL: Record<string, string> = {
  manual: "conector manual",
  spawned: "spawn: quem criou quem",
  depends: "depende de (advisory)",
  context: "contexto (advisory)",
};

/** Contexto de tarefa no conector — trecho curto que motivou o auto-
 * connect (`label` em store.ts/card-types.ts), truncado aqui pra nunca
 * estourar a pill que o renderiza (2627 abaixo). */
// Achado 3 (review adversarial, 2026-09-09) - mirrors message-bus.ts's
// truncateForLabel fix, duplicated on purpose (same reasoning as this
// function's own pre-existing duplication across main/renderer): strips
// C0/C1 control characters and Unicode bidi override/embedding/isolate
// controls (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM) BEFORE
// truncating - any of those, left in, can reorder or corrupt this app's
// SVG <text> connector pill. And truncates by Unicode code point
// (Array.from), not by .slice's UTF-16 code unit, so a surrogate pair
// (an emoji/astral character) never gets split in half.
// Achado 1 (review adversarial RODADA 2, 2026-09-09) - ORDER bug fixed
// here too, mirroring message-bus.ts: \n/\r/\t are C0 controls, so
// stripping controls BEFORE collapsing whitespace deleted them outright
// instead of leaving a separator ("ls -la\n/tmp" -> "ls -la/tmp", words
// glued together). Real whitespace controls are converted to a plain
// space FIRST now, then the rest of the C0/C1/bidi set is stripped,
// then whitespace runs collapse.
// Known, deliberately untreated gap (review adversarial rodada 2,
// 2026-09-09) - combining marks (Zalgo-style stacks) aren't filtered
// and can overflow the pill vertically; low-probability hostile input,
// and filtering risks mangling ordinary accented text - left alone.
// eslint-disable-next-line no-control-regex -- deliberate: this IS the sanitizer that strips C0/C1 control characters from an agent-supplied label (mirrors message-bus.ts, achado 3).
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
function truncateConnectorLabel(text: string, max = 60): string {
  const withRealWhitespace = text.replace(/[\n\r\t]/g, " ");
  const stripped = withRealWhitespace.replace(CONTROL_AND_BIDI_RE, "");
  const flat = stripped.trim().replace(/\s+/g, " ");
  const codePoints = Array.from(flat);
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join("")}…` : flat;
}

/** Review adversarial, 2026-09-09 (achado 2) — todo chamador de
 * `centeredSlot`/`nearestFreeSlot` precisa marcar quais rects existentes
 * são de card de navegador (`WebContentsView` nativo — `tryChangeRect`
 * abaixo recusa arrasto que aumente overlap com ele, então plantar OUTRO
 * card em cima o deixa permanentemente inarrastável). Um só lugar monta
 * essa lista pros dois módulos nunca divergirem. */
function existingRectsFor(cards: Card[]): { rect: Rect; blocking: boolean }[] {
  return cards.map((c) => ({ rect: c.rect, blocking: c.kind === "browser" }));
}

/** The shared identity function is deliberately process-agnostic, but the
 * two bundles each have to extract their own card-specific fallback hint.
 * Main does the equivalent for the persisted media JSON; the renderer has
 * the already-parsed `assetPath`. Everything after this boundary — label
 * priority, terminal ordinal, and kind fallback — is one shared function. */
function cardIdentitySnapshot(card: Card): CardIdentitySnapshot {
  return {
    id: card.id,
    kind: card.kind,
    label: card.label,
    provider: card.kind === "terminal" ? card.provider : "",
    fallbackHint: card.kind === "media" ? card.assetPath.split(/[\\/]/).pop() || null : null,
  };
}

// DESIGN-BACKLOG.md item 15 — this app's own checkout got renamed
// agent-canvas/ → Stellar/ mid-session (2026-08-26); updated to match.
// DESIGN-BACKLOG.md item 21, ponto 9, achado 6 — every kind of agent ask
// (AgentAskModal.tsx renders whichever is pending) shares `requestId`/
// `requesterId`/`reason`; `kind` picks which extra fields apply and drives
// allowAsk/denyAsk's branching.
type PendingAsk =
  | { kind: "open"; requestId: string; requesterId: string; url: string; reason?: string }
  | {
      kind: "spawn-agent";
      requestId: string;
      requesterId: string;
      provider: string;
      cwd?: string;
      resumeId?: string;
      reason?: string;
      model?: string;
      // Widened from "low" | "high" (DESIGN-BACKLOG.md §2.1, 2026-09-10)
      // — see preload/index.ts's SpawnAgentAskParams.effort doc comment
      // and card-types.ts's TerminalCardData.effort for the full reasoning.
      effort?: string;
      label?: string;
    }
  | {
      kind: "spawn-card";
      requestId: string;
      requesterId: string;
      cardKind: SpawnCardKind;
      cwd?: string;
      url?: string;
      reason?: string;
      anchorCardId?: string;
      side?: "left" | "right" | "top" | "bottom";
    }
  | { kind: "close-card"; requestId: string; requesterId: string; target: string; reason?: string };

/** Bug real achado ao vivo (2026-09-02, reportado por um usuário rodando o
 * app numa máquina diferente da do autor): estas duas constantes eram
 * paths absolutos hardcoded do `$HOME` do autor — só existiam nessa
 * máquina, então o app "só funcionava" ali (1º boot com `localStorage`
 * vazio, ou um board sem `cwd` persistido, apontavam pra um diretório
 * inexistente em qualquer outra instalação). `window.system.homeDir`
 * (preload/index.ts, `os.homedir()`) é o `$HOME` real de quem está
 * rodando o app, portátil por definição — nunca hardcoded. */
const DEFAULT_CWD = window.system.homeDir;
/** Só o valor inicial — o usuário pode trocar pra qualquer workspace via
 * `ProjectPicker` (folder dialog nativo), e a escolha persiste entre
 * lançamentos (`workspaceRoot` state abaixo, `WORKSPACE_ROOT_KEY`). */
const DEFAULT_WORKSPACE_ROOT = window.system.homeDir;
const WORKSPACE_ROOT_KEY = "ac.workspaceRoot";

/** Home/Topbar's "📁 {name}" label — the last path segment of whatever
 * root is currently chosen, falling back to "Projects" for a root that's
 * just "/" or empty (shouldn't happen via the picker, but a bad persisted
 * value should never crash the label). Splits on "/" OR "\\" — `root` is a
 * real OS path (from `window.system.homeDir` or the native folder dialog),
 * native-separator on Windows (`C:\Users\name`), never normalized to "/"
 * like the fs-tools relative-path keys are. */
function rootDisplayName(root: string): string {
  return (
    root
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() || "Projects"
  );
}
const PROVIDER_OPTIONS = ["bash", "claude", "codex", "cursor", "antigravity", "opencode"];
// Achado 1 (review adversarial, 2026-09-09) — throttle window for a
// connector label's auto-refresh (`scheduleConnectorLabelUpdate`); nobody
// reads a pill faster than this, so coalescing every write inside one
// window into a single one loses no real information.
const CONNECTOR_LABEL_THROTTLE_MS = 2_500;
/** Achado 2 (review adversarial RODADA 2, 2026-09-09) — the throttle's
 * per-connector bookkeeping snapshots `boardId`/`fromCardId`/`toCardId`/
 * `kind` at SCHEDULE time, not just at flush time: a trailing timer (or a
 * board-switch/unmount cleanup) can fire after the user has already
 * switched boards, and by then `connectorsRef.current`/`activeBoardIdRef`
 * reflect the NEW board, not the one this connector actually belongs to.
 * Flushing through this fixed snapshot instead of re-reading "current"
 * ambient state means a flush always lands on the connector's real,
 * original board — never silently mislabeled onto whatever happens to be
 * open at the moment the timer fires. */
type ConnectorLabelThrottleEntry = {
  lastWriteAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  pendingLabel: string | null;
  boardId: string;
  fromCardId: string;
  toCardId: string;
  kind: string | null;
};
const MIN_STROKE_POINTS = 2;
const MIN_STROKE_DISTANCE = 2;
const STROKE_PADDING = 8;
const REFLOW_MS = 320;
const GRID_SPACING = 28;
const ZOOM_STEP = 1.15;
// Pre-release audit P1 — `seenUrls[c.id] ?? []` used to create a brand
// new empty array every render for any card with no seen URLs yet,
// which `React.memo`'s shallow prop comparison would always see as
// "changed" even though nothing meaningful did. One shared, truly
// immutable reference instead — module-level, outside the component, so
// it's the exact same array for the app's entire lifetime.
const EMPTY_URLS: string[] = [];

/** Canvas background pattern — per-viewer preference (not per-board data,
 * doesn't need to sync/persist to the store), cycled by a topbar button.
 * "dots" is the original look; "grid"/"lines" answer the "personalização
 * de fundo com coordenadas/linhas" ask (graph paper / ruled notebook
 * paper); "plain" for when any pattern is unwanted. */
type BgStyle = "dots" | "grid" | "lines" | "plain";
const BG_STYLE_KEY = "ac.bgStyle";
const BG_STYLE_ORDER: BgStyle[] = ["dots", "grid", "lines", "plain"];
const BG_STYLE_LABEL: Record<BgStyle, string> = { dots: "pontos", grid: "grade", lines: "linhas", plain: "liso" };

function backgroundCss(style: BgStyle, dotSize: number, panX: number, panY: number): React.CSSProperties {
  const backgroundPosition = `${panX % dotSize}px ${panY % dotSize}px`;
  switch (style) {
    case "dots":
      return {
        backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.14) 1px, transparent 1px)",
        backgroundSize: `${dotSize}px ${dotSize}px`,
        backgroundPosition,
      };
    case "grid":
      return {
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px), " +
          "linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px)",
        backgroundSize: `${dotSize}px ${dotSize}px`,
        backgroundPosition,
      };
    case "lines":
      // 2x the spacing of the other styles — reads as ruled notebook paper,
      // not a measurement grid.
      return {
        backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)",
        backgroundSize: `${dotSize * 2}px ${dotSize * 2}px`,
        backgroundPosition,
      };
    case "plain":
      return {};
  }
}

// files/changes/sticky don't use provider/resume_id/model/system_prompt for
// their vendor meaning — the generic `cards` schema is reused as-is (no
// migration) by repurposing `cwd` (root path, or sticky note content) and
// `provider` (unused/"" for files+changes, sticky's color for sticky).
function toRow(card: Card, boardId: string): CardRow {
  const base = {
    id: card.id,
    board_id: boardId,
    group_id: card.groupId,
    label: card.label,
    updated_at: Date.now(),
    messages_json: null, // only "chat" (below) ever sets this to something real
    // Item 30 — always null through this generic upsert path; only the
    // dedicated archiveCard/unarchiveCard IPC ever changes it (App.tsx's
    // closeCard for chat cards). A normal upsert (drag/resize/rename/
    // message commit) never touches archive state.
    archived_at: null,
    // DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" — same
    // "null by default, only the one kind that uses it overrides" shape
    // as `messages_json` above; only "terminal" (below) ever sets this to
    // something real.
    effort: null,
    ...card.rect,
  };
  switch (card.kind) {
    case "terminal":
      return {
        ...base,
        kind: "terminal",
        provider: card.provider,
        cwd: card.cwd,
        resume_id: card.resumeId,
        model: card.model,
        effort: card.effort,
        system_prompt: card.systemPrompt,
      };
    case "files":
      return { ...base, kind: "files", provider: "", cwd: card.root, resume_id: null, model: null, system_prompt: null };
    case "changes":
      return { ...base, kind: "changes", provider: "", cwd: card.root, resume_id: null, model: null, system_prompt: null };
    case "sticky":
      return {
        ...base,
        kind: "sticky",
        provider: card.color,
        cwd: card.content,
        resume_id: null,
        model: card.mode,
        system_prompt: null,
      };
    case "browser":
      return {
        ...base,
        kind: "browser",
        provider: card.ownerCardId ?? "",
        cwd: card.url,
        resume_id: null,
        model: null,
        system_prompt: null,
      };
    case "remote-window":
      return { ...base, kind: "remote-window", provider: "", cwd: "", resume_id: null, model: null, system_prompt: null };
    case "task":
      // Ver TaskCardData's doc comment (card-types.ts) — sem campo próprio,
      // mesmo tratamento mínimo de remote-window acima.
      return { ...base, kind: "task", provider: "", cwd: "", resume_id: null, model: null, system_prompt: null };
    case "stroke":
      return {
        ...base,
        kind: "stroke",
        provider: card.color,
        cwd: JSON.stringify({ points: card.points, width: card.width, style: card.style }),
        resume_id: null,
        model: null,
        system_prompt: null,
      };
    case "chat":
      return {
        ...base,
        kind: "chat",
        provider: card.provider,
        cwd: card.cwd,
        resume_id: null,
        model: card.model,
        system_prompt: card.systemPrompt,
        messages_json: JSON.stringify({ messages: card.messages }),
      };
    case "media":
      // Item 57.9 — mesma convenção de reuso de coluna que "stroke" já
      // estabeleceu (sem migração): `provider` guarda `mediaType`, `cwd`
      // guarda o resto ({assetPath, rotation, view}) como JSON.
      return {
        ...base,
        kind: "media",
        provider: card.mediaType,
        cwd: JSON.stringify({ assetPath: card.assetPath, rotation: card.rotation, view: card.view }),
        resume_id: null,
        model: null,
        system_prompt: null,
      };
  }
}

const DEFAULT_MEDIA_VIEW: MediaView = { zoom: 1, panX: 0, panY: 0 };

/** Mesma postura defensiva de `parseStroke` acima — uma row malformada
 * renderiza como uma mídia vazia (assetPath "") em vez de derrubar o
 * board inteiro. */
function parseMedia(raw: string): { assetPath: string; rotation: 0 | 90 | 180 | 270; view: MediaView } {
  try {
    const parsed = JSON.parse(raw);
    const rotation = ([0, 90, 180, 270] as const).includes(parsed?.rotation) ? parsed.rotation : 0;
    const view: MediaView =
      parsed?.view && typeof parsed.view.zoom === "number" ? parsed.view : DEFAULT_MEDIA_VIEW;
    return { assetPath: typeof parsed?.assetPath === "string" ? parsed.assetPath : "", rotation, view };
  } catch {
    return { assetPath: "", rotation: 0, view: DEFAULT_MEDIA_VIEW };
  }
}

/** Same defensive-parse posture as `parseStroke` above — a malformed row
 * (or, pre-Fase-C, a legacy row with no `messages_json` at all — see
 * card-types.ts's `ChatCardData` doc comment) renders as an empty
 * conversation rather than crashing the whole board on load. `legacyCwd`
 * is Fase B's old row shape: `cwd` itself held `{messages: [...]}` before
 * `messages_json` existed to hold it properly. */
function parseChatMessages(messagesJson: string | null, legacyCwd: string): ChatMessage[] {
  const raw = messagesJson ?? legacyCwd;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
  } catch {
    // fall through
  }
  return [];
}

const DEFAULT_STROKE_WIDTH = 3;

/** Accepts the current `{points, width, style}` shape and the legacy bare
 * `[number,number][]` rows written before the pen panel (item 3) existed —
 * any other/malformed shape renders as an empty stroke rather than crash. */
function parseStroke(raw: string): { points: [number, number][]; width: number; style: "solid" | "marker" } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { points: parsed, width: DEFAULT_STROKE_WIDTH, style: "solid" };
    if (parsed && Array.isArray(parsed.points)) {
      return {
        points: parsed.points,
        width: typeof parsed.width === "number" ? parsed.width : DEFAULT_STROKE_WIDTH,
        style: parsed.style === "marker" ? "marker" : "solid",
      };
    }
  } catch {
    // malformed/legacy row — render as an empty stroke rather than crash.
  }
  return { points: [], width: DEFAULT_STROKE_WIDTH, style: "solid" };
}

function fromRow(r: CardRow): Card {
  const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  const groupId = r.group_id ?? null;
  const label = r.label ?? null;
  switch (r.kind) {
    case "files":
      return { id: r.id, kind: "files", root: r.cwd, rect, groupId, label };
    case "changes":
      return { id: r.id, kind: "changes", root: r.cwd, rect, groupId, label };
    case "sticky":
      return {
        id: r.id,
        kind: "sticky",
        content: r.cwd,
        color: r.provider || "yellow",
        // Legado (linha de antes deste campo existir, `model` null) cai em
        // "preview" — condizente com uma nota que já tem conteúdo salvo,
        // não a abrir em edição do nada a cada boot.
        mode: r.model === "edit" ? "edit" : "preview",
        rect,
        groupId,
        label,
      };
    case "browser":
      return { id: r.id, kind: "browser", url: r.cwd, ownerCardId: r.provider || null, rect, groupId, label };
    case "remote-window":
      return { id: r.id, kind: "remote-window", rect, groupId, label };
    case "task":
      return { id: r.id, kind: "task", rect, groupId, label };
    case "stroke": {
      const { points, width, style } = parseStroke(r.cwd);
      return {
        id: r.id,
        kind: "stroke",
        points,
        width,
        style,
        color: r.provider || STROKE_COLORS[0],
        rect,
        groupId,
        label,
      };
    }
    case "chat": {
      // Pre-Fase-C row: no messages_json column value yet means `cwd`
      // itself is the old JSON blob, not a real path — see card-types.ts.
      const isLegacyRow = r.messages_json === null;
      return {
        id: r.id,
        kind: "chat",
        // Item 28 — coerce only truly unknown/legacy values to the
        // original default; gemini/generic rows must round-trip as-is,
        // not silently collapse back to anthropic.
        provider: (["anthropic", "openai", "gemini", "generic"] as const).includes(r.provider as ChatProvider)
          ? (r.provider as ChatProvider)
          : "anthropic",
        model: r.model || DEFAULT_CHAT_MODEL,
        cwd: isLegacyRow ? DEFAULT_CWD : r.cwd,
        systemPrompt: r.system_prompt,
        messages: parseChatMessages(r.messages_json, r.cwd),
        rect,
        groupId,
        label,
      };
    }
    case "media": {
      const { assetPath, rotation, view } = parseMedia(r.cwd);
      return {
        id: r.id,
        kind: "media",
        assetPath,
        mediaType: r.provider === "pdf" ? "pdf" : "image",
        rotation,
        view,
        rect,
        groupId,
        label,
      };
    }
    case "terminal":
      return {
        id: r.id,
        kind: "terminal",
        provider: r.provider,
        cwd: r.cwd,
        resumeId: r.resume_id,
        continueLast: false,
        model: r.model,
        effort: r.effort,
        systemPrompt: r.system_prompt,
        initialInput: null,
        label,
        rect,
        groupId,
      };
    default:
      // `CardRow.kind` is a plain `string` (an untyped DB column), not the
      // literal `Card["kind"]` union — a genuinely unknown value here is a
      // real possibility (legacy/corrupt row), not just a forgotten case,
      // so this can't be an `assertNeverCardKind` compile-time check the
      // way the render switch below is. Warn instead of silently treating
      // it as a terminal card, so a *forgotten* case during development
      // (vs. real corrupt data) is at least visible in the console.
      console.warn(`fromRow: unknown card kind "${r.kind}", rendering as terminal`, r);
      return {
        id: r.id,
        kind: "terminal",
        provider: r.provider,
        cwd: r.cwd,
        resumeId: r.resume_id,
        continueLast: false,
        model: r.model,
        effort: r.effort,
        systemPrompt: r.system_prompt,
        initialInput: null,
        label,
        rect,
        groupId,
      };
  }
}

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [newProvider, setNewProvider] = useState("bash");
  const [newResumeId, setNewResumeId] = useState("");
  const [newContinueLast, setNewContinueLast] = useState(false);
  const [newModel, setNewModel] = useState("");
  // DESIGN-BACKLOG.md §2.1 "effort do card não é persistido", 2026-09-10
  // — this was the missing write surface: `effort` was persisted and read
  // back correctly, but a human creating a terminal card by hand (this
  // popover) had no field to set it at all, only an agent-driven
  // `spawn_agent` did. "" means "don't pass --effort" (provider default),
  // same convention as `newModel`/`newResumeId` above. Reset whenever the
  // provider changes to one that doesn't recognize the current value
  // (see the effect right below Rail's render) instead of letting a
  // claude-only value like "medium" silently reach antigravity, where
  // message-bus.ts's spawn_agent handler would refuse it — the popover
  // shouldn't hand the user a value it already knows will be rejected.
  const [newEffort, setNewEffort] = useState("");
  const [newSystemPrompt, setNewSystemPrompt] = useState("");
  const [seenUrls, setSeenUrls] = useState<Record<string, string[]>>({});
  // Pedido ao vivo (2026-08-27): o clique num link visto no terminal
  // deixou de abrir o navegador interno direto — agora pede confirmação
  // (ConfirmModal genérico), mesmo padrão de "closing a live terminal"
  // já usa. Separado de `pendingAsk`/AgentAskModal de propósito: aquele é
  // especificamente o gate de consentimento pra pedidos DE AGENTE (via
  // MCP/acbridge, acompanhado de requesterId/reason); este é um clique
  // humano direto, sem requester nem motivo pra mostrar.
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);
  // Pre-release audit S2 — a page inside SOME BrowserCard (not this app's
  // own agent flow) called `getDisplayMedia()`; main/index.ts holds the
  // request open until this resolves.
  const [pendingBrowserPermission, setPendingBrowserPermission] = useState<{ requestId: string; message: string } | null>(null);
  // Item 29 — central API-key management panel, not scoped to any card.
  const [showSecretsSettings, setShowSecretsSettings] = useState(false);
  // DESIGN-BACKLOG.md item 21, ponto 9, achado 6 — one union covers every
  // kind of agent ask (open URL, spawn agent, spawn non-terminal card);
  // AgentAskModal.tsx renders whichever is pending, allowAsk/denyAsk below
  // branch on `.kind`.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  // DESIGN-BACKLOG.md item 60, peça 1 — per-board spawn queue, kept live
  // via the `onQueueChanged` push (never polled). Keyed by boardId so a
  // board switch never loses another board's queue state.
  const [spawnQueues, setSpawnQueues] = useState<Record<string, SpawnQueueEntry[]>>({});
  // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 2 — mesmo padrão de
  // `spawnQueues` acima: keyed por boardId, carga inicial via
  // `window.tasks.listByBoard` (efeito abaixo, dependente de
  // `activeBoardId`) e depois só push (`window.tasks.onChanged`) — NUNCA
  // poll.
  const [taskBoards, setTaskBoards] = useState<Record<string, TaskBoardItem[]>>({});
  // RODADA 3, peça 5 — rodapé de escopo (`board X · N tasks · M em outros
  // boards`). GLOBAL (não keyed por board, ao contrário de `taskBoards`
  // acima) — é uma contagem por board só, carregada uma vez no boot (não
  // depende de `activeBoardId`) e atualizada por push
  // (`window.tasks.onScopeChanged`) toda vez que QUALQUER task em
  // QUALQUER board é gravada.
  const [taskCountsByBoard, setTaskCountsByBoard] = useState<Record<string, number>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [tool, setTool] = useState<Tool>("pointer");
  const [newStrokeColor, setNewStrokeColor] = useState<string>(STROKE_COLORS[0]);
  const [newStrokeWidth, setNewStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH);
  const [newStrokeStyle, setNewStrokeStyle] = useState<"solid" | "marker">("solid");
  const [drawingPoints, setDrawingPoints] = useState<Point[] | null>(null);
  /** Cards mid-close-animation — still rendered (with the .closing class),
   * removed from `cards` only once that finishes (see finalizeCloseCard). */
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [bgStyle, setBgStyle] = useState<BgStyle>(() => {
    const saved = localStorage.getItem(BG_STYLE_KEY);
    return (BG_STYLE_ORDER as string[]).includes(saved ?? "") ? (saved as BgStyle) : "dots";
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Fase C (atalhos) — sobreposições de combo por usuário, `ac.
  // shortcutOverrides` no localStorage (mesma convenção de preferência
  // renderer-only que `BG_STYLE_KEY`/`WORKSPACE_ROOT_KEY` acima já usam;
  // ver `shortcut-config.ts` pro porquê disso e não SQLite/`remote-
  // devices.json`). Só o que o usuário mudou é guardado — `setState` +
  // `saveShortcutOverrides` sempre juntos, mesmo padrão de `cycleBgStyle`
  // logo abaixo (setter e persistência lado a lado, não um `useEffect`
  // separado que reagiria a toda mudança de estado indiscriminadamente).
  const [shortcutOverrides, setShortcutOverrides] = useState<ShortcutOverrides>(() => loadShortcutOverrides());
  // DESIGN-BACKLOG.md §2.1 i18n fase 1 — locale lives in shared module state
  // (`setLocale`) so `t()` / `formatRelativeTime` work from main+renderer
  // without a React provider. React state here only forces a re-render when
  // the user overrides it (ShortcutsOverlay selector).
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  useEffect(() => {
    let cancelled = false;
    void window.i18n.get().then((info) => {
      if (cancelled) return;
      setLocale(info.locale);
      setLocaleState(info.locale);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  async function changeLocaleOverride(next: Locale | null) {
    const info = await window.i18n.setOverride(next);
    setLocale(info.locale);
    setLocaleState(info.locale);
  }
  function rebindShortcut(id: string, combo: ShortcutCombo) {
    setShortcutOverrides((prev) => {
      const next = setShortcutOverride(prev, id, combo);
      saveShortcutOverrides(next);
      return next;
    });
  }
  function restoreShortcutDefault(id: string) {
    setShortcutOverrides((prev) => {
      const next = clearShortcutOverride(prev, id);
      saveShortcutOverrides(next);
      return next;
    });
  }
  function restoreAllShortcutDefaults() {
    setShortcutOverrides(() => {
      saveShortcutOverrides({});
      return {};
    });
  }
  /** Right-click on empty canvas (item 1's alternate spawn path) — `screen`
   * positions the menu itself, `world` is where the chosen card lands
   * (`pointSlot`), captured once at open time so panning/zooming while the
   * menu is open doesn't retarget the spawn. */
  const [radialMenu, setRadialMenu] = useState<{ screen: Point; world: Point } | null>(null);
  /** Item 57.8 — ferramenta "export": recorte livre em coordenadas de
   * TELA (client, não mundo — é exatamente o espaço que
   * `capturePage(rect)` espera, sem nenhuma conversão de zoom/pan
   * necessária). `dragging` só controla se a barrinha de formato
   * (PNG/JPEG/PDF) aparece — o retângulo em si já é visível durante o
   * arraste. */
  const [exportSelection, setExportSelection] = useState<{ x: number; y: number; w: number; h: number; dragging: boolean } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [showRemotePairing, setShowRemotePairing] = useState(false);
  /** Set only when closeCard needs confirmation first (a terminal card
   * whose process is still live) — see closeCard/confirmCloseCard below. */
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [reflowing, setReflowing] = useState(false);
  /** Live per-card status (item 1) — only ever populated for the currently
   * loaded board's terminal cards (see TerminalCard's onStatusChange); every
   * OTHER board's "ativos" count falls back to the structural proxy from
   * `boardCounts` (provider !== "bash"), since a non-loaded board's PTYs
   * aren't running at all (switching boards kills them, see AGENTS.md). */
  const [liveStatus, setLiveStatus] = useState<Record<string, "ok" | "error" | "exited">>({});
  const [workspaceRoot, setWorkspaceRoot] = useState(
    () => localStorage.getItem(WORKSPACE_ROOT_KEY) || DEFAULT_WORKSPACE_ROOT,
  );
  const nextId = useRef(1);
  const cardsRef = useRef<Card[]>([]);
  cardsRef.current = cards;
  /** Ctrl/Cmd+D duplicate (below) targets the topmost card — needed as a
   * ref, not the raw `order` state, since it's read from a mount-only
   * (deps=[]) keydown effect that would otherwise close over a stale
   * empty array forever. */
  const orderRef = useRef<string[]>([]);
  orderRef.current = order;
  /** Regra geral de auto-conector (2026-09-02) abaixo (`autoConnect`) —
   * lida de dentro de handlers registrados uma vez no mount (mesmo
   * motivo de cardsRef/orderRef acima: sem isso, fecharia sobre um
   * array de conectores vazio pra sempre). */
  const connectorsRef = useRef<Connector[]>([]);
  connectorsRef.current = connectors;
  /** Achado 1 (review adversarial, 2026-09-09) — `autoConnect`'s label
   * auto-refresh (below) had no throttle: every distinct `send`/
   * `browser_*`/etc. between the same pair fired its own SQLite UPDATE
   * (`updateConnectorLabel`'s `window.store.connectors.upsert`) AND its
   * own `setConnectors` render, immediately. Two agents chatting in a
   * burst turned "reflect the current task" into a write storm nobody
   * could read anyway. Throttle state, keyed by connector id, for
   * `scheduleConnectorLabelUpdate` below — a `useRef` (not `useState`)
   * because it's scheduling bookkeeping, not something that should ever
   * itself trigger a render. */
  const connectorLabelThrottleRef = useRef<Map<string, ConnectorLabelThrottleEntry>>(new Map());

  // Pre-release audit P1 — stable per-card handler references, the
  // prerequisite for `React.memo` on the card components below to
  // actually skip re-rendering a card nothing changed about (see
  // useStableCardHandler.ts's doc comment for the full reasoning). Every
  // one of these function NAMES is declared further down in this same
  // component body — safe to reference here because `function` (not
  // `const`) declarations are hoisted with their full body, and each
  // hook's own `fnRef` is refreshed on every render regardless of where
  // it's called from. Placed here, before `!loaded`'s early return below,
  // because hooks can never be called conditionally.
  const getChangeHandler = useStableCardIdHandler(tryChangeRect);
  const getCommitHandler = useStableCardHandler(commitRect);
  const getRaiseHandler = useStableCardIdHandler(raise);
  const getFocusHandler = useStableCardIdHandler(jumpToCard);
  // DESIGN-BACKLOG.md §2.1 Item E — o badge `#{ownerCardId}` do
  // BrowserCard já mostrava QUEM abriu aquele navegador; faltava um
  // jeito de ir até lá. `useStableCardHandler` (não a variante -Id) por
  // precisar do card inteiro pra ler `ownerCardId`, não só o próprio id.
  const getFocusOwnerHandler = useStableCardHandler((card: BrowserCardData) => {
    if (card.ownerCardId) jumpToCard(card.ownerCardId);
  });
  const getCloseHandler = useStableCardIdHandler(closeCard);
  const getCloseAnimationEndHandler = useStableCardIdHandler(finalizeCloseCard);
  const getRenameHandler = useStableCardIdHandler(renameCard);
  const getResumeIdDiscoveredHandler = useStableCardIdHandler(resumeIdDiscovered);
  const getStatusChangeHandler = useStableCardIdHandler(handleTerminalStatus);
  const getContentChangeHandler = useStableCardIdHandler(changeStickyContent);
  const getContentCommitHandler = useStableCardHandler(commitStickyContent);
  const getColorCommitHandler = useStableCardHandler(commitStickyColor);
  const getModeCommitHandler = useStableCardHandler(commitStickyMode);
  const getMessagesCommitHandler = useStableCardHandler(commitChatMessages);
  const getModelCommitHandler = useStableCardHandler(commitChatModel);
  const getProviderCommitHandler = useStableCardHandler(commitChatProvider);
  const openInstallTerminalRef = useRef(openInstallTerminal);
  openInstallTerminalRef.current = openInstallTerminal;
  const stableSuggestInstall = useCallback(
    (providerId: string, command: string) => openInstallTerminalRef.current(providerId, command),
    [],
  );
  // Not per-card (no card identity involved — creating/opening a
  // session, not touching "this" card), so a single ref-stabilized
  // wrapper is enough, same shape as `stableSuggestInstall` above.
  const newChatSessionRef = useRef(newChatSession);
  newChatSessionRef.current = newChatSession;
  const stableNewChatSession = useCallback(
    (cardId: string, provider: ChatProvider) => newChatSessionRef.current(cardId, provider),
    [],
  );
  const openChatSessionRef = useRef(openChatSession);
  openChatSessionRef.current = openChatSession;
  const stableOpenChatSession = useCallback((session: ChatSessionRow) => openChatSessionRef.current(session), []);
  const {
    world,
    setWorld,
    worldRef,
    viewportRef,
    visibleRect,
    clientToWorld,
    zoomBy,
    setZoomAbs,
    focusCard,
    onWheel,
    startPan,
  } = useWorldTransform(cardsRef);
  // Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — DOM node for the new
  // `.cards-layer` sibling of `.world` (no CSS scale, screen-projected
  // cards live here). Callback-ref state (not a plain `useRef`) because
  // cards render via `createPortal` into this node, and a portal target
  // that's `null` on the very first render (before the ref attaches)
  // needs a re-render once it's actually available — a plain ref update
  // wouldn't trigger that.
  const [cardsLayerEl, setCardsLayerEl] = useState<HTMLDivElement | null>(null);
  const {
    loaded,
    boards,
    activeBoardId,
    activeBoardIdRef,
    // Achado (review adversarial RODADA 5, 2026-09-09) — read by
    // `scheduleConnectorLabelUpdate` below (via `decideConnectorLabelSchedule`)
    // to refuse to schedule anything while a board switch/delete is
    // between `setActiveBoardId` and the end of `loadBoard` — see
    // useBoardStore.ts's own doc comment on this ref for the full story.
    boardTransitionRef,
    boardCounts,
    switchBoard,
    goHome,
    createBoard,
    updateBoard,
    deleteBoard,
    setBoardAutonomous,
    setBoardConcurrencyCap,
  } = useBoardStore(
    nextId,
    setCards,
    setOrder,
    setConnectors,
    setWorld,
    () => setLiveStatus({}),
    DEFAULT_CWD,
    toRow,
    fromRow,
    // Achado (review adversarial RODADA 4, 2026-09-09) — see this
    // function's own doc comment above for why `deleteBoard` needs it
    // (discard, not flush, for a board that's about to stop existing).
    discardConnectorLabelThrottleForBoard,
  );

  useEffect(() => {
    const offUrlSeen = window.pty.onUrlSeen((id, url) => {
      setSeenUrls((prev) => (prev[id]?.includes(url) ? prev : { ...prev, [id]: [...(prev[id] ?? []), url] }));
    });
    const offAskOpen = window.browser.onAskOpen((requestId, requesterId, url, reason, autoApprove) => {
      // DESIGN-BACKLOG.md item 60, peça 5 — modo autônomo completo:
      // same immediate-resolve shape as spawn_agent's autoApprove below,
      // extended to open_url.
      if (autoApprove) {
        // O id volta pro chamador (achado ao vivo 2026-09-01): sem ele,
        // `open_url` respondia só `{ok:true}` e não havia caminho nenhum
        // até `browser_click`/`get_page_text` daquele card.
        const cardId = openBrowserFor(requesterId, url);
        // Achado ao vivo (2026-09-02) — este caminho (autoApprove, modo
        // autônomo) nunca registrava lineage nenhuma; só `spawn_agent`
        // tinha o próprio `addConnector(..., "spawned")` (item 62). Mesmo
        // princípio, generalizado: open_url TAMBÉM cria um card a partir
        // de um pedido de outro card.
        if (requesterId) autoConnect(requesterId, cardId, "spawned");
        void window.browser.resolveAsk(requestId, true, cardId);
        return;
      }
      setPendingAsk({ kind: "open", requestId, requesterId, url, reason });
    });
    // Pre-release audit S2 — same shape, its own state/modal (not
    // `pendingAsk`/`AgentAskModal` — no agent card is asking here, a
    // webpage inside a BrowserCard is). Covers both the generic media
    // permission prompt and the more specific screen-share one — main/
    // index.ts decides which `message` text to send per call.
    const offAskBrowserPermission = window.browser.onAskPermission((requestId, message) => {
      setPendingBrowserPermission({ requestId, message });
    });
    // DESIGN-BACKLOG.md item 21, ponto 9, achados 1 e 2 — same shape as
    // onAskOpen above, generalized to spawning an agent or a non-terminal
    // card. Both funnel into the same `pendingAsk`/AgentAskModal.
    const offAskSpawnAgent = window.spawn.onAskAgent((requestId, requesterId, params) => {
      // DESIGN-BACKLOG.md item 59 — `autoApprove` only ever comes from
      // message-bus.ts having already confirmed the requester's own board
      // is in autonomous mode and under its concurrency cap. No modal at
      // all in that case — same card-creation call `allowAsk()` uses for
      // a human-approved spawn, just triggered immediately instead of by
      // a button click.
      if (params.autoApprove) {
        const cardId = spawnAgentFor(params.provider, params.cwd, params.resumeId, params.model, params.label, params.effort);
        // DESIGN-BACKLOG.md item 62 — records real spawn lineage
        // automatically; `requesterId` is "" for the task engine's own
        // dispatches (item 60 peça 3), which have no real requester
        // card to connect from.
        // 2026-09-09 — `reason` (spawn_agent's own param, already carried
        // for the human-consent modal) is the only text this request
        // brings describing WHAT the spawned agent is for; says the task,
        // not just "spawned", same intent as deriveAutoConnectLabel does
        // for send/browser_* in message-bus.ts (spawn never goes through
        // that generalized path — see AUTO_CONNECT_CMDS's own comment —
        // so it needs its own label here).
        if (requesterId) addConnector(requesterId, cardId, "spawned", params.reason ? truncateConnectorLabel(params.reason) : null);
        void window.spawn.resolveAgent(requestId, { ok: true, cardId });
        return;
      }
      setPendingAsk({
        kind: "spawn-agent",
        requestId,
        requesterId,
        provider: params.provider,
        cwd: params.cwd,
        resumeId: params.resumeId,
        reason: params.reason,
        model: params.model,
        effort: params.effort,
        label: params.label,
      });
    });
    const offAskSpawnCard = window.spawn.onAskCard((requestId, requesterId, params) => {
      // DESIGN-BACKLOG.md item 60, peça 5 — same shape as spawn_agent's
      // autoApprove above, extended to non-terminal cards.
      if (params.autoApprove) {
        const spawned = spawnCardFor(params.kind, params.cwd, params.url, requesterId, params.anchorCardId, params.side);
        // Achado ao vivo (2026-09-02) — mesma lacuna do open_url acima:
        // spawn_card nunca registrava lineage, só spawn_agent tinha.
        // 2026-09-09 — same `reason`-as-label reasoning as spawn_agent above.
        // Reusing the singleton queue is not a new spawn, so do not draw a
        // misleading `spawned` connector to an existing card.
        if (requesterId && !spawned.reused) autoConnect(requesterId, spawned.cardId, "spawned", params.reason ? truncateConnectorLabel(params.reason) : null);
        void window.spawn.resolveCard(requestId, { ok: true, cardId: spawned.cardId });
        return;
      }
      setPendingAsk({
        kind: "spawn-card",
        requestId,
        requesterId,
        cardKind: params.kind,
        cwd: params.cwd,
        url: params.url,
        reason: params.reason,
        anchorCardId: params.anchorCardId,
        side: params.side,
      });
    });
    // Sticky item "close_card" (2026-09-03) — same ask/consent shape as
    // spawn above, opposite direction. `beginCloseAnimation` directly
    // (not `closeCard`'s own live-terminal "are you sure" gate) — the
    // human's approval of THIS request (or the autonomous auto-approve
    // below) already covers that decision, a second confirm would be
    // pure friction.
    const offAskClose = window.spawn.onAskClose((requestId, requesterId, target, reason, autoApprove) => {
      if (autoApprove) {
        beginCloseAnimation(target);
        void window.spawn.resolveClose(requestId, true);
        return;
      }
      setPendingAsk({ kind: "close-card", requestId, requesterId, target, reason });
    });
    // acbridge snapshot (item 4, DESIGN-BACKLOG.md) — main asks "what's on
    // screen for this target right now", only the renderer has the live
    // pan/zoom to answer. Reads cardsRef/worldRef (not `cards`/`world`
    // directly) since this listener is registered once at mount and needs
    // whatever's current at call time, not what was current when it was
    // registered.
    const offSnapshot = window.snapshot.onRectRequest((requestId, target) => {
      const vp = viewportRef.current?.getBoundingClientRect();
      const origin = vp ? { x: vp.x, y: vp.y } : { x: 0, y: 0 };
      let worldRect: Rect | null;
      if ("rect" in target) {
        worldRect = target.rect;
      } else {
        const card = cardsRef.current.find((c) => c.id === target.cardId);
        worldRect = card?.rect ?? null;
      }
      if (!worldRect) {
        window.snapshot.replyRect(requestId, null);
        return;
      }
      const screen = worldRectToScreen(worldRect, worldRef.current, origin);
      window.snapshot.replyRect(requestId, {
        x: Math.round(screen.x),
        y: Math.round(screen.y),
        width: Math.round(screen.w),
        height: Math.round(screen.h),
      });
    });
    // DESIGN-BACKLOG.md item 58, M1 — main asks "what does this terminal's
    // scrollback say", only the renderer holds the live xterm.js Terminal
    // instance (terminal-registry.ts). Replies null when there's no such
    // card, or it's not a terminal (nothing registered under that id).
    const offReadCard = window.readCard.onRequest((requestId, cardId, lines) => {
      window.readCard.reply(requestId, getTerminalText(cardId, lines));
    });
    // Achado ao vivo (2026-09-01) — read_sticky/write_sticky. Lê
    // `cardsRef` (não `cards`): este listener é registrado uma vez na
    // montagem e precisa do estado atual na hora da chamada, mesma razão
    // do listener de snapshot logo acima.
    const offSticky = window.sticky.onRequest((requestId, cardId, op) => {
      const card = cardsRef.current.find((c) => c.id === cardId);
      if (!card || card.kind !== "sticky") {
        window.sticky.reply(requestId, { ok: false, error: `no sticky card with id "${cardId}"` });
        return;
      }
      if (op.op === "read") {
        window.sticky.reply(requestId, { ok: true, content: card.content });
        return;
      }
      // A única proteção que a escrita tem (decidido com o usuário: sem
      // modal de consentimento) — e o renderer é o único lado que sabe
      // disso. `data-role`/`data-card-id` no próprio textarea
      // (StickyCard.tsx) é o que liga o elemento focado ao card; sem eles,
      // o `document.activeElement` não diria QUAL nota está sendo editada.
      // `data-role` (não a classe de estilo, que virou CSS Module hasheado
      // em 2026-09-03) é o hook estável pra esse tipo de checagem.
      const humanEditingNow = () => {
        const active = document.activeElement as HTMLElement | null;
        return active?.dataset.role === "sticky-textarea" && active.dataset.cardId === cardId;
      };
      // Cor/categoria (2026-09-02, `set_sticky_color`) — inofensivo, sem
      // guarda de foco (troca visual não apaga nada que um humano esteja
      // digitando).
      if (op.op === "set_color") {
        commitStickyColor(card, op.color);
        autoConnect(op.requesterId, cardId, "modified");
        window.sticky.reply(requestId, { ok: true, color: op.color });
        return;
      }
      // Modo edição/preview (2026-09-02, `set_sticky_mode`) — entrar em
      // edição é sempre inofensivo; FORÇAR preview enquanto um humano tem
      // o textarea focado de verdade recusa, mesma doutrina do write
      // abaixo ("nunca interromper o que a pessoa está fazendo").
      if (op.op === "set_mode") {
        if (op.mode === "preview" && humanEditingNow()) {
          window.sticky.reply(requestId, {
            ok: false,
            error: `sticky "${cardId}" is being edited by a human right now — not switching to preview; try again later`,
          });
          return;
        }
        commitStickyMode(card, op.mode);
        autoConnect(op.requesterId, cardId, "modified");
        window.sticky.reply(requestId, { ok: true, mode: op.mode });
        return;
      }
      if (humanEditingNow()) {
        window.sticky.reply(requestId, {
          ok: false,
          error: `sticky "${cardId}" is being edited by a human right now — not overwriting; try again later`,
        });
        return;
      }
      const isAppend = op.mode === "append";
      const next = isAppend ? card.content + op.content : op.content;
      changeStickyContent(cardId, next);
      commitStickyContent(card, next);
      autoConnect(op.requesterId, cardId, "modified", op.content ? truncateConnectorLabel(op.content) : null);
      if (isAppend) {
        window.sticky.reply(requestId, {
          ok: true,
          content: op.content,
          appended: true,
          totalLines: next.split("\n").length,
        });
      } else {
        window.sticky.reply(requestId, { ok: true, content: next });
      }
    });
    // DESIGN-BACKLOG.md item 60, peça 1 — one push per board whose queue
    // changed; replaces just that board's entry, leaves every other board
    // untouched.
    const offQueueChanged = window.spawn.onQueueChanged((boardId, queue) => {
      setSpawnQueues((prev) => ({ ...prev, [boardId]: queue }));
    });
    // Regra geral de auto-conector, metade que NÃO passa pelo renderer
    // hoje: `send_to_card` escreve direto no PTY em main (message-bus.ts),
    // sem round-trip nenhum — só assim consegue fazer o `connectorsRef`
    // dedup check + criar o conector de verdade no board aberto (a única
    // fonte de verdade pro estado `connectors` VISÍVEL é este processo).
    const offAutoConnect = window.store.connectors.onAutoConnect((fromCardId, toCardId, kind, label) => {
      autoConnect(fromCardId, toCardId, kind, label);
    });
    // Part 2's explicit half — `set_connector_label` (message-bus.ts)
    // mutated the DB directly (no round trip through this renderer, same
    // reason `send_to_card` above doesn't either), so the open board only
    // learns about it through this push. Reflects into local state
    // in-place instead of a full board reload.
    const offConnectorLabelChanged = window.store.connectors.onConnectorLabelChanged((id, label) => {
      setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)));
    });
    // DESIGN-BACKLOG.md §2.1 — mesmo caminho para `set_connector_kind`,
    // que até 2026-09-10 gravava no banco sem avisar ninguém: o kind só
    // aparecia num board aberto se ele tivesse sido definido na criação
    // (via `onAutoConnect`/`addConnector`), nunca numa alteração posterior.
    const offConnectorKindChanged = window.store.connectors.onConnectorKindChanged((id, kind) => {
      setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, kind } : c)));
    });
    // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 2 — mesmo padrão de
    // `offQueueChanged` acima: um push por board cujas tasks mudaram
    // (`main/index.ts`'s `notifyTaskChanged`, já filtrado por
    // `activeBoardId` do lado do main antes de sequer chegar aqui),
    // substitui só a entrada daquele board.
    const offTaskChanged = window.tasks.onChanged((boardId, tasks) => {
      setTaskBoards((prev) => ({ ...prev, [boardId]: tasks }));
    });
    // RODADA 3, peça 5 — rodapé de escopo: GLOBAL, substitui o mapa
    // inteiro a cada push (é um `GROUP BY` sobre todo `tasks`, mais barato
    // de simplesmente devolver por completo do que fazer o main computar
    // um diff).
    const offTaskScopeChanged = window.tasks.onScopeChanged((counts) => {
      setTaskCountsByBoard(counts);
    });
    return () => {
      offUrlSeen();
      offAskOpen();
      offAskBrowserPermission();
      offAskSpawnAgent();
      offAskSpawnCard();
      offAskClose();
      offSnapshot();
      offReadCard();
      offSticky();
      offQueueChanged();
      offAutoConnect();
      offConnectorLabelChanged();
      offConnectorKindChanged();
      offTaskChanged();
      offTaskScopeChanged();
    };
  }, []);

  // RODADA 3, peça 5 — carga inicial do rodapé de escopo. Uma vez só, no
  // boot (não depende de `activeBoardId` — é dado global, não por board,
  // ao contrário do efeito de `taskBoards` mais abaixo).
  useEffect(() => {
    window.tasks.countsByBoard().then(setTaskCountsByBoard);
  }, []);

  /** The active board's real working directory (item 1 revisited — "não
   * persiste o caminho correto") — every new card added while this board
   * is open (addTerminalCard/addFilesCard/addChangesCard, summarizeBoard)
   * defaults here instead of the app's own hardcoded DEFAULT_CWD, and
   * PathPicker.tsx's tree is what actually sets it now (see SessionModal,
   * createBoard/updateBoard in useBoardStore.ts). Falls back to
   * DEFAULT_CWD for a board that predates the `cwd` column (empty string
   * in the DB) or before any board is loaded at all. */
  const activeBoardCwd = boards.find((b) => b.id === activeBoardId)?.cwd || DEFAULT_CWD;
  // RODADA 3, peça 5 — rodapé de escopo do quadro de tasks. `useMemo`
  // (não um `Object.fromEntries` cru no JSX) pra manter a MESMA
  // referência entre renders enquanto `boards` não muda de verdade —
  // sem isso, todo drag de QUALQUER card recriaria este objeto e
  // derrubaria o `memo()` do TaskCard à toa (ele só precisa mudar
  // quando um board é criado/renomeado/apagado, não a cada pointermove).
  const boardNames = useMemo(() => Object.fromEntries(boards.map((b) => [b.id, b.name])), [boards]);

  /** Sets the workspace root directly, no dialog — PathPicker's header
   * breadcrumb (item 1, 2nd revisit) walks UP into `root`'s own ancestors
   * (up to 2 levels, computed from the path string alone) and clicking
   * one promotes it to root right away. Shared with `changeWorkspaceRoot`
   * below so both ways of changing the root stay in sync. */
  function navigateWorkspaceRoot(path: string) {
    setWorkspaceRoot(path);
    localStorage.setItem(WORKSPACE_ROOT_KEY, path);
  }

  /** PathPicker's "escolher outra pasta raiz" (reachable from every modal
   * with a project field — SessionModal create/edit, both via Home and
   * Topbar) — native OS folder dialog, for jumping somewhere the header's
   * ancestor crumbs can't reach (a sideways path, not just "up"). `null`
   * on cancel. */
  async function changeWorkspaceRoot() {
    const picked = await window.fs.pickDirectory(workspaceRoot);
    if (!picked) return;
    navigateWorkspaceRoot(picked);
  }

  // Fase B (atalhos) — despachante único. A cadeia de `if` que existia
  // aqui (uma checagem por atalho, guard `typing` copiado em cada uma) virou
  // UM registro declarativo (`shortcut-registry.ts`) + UMA resolução de
  // escopo real (`resolveShortcutScope` — soma foco, terminal e modal
  // aberto, não só "é focável") + UM matcher de combinação. A overlay de
  // "?" é GERADA do MESMO registro (`ShortcutsOverlay.tsx`), então as duas
  // coisas não têm mais como divergir (ver o doc comment no topo de
  // `shortcut-registry.ts` — é o ponto que fecha a causa raiz da fase B).
  //
  // `shortcutHandlersRef` existe pelo mesmo motivo do `zoomByRef` mais
  // abaixo: o listener se inscreve UMA vez (`[]` deps, igual já era antes
  // desta fase) e só lê a versão mais recente dos handlers via ref — sem
  // isso, `duplicateCard` (não memoizada) ficaria presa à closure da
  // primeira montagem, ou o efeito precisaria reassinar o listener a cada
  // render.
  const shortcutHandlersRef = useRef<Record<string, () => void>>({});
  shortcutHandlersRef.current = {
    "tool.pointer": () => setTool("pointer"),
    "tool.pen": () => setTool("pen"),
    "tool.connector": () => setTool("connector"),
    "tool.select": () => setTool("select"),
    // Escape exits pen/connector tool mode. Not required for correctness —
    // releasing the pointer already ends any in-progress stroke/connector
    // drag on its own (both are plain pointerdown→window pointermove/up
    // closures, immune to this component re-rendering) — just a cheap,
    // obvious way out for anyone who forgets which tool is active. Also
    // closes whatever else is open (this help, close confirmation, radial
    // menu, remote pairing) — see "tool.escapeReset" in the registry for
    // why it has no scope restriction.
    "tool.escapeReset": () => {
      setTool("pointer");
      setShowShortcuts(false);
      setPendingCloseId(null);
      setRadialMenu(null);
      setShowRemotePairing(false);
    },
    // Achado ao vivo (2026-09-02, fase A) — F11 apertado com foco dentro de
    // um terminal/navegador embutido bubblava até aqui e ligava o
    // fullscreen REAL da janela (nenhum desses componentes chama
    // `stopPropagation` pra F11, só `preventDefault`) — escondia o header
    // sem o usuário ter pedido. O escopo de "window.fullscreen" (só
    // "canvas", no registro) é o que impede isso agora.
    "window.fullscreen": () => {
      void window.winControls.toggleFullscreen();
    },
    "overlay.shortcuts.toggle": () => setShowShortcuts((v) => !v),
    // Achado 2 da revisão da fase A: o critério certo pra "Ctrl+D duplica
    // ou é EOF do terminal" é foco REAL (escopo), não "qual card está no
    // topo do z-order" — um card de terminal no topo mas sem foco de
    // teclado nele duplica normalmente. "card.duplicate" só dispara em
    // escopo "canvas" (registro); em escopo "terminal" este mesmo Ctrl+D
    // nem chega aqui, flui cru pro PTY ("terminal.eof" no registro).
    "card.duplicate": () => {
      const topId = orderRef.current[orderRef.current.length - 1];
      if (topId) duplicateCard(topId);
    },
  };

  // Fase C — mesmo motivo de `shortcutHandlersRef`/`zoomByRef`: o listener
  // se inscreve uma vez só, então precisa ler a sobreposição MAIS RECENTE
  // via ref, nunca a closure da montagem (sem isso, um rebind feito na
  // overlay só passaria a valer depois de um remount/reload).
  const shortcutOverridesRef = useRef(shortcutOverrides);
  shortcutOverridesRef.current = shortcutOverrides;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null;
      const id = resolveGlobalShortcut(
        e,
        {
          tagName: active?.tagName ?? "BODY",
          isContentEditable: active?.isContentEditable ?? false,
          isTerminalTextarea: active?.classList.contains("xterm-helper-textarea") ?? false,
          isModalOpen: isAnyModalOpen(),
        },
        shortcutOverridesRef.current,
      );
      if (!id) return;
      if (GLOBAL_SHORTCUTS_BY_ID[id]?.preventDefault) e.preventDefault();
      shortcutHandlersRef.current[id]?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Item 4 (atalhos, fase A) — Ctrl+Plus/Ctrl+Minus eram o zoom NATIVO do
  // Chromium, brigando com o zoom óptico do próprio canvas. Revisão pós-
  // review rodada 3 (2026-09-09): main/index.ts's `Menu` próprio já não
  // tem roles `zoomIn`/`zoomOut`/`resetZoom`, então não sobra zoom nativo
  // pra neutralizar — o que resta é só a FEATURE de redirecionar essas
  // duas teclas pro zoom do canvas (pedido original do item 4), via o
  // `before-input-event` (ainda vivo em main/index.ts, só pra isso —
  // nunca teve corrida, nada mudou aí). Main intercepta e reenvia pra cá;
  // usa o MESMO caminho que o botão de zoom do Topbar já usa (`zoomBy`/
  // `ZOOM_STEP`), nenhum segundo mecanismo de zoom novo. Ref pelo mesmo
  // motivo do keydown global acima (`zoomBy` é recriada a cada render
  // pelo `useWorldTransform`; sem isso o efeito reassinaria o listener
  // IPC a cada render à toa).
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const off = window.winControls.onZoomAccelerator((direction) => {
      zoomByRef.current(direction === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
    });
    return () => {
      off();
    };
  }, []);

  // Item 57.9 — sem isso, um drop que escape do `.viewport` (solto sobre
  // a rail/topbar) dispara o comportamento padrão do Electron de navegar
  // a janela pro `file://` solto, quebrando o app. Rede de segurança
  // global, além do onDrop/onDragOver do `.viewport` abaixo (que cobrem o
  // caso normal, dentro do canvas vazio).
  useEffect(() => {
    function prevent(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  function raise(id: string) {
    setOrder((prev) => [...prev.filter((x) => x !== id), id]);
  }

  /** Stricter than `isInView` (which is a plain bounding-box overlap check,
   * board-model.ts): a card mostly below the fold with just a sliver
   * poking into the viewport's bottom edge counts as "in view" there,
   * which is not what a human means by it. Used only for the new-card
   * off-screen-spawn guard below — `isInView` itself is unchanged since
   * other callers (visibility culling) want the lenient overlap check. */
  function centerInView(rect: Rect, viewport: Rect): boolean {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return cx >= viewport.x && cx <= viewport.x + viewport.w && cy >= viewport.y && cy <= viewport.y + viewport.h;
  }

  function addCard(card: Card) {
    // Keep the imperative view current before React renders the queued state
    // update. The task singleton guard can run twice in the same event turn
    // (for example, two approvals arriving together), so waiting for the
    // next render would leave a short duplicate-creation window.
    cardsRef.current = [...cardsRef.current, card];
    setCards((prev) => [...prev, card]);
    setOrder((prev) => [...prev, card.id]);
    void window.store.upsert(toRow(card, activeBoardIdRef.current!));
    toast(`${CARD_LABEL[card.kind]} criado${card.kind === "sticky" ? "a" : ""}`);
    // Pendentes #188 — every spawn path (rail, MCP spawn_card/spawn_agent,
    // open_url's auto-connect, duplicate) funnels through here, so this is
    // the one place that fixes "nasce no zoom atual do usuário" for all of
    // them at once. A card born at, say, 30% zoom reads as illegibly tiny
    // right when it's most useful to read. `setZoomAbs` anchors on the
    // current viewport CENTER (same math the zoom-pill already uses), not
    // on this new card's own rect — a full recenter-on-spawn would yank the
    // view away from whatever the user is actually looking at, which is
    // worse than leaving pan alone for a background/orchestrator-driven
    // spawn the human isn't watching.
    if (world.zoom !== 1) setZoomAbs(1);
  }

  /** Ctrl/Cmd+D (below) — clones the topmost card's full config (provider/
   * cwd/model for terminal, root for files/changes, url for browser, etc.)
   * at a small offset, fresh id, no group/label carried over. Terminal
   * cards never carry resumeId/continueLast — duplicating "the same
   * session" would mean two cards driving one real process; the point is a
   * fresh terminal with the same setup, not a second window onto the same
   * one (DESIGN-BACKLOG.md item 7). */
  function duplicateCard(id: string) {
    const source = cardsRef.current.find((c) => c.id === id);
    if (!source) return;
    const rect = { ...source.rect, x: source.rect.x + 32, y: source.rect.y + 32 };
    const newId = String(nextId.current++);
    const clone: Card =
      source.kind === "terminal"
        ? { ...source, id: newId, rect, groupId: null, label: null, resumeId: null, continueLast: false, initialInput: null }
        : { ...source, id: newId, rect, groupId: null, label: null };
    addCard(clone);
  }

  /** Rail's "localizar card" popover (DESIGN-BACKLOG.md item 7) — pans/
   * zooms to one card and brings it to front, same as clicking it directly
   * would via CardFrame's onRaise. */
  function jumpToCard(id: string) {
    focusCard(id);
    raise(id);
  }

  /** DESIGN-BACKLOG.md item 30 — the sessions popover's click handler
   * (Rail.tsx). Real bug found live via CDP building this: the SAME-board
   * case can't just call `switchBoard` (its own guard is a no-op when
   * already on that board id — `useBoardStore.ts`) NOR `loadBoard`
   * directly (it resets pan/zoom to origin unconditionally, a real,
   * disruptive side effect for "one card came back", not something this
   * small should cause). So same-board unarchive inserts the row
   * straight into `cards`/`order` state via the same `fromRow` every
   * other load path already uses, no board reload at all. Cross-board
   * unarchive-then-switch, by contrast, correctly picks the row up for
   * free — `switchBoard`'s own `loadBoard` fetches fresh from the store,
   * which by then no longer excludes it. */
  async function openChatSession(session: ChatSessionRow) {
    if (session.board_id === activeBoardIdRef.current) {
      if (session.archived_at !== null) {
        await window.store.unarchiveCard(session.id);
        const card = fromRow({ ...session, archived_at: null });
        setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]));
        setOrder((prev) => (prev.includes(card.id) ? prev : [...prev, card.id]));
      }
      jumpToCard(session.id);
      return;
    }
    if (session.archived_at !== null) await window.store.unarchiveCard(session.id);
    await switchBoard(session.board_id);
    // `focusCard` (inside jumpToCard) reads `cardsRef.current`, populated
    // by `loadBoard`'s own `setCards` — `await switchBoard()` only
    // guarantees the store fetch finished, not that React has committed
    // the resulting state yet. Two `requestAnimationFrame`s defensively
    // give React real paint cycles to catch up first — cheap insurance
    // against that race, not a proven-necessary fix.
    requestAnimationFrame(() => requestAnimationFrame(() => jumpToCard(session.id)));
  }

  /** `kind` — DESIGN-BACKLOG.md item 58 peça 4's field. Never drives
   * dispatch (see mcp-server.ts's `set_connector_kind`: advisory only,
   * on purpose — the real auto-dispatch mechanism is create_task's
   * `deps`, item 60 peça 3, deliberately separate). It DOES now flow
   * into this component's `Connector` state so the board can render/
   * react to it (Pendentes #188 — "conectores 100% decorativos"): a
   * real spawn (`spawnAgentFor`'s callers) passes `kind: "spawned"` here
   * to record actual lineage automatically; a human hand-drawing a
   * connector never passes one, staying `null` (purely decorative). */
  function addConnector(fromCardId: string, toCardId: string, kind?: string, label?: string | null) {
    const id = String(nextId.current++);
    const connector = { id, fromCardId, toCardId, kind: kind ?? null, label: label ?? null };
    setConnectors((prev) => [...prev, connector]);
    void window.store.connectors.upsert({
      id,
      board_id: activeBoardIdRef.current!,
      from_card_id: fromCardId,
      to_card_id: toCardId,
      updated_at: Date.now(),
      kind: kind ?? null,
      label: label ?? null,
    });
    if (!kind) toast("conector criado");
  }

  /** Regra geral pedida ao vivo (2026-09-02): "se um agente faz
   * modificação, spawn, write, em relação a outro objeto, o conector
   * conecta os dois card". `requesterId` já existe hoje pra spawn
   * (`addConnector(..., "spawned")`, achados nos 2 pontos que chamam
   * `spawnAgentFor` mais abaixo); isso generaliza pra qualquer outra
   * mutação cross-card que carregue identidade do chamador
   * (`write_sticky`/`set_sticky_color`/`set_sticky_mode`'s `offSticky`
   * abaixo, `send_to_card`'s push via `connector:auto`, ver
   * message-bus.ts). Idempotente por design, não só por educação: um
   * par (A,B) já conectado (em QUALQUER direção, kind qualquer —
   * inclusive um conector decorativo que um humano desenhou à mão) não
   * ganha uma 2ª seta a cada nova ação; mesmo carregando `kind` agora, a
   * escolha continua sendo não tocar num conector já existente — nunca
   * sobrescrever um kind que um humano ou outro agente já decidiu. */
  function autoConnect(requesterId: string | undefined | null, targetId: string, kind: string, label?: string | null) {
    if (!requesterId || requesterId === targetId) return;
    const existing = connectorsRef.current.find(
      (c) =>
        (c.fromCardId === requesterId && c.toCardId === targetId) ||
        (c.fromCardId === targetId && c.toCardId === requesterId),
    );
    if (existing) {
      // 2026-09-09, "contextualizar em tempo real" (relatório 2026-09-08)
      // — the automatic half of live-updating a label: a LATER mutation
      // between the same two cards (another `send`, a `write_sticky`,
      // etc.) overwrites the existing connector's label with the newest
      // one, so the pill tracks whatever the two cards are doing right
      // now instead of freezing at whatever created the connector.
      // Deliberately narrower than kind's own idempotence rule just above
      // this function: `kind` is a human/agent's considered semantic
      // ("depends"/"context") and must never be silently overwritten by a
      // later auto-connect — but a label is disposable, ambient context,
      // and going stale forever the moment a 2nd action happens is
      // exactly the bug being fixed here. Only touches `label`, never
      // `kind` — an existing "spawned" or hand-set "depends" connector
      // keeps its kind no matter how many more actions flow across it.
      // Skipped when the new label is null/empty (e.g. a scroll with no
      // selector) so a low-information event never blanks out a good
      // label a previous one set. The "is this actually different from
      // `existing.label`" dedupe used to live here too — it's now inside
      // `decideConnectorLabelSchedule` (review adversarial RODADA 5,
      // 2026-09-09), the single place that question gets answered, so
      // this only guards against calling the scheduler with no label at
      // all.
      if (label) scheduleConnectorLabelUpdate(existing.id, label);
      return;
    }
    addConnector(requesterId, targetId, kind, label);
  }

  /** Achado 1 (review adversarial, 2026-09-09) — throttle in front of
   * `updateConnectorLabel` for the AUTO half only (`autoConnect` above);
   * `set_connector_label`'s explicit path (`offConnectorLabelChanged`
   * below) is a deliberate call and stays untouched, same distinction the
   * finding asked for. Leading-edge-with-trailing-catch-up, keyed by
   * connector id: the first distinct label in a quiet connector writes
   * immediately (no reason to delay the FIRST real update); every other
   * one arriving inside `CONNECTOR_LABEL_THROTTLE_MS` of the last write
   * only overwrites `pendingLabel` — no SQLite UPDATE, no `setConnectors`
   * render — and a single trailing timer flushes whatever's pending when
   * the window closes, so the pill always lands on the LAST real value
   * instead of silently dropping it (a pure leading-edge throttle, like
   * `REPORT_NOTIFY_MIN_INTERVAL_MS` elsewhere in this codebase, would
   * drop it — fine for a one-shot notification, wrong for "what's the
   * connector doing right now"). Cuts BOTH costs the finding named (the
   * write and the render) together, since they're the same call
   * (`updateConnectorLabel` does the `setConnectors` + the `upsert` IPC
   * in one place) — there's no separate "push" to cut here, this branch
   * of `autoConnect` never goes over IPC from main, only the explicit
   * `set_connector_label` path does (see `onConnectorLabelChanged`). The
   * pre-existing dedupe that used to live in `autoConnect` moved into
   * `decideConnectorLabelSchedule` (review adversarial RODADA 5,
   * 2026-09-09) — a repeated IDENTICAL label still never reaches a
   * `setTimeout`/IPC call, that decision just isn't made HERE anymore. */
  function scheduleConnectorLabelUpdate(id: string, label: string) {
    const row = connectorsRef.current.find((c) => c.id === id);
    const map = connectorLabelThrottleRef.current;
    const existingState = map.get(id);
    const now = Date.now();

    // Achado (review adversarial RODADA 5, 2026-09-09) — the actual bug
    // that round: during the window between `useBoardStore.ts`'s
    // `setActiveBoardId` and the end of its `loadBoard` (tracked by
    // `boardTransitionRef`), `activeBoardIdRef.current` already points at
    // the incoming board while `connectorsRef.current` (read just above,
    // via `row`) can still hold the OUTGOING board's connectors — so a
    // stale event landing in that gap used to find a real-looking `row`
    // and snapshot it with the WRONG (new) `boardId`, a delayed write
    // eventually landing on a board that connector never belonged to
    // (worse still after a `deleteBoard`: the board it DID belong to is
    // gone, and the new board is being credited with someone else's
    // connector history). `decideConnectorLabelSchedule` is the single,
    // pure, Node-testable place this and every other "should I even
    // touch state" question about this throttle gets answered —
    // everything below this call is pure wiring: `Map` bookkeeping,
    // `setTimeout`, and the actual IPC/render side effects
    // (`applyConnectorLabelFlush`), none of which the decision itself
    // needs to know about.
    const decision = decideConnectorLabelSchedule({
      boardTransitionInFlight: boardTransitionRef.current,
      connectorExists: !!row,
      currentLabel: row?.label ?? null,
      nextLabel: label,
      now,
      lastWriteAt: existingState?.lastWriteAt ?? 0,
      hasPendingTimer: !!existingState?.timer,
      throttleWindowMs: CONNECTOR_LABEL_THROTTLE_MS,
    });
    if (decision.action === "ignore") return;
    // `row` is guaranteed non-null past this point — both "ignore" cases
    // that don't depend on it (`board-transition`) and the one that does
    // (`connector-gone`) already returned above.
    const state: ConnectorLabelThrottleEntry = existingState ?? {
      lastWriteAt: 0,
      timer: null,
      pendingLabel: null,
      boardId: activeBoardIdRef.current!,
      fromCardId: row!.fromCardId,
      toCardId: row!.toCardId,
      kind: row!.kind ?? null,
    };
    // Refresh the snapshot on every call (cheap) — keeps `boardId`/`kind`
    // accurate if either changed since this connector's last schedule,
    // without needing a separate invalidation path. Safe now in a way it
    // wasn't before this fix: `decideConnectorLabelSchedule` already
    // vetoed this whole call if a board transition was in flight, so
    // `activeBoardIdRef.current` here is guaranteed to be the SAME board
    // `row` actually belongs to.
    state.boardId = activeBoardIdRef.current!;
    state.fromCardId = row!.fromCardId;
    state.toCardId = row!.toCardId;
    state.kind = row!.kind ?? null;

    if (decision.action === "flush-now") {
      state.lastWriteAt = now;
      map.set(id, state);
      applyConnectorLabelFlush(id, state, label);
      return;
    }
    // decision.action === "queue"
    state.pendingLabel = label;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        const cur = map.get(id);
        if (!cur) return;
        cur.timer = null;
        cur.lastWriteAt = Date.now();
        const toWrite = cur.pendingLabel;
        cur.pendingLabel = null;
        if (toWrite != null) applyConnectorLabelFlush(id, cur, toWrite);
      }, decision.waitMs);
    }
    map.set(id, state);
  }

  /** Local-state + persisted half of a label change that did NOT come
   * from `set_connector_label`'s bus push (see `offConnectorLabelChanged`
   * below for that half) — reused by `scheduleConnectorLabelUpdate` above
   * (both its immediate and its trailing-timer branch) AND by the board-
   * switch/unmount cleanup effect below. Achado 2 (review adversarial
   * RODADA 2, 2026-09-09) — takes the connector's identity as a `snapshot`
   * parameter (captured at schedule time) instead of re-deriving it from
   * `connectorsRef.current`/`activeBoardIdRef` here: by the time a
   * trailing timer or a cleanup runs, those "current" refs may already
   * point at a DIFFERENT board than the one this connector actually
   * belongs to (see `ConnectorLabelThrottleEntry`'s own doc comment).
   * `setConnectors` is still always safe to call unconditionally — ids are
   * a single global sequence (store.ts) never reused across boards, so
   * mapping by id either hits the right connector (still on screen) or is
   * a harmless no-op (a different/no-longer-loaded board). Reuses the
   * full-row `upsert` plumbing `addConnector` already uses rather than
   * adding a 2nd IPC round trip for what's already a local mutation. */
  function applyConnectorLabelFlush(
    id: string,
    snapshot: Pick<ConnectorLabelThrottleEntry, "boardId" | "fromCardId" | "toCardId" | "kind">,
    label: string | null,
  ) {
    setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)));
    void window.store.connectors.upsert({
      id,
      board_id: snapshot.boardId,
      from_card_id: snapshot.fromCardId,
      to_card_id: snapshot.toCardId,
      updated_at: Date.now(),
      kind: snapshot.kind,
      label,
    });
  }

  /** Achado 2 (review adversarial RODADA 2, 2026-09-09) — the throttle
   * above only got cleared on an explicit connector delete; switching
   * boards (or unmounting) left trailing timers running for connectors
   * that were no longer on screen, and `connectorLabelThrottleRef`'s Map
   * entries leaked for the rest of the frontend session. `useEffect`'s
   * cleanup fires on BOTH cases this needs (dependency change = board
   * switch, unmount = closing the app/hot-reload), so one cleanup covers
   * both without hooking into `useBoardStore.ts`'s own switchBoard/goHome
   * (out of this task's file scope, and this is a strictly renderer-local
   * concern — that hook doesn't need to know throttling exists).
   * FLUSHES pending labels instead of dropping them: a `pendingLabel`
   * waiting in the queue is the most recent real value for that connector
   * — the exact thing "reflect the current task" exists to preserve —
   * dropping it here would silently regress to the label from before the
   * last burst. Writes through the entry's own SNAPSHOT (`boardId`/
   * `fromCardId`/`toCardId`/`kind`, captured back when it was scheduled),
   * not through `activeBoardIdRef`/`connectorsRef.current` — by the time
   * this cleanup runs, both of those may already reflect the board being
   * switched TO, not the one this connector belongs to; flushing through
   * the snapshot means the write correctly lands on the board the user is
   * LEAVING (accurate, not "stray") instead of risking a mislabel onto
   * the new one.
   * THE ASYMMETRY (review adversarial RODADA 4, 2026-09-09, spelled out
   * here because both cases run through this SAME effect and would
   * otherwise look inconsistent): this cleanup ALWAYS flushes — that's
   * only correct when the board being left still exists (an ordinary
   * `switchBoard`/`goHome`). `deleteBoard` (useBoardStore.ts) is the one
   * case where it wouldn't be: the board is gone by the time this would
   * fire, so flushing would `upsert` a phantom connector row pointing at
   * a `board_id` that no longer exists. That case is handled BEFORE this
   * effect ever sees it, not by branching in here:
   * `discardConnectorLabelThrottleForBoard` (below) is called from
   * `deleteBoard` ahead of its `setActiveBoardId`, removing that board's
   * entries from the map outright — so by the time THIS cleanup runs for
   * that same transition, there's nothing of the deleted board's left to
   * flush. One effect, two outcomes, decided entirely by who empties the
   * map first. */
  useEffect(() => {
    // Captured here, at effect-setup time, rather than read as
    // `connectorLabelThrottleRef.current` inside the cleanup below — same
    // Map object either way (this ref is never reassigned), but reading
    // `.current` directly inside a cleanup trips
    // `react-hooks/exhaustive-deps`'s "ref value may have changed by the
    // time this runs" check, which can't know that. Capturing the
    // reference up here is the idiomatic fix, not a suppression.
    const throttleMap = connectorLabelThrottleRef.current;
    return () => {
      for (const [id, state] of throttleMap) {
        if (state.timer) clearTimeout(state.timer);
        if (state.pendingLabel != null) applyConnectorLabelFlush(id, state, state.pendingLabel);
      }
      throttleMap.clear();
    };
  }, [activeBoardId]);

  // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 2 — carga inicial ao
  // trocar de board (o push acima só cobre mudanças POSTERIORES a este
  // efeito rodar). Mesmo formato de `TaskBoardItem[]` que o push entrega —
  // um único `IGNORE` de corrida: se o board mudar de novo antes da
  // promise resolver, `cancelled` descarta a resposta velha em vez de
  // pisar no board novo com dado do antigo.
  useEffect(() => {
    if (!activeBoardId) return;
    let cancelled = false;
    window.tasks.listByBoard(activeBoardId).then((tasks) => {
      if (cancelled) return;
      setTaskBoards((prev) => ({ ...prev, [activeBoardId]: tasks }));
    });
    return () => {
      cancelled = true;
    };
  }, [activeBoardId]);

  const { connectorDraft, startConnectorDrag } = useConnectorDrag(clientToWorld, cardsRef, order, addConnector);
  const { selectedIds, setSelectedIds, marquee, startMarqueeSelect, selectCard, groupSelected, ungroupSelected } =
    useCardSelection(cardsRef, setCards, activeBoardIdRef, nextId, clientToWorld, toRow);
  // Pre-release audit P1 — same stable-handler reasoning as the block
  // near cardsRef/orderRef above; these two specifically can only be
  // declared here, AFTER `startConnectorDrag`/`selectCard` exist (both
  // come from `const` destructuring above, not hoisted `function`
  // declarations like the rest, so referencing them any earlier would be
  // a real TDZ error, not just a style choice).
  const getConnectorStartHandler = useStableCardIdHandler(startConnectorDrag);
  const getSelectStartHandler = useStableCardIdHandler(selectCard);

  /** Achado 2 follow-up (found while fixing it, review adversarial RODADA
   * 2, 2026-09-09) — after `applyConnectorLabelFlush` stopped consulting
   * `connectorsRef.current` (the fix's whole point: a trailing timer must
   * flush through its own snapshot, not "current" state that may already
   * belong to a different board), it lost the free protection that guard
   * used to give for FREE against a connector that's gone by the time the
   * timer fires: `window.store.connectors.upsert` is an INSERT-or-UPDATE,
   * so flushing a pending label for a connector already deleted from the
   * DB would silently RESURRECT that row. `removeConnector` below already
   * clears its own entry synchronously on delete, so that path was never
   * at risk — but `finalizeCloseCard` and the chat-rename path
   * (`window.store.connectors.deleteForCard`) delete every connector
   * touching a closed card WITHOUT going through `removeConnector`, and
   * used to rely on that same now-removed guard. Called at both those
   * sites, right alongside `deleteForCard`, so a pending timer for a
   * connector on either side of the closed card is cancelled before it
   * can fire into a ghost row. */
  function clearConnectorLabelThrottleForCard(cardId: string) {
    const map = connectorLabelThrottleRef.current;
    for (const [connectorId, state] of map) {
      if (state.fromCardId !== cardId && state.toCardId !== cardId) continue;
      if (state.timer) clearTimeout(state.timer);
      map.delete(connectorId);
    }
  }

  /** Achado (review adversarial RODADA 4, 2026-09-09) — the SAME
   * resurrection risk as `clearConnectorLabelThrottleForCard` above, one
   * level up: `deleteBoard` (useBoardStore.ts) deletes the board and its
   * cards from the DB, then — if it was the active one — flips
   * `activeBoardId` to whatever board comes next. That flip is exactly
   * what the board-switch flush `useEffect` below reacts to, and its
   * cleanup would happily `upsert` a pending label's connector row with
   * `board_id` set to the board that JUST got deleted — a phantom row
   * referencing a board that no longer exists.
   * THE ASYMMETRY, spelled out because both cases run through the SAME
   * effect and look inconsistent otherwise: an ordinary `switchBoard`/
   * `goHome` moves to a board that still exists, so that effect's
   * snapshot-based flush has somewhere real to land — data isn't lost,
   * it's correctly written to the board being LEFT. A deleted board has
   * nowhere for that data to go anymore, so here the right move is to
   * DISCARD the pending label, not flush it. This function is how: called
   * from `deleteBoard` BEFORE it changes `activeBoardId`, it removes
   * every throttle entry that belongs to the board being deleted — by
   * the time the flush effect's cleanup actually runs for that
   * transition, there's nothing left of this board's entries for it to
   * (wrongly) write. The effect itself never needs to know which case
   * it's in; the asymmetry lives entirely in who gets to run first.
   * Not-a-bug noted by the reviewer (RODADA 5, 2026-09-09): this plain
   * `function` is recreated every render and passed straight into
   * `useBoardStore(...)` below as `discardPendingConnectorLabelsForBoard`
   * — harmless today since nothing puts it in a dependency array, only
   * calls it imperatively from inside `deleteBoard`. Left un-memoized on
   * purpose rather than "for free": `useCallback` needs a `const`, and a
   * `const`'s TDZ would require moving this whole definition above the
   * `useBoardStore(...)` call (its point of use) instead of relying on
   * `function` hoisting the way it does now — a real relocation, not a
   * free wrap, for a function that costs nothing extra to recreate each
   * render (no closure over anything but the stable
   * `connectorLabelThrottleRef`). */
  function discardConnectorLabelThrottleForBoard(boardId: string) {
    const map = connectorLabelThrottleRef.current;
    for (const [connectorId, state] of map) {
      if (state.boardId !== boardId) continue;
      if (state.timer) clearTimeout(state.timer);
      map.delete(connectorId);
    }
  }

  function removeConnector(id: string) {
    setConnectors((prev) => prev.filter((c) => c.id !== id));
    void window.store.connectors.delete(id);
    // Achado 1's throttle state is keyed by connector id — drop it here so
    // a stale trailing timer never fires `applyConnectorLabelFlush` for a
    // connector that no longer exists.
    const pending = connectorLabelThrottleRef.current.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    connectorLabelThrottleRef.current.delete(id);
    toast("conector removido");
  }

  /** Finalizes a pen stroke into a real `kind:"stroke"` card — its rect is the drawn bounding box, not the toolbar-button cascade slot. */
  function finishStroke(points: Point[], color: string) {
    if (points.length < MIN_STROKE_POINTS) return;
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const w = maxX - minX + STROKE_PADDING * 2;
    const h = maxY - minY + STROKE_PADDING * 2;
    if (w <= STROKE_PADDING * 2 || h <= STROKE_PADDING * 2) return;
    const normalized: [number, number][] = points.map((p) => [
      (p.x - minX + STROKE_PADDING) / w,
      (p.y - minY + STROKE_PADDING) / h,
    ]);
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "stroke",
      points: normalized,
      color,
      width: newStrokeWidth,
      style: newStrokeStyle,
      rect: { x: minX - STROKE_PADDING, y: minY - STROKE_PADDING, w, h },
      groupId: null,
      label: null,
    });
  }

  /** `at`: world point to spawn at (radial menu, item 1) — omitted for the
   * rail's own buttons, which keep centering on the visible viewport.
   * `provider`: override for the radial's terminal-provider submenu
   * (item 2) — picking a provider there bypasses the rail's own
   * `newProvider` state entirely (that state is only for the
   * terminal-config popover's own "provider" field) rather than calling
   * `setNewProvider` first and racing this function's read of the stale
   * pre-update value in the same render. */
  function addTerminalCard(at?: Point, provider?: string) {
    const id = String(nextId.current++);
    const rect = at ? pointSlot(at) : centeredSlot(visibleRect, cards.length, existingRectsFor(cards));
    addCard({
      id,
      kind: "terminal",
      provider: provider ?? newProvider,
      cwd: activeBoardCwd,
      resumeId: newResumeId.trim() || null,
      continueLast: newResumeId.trim() === "" && newContinueLast,
      model: newModel.trim() || null,
      effort: newEffort || null,
      systemPrompt: newSystemPrompt.trim() || null,
      initialInput: null,
      rect,
      groupId: null,
      label: null,
    });
    // centeredSlot's collision ring-search (board-model.ts) can walk a new
    // card's slot almost a full SPAWN_H/W past the naive centered position
    // to dodge an existing card — easily past the edge of the viewport on a
    // small window. Same guard as the pendingOpenUrl reuse path below: only
    // recenter when the card actually landed out of view. Deferred a tick:
    // `focusCard` reads `cardsRef.current`, which only picks up this card
    // after the `setCards` above commits and re-renders — calling it in the
    // same tick finds nothing and silently no-ops.
    if (!centerInView(rect, visibleRect)) setTimeout(() => focusCard(id), 0);
  }

  /** Replaces the 6 near-identical addXCard functions that used to live
   * here (files/changes/sticky/chat/browser/remote-window — see
   * cards/registry.ts's `defaultCardFields`, item "4 (deferida)"). Human
   * path only — via the Rail's one-click buttons or the radial menu (item
   * 12's chat card, item 21's browser card: no owner, no consent gate,
   * see AGENTS.md); the spawn-from-agent path (spawnCardFor below) is
   * separate and gated. `at`: world point to spawn at (radial menu),
   * omitted for the rail's own buttons, which keep centering on the
   * visible viewport. */
  function addCardOfKind(kind: (typeof RAIL_CREATE_ORDER)[number], at?: Point) {
    if (kind === "task") {
      const boardId = activeBoardIdRef.current;
      const decision = boardId
        ? decideTaskCardSpawn(
            cardsRef.current.map((card) => ({ id: card.id, boardId, kind: card.kind, archivedAt: null })),
            boardId,
          )
        : { action: "create" as const };
      if (decision.action === "reuse") {
        focusCard(decision.cardId);
        toast("A fila deste board já existe — focando o card existente");
        return;
      }
    }
    const id = String(nextId.current++);
    const rect = at ? pointSlot(at) : centeredSlot(visibleRect, cards.length, existingRectsFor(cards));
    addCard({
      id,
      ...defaultCardFields(kind, activeBoardCwd),
      rect,
      groupId: null,
      label: null,
    } as Card);
    // Same off-screen-spawn guard as addTerminalCard above — see its comment.
    if (!centerInView(rect, visibleRect)) setTimeout(() => focusCard(id), 0);
  }

  const MEDIA_MAX_DIM = 900;
  const MEDIA_MIN_DIM = 160;
  const PDF_DEFAULT_ASPECT = 4 / 3;

  function fitMediaRect(naturalW: number, naturalH: number, at: Point): Rect {
    const scale = Math.min(1, MEDIA_MAX_DIM / Math.max(naturalW, naturalH));
    const w = Math.max(MEDIA_MIN_DIM, naturalW * scale);
    const h = Math.max(MEDIA_MIN_DIM, naturalH * scale);
    return { x: at.x - w / 2, y: at.y - h / 2, w, h };
  }

  function defaultPdfRect(at: Point): Rect {
    const w = 700;
    const h = w / PDF_DEFAULT_ASPECT;
    return { x: at.x - w / 2, y: at.y - h / 2, w, h };
  }

  function imageNaturalSize(file: File): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ w: img.naturalWidth || MEDIA_MAX_DIM, h: img.naturalHeight || MEDIA_MAX_DIM * 0.75 });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ w: MEDIA_MAX_DIM, h: MEDIA_MAX_DIM * 0.75 });
      };
      img.src = url;
    });
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** Drop de um arquivo real do SO tem um path resolvível via
   * `webUtils.getPathForFile` (Electron 32+) — paste do clipboard não
   * (File sintético, só em memória), daí o try/catch: distingue os dois
   * casos sem precisar saber de antemão qual gesto originou o File. */
  function getRealPath(file: File): string | null {
    try {
      return window.boardAssets.getPathForFile(file) || null;
    } catch {
      return null;
    }
  }

  /** Item 57.9 — colar/arrastar uma imagem ou PDF no canvas vazio. PDF só
   * nasce de drop (path real de SO) — clipboard essencialmente nunca
   * carrega um PDF como item colável do jeito que carrega uma imagem
   * (limite de escopo deliberado, ver o plano). */
  async function createMediaCardFromFile(file: File, at: Point) {
    const boardId = activeBoardIdRef.current;
    if (!boardId) return;
    const mediaType: "image" | "pdf" | null = file.type.startsWith("image/")
      ? "image"
      : file.type === "application/pdf"
        ? "pdf"
        : null;
    if (!mediaType) return;

    const realPath = getRealPath(file);
    let saveResult: SaveBoardAssetResult;
    if (realPath) {
      saveResult = await window.boardAssets.copyFromPath(boardId, realPath);
    } else if (mediaType === "image") {
      saveResult = await window.boardAssets.saveBytes(boardId, await fileToBase64(file), file.type);
    } else {
      toast("PDF precisa ser arrastado (drop) — colar do clipboard não é suportado");
      return;
    }
    if (!saveResult.ok) {
      toast(`falha ao salvar mídia: ${saveResult.error}`);
      return;
    }

    let rect: Rect;
    if (mediaType === "image") {
      const { w, h } = await imageNaturalSize(file);
      rect = fitMediaRect(w, h, at);
    } else {
      rect = defaultPdfRect(at);
    }

    const id = String(nextId.current++);
    addCard({
      id,
      kind: "media",
      assetPath: saveResult.path,
      mediaType,
      rotation: 0,
      view: DEFAULT_MEDIA_VIEW,
      rect,
      groupId: null,
      label: null,
    });
  }

  /** Agent-requested (post-Allow) or a seenUrls chip click confirmed via the
   * `pendingOpenUrl`/ConfirmModal gate below — both are already-consented
   * by the time this runs. Reuses this owner's existing browser card if
   * one is open, else opens a new one. No toast here — this path isn't the
   * human "I just clicked +browser" moment the toasts above are for.
   * Returns the card id — spawn_card's browser variant (below) and the
   * acbridge/MCP "open" ask flow both need to report which card actually
   * got used back to the caller. `rectOverride`, when given (anchored
   * spawn — see `spawnCardFor`), is the IDEAL anchored position, not the
   * final one: it still goes through `nearestFreeSlot` below so an
   * anchored browser card doesn't land stacked on whatever already
   * occupies that spot (2026-09-09 fix, same as the non-browser path). */
  function openBrowserFor(ownerCardId: string | null, url: string, rectOverride?: Rect): string {
    const existing = cardsRef.current.find((c) => c.kind === "browser" && c.ownerCardId === ownerCardId);
    if (existing) {
      void window.browser.navigate(existing.id, url);
      raise(existing.id);
      return existing.id;
    }
    const id = String(nextId.current++);
    const rect = rectOverride
      ? nearestFreeSlot(rectOverride, existingRectsFor(cardsRef.current), visibleRect)
      : centeredSlot(visibleRect, cardsRef.current.length, existingRectsFor(cardsRef.current));
    const card: Card = {
      id,
      kind: "browser",
      url,
      ownerCardId,
      rect,
      groupId: null,
      label: null,
    };
    setCards((prev) => [...prev, card]);
    setOrder((prev) => [...prev, id]);
    void window.store.upsert(toRow(card, activeBoardIdRef.current!));
    // Pendentes #188 — same fix as `addCard`'s, duplicated here since this
    // path deliberately skips `addCard` (see its own comment above) and a
    // browser card born from open_url is exactly the "hard to read at the
    // user's current zoom" case the item calls out.
    if (world.zoom !== 1) setZoomAbs(1);
    return id;
  }

  // DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — a second (or third,
  // fourth agent...) terminal card, spawned by an already-running agent
  // rather than a human. Always through `addCard` (unlike openBrowserFor
  // above) — this IS the "something appeared on the board that a human
  // didn't click" moment the toast exists for.
  function spawnAgentFor(provider: string, cwd?: string, resumeId?: string, model?: string, label?: string, effort?: string): string {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "terminal",
      provider,
      cwd: cwd || activeBoardCwd,
      resumeId: resumeId || null,
      continueLast: false,
      model: model || null,
      effort: effort || null,
      systemPrompt: null,
      initialInput: null,
      rect: centeredSlot(visibleRect, cardsRef.current.length, existingRectsFor(cardsRef.current)),
      groupId: null,
      // DESIGN-BACKLOG.md item 62 — an MCP-driven spawn can name its own
      // child agent, same free-text field CardTag rename already sets;
      // `describeCard`/`describeCardLabel` already prefer it over the
      // ordinal convention whenever it's non-null.
      label: label || null,
    });
    return id;
  }

  /** DESIGN-BACKLOG.md item 57 ponto 13 — o botão "abrir terminal" do
   * aviso de CLI ausente (Topbar.tsx/useAgentAvailability.ts). Achado ao
   * vivo, 2026-09-03: morava dentro do fluxo de spawn de um card
   * (mostrava só DEPOIS de tentar e falhar, quebrando o fluxo do
   * usuário) — movido pro Topbar, que consulta a disponibilidade ANTES
   * de qualquer spawn. Um card `bash` puro no cwd do board ativo, com
   * `command` digitado no PTY logo após o spawn (useTerminal.ts's
   * `initialInput`) — nunca executado sozinho, o humano ainda aperta
   * Enter, mesmo espírito de toda ação com gate de consentimento
   * neste app (nunca rodar um install sozinho). */
  function openInstallTerminal(providerId: string, command: string) {
    const id = String(nextId.current++);
    addCard({
      id,
      kind: "terminal",
      provider: "bash",
      cwd: activeBoardCwd,
      resumeId: null,
      continueLast: false,
      model: null,
      effort: null,
      systemPrompt: null,
      initialInput: command,
      rect: centeredSlot(visibleRect, cardsRef.current.length, existingRectsFor(cardsRef.current)),
      groupId: null,
      label: `instalar ${providerId}`,
    });
  }

  // DESIGN-BACKLOG.md item 21, ponto 9, achado 2 — generalizes
  // openBrowserFor above to every non-terminal card kind. `browser`
  // delegates straight to openBrowserFor for identical owner-reuse
  // behavior — spawn_card's browser variant and the legacy `open` cmd
  // both end up at one real implementation, not two.
  type SpawnCardOutcome = { cardId: string; reused: boolean };

  function spawnCardFor(
    kind: SpawnCardKind,
    cwd: string | undefined,
    url: string | undefined,
    requesterId: string | null,
    anchorCardId?: string,
    side?: AnchorSide,
  ): SpawnCardOutcome {
    if (kind === "task") {
      const boardId = activeBoardIdRef.current;
      const decision = boardId
        ? decideTaskCardSpawn(
            cardsRef.current.map((card) => ({ id: card.id, boardId, kind: card.kind, archivedAt: null })),
            boardId,
          )
        : { action: "create" as const };
      if (decision.action === "reuse") return { cardId: decision.cardId, reused: true };
    }
    // Pendentes #188 ("spawn_card por coordenadas") — anchorCardId's
    // existence was already validated by message-bus.ts against the live
    // card list; a card that closed in the gap between that check and this
    // call is the one case still possible here, so fall back to the usual
    // centeredSlot rather than crash on `undefined.rect`.
    const anchor = anchorCardId ? cardsRef.current.find((c) => c.id === anchorCardId) : undefined;
    // `anchoredBase`: a posição IDEAL perto do card pai — não a final.
    // `nearestFreeSlot` decide onde plantar de verdade a partir dela (2026-
    // 09-09 fix: um card ancorado nascia colado no pai mesmo quando esse
    // ponto já estava ocupado por outro card).
    const anchoredBase = anchor && side ? anchoredSlot(anchor.rect, side) : undefined;
    if (kind === "browser") return { cardId: openBrowserFor(requesterId, url || "about:blank", anchoredBase), reused: false };
    const id = String(nextId.current++);
    const existingRects = existingRectsFor(cardsRef.current);
    const rect = anchoredBase
      ? nearestFreeSlot(anchoredBase, existingRects, visibleRect)
      : centeredSlot(visibleRect, cardsRef.current.length, existingRects);
    const card = {
      id,
      ...defaultCardFields(kind, cwd || activeBoardCwd),
      rect,
      groupId: null,
      label: null,
    } as Card;
    addCard(card);
    return { cardId: id, reused: false };
  }

  function allowAsk() {
    if (!pendingAsk) return;
    const ask = pendingAsk;
    setPendingAsk(null);
    if (ask.kind === "open") {
      const cardId = openBrowserFor(ask.requesterId, ask.url);
      // Achado ao vivo (2026-09-02) — mesma lacuna do autoApprove acima,
      // pro caminho aprovado por um humano.
      if (ask.requesterId) autoConnect(ask.requesterId, cardId, "spawned");
      void window.browser.resolveAsk(ask.requestId, true, cardId);
    } else if (ask.kind === "spawn-agent") {
      const cardId = spawnAgentFor(ask.provider, ask.cwd, ask.resumeId, ask.model, ask.label, ask.effort);
      // DESIGN-BACKLOG.md item 62 — same lineage record as the
      // autonomous auto-approve path above, for a human-approved spawn.
      // 2026-09-09 — same `reason`-as-label reasoning as the auto-approve path above.
      if (ask.requesterId) addConnector(ask.requesterId, cardId, "spawned", ask.reason ? truncateConnectorLabel(ask.reason) : null);
      void window.spawn.resolveAgent(ask.requestId, { ok: true, cardId });
    } else if (ask.kind === "spawn-card") {
      const spawned = spawnCardFor(ask.cardKind, ask.cwd, ask.url, ask.requesterId, ask.anchorCardId, ask.side);
      if (ask.requesterId && !spawned.reused) autoConnect(ask.requesterId, spawned.cardId, "spawned", ask.reason ? truncateConnectorLabel(ask.reason) : null);
      void window.spawn.resolveCard(ask.requestId, { ok: true, cardId: spawned.cardId });
    } else {
      // "close-card" — see `beginCloseAnimation`'s own note in the
      // autonomous auto-approve branch above for why this skips
      // `closeCard()`'s live-terminal re-confirm.
      beginCloseAnimation(ask.target);
      void window.spawn.resolveClose(ask.requestId, true);
    }
  }

  function denyAsk() {
    if (!pendingAsk) return;
    const ask = pendingAsk;
    setPendingAsk(null);
    if (ask.kind === "open") void window.browser.resolveAsk(ask.requestId, false);
    else if (ask.kind === "spawn-agent") void window.spawn.resolveAgent(ask.requestId, { ok: false, error: "denied by user" });
    else if (ask.kind === "spawn-card") void window.spawn.resolveCard(ask.requestId, { ok: false, error: "denied by user" });
    else void window.spawn.resolveClose(ask.requestId, false);
  }

  /** title/command text for whichever AgentAskModal is currently pending — kept out of the JSX below for readability. */
  function describeAsk(ask: PendingAsk): { title: string; command: string } {
    if (ask.kind === "open") return { title: "Permissão do navegador", command: ask.url };
    if (ask.kind === "spawn-agent") {
      return {
        title: "Permissão: spawnar agente",
        // DESIGN-BACKLOG.md item 62 — mostra o nome pedido pro agente
        // novo, se algum, antes do humano aprovar.
        command: `${ask.provider}${ask.label ? ` "${ask.label}"` : ""}${ask.cwd ? ` em ${ask.cwd}` : ""}${ask.resumeId ? ` (retomar ${ask.resumeId})` : ""}`,
      };
    }
    if (ask.kind === "spawn-card") {
      return {
        title: "Permissão: criar card",
        command: `${ask.cardKind}${ask.cwd ? ` em ${ask.cwd}` : ""}${ask.url ? ` (${ask.url})` : ""}`,
      };
    }
    return { title: "Permissão: fechar card", command: describeCard(ask.target) };
  }

  /** Item 2 (2026-09-09, pedido do dono do repo) — antes era literalmente
   * uma grade de 3 colunas na ordem de criação, ignorando os conectores por
   * completo (o próprio comentário antigo admitia isso: "reorganize is just
   * re-running that grid"). Agora lê o grafo de conectores do board
   * (`connectorsRef`) e monta um layout hierárquico dirigido — pai em cima,
   * filho embaixo (ver `hierarchicalLayout` em board-model.ts pra a decisão
   * completa). Cards sem conector nenhum caem na grade à parte de sempre. */
  function aiReorganize() {
    const nodes = cardsRef.current.map((c) => ({ id: c.id, w: c.rect.w, h: c.rect.h }));
    const positions = hierarchicalLayout(nodes, connectorsRef.current);
    const next = cardsRef.current.map((c) => ({ ...c, rect: positions.get(c.id) ?? c.rect }));
    setReflowing(true);
    setCards(next);
    next.forEach((c) => void window.store.upsert(toRow(c, activeBoardIdRef.current!)));
    toast("Cards organizados");
    window.setTimeout(() => setReflowing(false), REFLOW_MS);
  }

  /** Read-only snapshot for the AI action below — never mutates a card, never reads terminal scrollback (out of scope, see AGENTS.md). */
  async function buildBoardSnapshot(): Promise<string> {
    const lines: string[] = [];
    for (const c of cardsRef.current) {
      if (c.kind === "sticky") {
        lines.push(`- [nota adesiva, ${c.color}] ${c.content || "(vazia)"}`);
      } else if (c.kind === "files") {
        lines.push(`- [arquivos] raiz: ${c.root}`);
      } else if (c.kind === "changes") {
        try {
          const status = await window.git.status(c.root);
          if (!status.repo) {
            lines.push(`- [changes] raiz: ${c.root} (não é um repositório git)`);
          } else {
            const entries = status.entries.map((e) => `${e.status} ${e.path}`).join(", ");
            lines.push(
              `- [changes] raiz: ${c.root} (branch ${status.branch}, +${status.insertions}/-${status.deletions}${
                entries ? `: ${entries}` : ""
              })`,
            );
          }
        } catch {
          lines.push(`- [changes] raiz: ${c.root} (status indisponível)`);
        }
      } else if (c.kind === "browser") {
        lines.push(`- [navegador] ${c.url}`);
      } else if (c.kind === "stroke") {
        lines.push(`- [desenho] ${c.points.length} pontos`);
      } else if (c.kind === "remote-window") {
        lines.push(`- [janela externa] controle remoto`);
      } else if (c.kind === "chat") {
        lines.push(`- [chatbox ${c.model}] ${c.messages.length} mensagens`);
      } else if (c.kind === "media") {
        lines.push(`- [mídia ${c.mediaType}] ${c.assetPath}`);
      } else if (c.kind === "task") {
        const boardTasks = activeBoardId ? taskBoards[activeBoardId] ?? [] : [];
        lines.push(`- [fila] ${boardTasks.length} tasks`);
      } else {
        lines.push(`- [terminal ${c.provider}] cwd: ${c.cwd}`);
      }
    }
    for (const conn of connectors) {
      lines.push(`- [conector] ${describeCard(conn.fromCardId)} → ${describeCard(conn.toCardId)}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(board vazio)";
  }

  /** "Resumir" — the only AI action implemented so far. Read-only: the result becomes a new sticky note, nothing on the board is mutated on the AI's behalf (see AGENTS.md). */
  async function summarizeBoard() {
    if (newProvider === "bash" || aiBusy) return;
    setAiBusy(true);
    try {
      const snapshot = await buildBoardSnapshot();
      const prompt =
        `Aqui está o estado atual de um board de cards (canvas de trabalho):\n\n${snapshot}\n\n` +
        "Resuma esse estado em 2-4 frases, em português. Não use nenhuma ferramenta, responda só com o texto do resumo.";
      const result = await window.ai.summarize(newProvider, activeBoardCwd, prompt);
      const id = String(nextId.current++);
      const content = "text" in result ? result.text : `Erro: ${result.error}`;
      addCard({
        id,
        kind: "sticky",
        content,
        color: "blue",
        mode: "preview",
        rect: cascadeSlot(cardsRef.current.length),
        groupId: null,
        label: null,
      });
      toast("Nota de resumo criada");
    } finally {
      setAiBusy(false);
    }
  }

  // DESIGN-BACKLOG.md §2.1, identidade de card — the same pure function
  // feeds consent/toast prose AND CardFrame's header. `cardsRef` contains
  // only the currently loaded board, so a terminal on another board cannot
  // affect this card's ordinal. The derived name is display-only: every
  // target/key path continues to use `id`.
  function describeCard(id: string): string {
    const c = cardsRef.current.find((x) => x.id === id);
    if (!c) return `card #${id}`;
    return deriveCardDisplayName(
      cardIdentitySnapshot(c),
      cardsRef.current.map(cardIdentitySnapshot),
    );
  }

  /** The actual removal — cards/order/connectors/selection/liveStatus state
   * plus the store. Split from `closeCard` below so the close animation can
   * play first: the DOM node has to still exist while `.closing`'s
   * animation runs, so this only fires once that animation ends, not on
   * the click that requested the close. */
  function finalizeCloseCard(id: string) {
    // Item 30 — captured before the filter below removes it from `cards`;
    // `kind` decides delete vs. archive right after.
    const closedKind = cardsRef.current.find((c) => c.id === id)?.kind;
    setCards((prev) => prev.filter((c) => c.id !== id));
    setOrder((prev) => prev.filter((x) => x !== id));
    setConnectors((prev) => prev.filter((c) => c.fromCardId !== id && c.toCardId !== id));
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setLiveStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setClosingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // `onCloseAnimationEnd` AND the setTimeout fallback in
    // `beginCloseAnimation` below both call this same function — real
    // double-invocation, not hypothetical (confirmed live via CDP: it
    // was actually happening every close). The old plain `store.delete`
    // tolerated that for free (deleting an already-deleted row is a
    // harmless no-op). Item 30's archive/delete branch does NOT tolerate
    // it the same way: `closedKind` reads `cardsRef.current`, which the
    // FIRST call already filtered this card out of — the SECOND call
    // sees `undefined`, which used to silently fall through to `delete`
    // and would have UN-archived (deleted) a chat this same function
    // just archived a moment earlier. Bailing out whenever the card is
    // already gone from state makes both calls (again) idempotent — only
    // the true first invocation ever touches the store.
    if (closedKind === undefined) return;
    // Item 30 — a chat card's history is worth keeping around for the
    // sessions sidebar; every other kind still hard-deletes exactly as
    // before (a terminal's PTY, a browser's page, a file tree — nothing
    // there is meaningful to "reopen" the way a conversation is).
    if (closedKind === "chat") {
      void window.store.archiveCard(id);
      // Pre-release audit B2 — a write/bash consent still pending for
      // THIS card has no UI left to ever resolve it (its ChatCard is
      // gone); tell main so it denies rather than wedging that
      // provider's tool loop forever.
      window.chat.notifyCardClosed(id);
    } else void window.store.delete(id);
    void window.store.connectors.deleteForCard(id);
    clearConnectorLabelThrottleForCard(id);
  }

  /** Every card's own onClose calls this, not finalizeCloseCard directly —
   * marks the card as closing (CardFrame renders it with the .closing
   * animation class) and lets the animation's own end event trigger the
   * real removal. Also schedules finalizeCloseCard as a plain timeout, not
   * just on animationend: `prefers-reduced-motion: reduce` drops the
   * animation entirely (animations.css), which means no animationend event
   * ever fires — without this fallback the card would stay stuck forever
   * for anyone with that preference set. finalizeCloseCard no-ops safely
   * if called twice (whichever path fires first wins). */
  function beginCloseAnimation(id: string) {
    setClosingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setTimeout(() => finalizeCloseCard(id), 180);
  }

  /** A terminal card whose process hasn't reported "error"/"exited" yet is
   * assumed live — closing it kills a real running process, with no undo
   * (DESIGN-BACKLOG.md item 7: closing was instant and irreversible, the
   * one item flagged as an actual data-loss risk rather than convenience).
   * Every other card kind, and a terminal that's already dead, closes
   * immediately same as before — there's nothing to lose there, and
   * demanding confirmation for a files/sticky/browser card would just be
   * friction with no safety benefit. */
  function closeCard(id: string) {
    const card = cardsRef.current.find((c) => c.id === id);
    const isLiveTerminal = card?.kind === "terminal" && liveStatus[id] !== "error" && liveStatus[id] !== "exited";
    if (isLiveTerminal) {
      setPendingCloseId(id);
      return;
    }
    beginCloseAnimation(id);
  }

  function confirmCloseCard() {
    if (!pendingCloseId) return;
    beginCloseAnimation(pendingCloseId);
    setPendingCloseId(null);
  }

  function cancelCloseCard() {
    setPendingCloseId(null);
  }

  function cycleBgStyle() {
    setBgStyle((prev) => {
      const next = BG_STYLE_ORDER[(BG_STYLE_ORDER.indexOf(prev) + 1) % BG_STYLE_ORDER.length];
      localStorage.setItem(BG_STYLE_KEY, next);
      return next;
    });
  }

  function renameCard(id: string, label: string) {
    setCards((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, label } : c));
      const updated = next.find((c) => c.id === id);
      if (updated) void window.store.upsert(toRow(updated, activeBoardIdRef.current!));
      return next;
    });
  }

  /** DESIGN-BACKLOG.md §2.1 decisões 8/9 — o único caminho de escrita do
   * quadro de tasks nesta fase: aceitar a proposta de conclusão de um
   * report aprovado (`TaskCard`'s barra). Nunca chamado automaticamente —
   * só o clique do humano no botão dispara isto. A atualização de estado
   * chega pelo mesmo push de `task:changed` de sempre (main/index.ts's
   * `persistTask` -> `notifyTaskChanged`), não daqui — este handler só
   * pede, não otimisticamente aplica.
   */
  function approveTaskCompletion(taskId: string) {
    void window.tasks.approveCompletion(taskId).then((res) => {
      if (!res.ok) toast(`não deu pra concluir: ${res.error}`);
    });
  }

  function handleTerminalStatus(id: string, status: "ok" | "error" | "exited") {
    setLiveStatus((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }

  /** Moving a grouped card (item 4 — "just organization") drags every other
   * member of its group by the same delta. A resize never triggers this:
   * CardFrame's resize handler holds x/y fixed, so dx/dy is 0 and every
   * sibling's rect map is a no-op. */
  function changeRect(id: string, rect: Rect) {
    setCards((prev) => {
      const moving = prev.find((c) => c.id === id);
      if (!moving?.groupId) return prev.map((c) => (c.id === id ? { ...c, rect } : c));
      const dx = rect.x - moving.rect.x;
      const dy = rect.y - moving.rect.y;
      return prev.map((c) => {
        if (c.id === id) return { ...c, rect };
        if (c.groupId === moving.groupId) return { ...c, rect: { ...c.rect, x: c.rect.x + dx, y: c.rect.y + dy } };
        return c;
      });
    });
  }

  /**
   * A native browser view always paints above every DOM card regardless of
   * z-index — there's no way to make a dragged terminal/files/sticky card
   * visually cover a browser card the way DOM cards cover each other. Same
   * mitigation CentralByte's Fase 1 used for the identical structural
   * problem (native VTE over DOM): reject a move that would increase
   * overlap with a browser card, instead of pretending overlap works.
   *
   * "Would increase" (not "produces any overlap at all") — 2026-09-02, real
   * bug report: `centeredSlot`'s old stagger-only spawn (fixed separately,
   * see board-model.ts) could already land a browser card exactly on top of
   * another. Rejecting every overlapping rect outright, unconditionally,
   * meant BOTH cards involved were then stuck forever — since `rect` here
   * is the live pointer position and any drag that hasn't fully cleared the
   * other card's bounds yet still overlaps it, the plain reject fired on
   * literally every pointermove tick, so neither card ever moved a single
   * pixel, exactly the "imoveis, sem possivel de drag" the user saw.
   * Comparing the new overlap area against the CURRENTLY COMMITTED rect's
   * overlap area (not a flat yes/no) keeps the original guarantee — a drag
   * can never make a browser overlap worse than it already is — while still
   * letting an already-overlapping pair be dragged apart, one incremental
   * step at a time, same as a normal drag anywhere else on the board.
   */
  function tryChangeRect(id: string, rect: Rect) {
    const moving = cardsRef.current.find((c) => c.id === id);
    if (!moving) return;
    const worsens = cardsRef.current.some((other) => {
      if (other.id === id || (moving.kind !== "browser" && other.kind !== "browser")) return false;
      if (!rectsOverlap(rect, other.rect)) return false;
      return overlapArea(rect, other.rect) > overlapArea(moving.rect, other.rect);
    });
    if (worsens) return;
    changeRect(id, rect);
  }

  function commitRect(card: Card, rect: Rect) {
    void window.store.upsert(toRow({ ...card, rect }, activeBoardIdRef.current!));
    // changeRect already shifted every group sibling's rect in local state
    // during the drag (onChange fires per pointermove, ahead of this
    // pointerup-only commit) — persist their up-to-date rects too, reading
    // from cardsRef so it's the post-drag values, not `card`'s stale ones.
    if (card.groupId) {
      for (const sibling of cardsRef.current) {
        if (sibling.id !== card.id && sibling.groupId === card.groupId) {
          void window.store.upsert(toRow(sibling, activeBoardIdRef.current!));
        }
      }
    }
  }

  function resumeIdDiscovered(id: string, sessionId: string) {
    setCards((prev) => {
      const next = prev.map((c) => (c.id === id && c.kind === "terminal" ? { ...c, resumeId: sessionId } : c));
      const updated = next.find((c) => c.id === id);
      if (updated) void window.store.upsert(toRow(updated, activeBoardIdRef.current!));
      return next;
    });
  }

  function changeStickyContent(id: string, content: string) {
    setCards((prev) => prev.map((c) => (c.id === id && c.kind === "sticky" ? { ...c, content } : c)));
  }

  function commitStickyContent(card: StickyCardData, content: string) {
    void window.store.upsert(toRow({ ...card, content }, activeBoardIdRef.current!));
  }

  function commitStickyColor(card: StickyCardData, color: string) {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "sticky" ? { ...c, color } : c)));
    void window.store.upsert(toRow({ ...card, color }, activeBoardIdRef.current!));
  }

  /** Pedido ao vivo (2026-09-02) — "modo edição vs preview" controlável.
   * Mesmo padrão de commitStickyColor acima: persistido (via `model`,
   * ver card-types.ts), não estado de UI local — assim `set_sticky_mode`
   * (MCP) e o botão no header de `StickyCardInner` são o MESMO caminho,
   * nenhum atalho paralelo. */
  function commitStickyMode(card: StickyCardData, mode: "edit" | "preview") {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "sticky" ? { ...c, mode } : c)));
    void window.store.upsert(toRow({ ...card, mode }, activeBoardIdRef.current!));
  }

  /** Rotação (item 57.9) — clique discreto, sempre atualiza+persiste
   * juntos (mesmo padrão de commitStickyColor acima), ao contrário do
   * pan/zoom abaixo que segue o padrão live/commit do próprio drag. */
  function commitMediaRotation(card: MediaCardData, rotation: 0 | 90 | 180 | 270) {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "media" ? { ...c, rotation } : c)));
    void window.store.upsert(toRow({ ...card, rotation }, activeBoardIdRef.current!));
  }

  function changeMediaView(id: string, view: MediaView) {
    setCards((prev) => prev.map((c) => (c.id === id && c.kind === "media" ? { ...c, view } : c)));
  }

  function commitMediaView(card: MediaCardData, view: MediaView) {
    void window.store.upsert(toRow({ ...card, view }, activeBoardIdRef.current!));
  }

  /** DESIGN-BACKLOG.md item 12, Fase B — ChatCard owns its own streaming
   * state locally (token-by-token, no sqlite write per token — see
   * ChatCard.tsx) and calls this once per completed turn (or on an
   * edited/cleared history), same single-commit-at-the-end shape
   * `commitStickyContent` uses for its own onBlur. */
  function commitChatMessages(card: ChatCardData, messages: ChatMessage[]) {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "chat" ? { ...c, messages } : c)));
    void window.store.upsert(toRow({ ...card, messages }, activeBoardIdRef.current!));
  }

  function commitChatModel(card: ChatCardData, model: string) {
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "chat" ? { ...c, model } : c)));
    void window.store.upsert(toRow({ ...card, model }, activeBoardIdRef.current!));
  }

  /** DESIGN-BACKLOG.md item 12, Fase C — switching provider also resets to
   * that provider's own default model (an Anthropic model id sent to
   * OpenAI's endpoint, or vice versa, is just a guaranteed 404/400). */
  function commitChatProvider(card: ChatCardData, provider: ChatProvider) {
    const model =
      provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : provider === "gemini"
          ? DEFAULT_GEMINI_MODEL
          : provider === "generic"
            ? DEFAULT_GENERIC_MODEL
            : DEFAULT_CHAT_MODEL;
    setCards((prev) => prev.map((c) => (c.id === card.id && c.kind === "chat" ? { ...c, provider, model } : c)));
    void window.store.upsert(toRow({ ...card, provider, model }, activeBoardIdRef.current!));
  }

  /** Pedido ao vivo (2026-08-29, item 57 ponto 2; revisado ao vivo em
   * 2026-08-31 — "+" abria um CARD NOVO solto no board em vez de resetar
   * o próprio ChatCard, confuso pra quem esperava um "new chat" no
   * mesmo lugar). Reseta o card ATUAL em vez de criar um segundo: a
   * conversa antiga é ARQUIVADA sob o id antigo (mesmo mecanismo de
   * `finalizeCloseCard`'s branch "chat" — continua navegável no painel
   * de sessões depois), e um card NOVO (id novo, mesmo `rect`/`groupId`,
   * mesmo provider) nasce na mesma posição no `order` — visualmente é o
   * "mesmo" card, sem clutter novo no board; só o id/linha no banco
   * mudou por baixo, do mesmo jeito que fechar+reabrir já faria. */
  function newChatSession(cardId: string, provider: ChatProvider) {
    const old = cardsRef.current.find((c) => c.id === cardId);
    if (!old || old.kind !== "chat") return;
    const model =
      provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : provider === "gemini"
          ? DEFAULT_GEMINI_MODEL
          : provider === "generic"
            ? DEFAULT_GENERIC_MODEL
            : DEFAULT_CHAT_MODEL;
    const newId = String(nextId.current++);
    const newCard = {
      id: newId,
      ...defaultCardFields("chat", activeBoardCwd),
      provider,
      model,
      rect: old.rect,
      groupId: old.groupId,
      label: null,
    } as Card;
    setCards((prev) => [...prev.filter((c) => c.id !== cardId), newCard]);
    setOrder((prev) => prev.map((x) => (x === cardId ? newId : x)));
    setConnectors((prev) => prev.filter((c) => c.fromCardId !== cardId && c.toCardId !== cardId));
    void window.store.archiveCard(cardId);
    window.chat.notifyCardClosed(cardId);
    void window.store.connectors.deleteForCard(cardId);
    clearConnectorLabelThrottleForCard(cardId);
    void window.store.upsert(toRow(newCard, activeBoardIdRef.current!));
  }

  function startDrawing(e: React.PointerEvent) {
    const points: Point[] = [];
    function addPoint(clientX: number, clientY: number) {
      const p = clientToWorld(clientX, clientY);
      const last = points[points.length - 1];
      if (last) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (Math.sqrt(dx * dx + dy * dy) < MIN_STROKE_DISTANCE) return;
      }
      points.push(p);
      setDrawingPoints([...points]);
    }
    addPoint(e.clientX, e.clientY);
    function onMove(ev: PointerEvent) {
      addPoint(ev.clientX, ev.clientY);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrawingPoints(null);
      finishStroke(points, newStrokeColor);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** Item 57.8 — arraste livre em coordenadas de tela (não de mundo — ver
   * `exportSelection`'s doc comment). Descarta silenciosamente um
   * arraste minúsculo (< 8px, mesmo espírito de `MIN_STROKE_DISTANCE` —
   * um clique acidental sem intenção de recortar nada). */
  function startExportSelect(e: React.PointerEvent) {
    const startX = e.clientX;
    const startY = e.clientY;
    function rectFrom(clientX: number, clientY: number) {
      return { x: Math.min(startX, clientX), y: Math.min(startY, clientY), w: Math.abs(clientX - startX), h: Math.abs(clientY - startY) };
    }
    setExportSelection({ ...rectFrom(startX, startY), dragging: true });
    function onMove(ev: PointerEvent) {
      setExportSelection({ ...rectFrom(ev.clientX, ev.clientY), dragging: true });
    }
    function onUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const final = rectFrom(ev.clientX, ev.clientY);
      if (final.w < 8 || final.h < 8) {
        setExportSelection(null);
        return;
      }
      setExportSelection({ ...final, dragging: false });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function runExportSelection(format: "png" | "jpeg" | "pdf") {
    if (!exportSelection || exportBusy) return;
    const { x, y, w, h } = exportSelection;
    setExportBusy(true);
    // Esconde o retângulo/barra de formato ANTES de capturar — senão a
    // própria UI de seleção aparece dentro do recorte exportado. Duplo
    // rAF: garante que o DOM já repintou sem o overlay antes do
    // screenshot real (um commit de estado do React não é síncrono com
    // o próximo paint do browser).
    setExportSelection(null);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const defaultName = `stellar-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const result = await window.canvasExport.captureRect(
      { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) },
      format,
      defaultName,
    );
    setExportBusy(false);
    if (!result.ok) {
      if (result.error !== "cancelled") toast(`falha ao exportar: ${result.error}`);
      return;
    }
    toast(`exportado: ${result.path}`);
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return;
    if (tool === "pen") {
      startDrawing(e);
      return;
    }
    if (tool === "select") {
      startMarqueeSelect(e);
      return;
    }
    if (tool === "export") {
      startExportSelect(e);
      return;
    }
    if (tool === "connector") return;
    startPan(e);
    startRadialHold(e);
  }

  /** Item 1 revisited — press-and-hold as a second gatilho for the radial
   * menu, alongside right-click (below). Only wired for the pointer
   * tool's own branch above: pen/select/connector already do something
   * meaningful on pointerdown (draw/marquee/nothing), where a competing
   * hold-timer would misfire mid-gesture (e.g. drawing a single dot with
   * the pen held briefly still would pop the menu over the stroke).
   * `startPan` above still runs unconditionally — held still, its delta
   * is ~0 and it's harmless; this is a second, independent listener
   * measuring hold duration/movement, not a replacement for panning. */
  function startRadialHold(e: React.PointerEvent) {
    const startX = e.clientX;
    const startY = e.clientY;
    const worldPoint = clientToWorld(startX, startY);
    let moved = false;
    const timer = window.setTimeout(() => {
      if (moved) return;
      cleanup();
      setRadialMenu({ screen: { x: startX, y: startY }, world: worldPoint });
    }, 450);
    function onMove(ev: PointerEvent) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) moved = true;
    }
    function cleanup() {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
  }

  /** Right-click on empty canvas opens the radial menu (item 1) instead of
   * the OS/Electron context menu — a card only, so a right-click on the
   * pen/select tools' own drag gestures isn't hijacked mid-drag. */
  function onBackgroundContextMenu(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setRadialMenu({ screen: { x: e.clientX, y: e.clientY }, world: clientToWorld(e.clientX, e.clientY) });
  }

  /** Reusa o mesmo guard "clicou no fundo vazio, não num card" que
   * `onBackgroundPointerDown` já usa. */
  function onViewportDrop(e: React.DragEvent) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    void createMediaCardFromFile(file, clientToWorld(e.clientX, e.clientY));
  }

  // Item 57.9 — window-level (não uma prop `onPaste` no `.viewport`):
  // clicar no fundo vazio não move o foco pra dentro dele (nenhum
  // elemento focável ali), então um paste com "nada focado" dispara com
  // `document.activeElement === document.body`, que fica FORA (acima) de
  // `.viewport` na árvore — nunca bolharia pra um handler preso nele.
  // Mesmo motivo do keydown global logo acima usar refs em vez de state
  // capturado: `worldRef.current`/`viewportRef.current` ficam sempre
  // atuais mesmo dentro de um listener montado uma vez só.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const active = document.activeElement;
      const isFormField =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (isFormField || !e.clipboardData) return;
      const item = Array.from(e.clipboardData.items).find(
        (i) => i.kind === "file" && (i.type.startsWith("image/") || i.type === "application/pdf"),
      );
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      const viewportSize = viewportRef.current
        ? { width: viewportRef.current.clientWidth, height: viewportRef.current.clientHeight }
        : { width: 0, height: 0 };
      const at = rectCenter(viewportWorldRect(viewportSize, worldRef.current));
      void createMediaCardFromFile(file, at);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function selectRadialAction(action: RadialAction, providerId?: string) {
    const at = radialMenu?.world;
    setRadialMenu(null);
    if (action === "tool-pointer") return setTool("pointer");
    if (action === "tool-pen") return setTool("pen");
    if (action === "tool-connector") return setTool("connector");
    if (action === "tool-select") return setTool("select");
    if (!at) return;
    if (action === "terminal") addTerminalCard(at, providerId);
    else addCardOfKind(action, at);
  }

  if (!loaded) return <div className="viewport" />;

  // DESIGN-BACKLOG.md item 8 — boots here always (see useBoardStore's boot
  // effect); no board is loaded (so no PTYs spawned) until the user picks
  // one. `Titlebar` stays mounted for window controls even on Home.
  if (activeBoardId === null) {
    return (
      <div className="viewport">
        <Titlebar />
        <UpdateBanner />
        <Home
          boards={boards}
          boardCounts={boardCounts}
          rootName={rootDisplayName(workspaceRoot)}
          workspaceRoot={workspaceRoot}
          defaultCwd={DEFAULT_CWD}
          onChangeRoot={changeWorkspaceRoot}
          onNavigateRoot={navigateWorkspaceRoot}
          onOpenBoard={switchBoard}
          onCreateBoard={createBoard}
          onUpdateBoard={updateBoard}
          onDeleteBoard={deleteBoard}
          onToggleAutonomous={setBoardAutonomous}
          onSetConcurrencyCap={setBoardConcurrencyCap}
        />
      </div>
    );
  }

  const dotSize = GRID_SPACING * world.zoom;
  const backgroundStyle = backgroundCss(bgStyle, dotSize, world.panX, world.panY);

  const selectedCards = cards.filter((c) => selectedIds.has(c.id));
  const canGroup = tool === "select" && selectedCards.length >= 2;
  const commonGroupId =
    selectedCards.length > 0 && selectedCards.every((c) => c.groupId && c.groupId === selectedCards[0].groupId)
      ? selectedCards[0].groupId
      : null;
  const canUngroup = tool === "select" && commonGroupId !== null;

  // Live override for the active board only (see liveStatus's comment) —
  // every other board keeps the structural proxy fetched over IPC.
  // Excludes provider === "bash" (DESIGN-BACKLOG.md item 43) — the topbar
  // reads this as "N agente(s)", and a plain shell isn't an agent; without
  // this a board full of bash terminals inflated the agent count.
  const activeTerminalCards = cards.filter((c) => c.kind === "terminal" && c.provider !== "bash");
  const effectiveBoardCounts: Record<string, BoardCounts> = activeBoardId
    ? {
        ...boardCounts,
        [activeBoardId]: {
          agents: activeTerminalCards.length,
          active: activeTerminalCards.filter((c) => liveStatus[c.id] !== "error" && liveStatus[c.id] !== "exited")
            .length,
        },
      }
    : boardCounts;

  return (
    <div
      className="viewport"
      ref={viewportRef}
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
      onContextMenu={onBackgroundContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onViewportDrop}
      style={backgroundStyle}
    >
      <Titlebar />
      <div
        className="world"
        style={{ transform: `translate(${world.panX}px, ${world.panY}px) scale(${world.zoom})` }}
      >
        {cards.map((c) => {
          const zIndex = order.indexOf(c.id);
          const interactionMode = tool === "connector" ? "connector" : tool === "select" ? "select" : "normal";
          const onConnectorStart = getConnectorStartHandler(c);
          const onSelectStart = getSelectStartHandler(c);
          const selected = selectedIds.has(c.id);
          const displayName = describeCard(c.id);
          // A `switch` (not the old if/else-if chain) so a card kind this
          // doesn't handle is a compile error via `assertNeverCardKind`,
          // not a silent fall-through into rendering the wrong component —
          // the old chain's final unconditional `return <BrowserCard .../>`
          // used to be exactly that trap (DESIGN-BACKLOG.md item
          // "4 (deferida)").
          switch (c.kind) {
          case "terminal": {
            // Trilha B — último e mais arriscado kind migrado (por
            // design, ver plano). `correctZoomCoords` (useTerminal.ts)
            // deliberadamente NÃO foi tocado aqui — continua necessário
            // mesmo screen-projected, ver o comentário no prop
            // `screenProjected` de TerminalCard.tsx.
            if (!cardsLayerEl) return null;
            return createPortal(
              <TerminalCard
                key={c.id}
                id={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                providerId={c.provider}
                cwd={c.cwd}
                resumeId={c.resumeId}
                continueLast={c.continueLast}
                model={c.model}
                effort={c.effort}
                systemPrompt={c.systemPrompt}
                initialInput={c.initialInput}
                visible={isInView(c.rect, visibleRect)}
                seenUrls={seenUrls[c.id] ?? EMPTY_URLS}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                 onRename={getRenameHandler(c)}
                 onResumeIdDiscovered={getResumeIdDiscoveredHandler(c)}
                 onStatusChange={getStatusChangeHandler(c)}
                 onOpenUrl={setPendingOpenUrl}
                 onConnectorStart={onConnectorStart}
                 onSelectStart={onSelectStart}
                 selected={selected}
                 screenProjected
                isFocused={zIndex === order.length - 1}
                panX={world.panX}
                panY={world.panY}
                shortcutOverridesRef={shortcutOverridesRef}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "files": {
            // Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — segundo card
            // kind migrado depois de sticky/browser. Mesmo padrão de portal.
            if (!cardsLayerEl) return null;
            return createPortal(
              <FilesCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                root={c.root}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "changes": {
            // Trilha B — mesmo padrão de portal que "files" acima.
            if (!cardsLayerEl) return null;
            return createPortal(
              <ChangesCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                root={c.root}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "sticky": {
            // Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — this kind
            // is migrated to screen-projected rendering, so it portals
            // into `.cards-layer` instead of rendering inline here inside
            // `.world`'s scaled subtree. Which kinds are migrated is
            // exactly the set of `case`s below wrapped this way — kept as
            // the single, self-documenting source of truth rather than a
            // separate list that could drift out of sync. `cardsLayerEl`
            // is null for one render before the ref attaches — skip that
            // single frame rather than risk a flash inside `.world`.
            if (!cardsLayerEl) return null;
            return createPortal(
              <StickyCard
                key={c.id}
                cardId={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                content={c.content}
                color={c.color}
                mode={c.mode}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onContentChange={getContentChangeHandler(c)}
                onContentCommit={getContentCommitHandler(c)}
                onColorCommit={getColorCommitHandler(c)}
                onModeCommit={getModeCommitHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "stroke": {
            // Trilha B — mesmo padrão de portal que "files"/"changes" acima.
            if (!cardsLayerEl) return null;
            return createPortal(
              <StrokeCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                points={c.points}
                color={c.color}
                width={c.width}
                style={c.style}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "remote-window": {
            // Trilha B — último kind migrado, o mais simples dos 9: o
            // encaminhamento de ponteiro/teclado (`onVideoPointerMove` etc.)
            // é todo relativo (`e.movementX/Y`), nunca lê zoom/pan do board
            // — zero risco de coordenada, ao contrário de Terminal.
            if (!cardsLayerEl) return null;
            return createPortal(
              <RemoteWindowCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "chat": {
            // Trilha B — 9º e último tipo de card migrado. Fecha o plano
            // §0.8 ponto 2 (todos os 9 kinds, nenhum órfão no modelo antigo).
            if (!cardsLayerEl) return null;
            return createPortal(
              <ChatCard
                key={c.id}
                id={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                model={c.model}
                provider={c.provider}
                cwd={c.cwd}
                systemPrompt={c.systemPrompt}
                messages={c.messages}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onMessagesCommit={getMessagesCommitHandler(c)}
                onModelCommit={getModelCommitHandler(c)}
                onProviderCommit={getProviderCommitHandler(c)}
                onNewSession={stableNewChatSession}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                onOpenChatSession={stableOpenChatSession}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
                shortcutOverridesRef={shortcutOverridesRef}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "media": {
            // Trilha B — mesmo padrão de portal que "files"/"changes"/
            // "stroke" acima. Combinação nova aqui: MediaCard em modo
            // imagem é `chromeless` (nenhum outro kind migrado até agora
            // era) — ver CardFrame.tsx's `onHeaderPointerDown`/resize, que
            // já dividem por `zoom` de forma genérica, então não deveria
            // exigir tratamento especial, mas é a primeira vez que essa
            // combinação roda de verdade.
            if (!cardsLayerEl) return null;
            return createPortal(
              <MediaCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                boardId={activeBoardId}
                assetPath={c.assetPath}
                mediaType={c.mediaType}
                rotation={c.rotation}
                view={c.view}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={(r) => tryChangeRect(c.id, r)}
                onCommit={(r) => commitRect(c, r)}
                onRaise={() => raise(c.id)}
                onFocus={() => jumpToCard(c.id)}
                onClose={() => closeCard(c.id)}
                onCloseAnimationEnd={() => finalizeCloseCard(c.id)}
                onRename={(label) => renameCard(c.id, label)}
                onRotateCommit={(rotation) => commitMediaRotation(c, rotation)}
                onViewChange={(view) => changeMediaView(c.id, view)}
                onViewCommit={(view) => commitMediaView(c, view)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "browser": {
            // Trilha B — screen-projected, same portal pattern as "sticky"
            // above.
            if (!cardsLayerEl) return null;
            return createPortal(
              <BrowserCard
                key={c.id}
                id={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                visible={isInView(c.rect, visibleRect)}
                isFocused={zIndex === order.length - 1}
                url={c.url}
                ownerCardId={c.ownerCardId}
                sendTargets={cards.filter((x) => x.kind === "terminal" && x.id !== c.id).map((x) => ({ id: x.id, label: x.label }))}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onFocusOwner={getFocusOwnerHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
                shortcutOverridesRef={shortcutOverridesRef}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          case "task": {
            // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 — mesmo padrão de
            // portal que "files"/"changes" acima. `tasks` vem do estado
            // `taskBoards` (alimentado por `window.tasks.onChanged`, push —
            // ver o efeito logo abaixo do de `spawn.onQueueChanged` — nunca
            // por poll), escopado pro board deste card (que só pode ser o
            // board carregado agora, já que cards de outro board nem
            // montam).
            if (!cardsLayerEl) return null;
            return createPortal(
              <TaskCard
                key={c.id}
                rect={c.rect}
                zoom={world.zoom}
                zIndex={zIndex}
                interactionMode={interactionMode}
                reflowing={reflowing}
                closing={closingIds.has(c.id)}
                displayName={displayName}
                tasks={activeBoardId ? taskBoards[activeBoardId] ?? [] : []}
                // RODADA 2 — badge de WIP (peça 4). `boards` já é estado
                // carregado (useBoardStore.ts), mesma fonte que
                // `activeBoardCwd` acima já lê — zero consulta nova só
                // pra isto, `concurrency_cap` já vem junto com o resto do
                // BoardRow.
                concurrencyCapRaw={boards.find((b) => b.id === activeBoardId)?.concurrency_cap ?? null}
                // RODADA 3, peça 5 — rodapé de escopo. `taskCountsByBoard`
                // é GLOBAL (não escopado por board, ver seu próprio
                // comentário); `activeBoardId` cai numa string vazia só
                // no instante teórico em que este card renderiza sem
                // nenhum board carregado (não deveria acontecer — cards
                // só montam com um board aberto — mas o tipo é `string |
                // null` então o fallback existe pra nunca quebrar).
                activeBoardId={activeBoardId ?? ""}
                boardNames={boardNames}
                taskCountsByBoard={taskCountsByBoard}
                onChange={getChangeHandler(c)}
                onCommit={getCommitHandler(c)}
                onRaise={getRaiseHandler(c)}
                onFocus={getFocusHandler(c)}
                onClose={getCloseHandler(c)}
                onCloseAnimationEnd={getCloseAnimationEndHandler(c)}
                onRename={getRenameHandler(c)}
                onApproveCompletion={approveTaskCompletion}
                onConnectorStart={onConnectorStart}
                onSelectStart={onSelectStart}
                selected={selected}
                screenProjected
                panX={world.panX}
                panY={world.panY}
              />,
              cardsLayerEl,
              c.id,
            );
          }
          default:
            return assertNeverCardKind(c);
          }
        })}
        <svg className="board-overlay">
          <defs>
            <marker id="connector-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style={{ fill: "var(--foam)" }} />
            </marker>
          </defs>
          {(() => {
            const groupIds = new Set(cards.map((c) => c.groupId).filter((g): g is string => g !== null));
            const GROUP_PAD = 10;
            return [...groupIds].map((gid) => {
              const box = bboxOf(cards.filter((c) => c.groupId === gid).map((c) => c.rect));
              if (!box) return null;
              return (
                <rect
                  key={`group-${gid}`}
                  className="group-outline"
                  x={box.x - GROUP_PAD}
                  y={box.y - GROUP_PAD}
                  width={box.w + GROUP_PAD * 2}
                  height={box.h + GROUP_PAD * 2}
                />
              );
            });
          })()}
          {connectors.map((conn) => {
            const from = cards.find((c) => c.id === conn.fromCardId);
            const to = cards.find((c) => c.id === conn.toCardId);
            if (!from || !to) return null;
            const fromCenter = rectCenter(from.rect);
            const toCenter = rectCenter(to.rect);
            const start = clipLineToRect(fromCenter, toCenter, from.rect);
            const end = clipLineToRect(toCenter, fromCenter, to.rect);
            const control = quadraticControlPoint(start, end, 0.18);
            const midX = 0.25 * start.x + 0.5 * control.x + 0.25 * end.x;
            const midY = 0.25 * start.y + 0.5 * control.y + 0.25 * end.y;
            const kindClass = conn.kind ?? "manual";
            const kindLabel = CONNECTOR_KIND_LABEL[kindClass] ?? kindClass;
            const d = `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`;
            // Contexto de tarefa (item "conectores" do relatório 2026-09-08)
            // — pill num ponto diferente do meio (onde já mora o "×" de
            // apagar), senão as duas se sobrepõem. `conn.label` já vem
            // truncado a ~60 chars da origem (App.tsx's autoConnect callers/
            // message-bus.ts's truncateForLabel); aqui só encurta mais ainda
            // pro que cabe na pill — o `<title>` abaixo carrega a versão
            // maior pra quem passar o mouse.
            const labelT = 0.3;
            const labelOmt = 1 - labelT;
            const labelX = labelOmt * labelOmt * start.x + 2 * labelOmt * labelT * control.x + labelT * labelT * end.x;
            const labelY = labelOmt * labelOmt * start.y + 2 * labelOmt * labelT * control.y + labelT * labelT * end.y;
            const pillText = conn.label ? (conn.label.length > 26 ? `${conn.label.slice(0, 25)}…` : conn.label) : null;
            const pillWidth = pillText ? Math.min(190, Math.max(70, pillText.length * 6.4 + 22)) : 0;
            return (
              <g key={conn.id} className={`connector-group connector-group--${kindClass}`}>
                {/* Faixa larga invisível só pra facilitar o clique/hover na
                    curva real (fina, tracejada) — sem isso o hit-test do
                    SVG (stroke-only, sem fill) exigiria acertar poucos
                    pixels. Clicar aqui navega pro card de destino: dá à
                    seta um efeito real (Pendentes #188 — "conectores 100%
                    decorativos"), sem tocar em dispatch/execução nenhuma. */}
                <path
                  d={d}
                  className="connector-hit"
                  style={{ pointerEvents: "auto" }}
                  onClick={() => jumpToCard(conn.toCardId)}
                />
                <path className={`connector-line connector-line--${kindClass}`} d={d} markerEnd="url(#connector-arrow)">
                  <title>{conn.label ? `${kindLabel} — ${conn.label}` : kindLabel}</title>
                </path>
                {pillText && (
                  <g className="connector-label" style={{ pointerEvents: "none" }} transform={`translate(${labelX}, ${labelY})`}>
                    <rect x={-pillWidth / 2} y={-10} width={pillWidth} height={20} rx={4} />
                    <text x={0} y={1} textAnchor="middle" dominantBaseline="middle">
                      {pillText}
                    </text>
                  </g>
                )}
                <g
                  className="connector-delete"
                  // Achado 4 (review adversarial, 2026-09-09) — the inline
                  // `pointerEvents: "auto"` this used to carry beat any CSS
                  // rule by specificity, which would have silently undone
                  // layout.css's `.connector-delete`/`.connector-group:hover
                  // .connector-delete` pair (none while hidden, auto only on
                  // hover) the moment it ran. CSS alone controls it now.
                  transform={`translate(${midX}, ${midY})`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeConnector(conn.id);
                  }}
                >
                  <circle r={8} />
                  <text x={0} y={1} textAnchor="middle" dominantBaseline="middle">
                    ×
                  </text>
                </g>
              </g>
            );
          })}
          {connectorDraft &&
            (() => {
              const from = cards.find((c) => c.id === connectorDraft.fromId);
              if (!from) return null;
              const fromCenter = rectCenter(from.rect);
              const start = clipLineToRect(fromCenter, connectorDraft.point, from.rect);
              const control = quadraticControlPoint(start, connectorDraft.point, 0.18);
              return (
                <path
                  className="connector-draft"
                  d={`M${start.x},${start.y} Q${control.x},${control.y} ${connectorDraft.point.x},${connectorDraft.point.y}`}
                />
              );
            })()}
          {drawingPoints && drawingPoints.length > 1 && (
            <polyline
              className="pen-preview"
              points={drawingPoints.map((p) => `${p.x},${p.y}`).join(" ")}
              stroke={newStrokeColor}
              strokeWidth={newStrokeStyle === "marker" ? newStrokeWidth * 1.8 : newStrokeWidth}
              strokeOpacity={newStrokeStyle === "marker" ? 0.55 : 1}
            />
          )}
          {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
        </svg>
      </div>
      {/* Trilha B — all 9 card kinds now portal their DOM here instead of
          rendering inline inside `.world`'s map; see CardFrame.tsx's
          `screenProjected` prop doc comment for why (no CSS scale here,
          cards compute their own on-screen left/top). Empty div, contents
          arrive via `createPortal`. `.world`'s own `scale(zoom)` can't be
          removed yet even so — the `<svg className="board-overlay">`
          above (connector lines, the pen-drawing live preview, the
          group-select marquee) still lives inside `.world` and still
          relies on that ambient transform for its own coordinates; see
          DESIGN-BACKLOG.md's Trilha B entry for the follow-up this
          implies before §0.8 ponto 3 (remover scale(zoom) de .world) can
          be closed. */}
      <div className="cards-layer" ref={setCardsLayerEl} />
      <Rail
        tool={tool}
        setTool={setTool}
        strokeColors={STROKE_COLORS}
        strokeColor={newStrokeColor}
        setStrokeColor={setNewStrokeColor}
        strokeWidth={newStrokeWidth}
        setStrokeWidth={setNewStrokeWidth}
        strokeStyle={newStrokeStyle}
        setStrokeStyle={setNewStrokeStyle}
        canGroup={canGroup}
        canUngroup={canUngroup}
        onGroup={groupSelected}
        onUngroup={ungroupSelected}
        providers={PROVIDER_OPTIONS}
        newProvider={newProvider}
        setNewProvider={(p) => {
          // DESIGN-BACKLOG.md §2.1 "effort do card não é persistido",
          // 2026-09-10 — a value valid for the PREVIOUS provider (e.g.
          // claude's "medium") can be meaningless or refused for the new
          // one (antigravity only takes low/high — see
          // PROVIDER_EFFORT_VALUES's own comment). Clear it here, at the
          // one place the provider actually changes, rather than letting
          // a stale value ride along to a provider that never offered it
          // as an option in the first place.
          if (!(PROVIDER_EFFORT_VALUES[p] ?? []).includes(newEffort)) setNewEffort("");
          setNewProvider(p);
        }}
        newResumeId={newResumeId}
        setNewResumeId={setNewResumeId}
        newContinueLast={newContinueLast}
        setNewContinueLast={setNewContinueLast}
        newModel={newModel}
        setNewModel={setNewModel}
        newEffort={newEffort}
        setNewEffort={setNewEffort}
        newSystemPrompt={newSystemPrompt}
        setNewSystemPrompt={setNewSystemPrompt}
        onCreateTerminal={addTerminalCard}
        // Real bug found and fixed while verifying an unrelated refactor
        // (see AGENTS.md): `addXCard`'s optional `at?: Point` (added for
        // the radial menu, item 1) was once wired straight to a native
        // `onClick`, which React calls with the SyntheticEvent as the
        // first argument — that event object landed in `at` (truthy, so
        // the `at ? pointSlot(at) : ...` branch always won), and
        // `pointSlot(event)` read `event.x`/`.y` — undefined on a React
        // SyntheticEvent — producing NaN coordinates that render as (0,0).
        // The explicit `(kind) => addCardOfKind(kind)` wrapper below (not
        // passing `onCreate={addCardOfKind}` directly) keeps that fix:
        // Rail's button `onClick` calls `onCreate(kind)` with exactly one
        // argument, but staying explicit here costs nothing and documents
        // why it matters.
        onCreate={(kind) => addCardOfKind(kind)}
        aiBusy={aiBusy}
        summarizeDisabled={newProvider === "bash"}
        onReorganize={aiReorganize}
        onSummarize={summarizeBoard}
        cards={cards.map((c) => ({ id: c.id, kind: c.kind, label: describeCard(c.id) }))}
        kindIcon={CARD_ICON}
        kindLabel={CARD_LABEL}
        onJumpToCard={jumpToCard}
        onOpenSecretsSettings={() => setShowSecretsSettings(true)}
      />
      <Topbar
        boards={boards}
        activeBoardId={activeBoardId!}
        boardCounts={effectiveBoardCounts}
        rootName={rootDisplayName(workspaceRoot)}
        workspaceRoot={workspaceRoot}
        defaultCwd={DEFAULT_CWD}
        onChangeRoot={changeWorkspaceRoot}
        onNavigateRoot={navigateWorkspaceRoot}
        zoom={world.zoom}
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onZoomTo={(pct) => setZoomAbs(pct / 100)}
        bgStyleLabel={BG_STYLE_LABEL[bgStyle]}
        onCycleBgStyle={cycleBgStyle}
        onOpenRemote={() => setShowRemotePairing(true)}
        onGoHome={goHome}
        onSwitchBoard={switchBoard}
        onCreateBoard={createBoard}
        onUpdateBoard={updateBoard}
        onDeleteBoard={deleteBoard}
        onToggleAutonomous={setBoardAutonomous}
        onSetConcurrencyCap={setBoardConcurrencyCap}
        onSuggestInstall={stableSuggestInstall}
      />
      <Compass cards={cards} visibleRect={visibleRect} kindIcon={CARD_ICON} kindLabel={CARD_LABEL} cardLabel={describeCard} onFocusCard={jumpToCard} />
      <UpdateBanner />
      <ToastHost />
      {showShortcuts && (
        <ShortcutsOverlay
          onClose={() => setShowShortcuts(false)}
          shortcutOverrides={shortcutOverrides}
          onRebind={rebindShortcut}
          onRestoreDefault={restoreShortcutDefault}
          onRestoreAll={restoreAllShortcutDefaults}
          locale={locale}
          onLocaleOverrideChange={changeLocaleOverride}
        />
      )}
      {showRemotePairing && <RemotePairingModal onClose={() => setShowRemotePairing(false)} />}
      {radialMenu && (
        <RadialMenu
          x={radialMenu.screen.x}
          y={radialMenu.screen.y}
          tool={tool}
          providers={PROVIDER_OPTIONS}
          onSelect={selectRadialAction}
          onClose={() => setRadialMenu(null)}
        />
      )}
      {exportSelection && (
        <div
          className="export-selection-box"
          style={{ left: exportSelection.x, top: exportSelection.y, width: exportSelection.w, height: exportSelection.h }}
        >
          {!exportSelection.dragging && (
            <div className="export-selection-toolbar" onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => runExportSelection("png")}>PNG</button>
              <button onClick={() => runExportSelection("jpeg")}>JPEG</button>
              <button onClick={() => runExportSelection("pdf")}>PDF</button>
              <button className="export-selection-cancel" onClick={() => setExportSelection(null)} title={t("app.export.cancel")}>
                ×
              </button>
            </div>
          )}
        </div>
      )}
      <SpawnQueuePanel queue={spawnQueues[activeBoardId] ?? []} describeRequester={describeCard} />
      {pendingCloseId && (
        <ConfirmModal
          title={t("app.closeTerminal.title")}
          message={t("app.closeTerminal.message", { name: describeCard(pendingCloseId) })}
          confirmLabel={t("app.closeTerminal.confirm")}
          danger
          onConfirm={confirmCloseCard}
          onCancel={cancelCloseCard}
        />
      )}
      {pendingAsk && (
        <AgentAskModal
          {...describeAsk(pendingAsk)}
          requesterLabel={describeCard(pendingAsk.requesterId)}
          reason={pendingAsk.reason}
          onAllow={allowAsk}
          onDeny={denyAsk}
        />
      )}
      {pendingOpenUrl && (
        <ConfirmModal
          title={t("app.openUrl.title")}
          message={t("app.openUrl.message", { url: pendingOpenUrl })}
          confirmLabel={t("app.openUrl.confirm")}
          onConfirm={() => {
            const cardId = openBrowserFor(null, pendingOpenUrl);
            // Achado ao vivo (2026-09-02) — "clico no ícone e não abre":
            // quando já existe um card de navegador sem dono (aberto antes,
            // de qualquer terminal), openBrowserFor REUTILIZA esse card em
            // vez de criar um novo — se ele estiver fora do viewport atual
            // (usuário deu pan/zoom pra outro canto do board desde então),
            // a navegação/raise acontece de verdade, só que fora da vista:
            // pro usuário parece que nada aconteceu. Só centraliza a câmera
            // quando o card reusado de fato não está visível agora — um
            // card novo já nasce dentro do visibleRect (centeredSlot), não
            // precisa de jump nenhum.
            const card = cardsRef.current.find((c) => c.id === cardId);
            if (card && !isInView(card.rect, visibleRect)) focusCard(cardId);
            setPendingOpenUrl(null);
          }}
          onCancel={() => setPendingOpenUrl(null)}
        />
      )}
      {pendingBrowserPermission && (
        <ConfirmModal
          title={t("app.browserPermission.title")}
          message={pendingBrowserPermission.message}
          confirmLabel={t("app.browserPermission.confirm")}
          onConfirm={() => {
            window.browser.resolvePermissionAsk(pendingBrowserPermission.requestId, true);
            setPendingBrowserPermission(null);
          }}
          onCancel={() => {
            window.browser.resolvePermissionAsk(pendingBrowserPermission.requestId, false);
            setPendingBrowserPermission(null);
          }}
        />
      )}
      {showSecretsSettings && <SecretsSettingsModal onClose={() => setShowSecretsSettings(false)} />}
    </div>
  );
}
