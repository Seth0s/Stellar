import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ProviderId = "bash" | "claude" | "codex" | "cursor" | "antigravity" | "opencode";

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
  /** Sticky item "spawn_agent effort" (2026-09-03) — Antigravity's CLI
   * requires `--effort <low|high>` alongside certain models (`--model
   * gemini-3.1-pro` on its own falls back silently to a different model
   * with a warning, never actually running the one asked for). `model`
   * stays a plain string on purpose (every other provider only ever takes
   * one) — this is additive and provider-specific, `undefined` for every
   * provider whose `buildArgs` doesn't read it. */
  effort?: "low" | "high";
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
  "close_card/snapshot/page-text/read_card/card_status/report/read_report — read " +
  "each tool's own description). Otherwise a CLI `acbridge` is on your " +
  "PATH with the same capabilities (`acbridge` with no args prints " +
  "usage). If another card spawned you to do a task, call `report` (or " +
  "`acbridge report '<json>'`) with a structured result when you finish " +
  "it, even if you keep running afterward. Use these only when it " +
  "genuinely helps the task at hand.";

/** Um comando por família de SO — `npm install -g` já é igual nas duas,
 * mas os installers via `curl | bash` (cursor/antigravity) não existem no
 * Windows (achado ao vivo, 2026-09-03: "no Windows não tem bash"), que
 * tem seu próprio instalador PowerShell nativo em cada um desses
 * provedores (confirmado contra a documentação real de cada um). */
type InstallCommand = { posix: string; windows: string };

type ProviderDef = {
  id: ProviderId;
  label: string;
  binaryNames: string[];
  buildArgs: (opts: SpawnOpts) => string[];
  /** DESIGN-BACKLOG.md item 57 ponto 13 — real, current install command
   * per provider (confirmed live against each provider's own docs/npm
   * package, `windows` variant confirmed 2026-09-03): `binary_not_found`
   * surfaces this to the renderer so it can offer a pre-filled (never
   * auto-run) terminal. `null` for `bash` — always resolves via $SHELL/
   * ComSpec, never "not installed". */
  installCommand: InstallCommand | null;
};

export const PROVIDERS: ProviderDef[] = [
  { id: "bash", label: "Bash", binaryNames: [], buildArgs: () => [], installCommand: null },
  {
    id: "claude",
    label: "Claude",
    binaryNames: ["claude"],
    installCommand: { posix: "npm install -g @anthropic-ai/claude-code", windows: "npm install -g @anthropic-ai/claude-code" },
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
      // Prototipo (2026-09-06) — "unificar detecção de turno" pedido pelo
      // usuário: `isActive` (useTerminal.ts) hoje é só uma aproximação por
      // silêncio de bytes (900ms sem nada = "parou"), documentada como tal
      // no próprio código — faz a barra de atividade sumir mesmo com o
      // agente genuinamente ainda trabalhando (pensando, chamando
      // ferramenta), sem nenhum marcador real de fim de turno. `claude`
      // suporta hooks de verdade — `--settings` (confirmado ao vivo,
      // aceita um JSON string direto, não só path de arquivo) registra um
      // hook `Stop` EFÊMERO, aditivo igual o `--mcp-config` acima (nunca
      // toca `~/.claude/settings.json` nem o `.claude/settings.json` do
      // projeto — sem `--strict-mcp-config` equivalente aqui porque
      // `--settings` já é descrito como "additional settings", soma em
      // vez de substituir). O comando do hook é só `acbridge
      // turn-complete`, sem argumento nenhum — `acbridge` já lê seu
      // próprio `AGENT_CANVAS_CARD_ID` do ambiente (pty-registry.ts's
      // `spawn()` injeta isso em todo processo spawnado), mesmo auto-fill
      // que `report`/`send` já usam. Sinal REAL de fim de turno, não mais
      // heurística — `useTerminal.ts` usa isto pra decidir quando
      // `isActive` vira false, só pra este provider.
      args.push(
        "--settings",
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "acbridge turn-complete" }] }] } }),
      );
      return args;
    },
  },
  {
    id: "codex",
    label: "Codex",
    binaryNames: ["codex"],
    installCommand: { posix: "npm install -g @openai/codex", windows: "npm install -g @openai/codex" },
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
    // Windows confirmado contra cursor.com/docs/cli/installation
    // (2026-09-03) — instalador PowerShell nativo, mesmo endpoint com
    // um query param a mais, sem WSL.
    installCommand: {
      posix: "curl https://cursor.com/install -fsS | bash",
      windows: "irm 'https://cursor.com/install?win32=true' | iex",
    },
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
    // Windows confirmado contra a documentação real do Antigravity CLI
    // (2026-09-03) — instalador PowerShell nativo, sem WSL (há também uma
    // variante `.cmd` pro prompt puro, mas o PowerShell já cobre o caso
    // padrão sem precisar de um segundo comando por SO).
    installCommand: {
      posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      windows: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    buildArgs: ({ resumeId, continueLast, model, effort }) => {
      const args: string[] = [];
      if (resumeId) args.push("--conversation", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      return args;
    },
  },
  // Pedido ao vivo (2026-09-04) — worker local (Qwen via llama-server,
  // ver ai memory `qwen-buun-local-server`) precisava de um agente de
  // terminal de verdade (tool-calling real) em vez de só chat cru; em
  // vez de construir um harness próprio, reusa o `opencode` (sst/opencode)
  // já instalado, que já fala com qualquer endpoint OpenAI-compatible via
  // `provider` custom em `~/.config/opencode/opencode.json`. Sem flag
  // efêmera de registro de MCP (confirmado no `--help` real: só
  // `opencode mcp` persistente) — mesma categoria de cursor/antigravity
  // acima, registro fica em `mcp-registration.ts`.
  {
    id: "opencode",
    label: "OpenCode",
    binaryNames: ["opencode"],
    installCommand: { posix: "npm install -g opencode-ai", windows: "npm install -g opencode-ai" },
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--session", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      return args;
    },
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Achado ao vivo, 2026-09-03 — "no Windows não tem bash": não existe
 * jeito de sugerir `installCommand.posix` numa máquina sem bash/curl. */
export function providerInstallCommand(id: string, platform: NodeJS.Platform = process.platform): string | null {
  const cmd = providerById(id)?.installCommand;
  if (!cmd) return null;
  return platform === "win32" ? cmd.windows : cmd.posix;
}

// Extensões que o Windows tenta, em ordem, quando um nome sem extensão é
// "executado" — mesma lista que o próprio shell do Windows usa (variável
// `PATHEXT`, com um fallback caso ela não exista por algum motivo). Sem
// isso, `which(["claude"])` nunca acharia o shim real que `npm install -g`
// cria lá (`claude.cmd`/`claude.ps1`, nunca um `claude` sem extensão) —
// achado ao vivo, 2026-09-03, junto com o problema do bash acima: a
// detecção de binário em si já não dependia de shell nenhum (sempre foi
// busca de arquivo pura em `process.env.PATH`), só faltava tentar as
// extensões certas por SO.
const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.PS1")
  .split(";")
  .filter(Boolean);

export function which(names: string[], platform: NodeJS.Platform = process.platform): string | null {
  const path = process.env.PATH ?? "";
  const candidateNames =
    platform === "win32" ? names.flatMap((name) => [name, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => name + ext)]) : names;
  for (const dir of path.split(delimiter)) {
    for (const name of candidateNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolves the binary + args to spawn for a provider. `bash` always
 * resolves via $SHELL no POSIX; no Windows não existe `$SHELL`
 * (variável de ambiente é uma convenção só de shells Unix) nem `/bin/
 * bash` — resolve via `ComSpec` (sempre presente, aponta pro `cmd.exe`
 * real), mesma convenção que o próprio Windows/outras ferramentas
 * (ex. VS Code) usam como shell padrão quando nada mais foi escolhido. */
export function resolveSpawn(providerId: string, opts: SpawnOpts = {}): { binary: string; args: string[] } | null {
  const provider = providerById(providerId);
  if (!provider) return null;
  if (provider.id === "bash") {
    if (process.platform === "win32") {
      return { binary: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", args: [] };
    }
    return { binary: process.env.SHELL || "/bin/bash", args: [] };
  }
  const binary = which(provider.binaryNames);
  if (!binary) return null;
  return { binary, args: provider.buildArgs(opts) };
}

export type AgentAvailability = { id: ProviderId; label: string; installed: boolean; installCommand: string | null };

/** Checagem proativa (DESIGN-BACKLOG.md — "aviso antes mesmo de abrir um
 * agente", pedido ao vivo 2026-09-03): roda uma vez, fora do fluxo de
 * spawn de qualquer card, pro Topbar mostrar de cara quais CLIs de agente
 * faltam instalar. `bash` fica de fora — não é uma CLI de agente
 * instalável, é sempre o shell do próprio SO (ver resolveSpawn acima). */
export function checkAgentAvailability(): AgentAvailability[] {
  return PROVIDERS.filter((p) => p.id !== "bash").map((p) => ({
    id: p.id,
    label: p.label,
    installed: which(p.binaryNames) !== null,
    installCommand: providerInstallCommand(p.id),
  }));
}
