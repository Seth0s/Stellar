import { useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type { ChatMessage, ChatProvider } from "./card-types";
import type { WriteConsentRequest } from "../../preload/index";

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

export const CHAT_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"] as const;
export const DEFAULT_CHAT_MODEL: string = CHAT_MODELS[0];
// Not a claim about "the current latest OpenAI model" — just a
// long-stable, well-known id to prefill a free-text field with (see the
// model-input note below for why OpenAI doesn't get a fixed dropdown the
// way Anthropic does).
export const DEFAULT_OPENAI_MODEL = "gpt-4.1";

type ToolActivity = { id: string; name: string; input: unknown; status: "running" | "done"; ok?: boolean; summary?: string };
type WriteDecision = { path: string; allowed: boolean };

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
  const input = activity.input as { path?: string } | undefined;
  const label = input?.path ? `${activity.name}(${input.path})` : activity.name;
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
  const [savingKey, setSavingKey] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [writeDecisions, setWriteDecisions] = useState<WriteDecision[]>([]);
  const [pendingWrite, setPendingWrite] = useState<{ requestId: string } & WriteConsentRequest | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHasKey(null);
    void window.secrets.hasKey(provider).then((v) => {
      setHasKey(v);
      setShowKeyForm(!v);
    });
    void window.secrets.isEncryptionAvailable().then(setEncryptionAvailable);
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
    return () => {
      offToken();
      offDone();
      offError();
      offToolStart();
      offToolResult();
      offAskWrite();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, toolActivity, pendingWrite]);

  function saveKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    void window.secrets.setKey(provider, trimmed).then(() => {
      setSavingKey(false);
      setKeyInput("");
      setHasKey(true);
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

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const visibleActivity = toolActivity.filter((t) => t.name !== "write_file");

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
              <button className={provider === "anthropic" ? "active" : ""} onClick={() => onProviderCommit("anthropic")}>
                anthropic
              </button>
              <button className={provider === "openai" ? "active" : ""} onClick={() => onProviderCommit("openai")}>
                openai
              </button>
            </span>
            {provider === "anthropic" ? (
              <select className="chat-model-select" value={model} onChange={(e) => onModelCommit(e.target.value)}>
                {CHAT_MODELS.map((m) => (
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
            {hasKey ? `Trocar a API key da ${provider}:` : `Configure sua API key da ${provider} pra usar o chatbox:`}
          </p>
          {!encryptionAvailable && (
            <p className="chat-key-warn">
              este sistema não tem um keychain disponível — a key será salva sem criptografia.
            </p>
          )}
          <div className="chat-key-row">
            <input
              type="password"
              placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
            />
            <button className="primary" disabled={!keyInput.trim() || savingKey} onClick={saveKey}>
              salvar
            </button>
          </div>
          {hasKey && (
            <button
              className="chat-key-clear"
              onClick={() => {
                void window.secrets.clearKey(provider).then(() => setHasKey(false));
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

            {(streaming !== null || visibleActivity.length > 0 || pendingWrite || writeDecisions.length > 0) && (
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
