import { useEffect, useMemo, useState } from "react";
import { t, type MessageKey } from "../../shared/i18n";
import type { ProviderUsageStats } from "../../main/provider-usage";
import type { Tool } from "./card-types";
import { useAgentAvailability, useAvailableAgentProviders } from "./useAgentAvailability";
import {
  orderRadialProviders,
  RADIAL_MOCK_DEFAULT_PROVIDER,
  fetchRadialFixture,
  type RadialFixture,
  type RadialMockProvider,
} from "./radial-mock";
import { deriveRadialProviderItems } from "./radial-providers";
import { formatRadialQuota, type RadialQuotaView } from "./radial-quota";
import {
  polarOffset,
  providerAngleDeg,
  resolveRingGeometry,
  spawnAngleDeg,
  toolAngleDeg,
} from "./radial-ring-geometry";

/**
 * Dual-ring creation menu (app-v3 screen 12). Inner ring = tools V/P/C/S;
 * outer ring = eight spawn actions with labels and number keys; choosing
 * Agente opens a provider arc with live quotas without replacing the rings.
 * Opens from long-press or Q under the cursor (see App.tsx).
 */

export type RadialAction =
  | "tool-pointer"
  | "tool-pen"
  | "tool-connector"
  | "tool-select"
  | "terminal"
  | "files"
  | "changes"
  | "sticky"
  | "browser"
  | "chat"
  | "remote-window"
  | "task"
  | "quick-task";

type ToolDef = {
  action: RadialAction;
  id: string;
  glyph: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
  tool: Tool;
  keyGlyph: string;
};

type SpawnDef = {
  action: RadialAction;
  id: string;
  glyph: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
  key: string;
  opensProviders?: boolean;
};

const TOOLS: ToolDef[] = [
  { action: "tool-pointer", id: "pointer", glyph: "V", labelKey: "radial.pointer", hintKey: "radial.hint.pointer", tool: "pointer", keyGlyph: "V" },
  { action: "tool-pen", id: "pen", glyph: "P", labelKey: "radial.pen", hintKey: "radial.hint.pen", tool: "pen", keyGlyph: "P" },
  { action: "tool-connector", id: "connector", glyph: "C", labelKey: "radial.connector", hintKey: "radial.hint.connector", tool: "connector", keyGlyph: "C" },
  { action: "tool-select", id: "select", glyph: "S", labelKey: "radial.select", hintKey: "radial.hint.select", tool: "select", keyGlyph: "S" },
];

/** Outer ring — slot 6 keeps A5d quick-task ("Task aqui" / form). */
const SPAWNS: SpawnDef[] = [
  { action: "terminal", id: "agent", glyph: "›_", labelKey: "radial.agent", hintKey: "radial.hint.agent", key: "1", opensProviders: true },
  { action: "browser", id: "browser", glyph: "◎", labelKey: "radial.browser", hintKey: "radial.hint.browser", key: "2" },
  { action: "files", id: "ide", glyph: "{ }", labelKey: "radial.code", hintKey: "radial.hint.code", key: "3" },
  { action: "changes", id: "changes", glyph: "±", labelKey: "radial.changes", hintKey: "radial.hint.changes", key: "4" },
  { action: "sticky", id: "sticky", glyph: "▤", labelKey: "radial.sticky", hintKey: "radial.hint.sticky", key: "5" },
  { action: "quick-task", id: "task", glyph: "✓", labelKey: "radial.quickTask", hintKey: "radial.hint.quickTask", key: "6" },
  { action: "chat", id: "chat", glyph: "◌", labelKey: "radial.chat", hintKey: "radial.hint.chat", key: "7" },
  { action: "remote-window", id: "remote", glyph: "▣", labelKey: "radial.remoteWindow", hintKey: "radial.hint.remote", key: "8" },
];

const PROVIDER_DOT_VAR: Record<string, string> = {
  claude: "var(--radial-dot-claude)",
  antigravity: "var(--radial-dot-antigravity)",
  bash: "var(--radial-dot-bash)",
  commandcode: "var(--radial-dot-commandcode)",
  codex: "var(--radial-dot-codex)",
};

function providerDot(id: string): string {
  return PROVIDER_DOT_VAR[id] ?? "var(--radial-dot-default)";
}

export function RadialMenu({
  x,
  y,
  tool,
  providers,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  tool: Tool;
  providers: string[];
  onSelect: (action: RadialAction, providerId?: string) => void;
  onClose: () => void;
}) {
  const [fixture, setFixture] = useState<RadialFixture | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchRadialFixture().then((f) => {
      if (!cancelled) setFixture(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fixtureById = useMemo(() => {
    if (!fixture) return null;
    return new Map(fixture.providers.map((p) => [p.id, p]));
  }, [fixture]);

  const providerIds = useMemo(() => {
    if (fixture) return fixture.providers.map((p) => p.id);
    return orderRadialProviders(providers);
  }, [fixture, providers]);

  const [hoverId, setHoverId] = useState<string>("agent");
  const [subOpen, setSubOpen] = useState(true);
  const [provId, setProvId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, ProviderUsageStats | undefined>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const { missing } = useAgentAvailability();
  const all = useAvailableAgentProviders();
  const providerItems = useMemo(() => {
    const base = deriveRadialProviderItems(providerIds, missing, all);
    // Parity fixture: show every mock provider as selectable (same as the HTML).
    if (!fixture) return base;
    return base.map((item) => ({ ...item, installed: true, readiness: "unknown" as const }));
  }, [providerIds, missing, all, fixture]);
  const labelById = useMemo(() => {
    const map = new Map(all.map((p) => [p.id, p.label]));
    if (fixture) {
      for (const p of fixture.providers) map.set(p.id, p.label);
    }
    return map;
  }, [all, fixture]);

  const center = resolveRingGeometry(x, y, window.innerWidth, window.innerHeight, subOpen);

  const providerIdsKey = providerIds.join("\0");
  useEffect(() => {
    let cancelled = false;
    setNowMs(Date.now());
    const ids = providerIdsKey.split("\0").filter(Boolean);
    if (fixtureById) {
      const seeded: Record<string, ProviderUsageStats | undefined> = {};
      for (const id of ids) {
        const row = fixtureById.get(id);
        if (row) seeded[id] = row.stats;
      }
      setUsage(seeded);
      return;
    }
    void Promise.all(
      ids.map(async (id) => {
        try {
          const stats = await window.providerUsage.get(id);
          if (!cancelled) setUsage((prev) => ({ ...prev, [id]: stats }));
        } catch {
          if (!cancelled) setUsage((prev) => ({ ...prev, [id]: undefined }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [providerIdsKey, fixtureById]);

  useEffect(() => {
    if (provId !== null && providerIds.includes(provId)) return;
    const preferred =
      fixture?.defaultProviderId ??
      (providerIds.includes(RADIAL_MOCK_DEFAULT_PROVIDER) ? RADIAL_MOCK_DEFAULT_PROVIDER : providerIds[0] ?? null);
    setProvId(preferred);
  }, [provId, providerIds, fixture]);

  const quotas = useMemo(() => {
    const map = new Map<string, RadialQuotaView>();
    for (const item of providerItems) {
      const mock: RadialMockProvider | undefined = fixtureById?.get(item.id);
      map.set(
        item.id,
        formatRadialQuota({
          providerId: item.id,
          stats: usage[item.id],
          nowMs,
          override: mock
            ? { text: mock.quota, tone: mock.tone, dim: mock.dim }
            : null,
        }),
      );
    }
    return map;
  }, [providerItems, usage, nowMs, fixtureById]);

  const { centerLabel, centerHint } = useMemo(() => {
    const toolHit = TOOLS.find((n) => n.id === hoverId);
    if (toolHit) return { centerLabel: t(toolHit.labelKey), centerHint: t(toolHit.hintKey) };
    const spawnHit = SPAWNS.find((n) => n.id === hoverId);
    if (spawnHit?.opensProviders && subOpen && provId) {
      const q = quotas.get(provId);
      const name = labelById.get(provId) ?? provId;
      return {
        centerLabel: name,
        centerHint: q?.dim ? t("radial.hint.noQuota") : t("radial.hint.openHere"),
      };
    }
    if (spawnHit) return { centerLabel: t(spawnHit.labelKey), centerHint: t(spawnHit.hintKey) };
    return { centerLabel: "", centerHint: "" };
  }, [hoverId, subOpen, provId, quotas, labelById]);

  function pickSpawn(spawn: SpawnDef) {
    setHoverId(spawn.id);
    if (spawn.opensProviders) {
      setSubOpen(true);
      return;
    }
    onSelect(spawn.action);
  }

  function pickTool(def: ToolDef) {
    setHoverId(def.id);
    setSubOpen(false);
    onSelect(def.action);
  }

  function pickProvider(id: string) {
    setProvId(id);
    setHoverId("agent");
    setSubOpen(true);
    onSelect("terminal", id);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const digit = e.key;
      if (digit >= "1" && digit <= "8" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const spawn = SPAWNS[Number(digit) - 1];
        if (!spawn) return;
        e.preventDefault();
        setHoverId(spawn.id);
        if (spawn.opensProviders) {
          setSubOpen(true);
          return;
        }
        onSelect(spawn.action);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSelect]);

  const providerCount = providerItems.length;

  return (
    <div
      className="radial-backdrop"
      data-part="radial-menu"
      onPointerDown={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="radial-veil" aria-hidden="true" style={{ left: center.x, top: center.y }} />
      <div
        className="radial-menu"
        role="menu"
        aria-label={t("radial.menuLabel")}
        style={{ left: center.x, top: center.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="radial-ring radial-ring--outer"
          aria-hidden="true"
          style={{
            width: "var(--radial-outer-size)",
            height: "var(--radial-outer-size)",
            marginLeft: "calc(var(--radial-outer-size) / -2)",
            marginTop: "calc(var(--radial-outer-size) / -2)",
          }}
        />
        <div
          className="radial-ring radial-ring--inner"
          aria-hidden="true"
          style={{
            width: "var(--radial-inner-size)",
            height: "var(--radial-inner-size)",
            marginLeft: "calc(var(--radial-inner-size) / -2)",
            marginTop: "calc(var(--radial-inner-size) / -2)",
          }}
        />

        {TOOLS.map((def, i) => {
          const off = polarOffset(center.innerRadius, toolAngleDeg(i));
          return (
            <button
              key={def.id}
              type="button"
              role="menuitem"
              className={`radial-node radial-node--tool${hoverId === def.id ? " on" : ""}${def.tool === tool ? " is-active-tool" : ""}`}
              style={{
                left: off.x,
                top: off.y,
                width: center.toolSize,
                height: center.toolSize,
              }}
              aria-label={`${t(def.labelKey)} (${def.keyGlyph})`}
              aria-current={def.tool === tool ? "true" : undefined}
              data-radial-id={def.id}
              title={t(def.labelKey)}
              onMouseEnter={() => {
                setHoverId(def.id);
                setSubOpen(false);
              }}
              onClick={() => pickTool(def)}
            >
              <span className="radial-glyph radial-glyph--tool">{def.glyph}</span>
            </button>
          );
        })}

        {SPAWNS.map((def, i) => {
          const off = polarOffset(center.outerRadius, spawnAngleDeg(i));
          const labY = off.y + center.spawnSize / 2 + 6;
          return (
            <div key={def.id} className="radial-spawn-wrap">
              <button
                type="button"
                role="menuitem"
                className={`radial-node radial-node--spawn${hoverId === def.id ? " on" : ""}`}
                style={{
                  left: off.x,
                  top: off.y,
                  width: center.spawnSize,
                  height: center.spawnSize,
                }}
                aria-label={`${t(def.labelKey)} (${def.key})`}
                data-radial-id={def.id}
                data-radial-key={def.key}
                title={t(def.labelKey)}
                onMouseEnter={() => {
                  setHoverId(def.id);
                  if (def.opensProviders) setSubOpen(true);
                }}
                onClick={() => pickSpawn(def)}
              >
                <span className="radial-glyph radial-glyph--spawn">{def.glyph}</span>
              </button>
              <span className="radial-lab" style={{ left: off.x, top: labY }} aria-hidden="true">
                {t(def.labelKey)}
                <br />
                <span className="radial-lab-key">{def.key}</span>
              </span>
            </div>
          );
        })}

        {subOpen
          ? providerItems.map((item, i) => {
              const off = polarOffset(center.providerRadius, providerAngleDeg(i, providerCount));
              const q = quotas.get(item.id) ?? { text: "", tone: "muted" as const, dim: !item.installed };
              const name = labelById.get(item.id) ?? item.id;
              const selected = provId === item.id;
              return (
                <div key={item.id} className="radial-provider-wrap">
                  <button
                    type="button"
                    role="menuitem"
                    className={`radial-node radial-node--provider${selected ? " on" : ""}${q.dim || !item.installed ? " dim" : ""}`}
                    style={{
                      left: off.x,
                      top: off.y,
                      width: center.providerSize,
                      height: center.providerSize,
                    }}
                    aria-label={`${name}${q.dim || !item.installed ? `, ${t("radial.hint.noQuota")}` : ""}`}
                    data-radial-provider={item.id}
                    disabled={!item.installed}
                    onMouseEnter={() => {
                      setProvId(item.id);
                      setHoverId("agent");
                    }}
                    onClick={() => item.installed && pickProvider(item.id)}
                  >
                    <span className="radial-provider-dot" style={{ background: providerDot(item.id) }} />
                  </button>
                  <span
                    className="radial-lab radial-lab--provider"
                    style={{ left: off.x + 30, top: off.y - 14 }}
                    aria-hidden="true"
                  >
                    <span className="radial-lab-name">{name}</span>
                    <br />
                    <span
                      className={
                        q.tone === "warn" ? "radial-quota radial-quota--warn" : q.tone === "ok" ? "radial-quota radial-quota--ok" : "radial-quota"
                      }
                    >
                      {q.text}
                    </span>
                  </span>
                </div>
              );
            })
          : null}

        <div
          className="radial-hub"
          aria-live="polite"
          style={{
            width: center.hubSize,
            height: center.hubSize,
            marginLeft: -center.hubSize / 2,
            marginTop: -center.hubSize / 2,
          }}
        >
          <span className="radial-hub-label">{centerLabel}</span>
          <span className="radial-hub-hint">{centerHint}</span>
        </div>
        <span className="radial-pin" aria-hidden="true" />
      </div>

      <footer className="radial-footer" onPointerDown={(e) => e.stopPropagation()}>
        <span>
          {t("radial.footer.open")} <span className="radial-kbd">Q</span> {t("radial.footer.atCursor")}
        </span>
        <span>
          <span className="radial-kbd">1</span>–<span className="radial-kbd">8</span> {t("radial.footer.pick")}
        </span>
        <span>
          <span className="radial-kbd">Esc</span> {t("radial.footer.close")}
        </span>
        <span className="radial-footer-note">{t("radial.footer.spawnHint")}</span>
      </footer>
    </div>
  );
}
