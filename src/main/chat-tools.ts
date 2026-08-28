import { structuredPatch } from "diff";
import { readFile, writeFile, confine, MAX_FILE_BYTES } from "./fs-tools";
import { isSandboxAvailable, runSandboxedBash } from "./sandbox";

/**
 * DESIGN-BACKLOG.md item 12, Fase C — the tool set both chat providers
 * share (anthropic-client.ts, openai-client.ts each translate this into
 * their own wire format, but the actual execution is one implementation,
 * same reasoning as message-bus.ts's `handleRequest` serving both acbridge
 * and the MCP server). `readFile`/`writeFile`/`confine` are the SAME
 * functions `FilesCard.tsx` already drives via `window.fs.*` — a chat
 * card's file tools get the exact same root-confinement guarantee a human
 * browsing that card's `FilesCard` already has, nothing new to trust.
 *
 * `read_file` has no consent gate (same class of already-established
 * precedent as `get_page_text`/`snapshot` in item 21 ponto 9 achado 5 —
 * passive observation of something already inside a boundary the human
 * chose at card-creation time, the project root). `write_file` always
 * does — mutating a file is the same weight of action `spawn_agent`/
 * `open_url`/`spawn_card` already gate, so it gets the same treatment,
 * just rendered as an inline diff block in the chat stream instead of the
 * small `AgentAskModal` popup (a multi-line colored diff doesn't fit a
 * one-line `.agent-ask-command`).
 *
 * Fase D adds two more tools:
 * - `bash` — real command execution, sandboxed via `sandbox.ts` (bwrap;
 *   see that file's doc comment for the security model). Always gated,
 *   rendered as its own inline block (command text, not a diff) — a
 *   consent gate alone doesn't make an unsandboxed shell safe, so this
 *   tool REFUSES outright (no consent prompt at all — nothing safe to
 *   consent to) when bwrap isn't available on the host, rather than
 *   silently falling back to running the command unsandboxed.
 * - `delegate_to_agent` — reuses the EXISTING `spawn_agent` consent/spawn
 *   flow (message-bus.ts's `handleRequest`, DESIGN-BACKLOG.md item 21
 *   ponto 9 achado 1) rather than building a second one: the human sees
 *   the SAME `AgentAskModal` a `spawn_agent` MCP call already produces.
 *   Fire-and-forget from the tool loop's perspective — a spawned CLI
 *   session can't be synchronously awaited, so the tool result is just
 *   "spawned, card #N, running independently".
 */

/** Provider-agnostic — both anthropic-client.ts and openai-client.ts
 * accept/return this shape and translate to their own wire format. */
export type ChatMessage = { role: "user" | "assistant"; content: string };

export const READ_FILE_TOOL_NAME = "read_file" as const;
export const WRITE_FILE_TOOL_NAME = "write_file" as const;
export const BASH_TOOL_NAME = "bash" as const;
export const DELEGATE_TOOL_NAME = "delegate_to_agent" as const;

export const TOOL_DESCRIPTIONS = {
  [READ_FILE_TOOL_NAME]: "Read a file's contents. `path` is relative to this chat's project root.",
  [WRITE_FILE_TOOL_NAME]:
    "Create or overwrite a file with new full content. Shows the human a diff and waits for their approval before anything is actually written — if they deny it, the file is untouched and you're told so.",
  [BASH_TOOL_NAME]:
    "Run a shell command. Executes sandboxed (bubblewrap): filesystem writes are confined to this chat's project root and /tmp, the process runs in its own PID/IPC/UTS namespace (can't see or signal anything on the host), but network access IS available (npm install, curl, git clone, etc. all work). Always shown to the human for approval before running — if they deny it, nothing executes.",
  [DELEGATE_TOOL_NAME]:
    "Delegate a substantial, independent task to a full coding agent (claude, codex, or gemini) running in its own new terminal card on the board, in this chat's project root. Use this for real, multi-step engineering work, not small lookups. Asynchronous: you get back a card id, not the agent's output — you can't see what it does or wait for it inside this turn; check the board for the reply.",
} as const;

export const TOOL_PARAMETERS = {
  [READ_FILE_TOOL_NAME]: {
    type: "object",
    properties: { path: { type: "string", description: "File path, relative to the project root" } },
    required: ["path"],
  },
  [WRITE_FILE_TOOL_NAME]: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root" },
      content: { type: "string", description: "The FULL new content of the file (not a diff/patch)" },
    },
    required: ["path", "content"],
  },
  [BASH_TOOL_NAME]: {
    type: "object",
    properties: { command: { type: "string", description: "The shell command to run (bash -lc)" } },
    required: ["command"],
  },
  [DELEGATE_TOOL_NAME]: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["claude", "codex", "gemini"], description: "Which CLI agent to spawn" },
      reason: { type: "string", description: "Short description of the task being delegated, shown to the human" },
    },
    required: ["provider", "reason"],
  },
};

const MAX_TOOL_RESULT_CHARS = 20_000; // same cap browser-registry.ts's get_page_text already established

export type ToolResult = { ok: boolean; text: string };

export type WriteConsentRequest = { path: string; isNewFile: boolean; diffText: string; hunks: DiffHunk[] };
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

export type BashConsentRequest = { command: string };
export type DelegateProvider = "claude" | "codex" | "gemini";
export type DelegateResult = { ok: true; cardId: string } | { ok: false; error: string };

export async function runReadFile(root: string, path: string): Promise<ToolResult> {
  try {
    const res = await readFile(root, path);
    if ("tooLarge" in res) return { ok: false, text: `arquivo maior que ${MAX_FILE_BYTES / 1024}KB, não lido` };
    const truncated = res.content.length > MAX_TOOL_RESULT_CHARS;
    return { ok: true, text: truncated ? res.content.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…[truncado]" : res.content };
  } catch (err) {
    return { ok: false, text: `erro lendo ${path}: ${String(err)}` };
  }
}

/** Builds the diff (real content vs proposed content) that a human needs
 * to see BEFORE deciding — separate from actually writing, so the caller
 * can show this, await a decision, and only call `runWriteFile` after. */
export async function buildWriteConsent(root: string, path: string, newContent: string): Promise<WriteConsentRequest> {
  let oldContent = "";
  let isNewFile = false;
  try {
    const res = await readFile(root, path);
    if ("content" in res) oldContent = res.content;
  } catch {
    isNewFile = true;
  }
  const patch = structuredPatch(path, path, oldContent, newContent, "", "", { context: 3 });
  const diffText = patch.hunks.map((h) => h.lines.join("\n")).join("\n");
  return { path, isNewFile, diffText, hunks: patch.hunks };
}

export async function runWriteFile(root: string, path: string, content: string): Promise<ToolResult> {
  try {
    confine(root, path); // surfaces a path-escape attempt as a normal tool error, not a main-process crash
    await writeFile(root, path, content);
    return { ok: true, text: `escrito: ${path}` };
  } catch (err) {
    return { ok: false, text: `erro escrevendo ${path}: ${String(err)}` };
  }
}

/** What each provider client (anthropic-client.ts, openai-client.ts)
 * injects into `executeTool` below — cardId is already baked in by the
 * caller (each hook closes over it), so this stays provider- AND
 * card-agnostic. */
export type ChatToolHooks = {
  root: string;
  onToolStart: (name: string, input: unknown) => void;
  onToolResult: (name: string, ok: boolean, summary: string) => void;
  askWriteConsent: (req: WriteConsentRequest) => Promise<boolean>;
  askBashConsent: (req: BashConsentRequest) => Promise<boolean>;
  delegateToAgent: (provider: DelegateProvider, reason: string) => Promise<DelegateResult>;
};

const SUMMARY_MAX = 200;

/** The one real implementation both provider clients' tool loops call —
 * same reasoning as message-bus.ts's `handleRequest` serving both
 * acbridge and the MCP server: a capability written once, not twice. */
export async function executeTool(name: string, input: unknown, hooks: ChatToolHooks): Promise<ToolResult> {
  hooks.onToolStart(name, input);
  const args = (input ?? {}) as Record<string, unknown>;
  let result: ToolResult;

  if (name === READ_FILE_TOOL_NAME) {
    result = await runReadFile(hooks.root, String(args.path ?? ""));
  } else if (name === WRITE_FILE_TOOL_NAME) {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    const consentReq = await buildWriteConsent(hooks.root, path, content);
    const allowed = await hooks.askWriteConsent(consentReq);
    result = allowed ? await runWriteFile(hooks.root, path, content) : { ok: false, text: "o usuário negou esta escrita" };
  } else if (name === BASH_TOOL_NAME) {
    const command = String(args.command ?? "");
    if (!isSandboxAvailable()) {
      // No consent prompt at all here on purpose — there's nothing safe
      // for the human to approve without a sandbox, so asking would just
      // be theater. See sandbox.ts's doc comment.
      result = { ok: false, text: "sandbox indisponível (bubblewrap não encontrado neste sistema) — execução de comandos desabilitada" };
    } else {
      const allowed = await hooks.askBashConsent({ command });
      result = allowed ? await runSandboxedBash(hooks.root, command) : { ok: false, text: "o usuário negou a execução deste comando" };
    }
  } else if (name === DELEGATE_TOOL_NAME) {
    const provider: DelegateProvider = args.provider === "codex" ? "codex" : args.provider === "gemini" ? "gemini" : "claude";
    const reason = String(args.reason ?? "");
    const delegated = await hooks.delegateToAgent(provider, reason);
    result = delegated.ok
      ? { ok: true, text: `agente ${provider} criado (card ${delegated.cardId}), rodando de forma independente — acompanhe pelo board` }
      : { ok: false, text: `delegação não realizada: ${delegated.error}` };
  } else {
    result = { ok: false, text: `tool desconhecida: ${name}` };
  }

  const summary = result.text.length > SUMMARY_MAX ? result.text.slice(0, SUMMARY_MAX) + "…" : result.text;
  hooks.onToolResult(name, result.ok, summary);
  return result;
}
