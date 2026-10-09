import { describe, expect, it } from "vitest";
import {
  afterRouteHit,
  compileUrlPattern,
  decideRouteAccept,
  matchRequest,
  removeRoutes,
  urlMatchesPattern,
  type ActiveRoute,
} from "../../src/main/browser-route-decision";

function route(overrides: Partial<ActiveRoute> = {}): ActiveRoute {
  return {
    id: "r1",
    urlPattern: "*/api/items",
    method: null,
    response: { status: 200, body: "[]" },
    timesRemaining: null,
    hitCount: 0,
    ...overrides,
  };
}

describe("compileUrlPattern / urlMatchesPattern", () => {
  it("matches a glob against a full URL", () => {
    expect(urlMatchesPattern("http://127.0.0.1:5173/api/items", "*/api/items")).toBe(true);
    expect(urlMatchesPattern("http://127.0.0.1:5173/api/other", "*/api/items")).toBe(false);
  });

  it("accepts an explicit ^regex", () => {
    const re = compileUrlPattern("^https://example\\.com/v1/.*");
    expect(re.test("https://example.com/v1/x")).toBe(true);
  });
});

describe("decideRouteAccept", () => {
  it("accepts a minimal route", () => {
    const d = decideRouteAccept({ urlPattern: "*/x", response: { status: 204 } }, "r1");
    expect(d.action).toBe("accept");
  });

  it("refuses missing pattern, bad status, and body+bodyFile together", () => {
    expect(decideRouteAccept({ urlPattern: "", response: { status: 200 } }, "r").action).toBe("refuse");
    expect(decideRouteAccept({ urlPattern: "*/x", response: { status: 99 } }, "r").action).toBe("refuse");
    expect(
      decideRouteAccept(
        { urlPattern: "*/x", response: { status: 200, body: "a", bodyFile: "/tmp/a" } },
        "r",
      ).action,
    ).toBe("refuse");
  });

  it("normalizes method and times", () => {
    const d = decideRouteAccept(
      { urlPattern: "*/x", method: "post", response: { status: 201, body: "{}" }, times: 2 },
      "r9",
    );
    expect(d.action).toBe("accept");
    if (d.action === "accept") {
      expect(d.route.method).toBe("POST");
      expect(d.route.timesRemaining).toBe(2);
    }
  });
});

describe("matchRequest + afterRouteHit + removeRoutes", () => {
  it("first matching route wins; method filters", () => {
    const routes = [
      route({ id: "a", method: "POST", response: { status: 201, body: "a" } }),
      route({ id: "b", method: null, response: { status: 200, body: "b" } }),
    ];
    expect(matchRequest(routes, { url: "http://h/api/items", method: "GET" })).toMatchObject({
      action: "fulfill",
      routeId: "b",
    });
    expect(matchRequest(routes, { url: "http://h/api/items", method: "POST" })).toMatchObject({
      action: "fulfill",
      routeId: "a",
    });
    expect(matchRequest(routes, { url: "http://h/nope", method: "GET" })).toEqual({ action: "pass" });
  });

  it("timesRemaining drops the route after the last hit", () => {
    const once = [route({ id: "t", timesRemaining: 1 })];
    const hit = matchRequest(once, { url: "http://h/api/items", method: "GET" });
    expect(hit.action).toBe("fulfill");
    if (hit.action !== "fulfill") return;
    const next = afterRouteHit(once, hit.routeId);
    expect(next).toHaveLength(0);
  });

  it("removeRoutes clears by id, pattern, or all", () => {
    const routes = [route({ id: "a", urlPattern: "*/a" }), route({ id: "b", urlPattern: "*/b" })];
    expect(removeRoutes(routes, { routeId: "a" }).next.map((r) => r.id)).toEqual(["b"]);
    expect(removeRoutes(routes, { urlPattern: "*/b" }).removed.map((r) => r.id)).toEqual(["b"]);
    expect(removeRoutes(routes, {}).next).toEqual([]);
  });
});
