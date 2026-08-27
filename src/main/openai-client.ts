import OpenAI from "openai";
import type { ChatCompletionStreamingRunner } from "openai/lib/ChatCompletionStreamingRunner";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  TOOL_DESCRIPTIONS,
  TOOL_PARAMETERS,
  executeTool,
  type ChatMessage,
  type ChatToolHooks,
  type WriteConsentRequest,
} from "./chat-tools";

/**
 * DESIGN-BACKLOG.md item 12, Fase C — the "segunda API" (OpenAI-compatible
 * Chat Completions, the format nearly every compatible endpoint actually
 * implements — not the newer Responses API, which most third-party
 * "OpenAI-compatible" servers don't speak). Deliberate mirror of
 * anthropic-client.ts's shape (same manual per-turn loop over
 * `finalChatCompletion()`, same `send`/`cancel` public API) rather than
 * the SDK's own `runTools()` auto-loop helper — consistency between the
 * two providers' code matters more here than saving the loop bookkeeping,
 * and both need the identical consent-gate injection point anyway.
 */

const OPENAI_TOOLS: ChatCompletionTool[] = [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME].map((name) => ({
  type: "function",
  function: { name, description: TOOL_DESCRIPTIONS[name], parameters: TOOL_PARAMETERS[name] as Record<string, unknown> },
}));

const MAX_TOOL_TURNS = 8; // same cap/reasoning as anthropic-client.ts

function toOpenAiMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function createOpenAiClient(opts: {
  onToken: (cardId: string, delta: string) => void;
  onDone: (cardId: string, fullText: string) => void;
  onError: (cardId: string, message: string) => void;
  onToolStart: (cardId: string, name: string, input: unknown) => void;
  onToolResult: (cardId: string, name: string, ok: boolean, summary: string) => void;
  askWriteConsent: (cardId: string, req: WriteConsentRequest) => Promise<boolean>;
}) {
  const inFlight = new Map<string, ChatCompletionStreamingRunner>();
  const intentionalAborts = new Set<string>();

  async function runTurn(
    cardId: string,
    apiKey: string,
    model: string,
    system: string | null | undefined,
    initialMessages: ChatCompletionMessageParam[],
    hooks: ChatToolHooks,
  ) {
    const client = new OpenAI({ apiKey });
    const messages: ChatCompletionMessageParam[] = system ? [{ role: "system", content: system }, ...initialMessages] : [...initialMessages];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const runner = client.chat.completions.stream({ model, messages, tools: OPENAI_TOOLS });
      inFlight.set(cardId, runner);
      runner.on("content", (delta) => opts.onToken(cardId, delta));

      let completion: OpenAI.ChatCompletion;
      try {
        completion = await runner.finalChatCompletion();
      } catch (err) {
        inFlight.delete(cardId);
        if (intentionalAborts.delete(cardId)) return;
        opts.onError(cardId, err instanceof Error ? err.message : String(err));
        return;
      }
      inFlight.delete(cardId);

      const choice = completion.choices[0];
      const toolCalls = choice?.message.tool_calls;
      if (choice?.finish_reason !== "tool_calls" || !toolCalls || toolCalls.length === 0) {
        opts.onDone(cardId, choice?.message.content ?? "");
        return;
      }

      messages.push(choice.message);
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          // malformed tool-call JSON — executeTool's own missing-field
          // handling (String(args.path ?? "")) degrades gracefully from
          // here rather than throwing.
        }
        const result = await executeTool(call.function.name, input, hooks);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
      }
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
    };
    void runTurn(cardId, params.apiKey, params.model, params.system, toOpenAiMessages(params.messages), hooks);
  }

  function cancel(cardId: string) {
    const runner = inFlight.get(cardId);
    if (!runner) return;
    intentionalAborts.add(cardId);
    runner.abort();
    inFlight.delete(cardId);
  }

  return { send, cancel };
}
