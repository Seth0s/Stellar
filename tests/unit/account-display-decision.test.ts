import { describe, expect, it } from "vitest";
import {
  accountIdentity,
  isConnectivityFailure,
  isSessionOffline,
  statusIdentity,
} from "../../src/renderer/src/account-display-decision";
import type { CloudStatusInfo } from "../../src/preload/index";

describe("account identity", () => {
  it("shows the e-mail the user signed in with, else the GitHub login", () => {
    expect(
      accountIdentity({ displayName: "Ana", identities: [{ kind: "github", subject: "1", login: "ana" }, { kind: "email", subject: "ana@example.com", login: null }] }),
    ).toEqual({ name: "Ana", identity: "ana@example.com" });
    expect(accountIdentity({ displayName: "Ana", identities: [{ kind: "github", subject: "1", login: "ana" }] })).toEqual({
      name: "Ana",
      identity: "ana · GitHub",
    });
    expect(accountIdentity({ displayName: "Ana", identities: [] })).toEqual({ name: "Ana", identity: "" });
  });

  it("only a signed-in status has an identity", () => {
    expect(statusIdentity(null)).toBeNull();
    expect(statusIdentity({ state: "logged-out", apiBaseUrl: "x", lastError: null })).toBeNull();
  });
});

describe("connectivity failures", () => {
  it("recognises the ways an unreachable API reads, not a server refusal", () => {
    for (const raw of ["fetch failed", "TypeError: Failed to fetch", "connect ECONNREFUSED 127.0.0.1:1", "getaddrinfo ENOTFOUND api.x", "GET /v1/x timed out", "network"]) {
      expect(isConnectivityFailure(raw), raw).toBe(true);
    }
    for (const raw of ["plan required", "forbidden", "revisão mudou de novo", "", null, undefined]) {
      expect(isConnectivityFailure(raw), String(raw)).toBe(false);
    }
  });
});

describe("offline session", () => {
  it("is a logged-out status flagged by the main process", () => {
    const out: CloudStatusInfo = { state: "logged-out", apiBaseUrl: "x", lastError: "network" };
    expect(isSessionOffline(out)).toBe(false);
    expect(isSessionOffline({ ...out, sessionOffline: true } as CloudStatusInfo)).toBe(true);
    expect(isSessionOffline(null)).toBe(false);
  });
});
