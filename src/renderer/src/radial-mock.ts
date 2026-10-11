import type { ProviderUsageStats } from "../../main/provider-usage";

/**
 * Exact provider arc from docs/design/app-v3/prototipo/Radial.dc.html
 * (renderVals → P[]). Used as the parity fixture so app and prototype show
 * the same five providers, labels and short quota lines.
 *
 * Runtime fixture data reaches the renderer only via `window.system.getRadialFixture`
 * (main IPC, null when packaged). A loose `window.__stellarRadialFixture` is
 * ignored outside Vite DEV — same defense-in-depth as login-v2.
 */
export type RadialMockProvider = {
  id: string;
  label: string;
  quota: string;
  /** Warm (measured) vs warn (exhausted / missing). */
  tone: "ok" | "warn" | "muted";
  dim: boolean;
  /** Stats that `formatRadialQuota` turns into the same short quota line. */
  stats: ProviderUsageStats;
};

export const RADIAL_MOCK_PROVIDERS: readonly RadialMockProvider[] = [
  {
    id: "claude",
    label: "Claude",
    quota: "77% semana",
    tone: "ok",
    dim: false,
    stats: {
      provider: "claude",
      supported: true,
      source: "local-cache",
      segments: [{ key: "week", percent: 77 }],
      capturedAtMs: 1,
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    quota: "só Gemini",
    tone: "ok",
    dim: false,
    stats: {
      provider: "antigravity",
      supported: false,
      reason: "só Gemini",
    },
  },
  {
    id: "bash",
    label: "Shell",
    quota: "",
    tone: "muted",
    dim: false,
    stats: {
      provider: "bash",
      supported: false,
      reason: "",
    },
  },
  {
    id: "commandcode",
    label: "Command Code",
    quota: "sem cota",
    tone: "warn",
    dim: true,
    stats: {
      provider: "commandcode",
      supported: false,
      reason: "sem cota",
    },
  },
  {
    id: "codex",
    label: "Codex",
    quota: "sem crédito",
    tone: "warn",
    dim: true,
    stats: {
      provider: "codex",
      supported: false,
      reason: "sem crédito",
    },
  },
];

/** Prototype default selection (hub shows Claude). */
export const RADIAL_MOCK_DEFAULT_PROVIDER = "claude";

/** Stable display order for known providers (prototype first). */
export const RADIAL_PROVIDER_ORDER = RADIAL_MOCK_PROVIDERS.map((p) => p.id);

export function orderRadialProviders(ids: readonly string[]): string[] {
  const set = new Set(ids);
  const ordered: string[] = [];
  for (const id of RADIAL_PROVIDER_ORDER) {
    if (set.has(id)) ordered.push(id);
  }
  for (const id of ids) {
    if (!RADIAL_PROVIDER_ORDER.includes(id)) ordered.push(id);
  }
  return ordered;
}

export type RadialFixture = {
  providers: readonly RadialMockProvider[];
  defaultProviderId: string;
};

declare global {
  interface Window {
    /** Dev-only CDP convenience; ignored when `import.meta.env.DEV` is false. */
    __stellarRadialFixture?: RadialFixture | null;
  }
}

function coerceFixture(raw: unknown): RadialFixture | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { providers?: unknown; defaultProviderId?: unknown };
  if (!Array.isArray(obj.providers) || typeof obj.defaultProviderId !== "string") return null;
  return {
    defaultProviderId: obj.defaultProviderId,
    providers: obj.providers as RadialMockProvider[],
  };
}

/**
 * Loose window global — accepted only when `isDev` is true. Packaged /
 * production renderer builds pass `import.meta.env.DEV === false`.
 */
export function acceptLooseRadialFixture(isDev: boolean, loose: unknown): RadialFixture | null {
  if (!isDev) return null;
  return coerceFixture(loose);
}

/**
 * Loose window global — accepted only in Vite DEV. Packaged / production
 * renderer builds always return null here.
 */
export function readRadialFixtureGlobal(): RadialFixture | null {
  if (typeof window === "undefined") return null;
  return acceptLooseRadialFixture(Boolean(import.meta.env.DEV), window.__stellarRadialFixture);
}

/** @deprecated Prefer `fetchRadialFixture` — sync global is DEV-only. */
export function readRadialFixture(): RadialFixture | null {
  return readRadialFixtureGlobal();
}

/**
 * Preferred path: IPC from main (`ui:radial-fixture`), which is null when
 * `app.isPackaged`. Falls back to the DEV-only window global for local CDP.
 */
export async function fetchRadialFixture(): Promise<RadialFixture | null> {
  try {
    const fromMain = await window.system.getRadialFixture();
    const coerced = coerceFixture(fromMain);
    if (coerced) return coerced;
  } catch {
    /* channel missing until registerRadialFixtureIpc runs */
  }
  return readRadialFixtureGlobal();
}
