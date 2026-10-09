import { describe, expect, it } from "vitest";
import {
  decideBrowserFooter,
  decideChangesFooter,
  decideChatFooter,
  decideFilesFooter,
  decideMediaFooter,
  decideStickyFooter,
  decideTaskFooter,
  decideTerminalFooter,
} from "../../src/renderer/src/card-footer-decision";

describe("card footer decisions", () => {
  it("keeps unknown terminal health measurements absent", () => {
    expect(decideTerminalFooter({ lastActivityAt: null, context: null, quota: null }, 10_000)).toEqual({
      activitySeconds: null,
      contextPercent: null,
      quotaLabel: null,
    });
  });

  it("shows measured terminal age, context window percentage, and quota", () => {
    expect(decideTerminalFooter({
      lastActivityAt: 7_500,
      context: { usedTokens: 340_000, windowTokens: 1_000_000 },
      quota: { text: "Plan: 77% used", percent: 77 },
    }, 10_000)).toEqual({ activitySeconds: 2, contextPercent: 34, quotaLabel: "cota 77%" });
  });

  it("shows the browser status, viewport, console counts, and offscreen pause", () => {
    expect(decideBrowserFooter({
      httpStatusCode: 200,
      viewport: { width: 1340, height: 837 },
      zoom: 1,
      consoleErrors: 0,
      consoleWarnings: 2,
      visible: false,
    })).toEqual({
      statusTone: "good",
      viewportLabel: "1340 × 837 · zoom 100%",
      consoleLabel: "console 0 erros · 2 avisos",
      paused: true,
    });
  });

  it("omits files git fields outside a repository and empty sibling count", () => {
    expect(decideFilesFooter({ repo: false, branch: "", changedEntries: 0, folderCardCount: 0 })).toEqual({
      branch: null,
      changedCount: null,
      folderCardCount: null,
    });
  });

  it("reports changes from git status without inventing task attribution", () => {
    expect(decideChangesFooter({ repo: true, branch: "main", insertions: 340, deletions: 52, changedFiles: 18 })).toEqual({
      branch: "main",
      insertions: 340,
      deletions: 52,
      changedFiles: 18,
      uncommitted: true,
    });
  });

  it("formats note edit age only when a persisted timestamp exists", () => {
    expect(decideStickyFooter(undefined, 120_000)).toBeNull();
    expect(decideStickyFooter(0, 120_000)).toBe("editada há 2 min");
  });

  it("uses only measured chat turn duration and token counts", () => {
    expect(decideChatFooter({ streaming: true, elapsedMs: 12_000, lastTurn: null })).toEqual({
      durationMs: 12_000,
      inputTokens: null,
      outputTokens: null,
    });
    expect(decideChatFooter({
      streaming: false,
      elapsedMs: 99_000,
      lastTurn: { durationMs: 4_000, inputTokens: 10, outputTokens: 20 },
    })).toEqual({ durationMs: 4_000, inputTokens: 10, outputTokens: 20 });
  });

  it("omits media dimensions and PDF page count until each source reports them", () => {
    expect(decideMediaFooter({ kind: "image", imageSize: null, zoom: 1, page: 1, pageCount: 0 })).toEqual({
      imageDimensions: null,
      zoomPercent: 100,
      pageLabel: null,
    });
    expect(decideMediaFooter({ kind: "pdf", imageSize: null, zoom: 1, page: 1, pageCount: 0 }).pageLabel).toBeNull();
    expect(decideMediaFooter({ kind: "pdf", imageSize: null, zoom: 1, page: 3, pageCount: 8 }).pageLabel).toBe("3/8");
  });

  it("counts only live tasks and uses explicit human/review signals", () => {
    const pulse = decideTaskFooter([
      { phase: "running", cardAlive: true, blockedQuestion: null, requestedStatus: null, review: null, cards: [], updatedAt: 60_000 },
      { phase: "running", cardAlive: false, blockedQuestion: null, requestedStatus: null, review: null, cards: [], updatedAt: 120_000 },
      { phase: "awaiting_review", cardAlive: false, blockedQuestion: null, requestedStatus: null, review: "wanted", cards: [], updatedAt: 180_000 },
    ], 240_000);
    expect(pulse).toEqual({ working: 1, review: 1, needsHuman: 1, latestAge: "há 1 min" });
  });
});
