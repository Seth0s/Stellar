import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { readFileSync } from "node:fs";
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
  type ChatUsage,
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

const ANTHROPIC_TOOLS: Anthropic.Tool[] = [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME, DELEGATE_TOOL_NAME].map((name, i, arr) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  input_schema: TOOL_PARAMETERS[name] as Anthropic.Tool["input_schema"],
  // DESIGN-BACKLOG.md item 30 — prompt caching (Anthropic-specific;
  // OpenAI/Gemini cache automatically with no equivalent marker needed).
  // A cache breakpoint caches everything UP TO AND INCLUDING the marked
  // block, so only the LAST tool in the array needs the marker — it
  // covers the whole tools definition, identical on every single
  // request this app ever sends (same 4 tools, same schemas), so this
  // one marker pays for itself starting on the very first follow-up
  // message of ANY conversation, not just long ones.
  ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
}));

/**
 * Item 30 — user asked directly ("poupar cache read... é esse tipo de
 * persistência que digo"): the Messages API has no server-side
 * session/conversation concept at all (confirmed reading the SDK's own
 * types — `system`/`messages` are always resent whole, there's no
 * `session_id` param anywhere) — "resuming" a conversation IS just
 * resending its full stored history, and prompt caching is the ONLY
 * mechanism that makes that not cost full price every single turn.
 * Before this, zero `cache_control` anywhere in this file — every
 * message, every turn, reprocessed the entire growing transcript at full
 * price, worse as a conversation (or a reopened/persisted one) got
 * longer. Marks the trailing edge of whatever's being sent as a
 * breakpoint — the officially documented simple pattern for a growing
 * multi-turn conversation: next turn's request shares this exact prefix,
 * so it reads from cache instead of reprocessing it.
 */
function withCacheBreakpoint(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  const content: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }]
      : last.content.map((block, i, arr) => (i === arr.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block));
  return [...msgs.slice(0, -1), { ...last, content }];
}

// A tool call → tool result → re-ask cycle, repeated. Same fork-bomb-guard
// spirit as MAX_SPAWN_DEPTH (message-bus.ts) — a model stuck calling tools
// forever (or a buggy prompt loop) must hit a hard, honest stop rather
// than run up the human's API bill unattended.
const MAX_TOOL_TURNS = 8;

/** Item 66 — um bloco de imagem só guarda o PATH (ver ChatImageBlock's
 * doc comment, chat-tools.ts) — lido do disco e virado base64 só aqui,
 * na hora de montar a request de verdade, nunca persistido assim. Um
 * arquivo que sumiu (limpeza de temp do SO, path malformado) degrada pra
 * um bloco de texto avisando em vez de derrubar o turno inteiro — mesmo
 * espírito defensivo do resto da mensageria deste app.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const content: Anthropic.ContentBlockParam[] = m.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      try {
        const data = readFileSync(block.path).toString("base64");
        return { type: "image", source: { type: "base64", media_type: block.mediaType, data } };
      } catch (err) {
        return { type: "text", text: `[imagem anexada não pôde ser lida: ${err instanceof Error ? err.message : String(err)}]` };
      }
    });
    return { role: m.role, content };
  });
}

export function createAnthropicClient(opts: {
  onToken: (cardId: string, delta: string) => void;
  onDone: (cardId: string, fullText: string, usage: ChatUsage) => void;
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
    let inputTokens = 0;
    let outputTokens = 0;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        // Cached too (item 30) — the system prompt is identical across
        // every turn of a given conversation, same "resend the whole
        // thing every time" cost otherwise.
        system: system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : undefined,
        tools: ANTHROPIC_TOOLS,
        messages: withCacheBreakpoint(messages),
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
      inputTokens += final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0);
      outputTokens += final.usage.output_tokens;

      if (final.stop_reason !== "tool_use") {
        const text = final.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        opts.onDone(cardId, text, { inputTokens, outputTokens });
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
