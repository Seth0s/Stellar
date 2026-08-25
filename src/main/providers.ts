import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ProviderId = "bash" | "claude" | "codex" | "cursor";

export type SpawnOpts = {
  resumeId?: string;
  continueLast?: boolean;
  model?: string;
  systemPrompt?: string;
};

const ACBRIDGE_HINT =
  "You're running inside agent-canvas, a board of cards. A CLI tool " +
  "`acbridge` is on your PATH: `acbridge list` shows other open terminal " +
  "cards, `acbridge send <cardId> <message>` types a message into one of " +
  "them, `acbridge open <url>` asks the human to open a URL in an embedded " +
  "browser card. Use these only when it genuinely helps the task at hand.";

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
    buildArgs: ({ resumeId, continueLast, model, systemPrompt }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--continue");
      if (model) args.push("--model", model);
      // claude is the only provider with a system-prompt flag, so it's the
      // only one that gets a real (if best-effort) hint about acbridge —
      // codex/cursor have no equivalent hook and stay undocumented to the
      // agent itself.
      args.push("--append-system-prompt", systemPrompt || ACBRIDGE_HINT);
      return args;
    },
  },
  {
    id: "codex",
    label: "Codex",
    binaryNames: ["codex"],
    // Codex's resume is a subcommand, must come before any other flag.
    // No documented system-prompt flag.
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("resume", resumeId);
      else if (continueLast) args.push("resume", "--last");
      if (model) args.push("-m", model);
      return args;
    },
  },
  // `cursor` on PATH is usually the IDE launcher; the agent CLI is cursor-agent.
  {
    id: "cursor",
    label: "Cursor",
    binaryNames: ["cursor-agent"],
    // No documented system-prompt flag.
    buildArgs: ({ resumeId, continueLast, model }) => {
      const args: string[] = [];
      if (resumeId) args.push("--resume", resumeId);
      else if (continueLast) args.push("--continue");
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
