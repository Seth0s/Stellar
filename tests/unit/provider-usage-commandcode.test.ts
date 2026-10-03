import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProviderUsage,
  parseCommandcodeCredits,
  readCommandcodeCredits,
  resetProviderUsageCache,
  type ProviderUsageStats,
} from "../../src/main/provider-usage";

/**
 * A fonte de PERCENTUAL de cota (task 36034ff2). O `commandcode` expõe
 * `/alpha/billing/credits` — o ÚNICO percentual real obtível hoje (medido
 * 2026-10-03: HTTP 200, ~0,48 s, 386 B). O teste NUNCA toca rede nem o auth do
 * usuário: o `fetch` e o caminho do auth são injetados.
 */

/** Resposta REAL medida em 2026-10-03 (números do dono), shape fiel. */
const REAL_RESPONSE = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 29.9181547735,
    purchasedCredits: 0.099821188,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 5.07253355, cap: 14, exceeded: false, resetAt: 1791044439985 },
    weekly: { used: 5.07253355, cap: 35, exceeded: false, resetAt: 1791631239985 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
};

const tempDirs: string[] = [];

async function authFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-auth-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

function fakeFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown> }): typeof fetch {
  return vi.fn(async () => ({ ...response, json: response.json ?? (async () => ({})) })) as unknown as typeof fetch;
}

beforeEach(() => resetProviderUsageCache());
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("parseCommandcodeCredits — puro", () => {
  it("mapeia as DUAS janelas em PERCENTUAIS medidos, com o reset", () => {
    const parsed = parseCommandcodeCredits(REAL_RESPONSE);
    expect(parsed).not.toBeNull();
    expect(parsed!.segments).toEqual([
      { key: "session", percent: 36.2, resetsAtMs: 1791044439985 },
      { key: "week", percent: 14.5, resetsAtMs: 1791631239985 },
    ]);
  });

  it("sem `windowLimits` é AUSÊNCIA (null), nunca 0%", () => {
    expect(parseCommandcodeCredits({ credits: { monthlyCredits: 1 } })).toBeNull();
    expect(parseCommandcodeCredits(null)).toBeNull();
    expect(parseCommandcodeCredits("nope")).toBeNull();
  });

  it("`cap` ausente ou zero NÃO vira percentual (não há denominador)", () => {
    expect(parseCommandcodeCredits({ windowLimits: { fiveHour: { used: 5, cap: 0 } } })).toBeNull();
    expect(parseCommandcodeCredits({ windowLimits: { fiveHour: { used: 5 } } })).toBeNull();
    expect(parseCommandcodeCredits({ windowLimits: { fiveHour: { used: "x", cap: 14 } } })).toBeNull();
  });

  it("uma janela válida basta; a inválida é omitida sem contaminar a outra", () => {
    const parsed = parseCommandcodeCredits({
      windowLimits: { fiveHour: { used: 7, cap: 14 }, weekly: { used: 1, cap: 0 } },
    });
    expect(parsed!.segments).toEqual([{ key: "session", percent: 50 }]);
    // Sem `resetAt` numérico o segmento vai sem ele — não inventa data.
    expect(parsed!.segments[0].resetsAtMs).toBeUndefined();
  });
});

describe("readCommandcodeCredits — HTTP com auth injetado", () => {
  it("200 com a resposta real ⇒ supported/http/segmentos", async () => {
    const path = await authFile({ apiKey: "k_test", userId: "u" });
    const res = await readCommandcodeCredits({
      authPath: path,
      fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => REAL_RESPONSE }),
    });
    expect(res.supported).toBe(true);
    if (!res.supported) return;
    expect(res.source).toBe("http");
    expect(res.segments?.map((s) => [s.key, s.percent])).toEqual([
      ["session", 36.2],
      ["week", 14.5],
    ]);
    expect(res.capturedAtMs).toBeGreaterThan(0);
  });

  it("auth ausente ⇒ unavailable com motivo que NOMEIA a causa", async () => {
    const res = await readCommandcodeCredits({
      authPath: "/no/such/auth.json",
      fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => REAL_RESPONSE }),
    });
    expect(res.supported).toBe(false);
    if (res.supported) return;
    expect(res.reason).toContain("indisponível");
    expect(res.dashboardUrl).toBeTruthy();
  });

  it("HTTP 401 ⇒ motivo diz HTTP 401 (o catch não finge 'sem suporte')", async () => {
    const path = await authFile({ apiKey: "k_test" });
    const res = await readCommandcodeCredits({
      authPath: path,
      fetchImpl: fakeFetch({ ok: false, status: 401 }),
    });
    expect(res.supported).toBe(false);
    if (res.supported) return;
    expect(res.reason).toContain("HTTP 401");
  });

  it("falha de rede ⇒ unavailable, nunca um percentual fabricado", async () => {
    const path = await authFile({ apiKey: "k_test" });
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await readCommandcodeCredits({ authPath: path, fetchImpl: boom });
    expect(res.supported).toBe(false);
  });
});

describe("getProviderUsage('commandcode') — integração com injeção", () => {
  it("devolve o percentual e RESPEITA o cache de TTL (sem segundo fetch)", async () => {
    const path = await authFile({ apiKey: "k_test" });
    const doFetch = fakeFetch({ ok: true, status: 200, json: async () => REAL_RESPONSE });
    const first = await getProviderUsage("commandcode", { commandcodeAuthPath: path, fetchImpl: doFetch });
    const second = await getProviderUsage("commandcode", { commandcodeAuthPath: path, fetchImpl: doFetch });
    expect(first.supported).toBe(true);
    expect(second).toEqual(first);
    expect(doFetch).toHaveBeenCalledTimes(1);
    // Não é spawn: nada de `onDemand` (esse gesto é só para fonte cara).
    expect((first as Extract<ProviderUsageStats, { supported: true }>).source).toBe("http");
  });
});
