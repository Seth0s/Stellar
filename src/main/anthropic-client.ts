import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  TOOL_DESCRIPTIONS,
  TOOL_PARAMETERS,
  executeTool,
  type ChatMessage,
  type ChatToolHooks,
  type WriteConsentRequest,
  type BashConsentRequest,
  type DelegateProvider,
  type DelegateResult,
} from "./chat-tools";

/**
 * DESIGN-BACKLOG.md item 12 — Fase B built the plain streamed-text path;
 * Fase C adds a real agentic tool loop on top of it (read_file/write_file,
 * chat-tools.ts). Uses `@anthropic-ai/sdk` rather than hand-rolled SSE
 * parsing or the SDK's own (beta) `BetaToolRunner` — a manual loop over
 * the STABLE `messages.stream()` + `finalMessage()` API (already
 * validated in Fase B) keeps this predictable/debuggable and avoids
 * depending on a beta surface for something this central.
 *
 * `providers.ts`'s `ProviderDef` is structurally CLI-binary-spawn-only —
 * a chat provider that talks to an HTTP API directly doesn't fit that
 * shape at all, so this stays a deliberately separate module.
 */

const ANTHROPIC_TOOLS: Anthropic.Tool[] = [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME, DELEGATE_TOOL_NAME].map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  input_schema: TOOL_PARAMETERS[name] as Anthropic.Tool["input_schema"],
}));

// A tool call → tool result → re-ask cycle, repeated. Same fork-bomb-guard
// spirit as MAX_SPAWN_DEPTH (message-bus.ts) — a model stuck calling tools
// forever (or a buggy prompt loop) must hit a hard, honest stop rather
// than run up the human's API bill unattended.
const MAX_TOOL_TURNS = 8;

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function createAnthropicClient(opts: {
  onToken: (cardId: string, delta: string) => void;
  onDone: (cardId: string, fullText: string) => void;
  onError: (cardId: string, message: string) => void;
  onToolStart: (cardId: string, name: string, input: unknown) => void;
  onToolResult: (cardId: string, name: string, ok: boolean, summary: string) => void;
  askWriteConsent: (cardId: string, req: WriteConsentRequest) => Promise<boolean>;
  askBashConsent: (cardId: string, req: BashConsentRequest) => Promise<boolean>;
  delegateToAgent: (cardId: string, cwd: string, provider: DelegateProvider, reason: string) => Promise<DelegateResult>;
}) {
  const inFlight = new Map<string, MessageStream>();
  // Same reasoning as before — the SDK's own "error" event still fires
  // for a deliberately aborted stream (cancel(), or a second send()
  // superseding it); without this set that surfaces as a scary error for
  // something a human (or a superseding send) actually asked for.
  const intentionalAborts = new Set<string>();

  async function runTurn(
    cardId: string,
    apiKey: string,
    model: string,
    system: string | null | undefined,
    initialMessages: Anthropic.MessageParam[],
    hooks: ChatToolHooks,
  ) {
    const client = new Anthropic({ apiKey });
    const messages = [...initialMessages];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system: system || undefined,
        tools: ANTHROPIC_TOOLS,
        messages,
      });
      inFlight.set(cardId, stream);
      stream.on("text", (delta) => opts.onToken(cardId, delta));

      let final: Anthropic.Message;
      try {
        final = await stream.finalMessage();
      } catch (err) {
        inFlight.delete(cardId);
        if (intentionalAborts.delete(cardId)) return;
        opts.onError(cardId, err instanceof Error ? err.message : String(err));
        return;
      }
      inFlight.delete(cardId);

      if (final.stop_reason !== "tool_use") {
        const text = final.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        opts.onDone(cardId, text);
        return;
      }

      messages.push({ role: "assistant", content: final.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input, hooks);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.text, is_error: !result.ok });
      }
      messages.push({ role: "user", content: toolResults });
      // loop: re-ask with the tool results appended
    }
    opts.onError(cardId, `muitas chamadas de tool em sequência (limite de segurança: ${MAX_TOOL_TURNS})`);
  }

  function send(
    cardId: string,
    params: { apiKey: string; model: string; system?: string | null; messages: ChatMessage[]; root: string },
  ) {
    inFlight.get(cardId)?.abort();
    intentionalAborts.delete(cardId);

    const hooks: ChatToolHooks = {
      root: params.root,
      onToolStart: (name, input) => opts.onToolStart(cardId, name, input),
      onToolResult: (name, ok, summary) => opts.onToolResult(cardId, name, ok, summary),
      askWriteConsent: (req) => opts.askWriteConsent(cardId, req),
      askBashConsent: (req) => opts.askBashConsent(cardId, req),
      delegateToAgent: (provider, reason) => opts.delegateToAgent(cardId, params.root, provider, reason),
    };
    void runTurn(cardId, params.apiKey, params.model, params.system, toAnthropicMessages(params.messages), hooks);
  }

  function cancel(cardId: string) {
    // Best-effort: aborts whichever stream is currently in flight for this
    // card. If a write-consent modal is pending instead (between streams,
    // mid tool-loop), this doesn't retract it — a real, small limitation,
    // acceptable since there's no "stop generating" UI button yet either.
    const stream = inFlight.get(cardId);
    if (!stream) return;
    intentionalAborts.add(cardId);
    stream.abort();
    inFlight.delete(cardId);
  }

  return { send, cancel };
}
