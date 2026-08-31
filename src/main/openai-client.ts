import OpenAI from "openai";
import type { ChatCompletionStreamingRunner } from "openai/lib/ChatCompletionStreamingRunner";
import type { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
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

const OPENAI_TOOLS: ChatCompletionTool[] = [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, BASH_TOOL_NAME, DELEGATE_TOOL_NAME].map((name) => ({
  type: "function",
  function: { name, description: TOOL_DESCRIPTIONS[name], parameters: TOOL_PARAMETERS[name] as Record<string, unknown> },
}));

const MAX_TOOL_TURNS = 8; // same cap/reasoning as anthropic-client.ts

/** Item 66 — mesmo raciocínio de `toAnthropicMessages` (anthropic-client.ts):
 * `path` só é lido/convertido pra base64 aqui, na hora de montar a request
 * de verdade. Só `role: "user"` carrega array de verdade nesta app (nunca
 * geramos bloco de imagem numa resposta do assistente) — a asserção de tipo
 * reflete esse invariante, o SDK não modela isso por role sozinho.
 */
function toOpenAiMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content } as ChatCompletionMessageParam;
    const content: ChatCompletionContentPart[] = m.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      try {
        const data = readFileSync(block.path).toString("base64");
        return { type: "image_url", image_url: { url: `data:${block.mediaType};base64,${data}` } };
      } catch (err) {
        return { type: "text", text: `[imagem anexada não pôde ser lida: ${err instanceof Error ? err.message : String(err)}]` };
      }
    });
    return { role: m.role, content } as ChatCompletionMessageParam;
  });
}

export function createOpenAiClient(opts: {
  onToken: (cardId: string, delta: string) => void;
  onDone: (cardId: string, fullText: string, usage: ChatUsage) => void;
  onError: (cardId: string, message: string) => void;
  onToolStart: (cardId: string, name: string, input: unknown) => void;
  onToolResult: (cardId: string, name: string, ok: boolean, summary: string) => void;
  askWriteConsent: (cardId: string, req: WriteConsentRequest) => Promise<boolean>;
  askBashConsent: (cardId: string, req: BashConsentRequest) => Promise<boolean>;
  delegateToAgent: (cardId: string, cwd: string, provider: DelegateProvider, reason: string) => Promise<DelegateResult>;
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
    baseURL: string | undefined,
  ) {
    // DESIGN-BACKLOG.md item 28 — `baseURL` undefined keeps the SDK's own
    // default (api.openai.com), same as before this option existed. Set
    // for "gemini" (fixed, main/index.ts) and "generic" (user-supplied,
    // secrets.ts) — both speak the same OpenAI-compatible Chat Completions
    // shape this whole client already targets, so no separate client code
    // is needed per provider, just a different endpoint to point at.
    const client = new OpenAI({ apiKey, baseURL });
    const messages: ChatCompletionMessageParam[] = system ? [{ role: "system", content: system }, ...initialMessages] : [...initialMessages];
    let inputTokens = 0;
    let outputTokens = 0;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      // `stream_options.include_usage` — without it, a streamed response
      // never carries a `usage` field at all (confirmed in the SDK's own
      // types), silently leaving `completion.usage` undefined below.
      const runner = client.chat.completions.stream({ model, messages, tools: OPENAI_TOOLS, stream_options: { include_usage: true } });
      inFlight.set(cardId, runner);
      runner.on("content", (delta) => opts.onToken(cardId, delta));

      let completion: OpenAI.ChatCompletion;
      try {
        completion = await runner.finalChatCompletion();
      } catch (err) {
        inFlight.delete(cardId);
        if (intentionalAborts.delete(cardId)) return;
        // Achado ao vivo (2026-08-31, gemini via este shim OpenAI-
        // compatible): alguns endpoints "compatíveis" não mandam o campo
        // `index` em `delta.tool_calls[]` quando só existe UMA tool call
        // no turno (o spec real da OpenAI exige, mas nem todo servidor
        // implementa à risca) — o helper de streaming do SDK reconstrói
        // tool_calls por esse índice e joga um erro seco quando ele falta
        // (`ChatCompletionStream.ts`'s `invalid tool call index`), mesmo
        // com a resposta real já tendo chegado e sido cobrada no servidor
        // (usage real, confirmado ao vivo). Sem stream pra reconstruir
        // (`stream: false`), a MESMA requisição chega como um objeto
        // pronto — sem esse parsing incremental, então imune a esse gap
        // específico. Só entra nesse fallback pra esse erro exato; toda
        // resposta normal continua via streaming token-a-token.
        if (err instanceof Error && err.message.includes("invalid tool call index")) {
          try {
            completion = await client.chat.completions.create({ model, messages, tools: OPENAI_TOOLS });
            opts.onToken(cardId, completion.choices[0]?.message.content ?? "");
          } catch (fallbackErr) {
            opts.onError(cardId, fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
            return;
          }
        } else {
          opts.onError(cardId, err instanceof Error ? err.message : String(err));
          return;
        }
      }
      inFlight.delete(cardId);
      inputTokens += completion.usage?.prompt_tokens ?? 0;
      outputTokens += completion.usage?.completion_tokens ?? 0;

      const choice = completion.choices[0];
      const toolCalls = choice?.message.tool_calls;
      if (choice?.finish_reason !== "tool_calls" || !toolCalls || toolCalls.length === 0) {
        opts.onDone(cardId, choice?.message.content ?? "", { inputTokens, outputTokens });
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
    params: { apiKey: string; model: string; system?: string | null; messages: ChatMessage[]; root: string; baseURL?: string },
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
    void runTurn(cardId, params.apiKey, params.model, params.system, toOpenAiMessages(params.messages), hooks, params.baseURL);
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
