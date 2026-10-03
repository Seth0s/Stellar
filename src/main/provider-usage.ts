import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Um segmento de cota com percentual MEDIDO (numerador E denominador). É a
 * ÚNICA coisa que autoriza uma barra preenchida: um custo acumulado solto
 * NÃO gera percentual — quem não tem os dois lados mostra "não disponível",
 * nunca 0%. O `key` nomeia a JANELA ("session" 5h, "week" 7d, "credits").
 */
export type UsageSegment = {
  key: string;
  /** 0..100, medido na fonte. */
  percent: number;
  resetsAtMs?: number;
};

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
      /**
       * Segmentos de cota com percentual. Ausente/vazio = NÃO HÁ BARRA (a UI
       * mostra "não disponível"), que é diferente de um percentual 0 medido.
       */
      segments?: UsageSegment[];
      /**
       * Quando a FONTE capturou o dado — não quando esta leitura rodou. Vem do
       * próprio arquivo quando ele declara (ex.: `lastComputedDate` do claude);
       * `undefined` quando a fonte não carimba data (aí a idade não é exposta).
       */
      capturedAtMs?: number;
    }
  | {
      provider: string;
      supported: false;
      reason: string;
      dashboardUrl?: string;
      /**
       * A fonte existe, mas é CARA (spawn) e não roda sozinha: a UI oferece um
       * gesto explícito ("Medir agora") em vez de pagar o custo na abertura.
       */
      onDemand?: boolean;
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

/**
 * `opencode stats` custa um PROCESSO INTEIRO por chamada — MEDIDO 2026-10-03
 * nesta máquina: 5,28 s / 10,23 s / 13,63 s e 443.748 / 434.192 / 443.748 kB de
 * RSS. É exatamente o custo que a task manda não pagar em poll (o relay MCP
 * virou default-on hoje justamente por −70 MB/card). Por isso a fonte é SOB
 * DEMANDA: `getProviderUsage("opencode")` NÃO spawna por padrão; só com
 * `{ allowSpawn: true }`, que a UI expõe num botão explícito.
 */
export const OPENCODE_STATS_TIMEOUT_MS = 20_000;

const OPENCODE_ON_DEMAND_REASON =
  "`opencode stats` é fonte SOB DEMANDA: medido 5,3–13,6 s e ~440 MB RSS por chamada " +
  "(2026-10-03) — custo alto demais para poll. Use \"Medir agora\".";

/**
 * Cache com TTL por provider. Serve dois propósitos medidos: (1) a página de
 * providers monta e desmonta, e sem cache cada visita releria o arquivo do
 * claude; (2) impede que qualquer chamador vire um poll de fato — a leitura
 * viva acontece no máximo uma vez por TTL. O TTL é POLÍTICA DE EXIBIÇÃO
 * declarada (não medição): a idade exata do dado é sempre mostrada ao lado.
 */
export const USAGE_CACHE_TTL_MS = 60 * 1000;

type CacheEntry = { atMs: number; stats: ProviderUsageStats };
const cache = new Map<string, CacheEntry>();

/** Só para testes: o cache é módulo-global e sobreviveria a um caso. */
export function resetProviderUsageCache(): void {
  cache.clear();
}

function readCache(key: string, nowMs: number): ProviderUsageStats | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (nowMs - hit.atMs > USAGE_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.stats;
}

/** `lastComputedDate` ("2026-09-30") do próprio arquivo → epoch ms, ou `undefined`. */
function parseCapturedAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

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
      // O arquivo carimba a PRÓPRIA data de cálculo; é ela (não o mtime) que diz
      // de quando o dado é.
      capturedAtMs: parseCapturedAt(json.lastComputedDate),
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

/**
 * Spawna `opencode stats` UMA vez. O timeout agora é o MEDIDO (20 s) — o valor
 * antigo (3 s) ficava abaixo do custo real e transformava todo call num
 * `catch` que devolvia "não suportado", escondendo que a fonte simplesmente é
 * lenta. Chamadores que não querem pagar o spawn usam o gate por padrão de
 * `getProviderUsage`; esta função é o "sim, spawna".
 */
export async function readOpencodeStats(): Promise<ProviderUsageStats> {
  try {
    const { stdout } = await execFileP("opencode", ["stats"], { timeout: OPENCODE_STATS_TIMEOUT_MS });
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
  } catch (err) {
    // Não engolir a causa: o motivo nomeia o que falhou (timeout/exit), em vez
    // de afirmar que o provider "não suporta" — que era uma meia-verdade.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      provider: "opencode",
      supported: false,
      reason: `\`opencode stats\` não respondeu em ${OPENCODE_STATS_TIMEOUT_MS} ms ou falhou: ${detail}`,
      dashboardUrl: PROVIDER_DASHBOARDS.opencode,
    };
  }
}

export type ProviderUsageOptions = {
  /**
   * Autoriza fontes que SPAWNAM um processo. `false` (padrão) mantém o custo
   * fora do caminho de abertura da tela; a UI liga isto num gesto explícito.
   */
  allowSpawn?: boolean;
  /** Injetável para teste; defaults para `Date.now()`. */
  nowMs?: number;
};

/**
 * Leitura por provider. Ordem de preferência da task: arquivo/cache (barato)
 * → HTTP → sessão já viva; spawn é a ÚLTIMA e só sob pedido. Nenhum provider
 * entrega percentual de cota por arquivo/CLI hoje (medido 2026-10-03): o do
 * claude vive no JSON que a CLI passa por stdin ao statusLine, fora do disco —
 * por isso o invariante "sem número ⇒ não disponível" é o caminho comum.
 */
export async function getProviderUsage(
  providerId: string,
  opts: ProviderUsageOptions = {},
): Promise<ProviderUsageStats> {
  const norm = providerId.trim().toLowerCase();
  const nowMs = opts.nowMs ?? Date.now();

  const cached = readCache(norm, nowMs);
  if (cached) return cached;

  let result: ProviderUsageStats;

  if (norm === "bash") {
    result = {
      provider: "bash",
      supported: false,
      reason: "Shell local (conceito de cota e tokens de IA não se aplica)",
    };
  } else if (norm === "opencode") {
    result = opts.allowSpawn
      ? await readOpencodeStats()
      : {
          provider: "opencode",
          supported: false,
          reason: OPENCODE_ON_DEMAND_REASON,
          dashboardUrl: PROVIDER_DASHBOARDS.opencode,
          onDemand: true,
        };
  } else if (norm === "claude") {
    result = await readClaudeStats();
  } else {
    // Providers sem API CLI de uso desacoplada.
    const reasons: Record<string, string> = {
      codex: "Codex CLI não expõe endpoint ou comando CLI para consulta de cota/tokens restantes.",
      cursor: "Cursor é um aplicativo de desktop Electron sem interface CLI para consulta de fast requests/cota.",
      antigravity: "Antigravity CLI (agy) opera sob cotas da API Gemini sem comando desacoplado de telemetria.",
      cline: "Cline atua como agente BYOK/OpenRouter sem cota unificada no CLI.",
      commandcode: "Command Code possui apenas slash command interativo (/usage) na TUI.",
    };
    result = {
      provider: norm,
      supported: false,
      reason: reasons[norm] || `Provider "${providerId}" não expõe comando ou arquivo de uso de cota.`,
      dashboardUrl: PROVIDER_DASHBOARDS[norm],
    };
  }

  cache.set(norm, { atMs: nowMs, stats: result });
  return result;
}
