import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";

/**
 * DESIGN-BACKLOG.md item 12, Fase B — the first outbound HTTP client and
 * first SSE stream in this codebase (confirmed by exploration: `updater.ts`
 * delegates to `electron-updater`, `mcp-server.ts`/`remote-server.ts`/
 * `message-bus.ts` are all inbound servers). `providers.ts`'s `ProviderDef`
 * is structurally CLI-binary-spawn-only (`resolveSpawn` always resolves a
 * `$PATH` binary) — a chat provider that talks to an HTTP API directly
 * doesn't fit that shape at all, so this is a deliberately separate module,
 * not an entry added to `PROVIDERS`.
 *
 * Uses `@anthropic-ai/sdk` rather than hand-rolled SSE parsing — the raw
 * `data: {...}` stream has real correctness pitfalls (multi-byte UTF-8
 * split across TCP chunks, event framing) that a maintained client already
 * handles; not worth re-solving for a first version.
 *
 * Mirrors `pty-registry.ts`'s shape on purpose: a registry keyed by card
 * id, `onData`/`onExit`-style callbacks the caller wires to `safeSend`
 * (main/index.ts), so main → renderer streaming looks the same for a chat
 * card as it does for a terminal card.
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function createAnthropicClient(opts: {
  onToken: (cardId: string, delta: string) => void;
  onDone: (cardId: string, fullText: string) => void;
  onError: (cardId: string, message: string) => void;
}) {
  const inFlight = new Map<string, MessageStream>();
  // Cards whose stream was aborted on purpose (cancel(), or a second send()
  // superseding it) — the SDK's own "error" event still fires for an
  // aborted stream, and without this set that would surface as a scary
  // "erro: request aborted" to the user for something they (or a
  // superseding send) asked for.
  const intentionalAborts = new Set<string>();

  function send(cardId: string, params: { apiKey: string; model: string; system?: string | null; messages: ChatMessage[]; baseURL?: string }) {
    inFlight.get(cardId)?.abort();
    intentionalAborts.delete(cardId);

    const client = new Anthropic({ apiKey: params.apiKey, baseURL: params.baseURL });
    const stream = client.messages.stream({
      model: params.model,
      max_tokens: 4096,
      system: params.system || undefined,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    inFlight.set(cardId, stream);

    stream.on("text", (delta) => opts.onToken(cardId, delta));

    stream.on("error", (err) => {
      inFlight.delete(cardId);
      if (intentionalAborts.delete(cardId)) return;
      opts.onError(cardId, err instanceof Error ? err.message : String(err));
    });

    stream
      .finalMessage()
      .then((msg) => {
        inFlight.delete(cardId);
        const text = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        opts.onDone(cardId, text);
      })
      .catch(() => {
        // Already reported via the "error" event above (or intentionally
        // swallowed as an abort) — avoid a second error report for the
        // same failure.
      });
  }

  function cancel(cardId: string) {
    const stream = inFlight.get(cardId);
    if (!stream) return;
    intentionalAborts.add(cardId);
    stream.abort();
    inFlight.delete(cardId);
  }

  return { send, cancel };
}
