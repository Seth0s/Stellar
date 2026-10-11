/**
 * ACCOUNT INBOX — IPC surface + SSE + system notifications.
 *
 * Aggregates B8 team items with local awaiting_review tasks from the active
 * profile's boards, streams /v1/events in the main process, and raises an
 * Electron Notification when prefs.system allows it. Offline keeps the last
 * snapshot on disk under the profile userData.
 */

import { BrowserWindow, Notification, ipcMain } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCloudApi, type CloudApi } from "./cloud-api";
import {
  DEFAULT_NOTIFICATION_PREFS,
  aggregateInboxItems,
  emptyInboxSnapshot,
  mergeOfflineSnapshot,
  notificationCopy,
  shouldShowSystemNotification,
  type AggregatedInboxItem,
  type InboxSnapshot,
  type LocalAwaitingItem,
  type NotificationPrefs,
  type TeamInboxItem,
} from "./inbox-decision";
import { startInboxSse, type InboxSseClient } from "./inbox-sse";

export type InboxIpcDeps = {
  baseUserDataDir: () => string;
  activeProfileId: () => string | null;
  ensureToken: () => Promise<string | null>;
  apiBaseUrl: () => string;
  /** Local awaiting_review rows for sessions of the active profile. */
  listLocalAwaiting: () => LocalAwaitingItem[];
  /** Focus the app and tell the renderer to open an inbox item. */
  openInboxItem: (item: AggregatedInboxItem) => void;
  getMainWindow: () => BrowserWindow | null;
  now?: () => number;
};

function cachePath(baseUserDataDir: string, profileId: string): string {
  return join(baseUserDataDir, "profiles", profileId, "inbox-snapshot.json");
}

function readCache(path: string): InboxSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as InboxSnapshot;
    if (!raw || !Array.isArray(raw.items) || !raw.counts || !raw.prefs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(path: string, snapshot: InboxSnapshot): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(snapshot), "utf8");
  } catch {
    /* best-effort cache */
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function registerInboxIpc(deps: InboxIpcDeps): { stop: () => void; refresh: () => Promise<InboxSnapshot> } {
  let api: CloudApi | null = null;
  function cloudApi(): CloudApi {
    return (api ??= createCloudApi({ baseUrl: deps.apiBaseUrl() }));
  }

  let snapshot: InboxSnapshot = emptyInboxSnapshot(deps.now?.() ?? Date.now());
  let sse: InboxSseClient | null = null;
  let lastEventId: number | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const knownItemIds = new Set<string>();

  function profileCachePath(): string | null {
    const profileId = deps.activeProfileId();
    if (!profileId) return null;
    return cachePath(deps.baseUserDataDir(), profileId);
  }

  function loadCached(): void {
    const path = profileCachePath();
    if (!path) return;
    const cached = readCache(path);
    if (cached) {
      snapshot = { ...cached, offline: true };
      for (const item of snapshot.items) knownItemIds.add(item.id);
    }
  }

  loadCached();

  // Isolated smoke can seed the page with the prototype's seven rows without
  // standing up StellarCloud — path is absolute, JSON is an InboxSnapshot.
  if (process.env.STELLAR_INBOX_FIXTURE) {
    try {
      const fixture = JSON.parse(readFileSync(process.env.STELLAR_INBOX_FIXTURE, "utf8")) as InboxSnapshot;
      if (fixture && Array.isArray(fixture.items)) {
        snapshot = { ...fixture, offline: false, updatedAt: deps.now?.() ?? Date.now() };
        for (const item of snapshot.items) knownItemIds.add(item.id);
      }
    } catch {
      /* ignore bad fixture path */
    }
  }

  async function buildSnapshot(offline: boolean): Promise<InboxSnapshot> {
    // Smoke fixture is the whole snapshot — do not re-derive local rows over it.
    if (process.env.STELLAR_INBOX_FIXTURE && snapshot.items.length > 0) {
      return { ...snapshot, offline: false, updatedAt: deps.now?.() ?? Date.now() };
    }

    const now = deps.now?.() ?? Date.now();
    const localItems = deps.listLocalAwaiting();
    let teamItems: TeamInboxItem[] = [];
    let prefs: NotificationPrefs = snapshot.prefs ?? { ...DEFAULT_NOTIFICATION_PREFS };

    const token = await deps.ensureToken();
    if (token) {
      const [listRes, prefsRes] = await Promise.all([cloudApi().listInbox(token), cloudApi().getInboxPrefs(token)]);
      if (listRes.ok) teamItems = listRes.value.items;
      if (prefsRes.ok) prefs = prefsRes.value;
      if (!listRes.ok && !prefsRes.ok) {
        const path = profileCachePath();
        const cached = path ? readCache(path) : null;
        if (cached) return { ...cached, offline: true, updatedAt: now };
        return { ...aggregateInboxItems({ teamItems: [], localItems, now }), prefs, offline: true, updatedAt: now };
      }
      offline = false;
    } else {
      offline = true;
      const path = profileCachePath();
      const cached = path ? readCache(path) : null;
      if (cached) return mergeOfflineSnapshot(cached, localItems, now);
    }

    const agg = aggregateInboxItems({ teamItems, localItems, now });
    return { items: agg.items, counts: agg.counts, prefs, offline, updatedAt: now };
  }

  function maybeNotify(next: InboxSnapshot): void {
    if (!shouldShowSystemNotification(next.prefs, "system")) return;
    if (!Notification.isSupported()) return;
    for (const item of next.items) {
      if (knownItemIds.has(item.id) || item.seen) continue;
      knownItemIds.add(item.id);
      const copy = notificationCopy(item);
      const n = new Notification({ title: copy.title, body: copy.body });
      n.on("click", () => deps.openInboxItem(item));
      n.show();
    }
    for (const item of next.items) knownItemIds.add(item.id);
  }

  async function refresh(opts: { fromSse?: boolean; offline?: boolean } = {}): Promise<InboxSnapshot> {
    try {
      const next = await buildSnapshot(Boolean(opts.offline));
      if (opts.fromSse) maybeNotify(next);
      else {
        for (const item of next.items) knownItemIds.add(item.id);
      }
      snapshot = next;
      const path = profileCachePath();
      if (path && !next.offline) writeCache(path, next);
      broadcast("inbox:snapshot", snapshot);
      return snapshot;
    } catch {
      snapshot = { ...snapshot, offline: true, updatedAt: deps.now?.() ?? Date.now() };
      broadcast("inbox:snapshot", snapshot);
      return snapshot;
    }
  }

  function scheduleRefreshFromSse(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh({ fromSse: true });
    }, 150);
  }

  function ensureSse(): void {
    if (sse) return;
    sse = startInboxSse({
      url: cloudApi().eventsUrl(),
      token: () => deps.ensureToken(),
      initialLastEventId: lastEventId,
      handlers: {
        onEvent: (event) => {
          if (event.id != null) lastEventId = event.id;
          broadcast("inbox:event", { id: event.id, name: event.name, data: event.data });
          if (event.name === "inbox" || event.name === "task" || event.name === "") {
            scheduleRefreshFromSse();
          }
        },
        onStatus: (status) => {
          broadcast("inbox:status", { status });
          if (status === "offline") {
            snapshot = { ...snapshot, offline: true };
            broadcast("inbox:snapshot", snapshot);
          }
        },
      },
    });
  }

  function stopSse(): void {
    sse?.stop();
    sse = null;
  }

  ipcMain.handle("inbox:snapshot", async () => {
    ensureSse();
    return refresh();
  });

  ipcMain.handle("inbox:mark-seen", async (_e, itemId: unknown) => {
    if (typeof itemId !== "string") return { ok: false as const, error: "invalid id" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false as const, error: "não logado" };
    const teamId = itemId.startsWith("team:") ? itemId.slice("team:".length) : itemId;
    const res = await cloudApi().markInboxSeen(token, teamId);
    if (!res.ok) return { ok: false as const, error: res.error.message };
    await refresh();
    return { ok: true as const };
  });

  ipcMain.handle("inbox:mark-all-seen", async () => {
    const token = await deps.ensureToken();
    if (!token) return { ok: false as const, error: "não logado" };
    const res = await cloudApi().markAllInboxSeen(token);
    if (!res.ok) return { ok: false as const, error: res.error.message };
    await refresh();
    return { ok: true as const };
  });

  ipcMain.handle("inbox:prefs", async () => {
    const token = await deps.ensureToken();
    if (!token) return { ok: true as const, prefs: snapshot.prefs, offline: true };
    const res = await cloudApi().getInboxPrefs(token);
    if (!res.ok) return { ok: true as const, prefs: snapshot.prefs, offline: true };
    snapshot = { ...snapshot, prefs: res.value };
    return { ok: true as const, prefs: res.value, offline: false };
  });

  ipcMain.handle("inbox:set-prefs", async (_e, body: unknown) => {
    if (!body || typeof body !== "object") return { ok: false as const, error: "invalid prefs" };
    const rec = body as Record<string, unknown>;
    const patch: { in_app?: boolean; system?: boolean; daily_digest?: boolean } = {};
    if (typeof rec.inApp === "boolean") patch.in_app = rec.inApp;
    if (typeof rec.system === "boolean") patch.system = rec.system;
    if (typeof rec.dailyDigest === "boolean") patch.daily_digest = rec.dailyDigest;
    if (typeof rec.in_app === "boolean") patch.in_app = rec.in_app;
    if (typeof rec.daily_digest === "boolean") patch.daily_digest = rec.daily_digest;
    const token = await deps.ensureToken();
    if (!token) {
      snapshot = {
        ...snapshot,
        prefs: {
          inApp: patch.in_app ?? snapshot.prefs.inApp,
          system: patch.system ?? snapshot.prefs.system,
          dailyDigest: patch.daily_digest ?? snapshot.prefs.dailyDigest,
        },
      };
      broadcast("inbox:snapshot", snapshot);
      return { ok: true as const, prefs: snapshot.prefs, offline: true };
    }
    const res = await cloudApi().putInboxPrefs(token, patch);
    if (!res.ok) return { ok: false as const, error: res.error.message };
    snapshot = { ...snapshot, prefs: res.value };
    const path = profileCachePath();
    if (path) writeCache(path, snapshot);
    broadcast("inbox:snapshot", snapshot);
    return { ok: true as const, prefs: res.value, offline: false };
  });

  ipcMain.handle("inbox:open", async (_e, itemId: unknown) => {
    if (typeof itemId !== "string") return { ok: false as const };
    const item = snapshot.items.find((i) => i.id === itemId);
    if (!item) return { ok: false as const };
    deps.openInboxItem(item);
    return { ok: true as const };
  });

  // Kick SSE when any renderer asks; also warm the cache on register.
  ensureSse();
  void refresh();

  return {
    stop: () => {
      stopSse();
      if (refreshTimer) clearTimeout(refreshTimer);
    },
    refresh: () => refresh(),
  };
}
