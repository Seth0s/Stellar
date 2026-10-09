import { describe, expect, it } from "vitest";
import {
  ERROR_CONTEXT_TEXT_MAX_CHARS,
  buildErrorContext,
  pickConsoleTail,
  pickFailedRequests,
  summarizeVisibleText,
} from "../../src/main/browser-error-context-decision";
import { decideSpaNotFound } from "../../src/main/browser-navigate-decision";

describe("summarizeVisibleText + buildErrorContext", () => {
  it("collapses whitespace and announces truncation", () => {
    const long = "a ".repeat(ERROR_CONTEXT_TEXT_MAX_CHARS);
    const summary = summarizeVisibleText(long);
    expect(summary.truncated).toBe(true);
    expect(summary.text.length).toBe(ERROR_CONTEXT_TEXT_MAX_CHARS);
  });

  it("packs url, title, text, console tail, and failed requests", () => {
    const ctx = buildErrorContext({
      url: "http://x/app",
      title: "App",
      visibleTextRaw: "Hello   world",
      console: [
        { level: "error", message: "boom" },
        { level: "log", message: "ok" },
      ],
      network: [
        { method: "GET", url: "http://x/ok", status: 200 },
        { method: "POST", url: "http://x/fail", status: 500 },
      ],
    });
    expect(ctx.url).toBe("http://x/app");
    expect(ctx.visibleText).toBe("Hello world");
    expect(ctx.console.map((c) => c.message)).toContain("boom");
    expect(ctx.failedRequests).toEqual([{ method: "POST", url: "http://x/fail", status: 500 }]);
  });

  it("pick helpers keep only the tail", () => {
    expect(pickConsoleTail(Array.from({ length: 20 }, (_, i) => ({ level: "log", message: String(i) }))).length).toBe(8);
    expect(
      pickFailedRequests([
        { method: "GET", url: "/a", status: 200 },
        { method: "GET", url: "/b", status: 404 },
      ]),
    ).toHaveLength(1);
  });
});

describe("decideSpaNotFound", () => {
  it("flags document status 404", () => {
    expect(decideSpaNotFound({ title: "X", visibleText: "", documentStatus: 404 }).notFound).toBe(true);
  });

  it("flags a 404-looking title", () => {
    const r = decideSpaNotFound({ title: "404 — Not Found", visibleText: "", documentStatus: null });
    expect(r.notFound).toBe(true);
    expect(r.reason).toMatch(/title/i);
  });

  it("honours a text notFoundMarker", () => {
    const r = decideSpaNotFound({
      title: "App",
      visibleText: "Rota inexistente neste board",
      documentStatus: null,
      notFoundMarker: "Rota inexistente",
    });
    expect(r.notFound).toBe(true);
  });

  it("honours a matched selector marker", () => {
    const r = decideSpaNotFound({
      title: "App",
      visibleText: "",
      documentStatus: null,
      notFoundMarker: "[data-testid=not-found]",
      markerSelectorMatched: true,
    });
    expect(r.notFound).toBe(true);
  });

  it("does not flag a healthy page", () => {
    expect(
      decideSpaNotFound({ title: "Settings", visibleText: "Preferências da conta", documentStatus: 200 }).notFound,
    ).toBe(false);
  });
});
