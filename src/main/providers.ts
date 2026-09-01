import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ProviderId = "bash" | "claude" | "codex" | "cursor" | "antigravity";

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
  "snapshot/page-text/read_card/card_status/report/read_report — read " +
  "each tool's own description). Otherwise a CLI `acbridge` is on your " +
  "PATH with the same capabilities (`acbridge` with no args prints " +
  "usage). If another card spawned you to do a task, call `report` (or " +
  "`acbridge report '<json>'`) with a structured result when you finish " +
  "it, even if you keep running afterward. Use these only when it " +
  "genuinely helps the task at hand.";

type ProviderDef = {
  id: ProviderId;
  label: string;
  binaryNames: string[];
  buildArgs: (opts: SpawnOpts) => string[];
  /** DESIGN-BACKLOG.md item 57 ponto 13 — real, current install command
   * per provider (confirmed live against each provider's own docs/npm
   * package on 2026-08-29, not guessed): `binary_not_found` surfaces this
   * to the renderer so it can offer a pre-filled (never auto-run)
   * terminal. `null` for `bash` — always resolves via $SHELL, never
   * "not installed". */
  installCommand: string | null;
};

export const PROVIDERS: ProviderDef[] = [
  { id: "bash", label: "Bash", binaryNames: [], buildArgs: () => [], installCommand: null },
  {
    id: "claude",
    label: "Claude",
    binaryNames: ["claude"],
    installCommand: "npm install -g @anthropic-ai/claude-code",
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
    installCommand: "npm install -g @openai/codex",
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
  // `cursor` on PATH is usually the IDE launcher; the agent CLI is a
  // separate binary. DESIGN-BACKLOG.md item 57 ponto 13 — confirmed live
  // against cursor.com/docs/cli/installation (2026-08-29) that the
  // installed binary is now named `agent`, not `cursor-agent` — Cursor
  // renamed it at some point after this list was first written ("older
  // articles still use the longer name," per their own docs). Tries the
  // current name first, falls back to the legacy one for an install that
  // predates the rename — same `which()` semantics as every other
  // multi-name lookup already in this file.
  {
    id: "cursor",
    label: "Cursor",
    binaryNames: ["agent", "cursor-agent"],
    installCommand: "curl https://cursor.com/install -fsS | bash",
    // Sem flag de system-prompt e, ao contrário de claude/codex acima,
    // sem flag efêmera de registro de MCP: a CLI do Cursor só descobre
    // servidor MCP por `.cursor/mcp.json` escrito em disco (do projeto ou
    // global). Escrever no `.cursor/mcp.json` DO PROJETO a cada spawn
    // continua fora de cogitação — é efeito colateral no repositório do
    // usuário. O que mudou (2026-09-01, a pedido): o registro passou a
    // acontecer uma vez só, no config GLOBAL do usuário e apontando pro
    // shim stdio, em `mcp-registration.ts` — fora do `buildArgs`, que é
    // por invocação. Por isso não há nada de MCP nos args aqui.
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      return args;
    },
  },
  // Pedido ao vivo (2026-08-31) — usuário pediu pra trocar o provider
  // "gemini" por "antigravity": achado ao vivo pesquisando (`gemini`
  // deixou de resolver como CLI própria — a Google aposentou o Gemini
  // CLI e o substituiu pelo Antigravity CLI, um agente de terminal
  // escrito em Go que compartilha motor com o app desktop Antigravity
  // 2.0). Flags confirmadas via busca na documentação real (não
  // adivinhadas): binário `agy`, `--conversation <id>` retoma uma
  // conversa específica por id, `--continue`/`-c` retoma a mais
  // recente, `--model` seleciona o modelo. Sem flag efêmera de
  // registro de MCP por-invocação — confirmado que a única forma é
  // `agy mcp add` (persistente, arquivo `~/.gemini/config/
  // mcp_config.json` ou `.agents/mcp_config.json` por workspace) —
  // Como no cursor logo acima, isso deixou de ser uma não-escolha
  // (2026-09-01, a pedido): `mcp-registration.ts` roda `agy mcp add` uma
  // vez, preguiçosamente, no primeiro spawn de um card antigravity, e
  // aponta pro shim stdio — nunca por spawn, nunca no repositório do
  // usuário. Nada de MCP nos args daqui, que são por invocação.
  {
    id: "antigravity",
    label: "Antigravity",
    binaryNames: ["agy"],
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--conversation", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      return args;
    },
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providerInstallCommand(id: string): string | null {
  return providerById(id)?.installCommand ?? null;
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
