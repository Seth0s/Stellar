import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ProviderUsageStats =
  | {
      provider: string;
      supported: true;
      source: "cli-stats" | "local-cache";
      costUSD?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      totalMessages?: number;
      totalSessions?: number;
      extraInfo?: string;
    }
  | {
      provider: string;
      supported: false;
      reason: string;
      dashboardUrl?: string;
    };

export const PROVIDER_DASHBOARDS: Record<string, string> = {
  claude: "https://console.anthropic.com/settings/plans",
  codex: "https://platform.openai.com/usage",
  cursor: "https://cursor.com/settings",
  antigravity: "https://aistudio.google.com/",
  opencode: "https://opencode.ai/",
  cline: "https://openrouter.ai/activity",
  commandcode: "https://commandcode.ai/",
};

export async function readClaudeStats(homeDir = homedir()): Promise<ProviderUsageStats> {
  const statsPath = join(homeDir, ".claude", "stats-cache.json");
  try {
    const raw = await readFile(statsPath, "utf-8");
    const json = JSON.parse(raw);
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCostUSD = 0;

    if (json.modelUsage && typeof json.modelUsage === "object") {
      for (const modelData of Object.values(json.modelUsage) as Record<string, number>[]) {
        totalInput += modelData.inputTokens || 0;
        totalOutput += modelData.outputTokens || 0;
        totalCacheRead += modelData.cacheReadInputTokens || 0;
        totalCostUSD += modelData.costUSD || 0;
      }
    }

    return {
      provider: "claude",
      supported: true,
      source: "local-cache",
      costUSD: totalCostUSD > 0 ? totalCostUSD : undefined,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      totalMessages: json.totalMessages,
      totalSessions: json.totalSessions,
      extraInfo: "Lido de ~/.claude/stats-cache.json (histórico acumulado local)",
    };
  } catch {
    return {
      provider: "claude",
      supported: false,
      reason: "Arquivo ~/.claude/stats-cache.json não encontrado ou inválido",
      dashboardUrl: PROVIDER_DASHBOARDS.claude,
    };
  }
}

export function parseOpencodeStatsOutput(stdout: string): {
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  sessions?: number;
  messages?: number;
} {
  const out: {
    costUSD?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    sessions?: number;
    messages?: number;
  } = {};

  const parseTokenCount = (str: string): number => {
    const s = str.trim().toUpperCase();
    if (s.endsWith("M")) return Math.round(parseFloat(s.slice(0, -1)) * 1_000_000);
    if (s.endsWith("K")) return Math.round(parseFloat(s.slice(0, -1)) * 1_000);
    return Math.round(parseFloat(s)) || 0;
  };

  for (const line of stdout.split("\n")) {
    const clean = line.replace(/[│┌┐└┘├┤─]/g, "").trim();
    if (!clean) continue;

    if (clean.startsWith("Total Cost")) {
      const match = clean.match(/\$([0-9.]+)/);
      if (match) out.costUSD = parseFloat(match[1]);
    } else if (clean.startsWith("Input")) {
      const parts = clean.split(/\s+/);
      if (parts.length >= 2) out.inputTokens = parseTokenCount(parts[1]);
    } else if (clean.startsWith("Output")) {
      const parts = clean.split(/\s+/);
      if (parts.length >= 2) out.outputTokens = parseTokenCount(parts[1]);
    } else if (clean.startsWith("Cache Read")) {
      const parts = clean.split(/\s+/);
      if (parts.length >= 3) out.cacheReadTokens = parseTokenCount(parts[2]);
    } else if (clean.startsWith("Sessions")) {
      const parts = clean.split(/\s+/);
      if (parts.length >= 2) out.sessions = parseInt(parts[1].replace(/,/g, ""), 10);
    } else if (clean.startsWith("Messages")) {
      const parts = clean.split(/\s+/);
      if (parts.length >= 2) out.messages = parseInt(parts[1].replace(/,/g, ""), 10);
    }
  }

  return out;
}

export async function readOpencodeStats(): Promise<ProviderUsageStats> {
  try {
    const { stdout } = await execFileP("opencode", ["stats"], { timeout: 3000 });
    const parsed = parseOpencodeStatsOutput(stdout);
    return {
      provider: "opencode",
      supported: true,
      source: "cli-stats",
      costUSD: parsed.costUSD,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cacheReadTokens: parsed.cacheReadTokens,
      totalSessions: parsed.sessions,
      totalMessages: parsed.messages,
      extraInfo: "Obtido diretamente via comando `opencode stats`",
    };
  } catch {
    return {
      provider: "opencode",
      supported: false,
      reason: "Falha ao executar `opencode stats` ou binário indisponível",
      dashboardUrl: PROVIDER_DASHBOARDS.opencode,
    };
  }
}

export async function getProviderUsage(providerId: string): Promise<ProviderUsageStats> {
  const norm = providerId.trim().toLowerCase();

  if (norm === "bash") {
    return {
      provider: "bash",
      supported: false,
      reason: "Shell local (conceito de cota e tokens de IA não se aplica)",
    };
  }

  if (norm === "opencode") {
    return readOpencodeStats();
  }

  if (norm === "claude") {
    return readClaudeStats();
  }

  // Providers sem API CLI de uso desacoplada
  const reasons: Record<string, string> = {
    codex: "Codex CLI não expõe endpoint ou comando CLI para consulta de cota/tokens restantes.",
    cursor: "Cursor é um aplicativo de desktop Electron sem interface CLI para consulta de fast requests/cota.",
    antigravity: "Antigravity CLI (agy) opera sob cotas da API Gemini sem comando desacoplado de telemetria.",
    cline: "Cline atua como agente BYOK/OpenRouter sem cota unificada no CLI.",
    commandcode: "Command Code possui apenas slash command interativo (/usage) na TUI.",
  };

  return {
    provider: norm,
    supported: false,
    reason: reasons[norm] || `Provider "${providerId}" não expõe comando ou arquivo de uso de cota.`,
    dashboardUrl: PROVIDER_DASHBOARDS[norm],
  };
}
