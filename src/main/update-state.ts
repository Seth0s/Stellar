/**
 * THE UPDATE DIALOG'S STATE, kept in the main process.
 *
 * The download runs in main and outlives the dialog: closing the window must
 * not cancel it, and reopening it (from the title-bar icon, after a reload) has
 * to land on the real state — so main owns one snapshot, pushes it on every
 * change, and answers `updater:get-state` with it.
 *
 * Phases, in the only order they happen:
 *
 *   idle ─▶ available ─▶ downloading ─▶ ready ─▶ installing
 *             │  ▲            │                      │
 *             │  └─ cancel ───┘                      │
 *             ▼                                      ▼
 *           manual (install cannot update itself)  error (download | install)
 *
 * `installing` is entered ONLY by an explicit restart request — nothing in this
 * file moves a snapshot there on its own. Pure functions, so the transitions
 * are testable without Electron.
 */
import type { UpdateErrorKind } from "./update-error-decision";
import type { ManualInstall } from "./update-manual-decision";

export type UpdaterPhase = "idle" | "available" | "downloading" | "ready" | "installing" | "error" | "manual";

export type UpdaterProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdaterError = {
  kind: UpdateErrorKind;
  /** Where it failed — decides what "try again" does. */
  stage: "download" | "install";
  code: string | null;
  /** First line of the library's message, never a stack. */
  detail: string;
  percent: number | null;
  transferred: number | null;
  total: number | null;
  /** Disk failures: what the download needs and what is free (bytes). */
  neededBytes: number | null;
  freeBytes: number | null;
  /** macOS swap log, when the swap failed. */
  swapLogPath: string | null;
};

export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  version: string | null;
  changelog: string;
  /** Size of the package the feed declares, for "Baixar · 38 MB". */
  downloadBytes: number | null;
  progress: UpdaterProgress | null;
  error: UpdaterError | null;
  manual: ManualInstall | null;
};

export const IDLE_SNAPSHOT: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  changelog: "",
  downloadBytes: null,
  progress: null,
  error: null,
  manual: null,
};

export function onUpdateAvailable(
  snap: UpdaterSnapshot,
  offered: {
    version: string;
    changelog: string;
    downloadBytes: number | null;
    /** `null` when this install can update itself. */
    manual: ManualInstall | null;
  },
): UpdaterSnapshot {
  // A repeated check for the version already being fetched, kept or installed
  // must not drop the dialog back to "available".
  if (snap.version === offered.version && ["downloading", "ready", "installing"].includes(snap.phase)) {
    return snap;
  }
  return {
    ...IDLE_SNAPSHOT,
    phase: offered.manual === null ? "available" : "manual",
    version: offered.version,
    changelog: offered.changelog,
    downloadBytes: offered.downloadBytes,
    manual: offered.manual,
  };
}

export function onDownloadStarted(snap: UpdaterSnapshot): UpdaterSnapshot {
  const startable = snap.phase === "available" || (snap.phase === "error" && snap.error?.stage === "download");
  if (!startable) return snap;
  return {
    ...snap,
    phase: "downloading",
    error: null,
    progress: { percent: 0, transferred: 0, total: snap.downloadBytes ?? 0, bytesPerSecond: 0 },
  };
}

export function onDownloadProgress(snap: UpdaterSnapshot, progress: UpdaterProgress): UpdaterSnapshot {
  if (snap.phase !== "downloading") return snap;
  return { ...snap, progress };
}

export function onDownloaded(snap: UpdaterSnapshot): UpdaterSnapshot {
  if (snap.phase !== "downloading" && snap.phase !== "available") return snap;
  const total = snap.progress?.total ?? snap.downloadBytes ?? 0;
  return {
    ...snap,
    phase: "ready",
    error: null,
    progress: { percent: 100, transferred: total, total, bytesPerSecond: 0 },
  };
}

export function onDownloadCancelled(snap: UpdaterSnapshot): UpdaterSnapshot {
  if (snap.phase !== "downloading") return snap;
  return { ...snap, phase: "available", progress: null, error: null };
}

export function onUpdateFailed(
  snap: UpdaterSnapshot,
  stage: UpdaterError["stage"],
  failure: {
    kind: UpdateErrorKind;
    code: string | null;
    detail: string;
    neededBytes?: number | null;
    freeBytes?: number | null;
    swapLogPath?: string | null;
  },
): UpdaterSnapshot {
  return {
    ...snap,
    phase: "error",
    error: {
      kind: failure.kind,
      stage,
      code: failure.code,
      detail: failure.detail,
      percent: snap.progress && stage === "download" ? Math.round(snap.progress.percent) : null,
      transferred: snap.progress && stage === "download" ? snap.progress.transferred : null,
      total: snap.progress && stage === "download" ? snap.progress.total : null,
      neededBytes: failure.neededBytes ?? null,
      freeBytes: failure.freeBytes ?? null,
      swapLogPath: failure.swapLogPath ?? null,
    },
  };
}

/** Only the explicit restart request gets here: `ready`, or a retry after an install failure. */
export function onInstallStarted(snap: UpdaterSnapshot): UpdaterSnapshot {
  const startable = snap.phase === "ready" || (snap.phase === "error" && snap.error?.stage === "install");
  if (!startable) return snap;
  return { ...snap, phase: "installing", error: null };
}

/** What "try again" does after a failure. */
export function retryAction(snap: UpdaterSnapshot): "download" | "install" | null {
  if (snap.phase !== "error" || snap.error === null) return null;
  return snap.error.stage;
}
