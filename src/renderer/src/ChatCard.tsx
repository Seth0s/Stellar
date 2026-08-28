import { useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import { toast } from "./useToast";
import { PROVIDER_LABELS, PROVIDER_KEY_PLACEHOLDER, PROVIDER_MODELS, keyFormatWarning } from "./secretsUi";
import type { Rect } from "./board-model";
import type { ChatMessage, ChatProvider } from "./card-types";
import type { WriteConsentRequest, BashConsentRequest } from "../../preload/index";

const ALL_PROVIDERS: ChatProvider[] = ["anthropic", "openai", "gemini", "generic"];

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

/** Lazy-loaded on first render that actually needs it, same reasoning as
 * FilesCard.tsx's own `MarkdownPreview` (marked+dompurify are ~170KB raw
 * of the renderer bundle) — except here every chat message needs this, so
 * unlike FilesCard it'll load on effectively every ChatCard's first
 * message rather than staying dormant for the session. */
function Markdown({ content }: { content: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([import("marked"), import("dompurify")]).then(([{ marked }, { default: DOMPurify }]) => {
      if (cancelled) return;
      setHtml(DOMPurify.sanitize(marked.parse(content, { async: false })));
    });
    return () => {
      cancelled = true;
    };
  }, [content]);
  if (html === null) return <span className="chat-msg-text">{content}</span>;
  return <div className="chat-msg-md" dangerouslySetInnerHTML={{ __html: html }} />;
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

export function ChatCard({
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
  label,
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
  label: string | null;
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
}) {
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
  const [draft, setDraft] = useState("");
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
    const offDone = window.chat.onDone((cardId, fullText) => {
      if (cardId !== id) return;
      onMessagesCommit([...messagesRef.current, { role: "assistant", content: fullText }]);
      setStreaming(null);
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

  function send() {
    const text = draft.trim();
    if (!text || streaming !== null) return;
    const next = [...messages, { role: "user" as const, content: text }];
    onMessagesCommit(next);
    setDraft("");
    setError(null);
    setStreaming("");
    setToolActivity([]);
    setWriteDecisions([]);
    setBashDecisions([]);
    void window.chat.send(id, { provider, model, systemPrompt, messages: next, cwd }).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setStreaming(null);
      }
    });
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
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
      rect={rect}
      zoom={zoom}
      zIndex={zIndex}
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
      footerContent={<span className="chat-foot-cwd">{cwd}</span>}
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="chat" size={14} />
            <CardTag label={label ?? "chatbox"} onRename={onRename} />
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
                {m.role === "assistant" ? <Markdown content={m.content} /> : <span className="chat-msg-text">{m.content}</span>}
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
                    <Markdown content={streaming} />
                  ))}
              </div>
            )}
            {error && <div className="chat-error">erro: {error}</div>}
          </div>
          <div className="chat-composer">
            <textarea
              rows={1}
              placeholder="Peça algo ao chatbox…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button className="chat-send-btn" disabled={!draft.trim() || streaming !== null} onClick={send}>
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
        </>
      )}
    </CardFrame>
  );
}
