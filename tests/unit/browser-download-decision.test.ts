import { describe, expect, it } from "vitest";
import { registerSessionListenerOnce, reserveUniqueDownloadPath } from "../../src/main/browser-download-decision";

describe("reserveUniqueDownloadPath", () => {
  it("adds a numbered suffix instead of overwriting an existing download", () => {
    const existing = new Set(["/downloads/report.txt", "/downloads/report (1).txt"]);
    const reserved = new Set<string>();

    expect(reserveUniqueDownloadPath("/downloads", "report.txt", reserved, (path) => existing.has(path))).toBe(
      "/downloads/report (2).txt",
    );
  });

  it("reserves paths for active concurrent downloads and strips directory components", () => {
    const reserved = new Set<string>();

    expect(reserveUniqueDownloadPath("/downloads", "report.txt", reserved, () => false)).toBe("/downloads/report.txt");
    expect(reserveUniqueDownloadPath("/downloads", "../report.txt", reserved, () => false)).toBe("/downloads/report (1).txt");
  });

  it("keeps dotfiles and extensionless filenames intact while numbering collisions", () => {
    const reserved = new Set(["/downloads/.env", "/downloads/README"]);

    expect(reserveUniqueDownloadPath("/downloads", ".env", reserved, () => false)).toBe("/downloads/.env (1)");
    expect(reserveUniqueDownloadPath("/downloads", "README", reserved, () => false)).toBe("/downloads/README (1)");
  });

  it("falls back to a safe name for dot path components", () => {
    expect(reserveUniqueDownloadPath("/downloads", "..", new Set(), () => false)).toBe("/downloads/download");
  });
});

describe("registerSessionListenerOnce", () => {
  it("attaches one download listener when a persistent profile reuses its session", () => {
    const registered = new WeakSet<object>();
    const persistentSession = {};
    let listenerCount = 0;
    const attach = () => {
      listenerCount++;
    };

    expect(registerSessionListenerOnce(persistentSession, registered, attach)).toBe(true);
    expect(registerSessionListenerOnce(persistentSession, registered, attach)).toBe(false);
    expect(listenerCount).toBe(1);
  });

  it("registers a listener for each distinct partition session", () => {
    const registered = new WeakSet<object>();
    let listenerCount = 0;
    const attach = () => {
      listenerCount++;
    };

    registerSessionListenerOnce({}, registered, attach);
    registerSessionListenerOnce({}, registered, attach);
    expect(listenerCount).toBe(2);
  });
});
