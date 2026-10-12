import { describe, expect, it } from "vitest";
import {
  decideLoginOutcome,
  loginErrorForStatus,
  loginErrorKey,
  readPendingExtras,
} from "../../src/renderer/src/login-flow-decision";
import { classifyEmailStartError, LOGIN_ERROR } from "../../src/main/cloud-auth-decision";
import type { CloudStatusInfo } from "../../src/preload/index";

const out = (lastError: string | null): CloudStatusInfo => ({ state: "logged-out", apiBaseUrl: "http://x", lastError });
const pending = (provider: "github" | "email", extra: object = {}): CloudStatusInfo =>
  ({ state: "pending", apiBaseUrl: "http://x", provider, ...extra }) as CloudStatusInfo;
const loggedIn: CloudStatusInfo = {
  state: "logged-in",
  apiBaseUrl: "http://x",
  account: { displayName: "A", identities: [] },
  plan: null,
  expiresAtMs: 1,
};

describe("login error codes", () => {
  it("every machine code the main process writes has a message", () => {
    for (const code of Object.values(LOGIN_ERROR)) expect(loginErrorKey(code), code).not.toBeNull();
  });

  it("classifies a failed e-mail request by what the server (or the wire) said", () => {
    const err = (status: number, code: string) => ({ status, code, message: "m" });
    expect(classifyEmailStartError(err(0, "network"))).toBe("network");
    expect(classifyEmailStartError(err(0, "timeout"))).toBe("timeout");
    expect(classifyEmailStartError(err(503, "email_unavailable"))).toBe("email_unavailable");
    expect(classifyEmailStartError(err(503, "unknown"))).toBe("email_unavailable");
    expect(classifyEmailStartError(err(403, "signup_closed"))).toBe("signup_closed");
    expect(classifyEmailStartError(err(429, "rate_limited"))).toBe("rate_limited");
    expect(classifyEmailStartError(err(422, "invalid_request"))).toBe("invalid_email");
    expect(classifyEmailStartError(err(500, "internal"))).toBe("email_failed");
  });

  it("a stale session error outside an attempt is not shown; inside one it reads as generic", () => {
    expect(loginErrorForStatus(out("refresh failed (401)"), false)).toBeNull();
    expect(loginErrorForStatus(out("refresh failed (401)"), true)).toBe("cloud.error.generic");
    expect(loginErrorForStatus(out("login_timeout"), false)).toBe("cloud.error.loginTimeout");
    expect(loginErrorForStatus(out(null), true)).toBeNull();
    expect(loginErrorForStatus(pending("email"), true)).toBeNull();
  });
});

describe("decideLoginOutcome", () => {
  it("e-mail waits only on a real pending; any logged-out answer is a failure", () => {
    expect(decideLoginOutcome("email", pending("email"))).toEqual({ kind: "waiting-email" });
    expect(decideLoginOutcome("email", out("email_unavailable"))).toEqual({
      kind: "failed",
      errorKey: "cloud.error.emailUnavailable",
    });
    expect(decideLoginOutcome("email", out("network"))).toEqual({ kind: "failed", errorKey: "cloud.error.network" });
    expect(decideLoginOutcome("email", out(null))).toEqual({ kind: "failed", errorKey: "cloud.error.generic" });
  });

  it("github waits on the browser; a fast callback lands as signed-in", () => {
    expect(decideLoginOutcome("github", pending("github"))).toEqual({ kind: "waiting-browser" });
    expect(decideLoginOutcome("github", loggedIn)).toEqual({ kind: "signed-in" });
  });
});

describe("readPendingExtras", () => {
  it("reads the URL and the open failure only from a pending status", () => {
    expect(readPendingExtras(pending("github", { loginUrl: "http://x/v1/auth/start?a=1", openFailed: true }))).toEqual({
      loginUrl: "http://x/v1/auth/start?a=1",
      openFailed: true,
    });
    expect(readPendingExtras(pending("github"))).toEqual({ loginUrl: null, openFailed: false });
    expect(readPendingExtras(out(null))).toEqual({ loginUrl: null, openFailed: false });
    expect(readPendingExtras(null)).toEqual({ loginUrl: null, openFailed: false });
  });
});
