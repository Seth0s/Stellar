import { useEffect, useRef, useState } from "react";
import { CardFrame } from "./CardFrame";
import { CardTag } from "./CardTag";
import { Icon } from "./icons";
import type { Rect } from "./board-model";
import type { ChatMessage } from "./card-types";

/**
 * DESIGN-BACKLOG.md item 12, Fase B — first real implementation of the
 * chatbox card scoped in the Fase A prototype (`chatbox-prototype.html`,
 * an artifact, not code). This phase is deliberately text-only: streamed
 * markdown replies against the Anthropic Messages API, no tool use, no
 * diffs, no subagent blocks — those are Fase C/D. Visually it's the
 * plainer subset of the prototype (message stream + composer + model
 * picker), same tokens/fonts, no thinking/tool-call/diff chrome yet since
 * there's nothing real behind those blocks at this phase.
 */

export const CHAT_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"] as const;
export const DEFAULT_CHAT_MODEL: string = CHAT_MODELS[0];

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

export function ChatCard({
  id,
  rect,
  zoom,
  zIndex,
  model,
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
  onConnectorStart,
  onSelectStart,
}: {
  id: string;
  rect: Rect;
  zoom: number;
  zIndex: number;
  model: string;
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
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.secrets.hasKey("anthropic").then((v) => {
      setHasKey(v);
      setShowKeyForm(!v);
    });
    void window.secrets.isEncryptionAvailable().then(setEncryptionAvailable);
  }, []);

  // Subscribed once (not per-render) — reads live state via refs, not
  // closed-over props, so it never goes stale. Same reasoning
  // useTerminal.ts's onData subscription already established for pty
  // streams; chat:token/done/error follow the identical main → renderer
  // shape (main/index.ts, main/anthropic-client.ts).
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
    return () => {
      offToken();
      offDone();
      offError();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  function saveKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    void window.secrets.setKey("anthropic", trimmed).then(() => {
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
    void window.chat
      .send(id, { model, systemPrompt, messages: next })
      .then((result) => {
        if (!result.ok) {
          setError(result.error);
          setStreaming(null);
        }
      });
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

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
      headerContent={
        <>
          <span className="card-head-label">
            <Icon name="chat" size={14} />
            <CardTag label={label ?? "chatbox"} onRename={onRename} />
            <select className="chat-model-select" value={model} onChange={(e) => onModelCommit(e.target.value)}>
              {CHAT_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
            {hasKey ? "Trocar a API key da Anthropic:" : "Configure sua API key da Anthropic pra usar o chatbox:"}
          </p>
          {!encryptionAvailable && (
            <p className="chat-key-warn">
              este sistema não tem um keychain disponível — a key será salva sem criptografia.
            </p>
          )}
          <div className="chat-key-row">
            <input
              type="password"
              placeholder="sk-ant-…"
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
                void window.secrets.clearKey("anthropic").then(() => setHasKey(false));
              }}
            >
              remover key salva
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="chat-messages thin-scroll" ref={scrollRef}>
            {messages.length === 0 && streaming === null && (
              <div className="chat-empty">peça algo ao chatbox…</div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                {m.role === "assistant" ? <Markdown content={m.content} /> : <span className="chat-msg-text">{m.content}</span>}
              </div>
            ))}
            {streaming !== null && (
              <div className="chat-msg assistant">
                {streaming.length === 0 ? (
                  <span className="chat-thinking-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <Markdown content={streaming} />
                )}
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
