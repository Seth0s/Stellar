/**
 * browser_route / browser_unroute — which mocked response, if any, answers a
 * request. Pure: the registry owns Electron protocol handlers and I/O.
 *
 * Scope is always one browser card (its session partition). A missing mock
 * means the real network continues — never a silent global rewrite.
 */

export type RouteResponseSpec = {
  status: number;
  headers?: Record<string, string>;
  /** UTF-8 body string XOR path to a file (bodyFile). */
  body?: string;
  bodyFile?: string;
};

export type RouteInput = {
  urlPattern: string;
  method?: string | null;
  response: RouteResponseSpec;
  /** Fulfill at most N times, then drop. Omit/null = unlimited. */
  times?: number | null;
};

export type ActiveRoute = {
  id: string;
  urlPattern: string;
  method: string | null;
  response: RouteResponseSpec;
  timesRemaining: number | null;
  hitCount: number;
};

export type RouteMatch =
  | { action: "fulfill"; routeId: string; response: RouteResponseSpec; consume: boolean }
  | { action: "pass" };

export type RouteDecision =
  | { action: "accept"; route: Omit<ActiveRoute, "hitCount"> }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeRouteRefuse(reason: string): string {
  return `browser_route refused: ${reason}`;
}

/**
 * Glob-style urlPattern (`*` = any run of chars) → RegExp, anchored full-URL
 * match. A pattern that already looks like a regex (`^…`) is compiled as-is.
 */
export function compileUrlPattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (trimmed.startsWith("^")) {
    return new RegExp(trimmed, "i");
  }
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    return compileUrlPattern(pattern).test(url);
  } catch {
    return false;
  }
}

export function decideRouteAccept(input: RouteInput, id: string): RouteDecision {
  const urlPattern = typeof input.urlPattern === "string" ? input.urlPattern.trim() : "";
  if (!urlPattern) {
    return { action: "refuse", error: describeRouteRefuse("`urlPattern` is required (glob like `*/api/items` or a ^regex).") };
  }
  try {
    compileUrlPattern(urlPattern);
  } catch (err) {
    return {
      action: "refuse",
      error: describeRouteRefuse(`invalid urlPattern ${JSON.stringify(urlPattern)}: ${String(err)}`),
    };
  }
  const status = input.response?.status;
  if (typeof status !== "number" || !Number.isFinite(status) || status < 100 || status > 599) {
    return {
      action: "refuse",
      error: describeRouteRefuse("`response.status` must be an HTTP status 100–599."),
    };
  }
  const hasBody = typeof input.response.body === "string";
  const hasFile = typeof input.response.bodyFile === "string" && input.response.bodyFile.trim().length > 0;
  if (hasBody && hasFile) {
    return {
      action: "refuse",
      error: describeRouteRefuse("pass either `response.body` or `response.bodyFile`, not both."),
    };
  }
  let timesRemaining: number | null = null;
  if (input.times !== undefined && input.times !== null) {
    if (typeof input.times !== "number" || !Number.isFinite(input.times) || input.times < 1 || !Number.isInteger(input.times)) {
      return {
        action: "refuse",
        error: describeRouteRefuse("`times` must be a positive integer (or omit for unlimited)."),
      };
    }
    timesRemaining = input.times;
  }
  const method =
    typeof input.method === "string" && input.method.trim()
      ? input.method.trim().toUpperCase()
      : null;
  return {
    action: "accept",
    route: {
      id,
      urlPattern,
      method,
      response: {
        status,
        headers: input.response.headers,
        body: hasBody ? input.response.body : undefined,
        bodyFile: hasFile ? input.response.bodyFile!.trim() : undefined,
      },
      timesRemaining,
    },
  };
}

/**
 * First matching active route wins (registration order). `consume: true`
 * means the caller should decrement timesRemaining / drop the route.
 */
export function matchRequest(
  routes: ReadonlyArray<ActiveRoute>,
  request: { url: string; method: string },
): RouteMatch {
  const method = String(request.method || "GET").toUpperCase();
  for (const route of routes) {
    if (route.method && route.method !== method) continue;
    if (!urlMatchesPattern(request.url, route.urlPattern)) continue;
    const consume = route.timesRemaining !== null;
    return { action: "fulfill", routeId: route.id, response: route.response, consume };
  }
  return { action: "pass" };
}

/** After a fulfill with times: return the next list (drop when exhausted). */
export function afterRouteHit(routes: ActiveRoute[], routeId: string): ActiveRoute[] {
  return routes
    .map((r) => {
      if (r.id !== routeId) return r;
      const hitCount = r.hitCount + 1;
      if (r.timesRemaining === null) return { ...r, hitCount };
      const timesRemaining = r.timesRemaining - 1;
      return { ...r, hitCount, timesRemaining };
    })
    .filter((r) => r.timesRemaining === null || r.timesRemaining > 0);
}

export function removeRoutes(
  routes: ActiveRoute[],
  opts: { routeId?: string | null; urlPattern?: string | null },
): { next: ActiveRoute[]; removed: ActiveRoute[] } {
  const id = typeof opts.routeId === "string" ? opts.routeId.trim() : "";
  const pattern = typeof opts.urlPattern === "string" ? opts.urlPattern.trim() : "";
  if (!id && !pattern) {
    return { next: [], removed: [...routes] };
  }
  const removed: ActiveRoute[] = [];
  const next: ActiveRoute[] = [];
  for (const r of routes) {
    if ((id && r.id === id) || (pattern && r.urlPattern === pattern)) removed.push(r);
    else next.push(r);
  }
  return { next, removed };
}

/** Public summary for MCP/UI — no file paths with secrets beyond what was declared. */
export function summarizeRoute(route: ActiveRoute): {
  id: string;
  urlPattern: string;
  method: string | null;
  status: number;
  timesRemaining: number | null;
  hitCount: number;
  hasBodyFile: boolean;
} {
  return {
    id: route.id,
    urlPattern: route.urlPattern,
    method: route.method,
    status: route.response.status,
    timesRemaining: route.timesRemaining,
    hitCount: route.hitCount,
    hasBodyFile: Boolean(route.response.bodyFile),
  };
}
