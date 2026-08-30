// DESIGN-BACKLOG.md item 57 ponto 7 — anthropic-client.ts accumulates
// input/output tokens ACROSS a tool-loop turn (each round resends the
// whole growing message array, so summing gives the true total cost of one
// user turn, not just the final round's slice). No real Anthropic API key
// exists in this environment to prove this end-to-end over the network
// (smoke-chat-status-line.mjs covers the OpenAI-compatible path that way,
// with a real local HTTP server) — so this test goes straight at the REAL
// exported `createAnthropicClient` function (same spirit as
// session-watch.ts's direct-import tests earlier this session), monkey-
// patching only the SDK's `Messages.prototype.stream` (the network
// boundary) to return two canned rounds with KNOWN usage numbers, and
// asserting the accumulated total handed to `onDone` is their real sum —
// not a guess, not the last round's number alone.
import { register } from "node:module";
import Anthropic from "@anthropic-ai/sdk";
import { makeChecker } from "./cdp-client.mjs";

// See ts-relative-import-loader.mjs's own doc comment — anthropic-client.ts
// imports "./chat-tools" with no extension (fine for tsc/electron-vite,
// not for plain Node ESM resolution), so importing it directly here needs
// this hook registered BEFORE that import happens — hence the dynamic
// `import()` below instead of a static one, which Node would otherwise
// hoist and resolve before this line ever runs.
register(new URL("./ts-relative-import-loader.mjs", import.meta.url));
const { createAnthropicClient } = await import("../../src/main/anthropic-client.ts");

const { check, finish } = makeChecker();

const ROUND_1_USAGE = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 30 };
const ROUND_2_USAGE = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 150, output_tokens: 40 };
// Real total context tokens = input + cache_creation + cache_read, summed
// across both rounds (a cache HIT still means the model saw those tokens).
const EXPECTED_INPUT = 100 + 20 + 0 + (0 + 0 + 150);
const EXPECTED_OUTPUT = 30 + 40;

// Patched via a throwaway instance's OWN prototype chain, not a guessed
// subpath import — guarantees this is the exact same class object
// anthropic-client.ts's `new Anthropic(...)` instances actually use,
// sidestepping any dual-module-instance mismatch between how a subpath
// import and the package's own internal resolution might each load
// "resources/messages/messages.js".
const probeClient = new Anthropic({ apiKey: "unused-probe-key" });
const MessagesProto = Object.getPrototypeOf(probeClient.messages);

let call = 0;
const originalStream = MessagesProto.stream;
MessagesProto.stream = function fakeStream() {
  call += 1;
  const isFirstRound = call === 1;
  const fakeFinal = isFirstRound
    ? {
        stop_reason: "tool_use",
        usage: ROUND_1_USAGE,
        content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "package.json" } }],
      }
    : {
        stop_reason: "end_turn",
        usage: ROUND_2_USAGE,
        content: [{ type: "text", text: "resposta final de teste" }],
      };
  return {
    on() {},
    abort() {},
    finalMessage: async () => fakeFinal,
  };
};

try {
  const results = [];
  const client = createAnthropicClient({
    onToken: () => {},
    onDone: (cardId, fullText, usage) => results.push({ cardId, fullText, usage }),
    onError: (cardId, message) => results.push({ cardId, error: message }),
    onToolStart: () => {},
    onToolResult: () => {},
    askWriteConsent: async () => false,
    askBashConsent: async () => false,
    delegateToAgent: async () => ({ ok: false, error: "not used in this test" }),
  });

  client.send("card-1", {
    apiKey: "fake-key-never-sent (network layer is monkey-patched out)",
    model: "claude-sonnet-5",
    system: null,
    messages: [{ role: "user", content: "oi" }],
    root: new URL("../..", import.meta.url).pathname,
  });

  // Two rounds (tool_use then end_turn) + a real (fast) read_file — a few
  // event-loop turns to settle, generously bounded.
  const TIMEOUT_MS = 5000;
  const start = Date.now();
  while (results.length === 0 && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 20));
  }

  check("createAnthropicClient's onDone fired (não onError)", results[0]?.error === undefined, true);
  check("duas rodadas de stream() realmente aconteceram (tool_use → end_turn)", call, 2);
  check("texto final é o da 2ª rodada, não a 1ª", results[0]?.fullText, "resposta final de teste");
  check("inputTokens é a SOMA real das duas rodadas (input + cache_creation + cache_read)", results[0]?.usage?.inputTokens, EXPECTED_INPUT);
  check("outputTokens é a SOMA real das duas rodadas", results[0]?.usage?.outputTokens, EXPECTED_OUTPUT);
} finally {
  MessagesProto.stream = originalStream;
}
finish();
