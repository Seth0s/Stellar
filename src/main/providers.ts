import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ProviderId = "bash" | "claude" | "codex" | "cursor" | "gemini";

export type SpawnOpts = {
  resumeId?: string;
  continueLast?: boolean;
  model?: string;
  systemPrompt?: string;
  /** DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — how many agent-
   * initiated (not human-initiated) spawns led to this one. `undefined`/
   * `0` for every human-triggered spawn (rail, radial menu) — a fresh
   * chain always starts here. Threaded into the process env
   * (AGENT_CANVAS_SPAWN_DEPTH, see pty-registry.ts) so a NEW spawn
   * request from THIS agent reports the right depth, and enforced as a
   * hard cap in message-bus.ts (MAX_SPAWN_DEPTH) before any consent
   * modal even shows. */
  spawnDepth?: number;
  /** Internal only — never set by the renderer/IPC caller. Injected by
   * `pty-registry.ts::spawn()` from its own closed-over `mcpUrl` so
   * `buildArgs` below can register the MCP server per-provider without
   * every call site needing to know the port. */
  mcpUrl?: string;
};

// DESIGN-BACKLOG.md item 21, ponto 9 — the primary agent-facing interface
// is now the MCP server (mcp-server.ts) for providers that speak MCP;
// acbridge stays as the CLI fallback (see its own header comment). Kept
// short — MCP tool descriptions are self-documenting, this is just a
// nudge to look for them, not a manual.
const ACBRIDGE_HINT =
  "You're running inside agent-canvas, a board of cards. If an MCP server " +
  "named `stellar` is connected, prefer its tools (list/send/open/spawn/" +
  "snapshot/page-text — read each tool's own description). Otherwise a " +
  "CLI `acbridge` is on your PATH with the same capabilities (`acbridge` " +
  "with no args prints usage). Use these only when it genuinely helps the " +
  "task at hand.";

type ProviderDef = {
  id: ProviderId;
  label: string;
  binaryNames: string[];
  buildArgs: (opts: SpawnOpts) => string[];
};

export const PROVIDERS: ProviderDef[] = [
  { id: "bash", label: "Bash", binaryNames: [], buildArgs: () => [] },
  {
    id: "claude",
    label: "Claude",
    binaryNames: ["claude"],
    buildArgs: ({ resumeId, continueLast, model, systemPrompt, mcpUrl }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      // claude is the only provider with a system-prompt flag, so it's the
      // only one that gets a real (if best-effort) hint about acbridge —
      // codex/cursor have no equivalent hook and stay undocumented to the
      // agent itself via THIS mechanism (codex gets the MCP server
      // registered below instead, which is self-documenting).
      args.push("--append-system-prompt", systemPrompt || ACBRIDGE_HINT);
      // Ephemeral registration (DESIGN-BACKLOG.md item 21, ponto 9) — a
      // spawn-scoped `--mcp-config` flag, not a written .mcp.json. Never
      // touches the project's own MCP config, never persists past this
      // one process. `--strict-mcp-config` is deliberately NOT set here —
      // this should ADD to whatever the user's own project already
      // configures, not replace it.
      if (mcpUrl) {
        args.push("--mcp-config", JSON.stringify({ mcpServers: { stellar: { type: "http", url: mcpUrl } } }));
      }
      return args;
    },
  },
  {
    id: "codex",
    label: "Codex",
    binaryNames: ["codex"],
    // Codex's resume is a subcommand, must come before any other flag.
    // No documented system-prompt flag — gets the MCP server registered
    // instead (codex supports an ephemeral `-c key=value` TOML override,
    // scoped to this one invocation, same non-persisting spirit as
    // claude's --mcp-config above).
    buildArgs: ({ resumeId, continueLast, model, mcpUrl }) => {
      const args: string[] = [];
      if (resumeId) args.push("resume", resumeId);
      else if (continueLast) args.push("resume", "--last");
      if (model) args.push("-m", model);
      if (mcpUrl) args.push("-c", `mcp_servers.stellar.url=${mcpUrl}`);
      return args;
    },
  },
  // `cursor` on PATH is usually the IDE launcher; the agent CLI is cursor-agent.
  {
    id: "cursor",
    label: "Cursor",
    binaryNames: ["cursor-agent"],
    // No documented system-prompt flag, AND (unlike claude/codex above)
    // no ephemeral per-invocation MCP registration flag either — Cursor
    // CLI only discovers MCP servers from a written .cursor/mcp.json
    // (project or global), auto-loaded by file-path precedence. Writing
    // into a project's own .cursor/mcp.json on every spawn was
    // deliberately NOT done here — that's a real file-system side effect
    // in the user's repo, not something to do silently on every terminal
    // spawn. Left undocumented to the agent itself, same as before; a
    // human can still register `stellar` manually in .cursor/mcp.json if
    // they want cursor-agent cards to have it.
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      return args;
    },
  },
  // DESIGN-BACKLOG.md item 28 — flags verified against the real upstream
  // docs (google-gemini/gemini-cli), not guessed: `gemini` wasn't
  // installed on this machine to test live against, so `--resume`/`-r`
  // (accepts "latest", an index, or a full session UUID) and `--model`/
  // `-m` are confirmed from docs/cli/cli-reference.md rather than
  // reverse-engineered like the other three providers' session-discovery
  // in session-watch.ts.
  {
    id: "gemini",
    label: "Gemini",
    binaryNames: ["gemini"],
    // No documented system-prompt flag, AND (like cursor-agent above) no
    // ephemeral per-invocation MCP registration flag — confirmed against
    // docs/tools/mcp-server.md: the only mechanisms are `gemini mcp add`
    // and hand-editing `~/.gemini/settings.json`, both persistent, not
    // scoped to one spawn. Same deliberate non-choice as cursor: don't
    // silently write into the user's own Gemini config on every terminal
    // spawn. A human can still register `stellar` manually if they want
    // gemini cards to have it.
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--resume", "latest");
      if (model) args.push("--model", model);
      return args;
    },
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function which(names: string[]): string | null {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolves the binary + args to spawn for a provider. `bash` always resolves via $SHELL. */
export function resolveSpawn(providerId: string, opts: SpawnOpts = {}): { binary: string; args: string[] } | null {
  const provider = providerById(providerId);
  if (!provider) return null;
  if (provider.id === "bash") {
    return { binary: process.env.SHELL || "/bin/bash", args: [] };
  }
  const binary = which(provider.binaryNames);
  if (!binary) return null;
  return { binary, args: provider.buildArgs(opts) };
}
