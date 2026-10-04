/**
 * Cliente HTTP do backend da conta Stellar (StellarCloud B2). Casca fina sobre
 * `fetch`, com o envelope de erro do backend traduzido para um resultado
 * tipado — nunca lança por status HTTP (rede cai como `status: 0`).
 */

import {
  parseCloudApiError,
  parseMe,
  parseTokenPair,
  type CloudAccount,
  type CloudApiError,
  type ParsedTokenPair,
} from "./cloud-auth-decision";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: CloudApiError };

export function createCloudApi(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(method: string, path: string, opts2: { body?: unknown; token?: string } = {}): Promise<
    ApiResult<unknown>
  > {
    const headers: Record<string, string> = {};
    if (opts2.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts2.token) headers["Authorization"] = `Bearer ${opts2.token}`;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts2.body === undefined ? undefined : JSON.stringify(opts2.body),
      });
    } catch (err) {
      return { ok: false, error: { status: 0, code: "network", message: err instanceof Error ? err.message : String(err) } };
    }

    let parsed: unknown = null;
    const text = await response.text().catch(() => "");
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      return { ok: false, error: parseCloudApiError(response.status, parsed, `${method} ${path} failed (${response.status})`) };
    }
    return { ok: true, value: parsed };
  }

  return {
    baseUrl,

    /** POST /v1/auth/email — pede o link de uso único. */
    async startEmail(body: Record<string, string>): Promise<ApiResult<null>> {
      const res = await request("POST", "/v1/auth/email", { body });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** POST /v1/auth/token (authorization_code). */
    async exchange(body: Record<string, string>): Promise<ApiResult<ParsedTokenPair>> {
      const res = await request("POST", "/v1/auth/token", { body });
      if (!res.ok) return res;
      const pair = parseTokenPair(res.value);
      if (!pair) return { ok: false, error: { status: 0, code: "invalid_response", message: "token response missing fields" } };
      return { ok: true, value: pair };
    },

    /** POST /v1/auth/token (refresh_token). */
    async refresh(body: Record<string, string>): Promise<ApiResult<ParsedTokenPair>> {
      const res = await request("POST", "/v1/auth/token", { body });
      if (!res.ok) return res;
      const pair = parseTokenPair(res.value);
      if (!pair) return { ok: false, error: { status: 0, code: "invalid_response", message: "refresh response missing fields" } };
      return { ok: true, value: pair };
    },

    /** POST /v1/auth/logout — idempotente; sem token ainda devolve 204. */
    async logout(refreshToken: string): Promise<ApiResult<null>> {
      const res = await request("POST", "/v1/auth/logout", { body: { refresh_token: refreshToken } });
      return res.ok ? { ok: true, value: null } : res;
    },

    /** GET /v1/me (Bearer) → conta/identidades. */
    async me(accessToken: string): Promise<ApiResult<CloudAccount>> {
      const res = await request("GET", "/v1/me", { token: accessToken });
      if (!res.ok) return res;
      const account = parseMe(res.value);
      if (!account) return { ok: false, error: { status: 0, code: "invalid_response", message: "/me response missing account" } };
      return { ok: true, value: account };
    },

    async health(): Promise<boolean> {
      const res = await request("GET", "/v1/healthz");
      return res.ok;
    },
  };
}

export type CloudApi = ReturnType<typeof createCloudApi>;
