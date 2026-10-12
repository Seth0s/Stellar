import { describe, it, expect } from "vitest";
import {
  IDLE_SNAPSHOT,
  onDownloadCancelled,
  onDownloadProgress,
  onDownloadStarted,
  onDownloaded,
  onInstallStarted,
  onUpdateAvailable,
  onUpdateFailed,
  retryAction,
  type UpdaterSnapshot,
} from "../../src/main/update-state";

const OFFER = { version: "0.9.0", changelog: "- novo", downloadBytes: 40_000_000, manual: null };
const failure = { kind: "network" as const, code: "ENOTFOUND", detail: "getaddrinfo ENOTFOUND" };

function downloading(): UpdaterSnapshot {
  return onDownloadStarted(onUpdateAvailable(IDLE_SNAPSHOT, OFFER));
}

describe("update state — the way in", () => {
  it("an offered version is `available`, or `manual` when the install cannot update itself", () => {
    expect(onUpdateAvailable(IDLE_SNAPSHOT, OFFER).phase).toBe("available");
    const manual = { manager: "dnf" as const, fileName: "f.rpm", command: "sudo dnf install ./f.rpm" };
    const s = onUpdateAvailable(IDLE_SNAPSHOT, { ...OFFER, manual });
    expect(s.phase).toBe("manual");
    expect(s.manual).toEqual(manual);
  });

  it("downloading only starts from `available` or after a failed download", () => {
    expect(onDownloadStarted(IDLE_SNAPSHOT).phase).toBe("idle");
    expect(downloading().phase).toBe("downloading");
    expect(downloading().progress).toEqual({ percent: 0, transferred: 0, total: 40_000_000, bytesPerSecond: 0 });
  });

  it("a repeated check for the version in flight does not reset the dialog", () => {
    const d = downloading();
    expect(onUpdateAvailable(d, OFFER)).toBe(d);
    const ready = onDownloaded(d);
    expect(onUpdateAvailable(ready, OFFER)).toBe(ready);
    // A NEWER version does start over.
    expect(onUpdateAvailable(ready, { ...OFFER, version: "0.9.1" }).phase).toBe("available");
  });
});

describe("update state — download", () => {
  it("records progress only while downloading", () => {
    const p = { percent: 48, transferred: 18_400_000, total: 38_200_000, bytesPerSecond: 3_100_000 };
    expect(onDownloadProgress(downloading(), p).progress).toEqual(p);
    const avail = onUpdateAvailable(IDLE_SNAPSHOT, OFFER);
    expect(onDownloadProgress(avail, p)).toBe(avail);
  });

  it("finishes as `ready` with 100%", () => {
    const s = onDownloaded(downloading());
    expect(s.phase).toBe("ready");
    expect(s.progress?.percent).toBe(100);
  });

  it("cancelling goes back to `available`, forgetting progress", () => {
    const s = onDownloadCancelled(onDownloadProgress(downloading(), { percent: 20, transferred: 1, total: 5, bytesPerSecond: 1 }));
    expect(s.phase).toBe("available");
    expect(s.progress).toBeNull();
  });
});

describe("update state — restart is never automatic", () => {
  it("`installing` is reachable only from `ready` (or a retried install)", () => {
    expect(onInstallStarted(IDLE_SNAPSHOT).phase).toBe("idle");
    expect(onInstallStarted(onUpdateAvailable(IDLE_SNAPSHOT, OFFER)).phase).toBe("available");
    expect(onInstallStarted(downloading()).phase).toBe("downloading");
    expect(onInstallStarted(onDownloaded(downloading())).phase).toBe("installing");
  });

  it("no transition other than the explicit one ever produces `installing`", () => {
    const steps = [
      onUpdateAvailable(IDLE_SNAPSHOT, OFFER),
      downloading(),
      onDownloaded(downloading()),
      onUpdateFailed(downloading(), "download", failure),
    ];
    for (const s of steps) expect(s.phase).not.toBe("installing");
  });
});

describe("update state — failures", () => {
  it("a download failure keeps how far it got, and retries the download", () => {
    const mid = onDownloadProgress(downloading(), { percent: 62.4, transferred: 23_700_000, total: 38_200_000, bytesPerSecond: 1 });
    const s = onUpdateFailed(mid, "download", failure);
    expect(s.phase).toBe("error");
    expect(s.error).toMatchObject({ stage: "download", percent: 62, transferred: 23_700_000, total: 38_200_000, kind: "network" });
    expect(retryAction(s)).toBe("download");
    expect(onDownloadStarted(s).phase).toBe("downloading");
  });

  it("an install failure retries the install and keeps the swap log", () => {
    const ready = onDownloaded(downloading());
    const s = onUpdateFailed(ready, "install", { ...failure, kind: "unknown", swapLogPath: "/tmp/swap.log" });
    expect(s.error).toMatchObject({ stage: "install", percent: null, swapLogPath: "/tmp/swap.log" });
    expect(retryAction(s)).toBe("install");
    expect(onInstallStarted(s).phase).toBe("installing");
  });

  it("there is nothing to retry outside an error", () => {
    expect(retryAction(IDLE_SNAPSHOT)).toBeNull();
    expect(retryAction(downloading())).toBeNull();
  });
});
