import { memo, useEffect, useRef, useState, type MutableRefObject } from "react";
import { CardFrame } from "./CardFrame";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { toast } from "./useToast";
import { PROVIDER_LABELS, PROVIDER_KEY_PLACEHOLDER, PROVIDER_MODELS, keyFormatWarning } from "./secretsUi";
import type { Rect } from "./board-model";
import type { ChatContentBlock, ChatImageBlock, ChatMessage, ChatProvider } from "./card-types";
import type { WriteConsentRequest, BashConsentRequest, CardRow } from "../../preload/index";
import { matchesShortcut } from "./shortcut-config";
import type { ShortcutOverrides } from "./shortcut-registry";
import { formatRelativeTime } from "../../shared/i18n";

const ALL_PROVIDERS: ChatProvider[] = ["anthropic", "openai", "gemini", "generic"];

const ALLOWED_IMAGE_TYPES: ChatImageBlock["mediaType"][] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** Item 66 — extrai só o TEXTO de um `content` que agora também pode ser
 * um array de blocos (imagem colada) — usado onde só o texto plano
 * importa (preview de sessão, fallback de markdown ainda carregando). */
function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

/** Item 66 — só o `path` sobrevive em `messages_json` (nunca base64, ver
 * ChatImageBlock's doc comment em card-types.ts); a miniatura é
 * re-lida sob demanda via IPC e cacheada em memória pela vida da sessão
 * do app (module-level, não por-instância — a mesma imagem reaparece em
 * toda re-renderização da lista de mensagens). */
const imageDataUrlCache = new Map<string, string>();

function ChatImageThumb({ block }: { block: ChatImageBlock }) {
  const [dataUrl, setDataUrl] = useState<string | null>(imageDataUrlCache.get(block.path) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (dataUrl) return;
    let cancelled = false;
    void window.clipboardImage.readAttachment(block.path).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      const url = `data:${block.mediaType};base64,${result.base64}`;
      imageDataUrlCache.set(block.path, url);
      setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.path]);
  if (failed) return <span className="chat-msg-image-failed">[imagem não pôde ser carregada]</span>;
  if (!dataUrl) return <span className="chat-msg-image-loading" />;
  return <img className="chat-msg-image" src={dataUrl} alt="imagem anexada" />;
}

/** DESIGN-BACKLOG.md item 38 — correção de escopo do item 30: a lista de
 * sessões vive DENTRO do chatbox (painel expansível, mesmo espírito do
 * CentralByte — um push-panel que reparte o próprio card, não um popover
 * na régua do canvas). `CardRow` (uma linha `kind: "chat"`) aliased pra
 * legibilidade nos call sites deste arquivo. */
export type ChatSessionRow = CardRow;

/** Falls back to o texto real da primeira mensagem do usuário quando a
 * sessão não tem `label` próprio (mesmo espírito de "rótulo humano em vez
 * de id cru" do `describeCard`, item 22, aplicado a uma conversa em vez
 * de um card). Defensive JSON.parse — uma `messages_json` malformada/
 * legada degrada pra um placeholder genérico em vez de derrubar o painel
 * inteiro. */
function sessionPreview(s: ChatSessionRow): string {
  try {
    const parsed = JSON.parse(s.messages_json ?? '{"messages":[]}') as { messages?: ChatMessage[] };
    const firstUser = parsed.messages?.find((m) => m.role === "user");
    if (firstUser) {
      const text = textOf(firstUser.content).trim();
      const hasImage = typeof firstUser.content !== "string" && firstUser.content.some((b) => b.type === "image");
      const label = text || (hasImage ? "📎 imagem" : "");
      if (label) {
        const prefix = hasImage && text ? "📎 " : "";
        return prefix + (label.length > 60 ? label.slice(0, 60) + "…" : label);
      }
    }
  } catch {
    // Malformed/legacy row — fall through to the generic placeholder.
  }
  return "conversa vazia";
}

/** Coarse relative time — DESIGN-BACKLOG.md §2.1 i18n fase 1: shared
 * `Intl.RelativeTimeFormat` helper (same as Home / formatTaskAge). */
function relativeTime(ms: number): string {
  return formatRelativeTime(ms, Date.now());
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** UI preference, not per-card data — same `localStorage` convention as
 * Rail.tsx's own collapse toggle (`ac.railCollapsed`). Shared across every
 * ChatCard on purpose (open one, they open expanded from then on) — mirrors
 * CentralByte's own `cc-left-open` persistence for the same reason: a
 * panel a user just opened shouldn't silently re-hide on the next card. */
const SESSIONS_PANEL_OPEN_KEY = "ac.chatSessionsPanelOpen";

/**
 * DESIGN-BACKLOG.md item 12 — Fase B built plain streamed-text chat; Fase
 * C adds a real agentic tool loop on top (read_file/write_file,
 * main/chat-tools.ts) and a second provider (OpenAI-compatible Chat
 * Completions). Tool activity here is DELIBERATELY transient (local React
 * state, reset every `send()`) — not part of `messages`/persisted history.
 * A completed turn commits only the final user+assistant text, same shape
 * Fase B already had; the model doesn't need its own past tool calls
 * replayed to continue a conversation (its own final answer already
 * reflects the results), so this keeps the persisted schema simple rather
 * than building a provider-agnostic tool-call storage format for a phase
 * that doesn't strictly need one. A `write_file` decision (allow/deny) is
 * the one piece of tool activity worth a permanent trace, so those
 * collapse into a one-line summary that survives until the next send —
 * still transient, just outliving the rest of that turn's activity.
 */

// item 31 — CHAT_MODELS/DEFAULT_* derive from the curated PROVIDER_MODELS
// list in secretsUi.ts (shared with SecretsSettingsModal), one source of
// truth instead of three separate hardcoded singletons.
export const CHAT_MODELS = PROVIDER_MODELS.anthropic;
export const DEFAULT_CHAT_MODEL: string = CHAT_MODELS[0];
export const DEFAULT_OPENAI_MODEL: string = PROVIDER_MODELS.openai[0];
export const DEFAULT_GEMINI_MODEL: string = PROVIDER_MODELS.gemini[0];
// "generic" has no meaningful default — any value here would just be
// wrong for whatever endpoint the user actually configured.
export const DEFAULT_GENERIC_MODEL = "";

type ToolActivity = { id: string; name: string; input: unknown; status: "running" | "done"; ok?: boolean; summary?: string };
type WriteDecision = { path: string; allowed: boolean };
type BashDecision = { command: string; allowed: boolean };

/** Shared label logic for both the generic ToolLine and the "done"
 * summary lines below — one place that knows how to describe each tool's
 * input, rather than re-deriving it per render site. */
function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.path === "string") return `${name}(${i.path})`;
  if (typeof i.command === "string") {
    const c = i.command.length > 48 ? i.command.slice(0, 48) + "…" : i.command;
    return `${name}(${c})`;
  }
  if (typeof i.provider === "string") return `${name}(${i.provider})`;
  return name;
}

function ToolLine({ activity }: { activity: ToolActivity }) {
  const label = toolLabel(activity.name, activity.input);
  return (
    <div className={`chat-tool-line ${activity.status}${activity.ok === false ? " error" : ""}`}>
      <Icon name="apiKey" size={11} />
      <span className="chat-tool-line-label">{label}</span>
      {activity.status === "running" ? (
        <span className="chat-tool-line-status">rodando…</span>
      ) : (
        <span className="chat-tool-line-status">{activity.ok === false ? "erro" : "ok"}</span>
      )}
    </div>
  );
}

function DiffView({ hunks }: { hunks: WriteConsentRequest["hunks"] }) {
  return (
    <div className="chat-diff-body">
      {hunks.map((h, hi) => (
        <div key={hi}>
          {h.lines.map((line, li) => {
            const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
            return (
              <div key={li} className={`chat-diff-line ${cls}`}>
                {line || " "}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Pre-release audit P1 — see useStableCardHandler.ts's doc comment;
 * wrapped in `React.memo` below. */
function ChatCardInner({
  id,
  rect,
  zoom,
  zIndex,
  model,
  provider,
  cwd,
  systemPrompt,
  messages,
  interactionMode,
  selected,
  reflowing,
  closing,
  displayName,
  onChange,
  onCommit,
  onRaise,
  onFocus,
  onClose,
  onCloseAnimationEnd,
  onRename,
  onMessagesCommit,
  onModelCommit,
  onProviderCommit,
  onConnectorStart,
  onSelectStart,
  onOpenChatSession,
  onNewSession,
  screenProjected,
  panX,
  panY,
  shortcutOverridesRef,
}: {
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  model: string;
  provider: ChatProvider;
  cwd: string;
  systemPrompt: string | null;
  messages: ChatMessage[];
  interactionMode?: "normal" | "connector" | "select";
  selected?: boolean;
  reflowing?: boolean;
  closing?: boolean;
  displayName: string;
  onChange: (rect: Rect) => void;
  onCommit: (rect: Rect) => void;
  onRaise: () => void;
  onFocus: () => void;
  onClose: () => void;
  onCloseAnimationEnd?: () => void;
  onRename: (label: string) => void;
  onMessagesCommit: (messages: ChatMessage[]) => void;
  onModelCommit: (model: string) => void;
  onProviderCommit: (provider: ChatProvider) => void;
  onConnectorStart?: (e: React.PointerEvent) => void;
  onSelectStart?: (e: React.PointerEvent) => void;
  /** DESIGN-BACKLOG.md item 30/38 — every chat session (live or
   * archived), across every board. App.tsx owns switching boards/
   * unarchiving/focusing, this component only renders the list and
   * reports clicks. */
  onOpenChatSession: (session: ChatSessionRow) => void;
  /** Pedido ao vivo (2026-08-29, item 57 ponto 2; revisado 2026-08-31) —
   * reseta ESTE card pra uma sessão nova vazia (mesmo provider), sem
   * abrir um segundo card no board. */
  onNewSession: (cardId: string, provider: ChatProvider) => void;
  /** Trilha B — see CardFrame.tsx's `screenProjected` doc comment. Passed
   * straight through, same pattern the other migrated kinds use. */
  screenProjected?: boolean;
  panX?: number;
  panY?: number;
  /** Follow-up fase C — ref estável (App.tsx mantém `.current`); o
   * handler de tecla lê o override mais recente sem re-render / sem
   * re-registrar listener. */
  shortcutOverridesRef: MutableRefObject<ShortcutOverrides>;
}) {
  // Pre-release audit P1 — same render-count counter as TerminalCard.tsx
  // (see its doc comment) — lets the verify harness prove `React.memo`
  // below actually skips this card when nothing about it changed.
  const renderCounts = (window as unknown as { __cardRenderCounts?: Record<string, number> }).__cardRenderCounts ??= {};
  renderCounts[id] = (renderCounts[id] ?? 0) + 1;

  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  // Item 29 — status dot per provider on the picker, so switching
  // providers to check "did I already set this one?" isn't necessary.
  // Fetched once per mount + refreshed after this card's own save/clear;
  // a key set/removed via the central SecretsSettingsModal while this
  // card stays open won't update these dots until the card remounts —
  // a real, minor, accepted gap (no shared reactive secrets store exists
  // to push that update live).
  const [keyStatus, setKeyStatus] = useState<Partial<Record<ChatProvider, boolean>>>({});

  useEffect(() => {
    void Promise.all(ALL_PROVIDERS.map((p) => window.secrets.hasKey(p).then((v) => [p, v] as const))).then((entries) => {
      setKeyStatus(Object.fromEntries(entries));
    });
  }, []);

  // item 38 — painel de sessões expansível, dentro do próprio card (não
  // mais um popover na régua do canvas — mal-entendido do item 30).
  const [sessionsOpen, setSessionsOpen] = useState(() => localStorage.getItem(SESSIONS_PANEL_OPEN_KEY) === "1");
  const [chatSessions, setChatSessions] = useState<ChatSessionRow[]>([]);

  useEffect(() => {
    localStorage.setItem(SESSIONS_PANEL_OPEN_KEY, sessionsOpen ? "1" : "0");
  }, [sessionsOpen]);

  // Refetched every time the panel opens — a session's `updated_at`/
  // `archived_at` can change from elsewhere (sending a message, closing
  // a ChatCard) while this panel isn't open, a stale snapshot from mount
  // time would drift.
  useEffect(() => {
    if (!sessionsOpen) return;
    void window.store.listChatSessions().then(setChatSessions);
  }, [sessionsOpen]);
  const sessionsForProvider = chatSessions.filter((s) => s.provider === provider);
  const [draft, setDraft] = useState("");
  // Item 66 — anexos pendentes do composer (ainda não enviados). `previewUrl`
  // é o data URL cheio, gerado localmente por `FileReader` no momento do
  // paste/drop — evita um round-trip de IPC só pra mostrar a própria
  // miniatura que o usuário acabou de colar.
  const [attachments, setAttachments] = useState<{ id: string; path: string; mediaType: ChatImageBlock["mediaType"]; previewUrl: string }[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [writeDecisions, setWriteDecisions] = useState<WriteDecision[]>([]);
  const [pendingWrite, setPendingWrite] = useState<{ requestId: string } & WriteConsentRequest | null>(null);
  const [bashDecisions, setBashDecisions] = useState<BashDecision[]>([]);
  const [pendingBash, setPendingBash] = useState<{ requestId: string } & BashConsentRequest | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pedido ao vivo (2026-08-29, item 57 ponto 7) — status-line com contexto/
  // duração real, nunca estimado: `usage` vem do próprio objeto de resposta
  // final do provider (Anthropic `Message.usage`, OpenAI/Gemini
  // `ChatCompletion.usage` — ver main/chat-tools.ts `ChatUsage`), e a
  // duração é medida de verdade (`Date.now()` no envio até o `chat:done`).
  const turnStartRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastTurn, setLastTurn] = useState<{ durationMs: number; inputTokens: number; outputTokens: number } | null>(null);
  useEffect(() => {
    if (streaming === null) return;
    const timer = setInterval(() => {
      if (turnStartRef.current !== null) setElapsedMs(Date.now() - turnStartRef.current);
    }, 200);
    return () => clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    setHasKey(null);
    setRevealKey(false);
    void window.secrets.hasKey(provider).then((v) => {
      setHasKey(v);
      setShowKeyForm(!v);
    });
    void window.secrets.isEncryptionAvailable().then(setEncryptionAvailable);
    // Item 28 — prefill the endpoint field with whatever was saved last
    // time, so reopening the key form to rotate the key doesn't also
    // blank out the endpoint.
    if (provider === "generic") {
      void window.secrets.getBaseURL(provider).then((v) => setBaseUrlInput(v ?? ""));
    } else {
      setBaseUrlInput("");
    }
  }, [provider]);

  // Subscribed once (not per-render) — reads live state via refs, not
  // closed-over props, so it never goes stale. Same reasoning
  // useTerminal.ts's onData subscription already established for pty
  // streams.
  useEffect(() => {
    const offToken = window.chat.onToken((cardId, delta) => {
      if (cardId !== id) return;
      setStreaming((prev) => (prev ?? "") + delta);
    });
    const offDone = window.chat.onDone((cardId, fullText, usage) => {
      if (cardId !== id) return;
      onMessagesCommit([...messagesRef.current, { role: "assistant", content: fullText }]);
      setStreaming(null);
      setLastTurn({
        durationMs: turnStartRef.current !== null ? Date.now() - turnStartRef.current : 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    });
    const offError = window.chat.onError((cardId, message) => {
      if (cardId !== id) return;
      setError(message);
      setStreaming(null);
    });
    const offToolStart = window.chat.onToolStart((cardId, name, input) => {
      if (cardId !== id) return;
      setToolActivity((prev) => [...prev, { id: `${prev.length}-${name}`, name, input, status: "running" }]);
    });
    // No per-call id on the wire — safe because tools execute strictly
    // sequentially per card (chat-tools.ts), so "the last running entry"
    // is always the one this result belongs to.
    const offToolResult = window.chat.onToolResult((cardId, _name, ok, summary) => {
      if (cardId !== id) return;
      setToolActivity((prev) => {
        const idx = [...prev].reverse().findIndex((t) => t.status === "running");
        if (idx === -1) return prev;
        const realIdx = prev.length - 1 - idx;
        const next = [...prev];
        next[realIdx] = { ...next[realIdx], status: "done", ok, summary };
        return next;
      });
    });
    const offAskWrite = window.chat.onAskWrite((requestId, cardId, req) => {
      if (cardId !== id) return;
      setPendingWrite({ requestId, ...req });
    });
    const offAskBash = window.chat.onAskBash((requestId, cardId, req) => {
      if (cardId !== id) return;
      setPendingBash({ requestId, ...req });
    });
    return () => {
      offToken();
      offDone();
      offError();
      offToolStart();
      offToolResult();
      offAskWrite();
      offAskBash();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, toolActivity, pendingWrite, pendingBash]);

  function saveKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    if (provider === "generic" && !baseUrlInput.trim()) return;
    setSavingKey(true);
    void window.secrets.setKey(provider, trimmed, provider === "generic" ? baseUrlInput.trim() : undefined).then((result) => {
      setSavingKey(false);
      // Item 29 — `setKey` used to be assumed infallible; a real write
      // failure (disk full, keychain rejection) left the button stuck in
      // "salvando…" with zero feedback. Now surfaced.
      if (!result.ok) {
        toast(`falha ao salvar a key: ${result.error}`);
        return;
      }
      setKeyInput("");
      setRevealKey(false);
      setHasKey(true);
      setKeyStatus((prev) => ({ ...prev, [provider]: true }));
      setShowKeyForm(false);
    });
  }

  // Item 66 — path já real em disco (window.clipboardImage.saveBytes já
  // resolveu, ver clipboard-image.ts); só falta ler os bytes localmente
  // (pro preview instantâneo) e checar os limites (tipo suportado,
  // contagem por mensagem — a API ainda vai rejeitar algo grande demais
  // sozinha, esse limite aqui é só sobre "quantas imagens numa mensagem
  // faz sentido pedir pra CLI/modelo olhar de uma vez").
  async function addImageFile(file: File) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      toast(`máximo de ${MAX_ATTACHMENTS_PER_MESSAGE} imagens por mensagem`);
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type as ChatImageBlock["mediaType"])) {
      toast(`tipo de imagem não suportado: ${file.type || "desconhecido"}`);
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const result = await window.clipboardImage.saveBytes(base64, file.type);
    if (!result.ok) {
      toast(`falha ao anexar imagem: ${result.error}`);
      return;
    }
    setAttachments((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, path: result.path, mediaType: file.type as ChatImageBlock["mediaType"], previewUrl: dataUrl },
    ]);
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }

  /** Só intercepta quando há de fato um item de imagem — um paste de
   * texto comum continua caindo no comportamento padrão da textarea. */
  function onComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageItems = Array.from(e.clipboardData.items).filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) void addImageFile(file);
    }
  }

  function onComposerDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }

  function onComposerDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const file of imageFiles) void addImageFile(file);
  }

  function send() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || streaming !== null) return;
    const content: ChatMessage["content"] =
      attachments.length === 0
        ? text
        : [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...attachments.map((a): ChatImageBlock => ({ type: "image", path: a.path, mediaType: a.mediaType })),
          ];
    const next = [...messages, { role: "user" as const, content }];
    onMessagesCommit(next);
    setDraft("");
    setAttachments([]);
    setError(null);
    setStreaming("");
    setToolActivity([]);
    setWriteDecisions([]);
    setBashDecisions([]);
    turnStartRef.current = Date.now();
    setElapsedMs(0);
    void window.chat.send(id, { provider, model, systemPrompt, messages: next, cwd }).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setStreaming(null);
      }
    });
  }

  // Pedido ao vivo (2026-08-31) — o botão de enviar antes só desabilitava
  // durante a inferência, sem nenhum jeito de parar. `window.chat.cancel`
  // (main/anthropic-client.ts, main/openai-client.ts) já existia — best-
  // effort, aborta o stream em voo — mas nunca tinha UI. Nenhum
  // onDone/onError chega depois de um cancel intencional (ver comentário
  // de `intentionalAborts` nos dois clients), então o texto parcial já
  // gerado é commitado aqui mesmo, localmente — como parar um "stop" de
  // verdade em outros chats, guarda o que já foi gerado em vez de descartar.
  function stop() {
    void window.chat.cancel(id, provider);
    if (streaming) {
      onMessagesCommit([...messagesRef.current, { role: "assistant", content: streaming }]);
    }
    setStreaming(null);
  }

  function resolveWrite(allowed: boolean) {
    if (!pendingWrite) return;
    void window.chat.resolveWrite(pendingWrite.requestId, allowed);
    setWriteDecisions((prev) => [...prev, { path: pendingWrite.path, allowed }]);
    setPendingWrite(null);
  }

  function resolveBash(allowed: boolean) {
    if (!pendingBash) return;
    void window.chat.resolveBash(pendingBash.requestId, allowed);
    setBashDecisions((prev) => [...prev, { command: pendingBash.command, allowed }]);
    setPendingBash(null);
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const overrides = shortcutOverridesRef.current;
    const ev = e.nativeEvent;
    if (matchesShortcut(ev, "chat.send", overrides)) {
      e.preventDefault();
      send();
      return;
    }
    if (matchesShortcut(ev, "chat.newline", overrides)) {
      // Default é Shift+Enter — o textarea já insere a quebra. Se o
      // usuário rebindou pra outra tecla, inserimos manualmente.
      if (e.key !== "Enter") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        setDraft((d) => d.slice(0, start) + "\n" + d.slice(end));
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
      }
      return;
    }
    // Shift+Enter (ou outro Enter+shift) que JÁ NÃO é o newline efetivo —
    // bloqueia a inserção nativa pra o atalho antigo não continuar
    // funcionando além do que a UI mostra. Enter solto (send rebindado
    // pra longe) continua inserindo linha nativamente de propósito.
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
    }
  }

  // write_file's own diff/decision block already fully represents it, and
  // bash's own consent block already shows the command while it's
  // pending — showing the generic "rodando…" line too would just be
  // duplicate noise. A bash entry DOES still show once done (its stdout
  // summary is real information the consent block never had).
  const visibleActivity = toolActivity.filter((t) => t.name !== "write_file" && !(t.name === "bash" && t.status === "running"));

  return (
    <CardFrame
      className="chat-card"
      kind="chat"
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
      displayName={displayName}
      onRename={onRename}
      screenProjected={screenProjected}
      panX={panX}
      panY={panY}
      interactionMode={interactionMode}
      selected={selected}
      accent="var(--accent-chat)"
      reflowing={reflowing}
      closing={closing}
      onChange={onChange}
      onCommit={onCommit}
      onRaise={onRaise}
      onFocus={onFocus}
      onCloseAnimationEnd={onCloseAnimationEnd}
      onConnectorStart={onConnectorStart}
      onSelectStart={onSelectStart}
      footerContent={
        <span className="chat-foot-row">
          <span className="chat-foot-cwd">{cwd}</span>
          {streaming !== null ? (
            <span className="chat-foot-status" title="tempo decorrido nesta resposta">
              {formatDuration(elapsedMs)}
            </span>
          ) : (
            lastTurn && (
              <span
                className="chat-foot-status"
                title={`última resposta: ${formatDuration(lastTurn.durationMs)} · ${lastTurn.inputTokens} tokens de contexto enviados · ${lastTurn.outputTokens} tokens de resposta`}
              >
                {formatDuration(lastTurn.durationMs)} · {formatTokenCount(lastTurn.inputTokens)} in / {formatTokenCount(lastTurn.outputTokens)} out
              </span>
            )
          )}
        </span>
      }
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="chat" size={14} />
            <span className="chat-provider-picker">
              {ALL_PROVIDERS.map((p) => (
                <button
                  key={p}
                  className={provider === p ? "active" : ""}
                  title={keyStatus[p] ? `${PROVIDER_LABELS[p]} — key configurada` : `${PROVIDER_LABELS[p]} — sem key`}
                  onClick={() => onProviderCommit(p)}
                >
                  {PROVIDER_LABELS[p]}
                  {/* Item 29 — indicador de qual provider já tem key salva,
                      sem precisar clicar em cada um pra descobrir. */}
                  <span className={`chat-provider-dot${keyStatus[p] ? " has-key" : ""}`} />
                </button>
              ))}
            </span>
            {provider !== "generic" ? (
              <select className="chat-model-select" value={model} onChange={(e) => onModelCommit(e.target.value)}>
                {PROVIDER_MODELS[provider].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="chat-model-input"
                value={model}
                onChange={(e) => onModelCommit(e.target.value)}
                placeholder="id do modelo do seu endpoint"
                title="Id do modelo — qualquer um que seu endpoint OpenAI-compatible aceite"
              />
            )}
          </span>
          <span className="card-head-actions">
            <button
              className={sessionsOpen ? "active" : ""}
              data-role="chat-sessions-toggle"
              title="Sessões de chat"
              onClick={() => setSessionsOpen((v) => !v)}
            >
              <Icon name="chatSessionsPanel" size={12} />
            </button>
            <button title="API key" onClick={() => setShowKeyForm((v) => !v)}>
              <Icon name="apiKey" size={12} />
            </button>
            <button onClick={onClose}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </>
      }
    >
      <div className="chat-card-body">
        {sessionsOpen && (
          <div className="chat-sessions-panel thin-scroll">
            <div className="chat-sessions-panel-heading">
              SESSÕES DE CHAT
              <button
                className="chat-sessions-new-btn"
                title={`Nova sessão (${provider})`}
                onClick={() => onNewSession(id, provider)}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            {/* Pedido ao vivo (2026-08-29, item 57 ponto 2) — sessões
                deveriam respeitar o provider, cada um com sua lista;
                trocar de provider (pills do header) muda a lista aqui
                junto, em vez de mostrar todas cruzadas. `chatSessions`
                guarda TODAS (buscadas uma vez ao abrir o painel) — o
                filtro é só na renderização, sem round-trip extra. */}
            {sessionsForProvider.length === 0 ? (
              <div className="popover-empty">nenhuma conversa ainda com {provider}</div>
            ) : (
              sessionsForProvider.map((s) => (
                <button
                  key={s.id}
                  className={`chat-session-row${s.id === id ? " current" : ""}`}
                  onClick={() => onOpenChatSession(s)}
                >
                  <span className="chat-session-row-line">
                    <Icon name="chat" size={13} />
                    {s.label ?? sessionPreview(s)}
                    {s.archived_at !== null && (
                      <span className="chat-session-archived-badge" title="conversa fechada — clique pra reabrir">
                        arquivada
                      </span>
                    )}
                  </span>
                  <span className="chat-session-meta">
                    {s.provider} · {relativeTime(s.updated_at)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        <div className="chat-card-main">
      {showKeyForm ? (
        <div className="chat-key-form">
          <p>
            {hasKey
              ? `Trocar a API key da ${PROVIDER_LABELS[provider]}:`
              : `Configure sua API key da ${PROVIDER_LABELS[provider]} pra usar o chatbox:`}
          </p>
          {!encryptionAvailable && (
            <p className="chat-key-warn">
              este sistema não tem um keychain disponível — a key será salva sem criptografia.
            </p>
          )}
          {provider === "generic" && (
            <div className="chat-key-row">
              <input
                type="text"
                placeholder="https://seu-endpoint/v1 (Ollama, vLLM, etc.)"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveKey()}
              />
            </div>
          )}
          <div className="chat-key-row">
            <input
              type={revealKey ? "text" : "password"}
              placeholder={PROVIDER_KEY_PLACEHOLDER[provider]}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
            />
            <button
              type="button"
              className="chat-key-reveal"
              title={revealKey ? "ocultar" : "mostrar"}
              onClick={() => setRevealKey((v) => !v)}
            >
              <Icon name={revealKey ? "eyeOff" : "eye"} size={14} />
            </button>
            <button
              className="primary"
              disabled={!keyInput.trim() || (provider === "generic" && !baseUrlInput.trim()) || savingKey}
              onClick={saveKey}
            >
              salvar
            </button>
          </div>
          {keyFormatWarning(provider, keyInput) && <p className="chat-key-warn">{keyFormatWarning(provider, keyInput)}</p>}
          {hasKey && (
            <button
              className="chat-key-clear"
              onClick={() => {
                void window.secrets.clearKey(provider).then((result) => {
                  if (!result.ok) {
                    toast(`falha ao remover a key: ${result.error}`);
                    return;
                  }
                  setHasKey(false);
                  setKeyStatus((prev) => ({ ...prev, [provider]: false }));
                });
              }}
            >
              remover key salva
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="chat-messages thin-scroll" ref={scrollRef}>
            {messages.length === 0 && streaming === null && <div className="chat-empty">peça algo ao chatbox…</div>}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                {m.role === "assistant" ? (
                  <Markdown
                    content={textOf(m.content)}
                    className="chat-msg-md"
                    loadingFallback={<span className="chat-msg-text">{textOf(m.content)}</span>}
                  />
                ) : typeof m.content === "string" ? (
                  <span className="chat-msg-text">{m.content}</span>
                ) : (
                  <div className="chat-msg-blocks">
                    {m.content.map((block, bi) =>
                      block.type === "text" ? (
                        <span key={bi} className="chat-msg-text">{block.text}</span>
                      ) : (
                        <ChatImageThumb key={bi} block={block} />
                      ),
                    )}
                  </div>
                )}
              </div>
            ))}

            {(streaming !== null ||
              visibleActivity.length > 0 ||
              pendingWrite ||
              writeDecisions.length > 0 ||
              pendingBash ||
              bashDecisions.length > 0) && (
              <div className="chat-msg assistant">
                {visibleActivity.map((t) => (
                  <ToolLine key={t.id} activity={t} />
                ))}
                {writeDecisions.map((d, i) => (
                  <div key={i} className={`chat-tool-line done${d.allowed ? "" : " error"}`}>
                    <Icon name="apiKey" size={11} />
                    <span className="chat-tool-line-label">write_file({d.path})</span>
                    <span className="chat-tool-line-status">{d.allowed ? "aplicado" : "negado"}</span>
                  </div>
                ))}
                {pendingWrite && (
                  <div className="chat-diff-block">
                    <div className="chat-diff-head">
                      <Icon name="apiKey" size={12} />
                      <span>{pendingWrite.path}</span>
                      {pendingWrite.isNewFile && <span className="chat-diff-new">novo arquivo</span>}
                    </div>
                    <DiffView hunks={pendingWrite.hunks} />
                    <div className="chat-diff-actions">
                      <span className="chat-diff-hint">pedido de escrita — precisa da sua aprovação</span>
                      <button className="chat-diff-deny" onClick={() => resolveWrite(false)}>
                        negar
                      </button>
                      <button className="chat-diff-allow" onClick={() => resolveWrite(true)}>
                        permitir
                      </button>
                    </div>
                  </div>
                )}
                {bashDecisions.map((d, i) => (
                  <div key={i} className={`chat-tool-line done${d.allowed ? "" : " error"}`}>
                    <Icon name="apiKey" size={11} />
                    <span className="chat-tool-line-label">bash({d.command})</span>
                    <span className="chat-tool-line-status">{d.allowed ? "executado" : "negado"}</span>
                  </div>
                ))}
                {pendingBash && (
                  <div className="chat-bash-block">
                    <div className="chat-bash-head">
                      <Icon name="apiKey" size={12} />
                      <span>comando sandboxed (bubblewrap)</span>
                    </div>
                    <pre className="chat-bash-command">{pendingBash.command}</pre>
                    <div className="chat-diff-actions">
                      <span className="chat-diff-hint">pedido de execução — precisa da sua aprovação</span>
                      <button className="chat-diff-deny" onClick={() => resolveBash(false)}>
                        negar
                      </button>
                      <button className="chat-diff-allow" onClick={() => resolveBash(true)}>
                        permitir
                      </button>
                    </div>
                  </div>
                )}
                {streaming !== null &&
                  (streaming.length === 0 ? (
                    <span className="chat-thinking-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <Markdown
                      content={streaming}
                      className="chat-msg-md"
                      loadingFallback={<span className="chat-msg-text">{streaming}</span>}
                    />
                  ))}
              </div>
            )}
            {error && <div className="chat-error">erro: {error}</div>}
          </div>
          <div className="chat-composer-wrap">
            {attachments.length > 0 && (
              <div className="chat-attachments-strip">
                {attachments.map((a) => (
                  <div key={a.id} className="chat-attachment-thumb">
                    <img src={a.previewUrl} alt="anexo pendente" />
                    <button
                      className="chat-attachment-remove"
                      title="Remover anexo"
                      onClick={() => removeAttachment(a.id)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-composer">
              <textarea
                rows={1}
                placeholder="Peça algo ao chatbox… (cole ou arraste uma imagem)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                onPaste={onComposerPaste}
                onDragOver={onComposerDragOver}
                onDrop={onComposerDrop}
              />
              {streaming !== null ? (
                <button className="chat-send-btn chat-stop-btn" title="Parar" onClick={stop}>
                  <Icon name="interrupt" size={16} />
                </button>
              ) : (
                <button className="chat-send-btn" disabled={!draft.trim() && attachments.length === 0} onClick={send}>
                  <Icon name="chevronRight" size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
        </div>
      </div>
    </CardFrame>
  );
}

export const ChatCard = memo(ChatCardInner);
