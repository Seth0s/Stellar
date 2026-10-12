import { describe, expect, it } from "vitest";
import {
  EMPTY_SECTION,
  applyCache,
  applyFailure,
  applyLive,
  beginLoad,
  decideSectionState,
  groupSectionNotices,
  isDetailData,
  isListData,
  isOverviewData,
  overviewCacheBelongsTo,
  parseCacheEntry,
  sectionNotice,
  serializeCacheEntry,
  showsSkeleton,
  teamCacheKey,
  type SectionRecord,
  type TeamSection,
} from "../../src/renderer/src/team-load-decision";

const T0 = Date.UTC(2026, 9, 12, 14, 32);

describe("decideSectionState — what a section shows", () => {
  it("has no data and nothing back yet: loading (skeleton)", () => {
    expect(decideSectionState(EMPTY_SECTION)).toBe("loading");
    expect(decideSectionState(beginLoad(EMPTY_SECTION))).toBe("loading");
    expect(showsSkeleton(beginLoad(EMPTY_SECTION))).toBe(true);
  });

  it("has no data and the request failed: error, never an endless skeleton", () => {
    const failed = applyFailure(beginLoad(EMPTY_SECTION), "falha em tasks");
    expect(decideSectionState(failed)).toBe("error");
    expect(showsSkeleton(failed)).toBe(false);
  });

  it("data from the backend: ready", () => {
    expect(decideSectionState(applyLive(T0))).toBe("ready");
    expect(showsSkeleton(applyLive(T0))).toBe(false);
  });

  it("data from the cache is stale even while the refresh is in flight", () => {
    const cached = applyCache(EMPTY_SECTION, T0);
    expect(decideSectionState(cached)).toBe("stale");
    expect(decideSectionState(beginLoad(cached))).toBe("stale");
    expect(showsSkeleton(beginLoad(cached))).toBe(false);
  });

  it("a failed refresh over live data keeps the data, marked stale", () => {
    const failed = applyFailure(beginLoad(applyLive(T0)), "offline");
    expect(failed.source).toBe("live");
    expect(decideSectionState(failed)).toBe("stale");
  });

  it("a failed refresh over cached data stays stale (it was never confirmed)", () => {
    expect(decideSectionState(applyFailure(beginLoad(applyCache(EMPTY_SECTION, T0)), "offline"))).toBe("stale");
  });

  it("a new request clears the previous error: back to loading when nothing is shown, ready when live data is", () => {
    const failedEmpty = applyFailure(EMPTY_SECTION, "x");
    expect(decideSectionState(beginLoad(failedEmpty))).toBe("loading");
    const failedLive = applyFailure(applyLive(T0), "x");
    expect(decideSectionState(beginLoad(failedLive))).toBe("ready");
  });

  it("the backend answer after a failure or a cache makes the section ready", () => {
    const stale = applyFailure(beginLoad(applyCache(EMPTY_SECTION, T0)), "offline");
    expect(decideSectionState(applyLive(T0 + 5000))).toBe("ready");
    expect(applyLive(T0 + 5000).savedAtMs).toBe(T0 + 5000);
    expect(stale.savedAtMs).toBe(T0);
  });
});

describe("applyCache — the cache never wins over the backend", () => {
  it("does not replace data the backend already confirmed", () => {
    const live = applyLive(T0);
    expect(applyCache(live, T0 - 1000)).toBe(live);
  });

  it("does not replace an older cache either (first read wins)", () => {
    const cached = applyCache(EMPTY_SECTION, T0);
    expect(applyCache(cached, T0 + 1)).toBe(cached);
  });

  it("keeps the in-flight flag of a request already out", () => {
    const rec = applyCache(beginLoad(EMPTY_SECTION), T0);
    expect(rec.inFlight).toBe(true);
    expect(rec.source).toBe("cache");
  });
});

describe("sectionNotice — what the section says about its freshness", () => {
  it("says nothing while loading or ready", () => {
    expect(sectionNotice(EMPTY_SECTION, "pt-BR")).toBeNull();
    expect(sectionNotice(applyLive(T0), "pt-BR")).toBeNull();
  });

  it("stale carries the time of the last refresh, in the locale", () => {
    const notice = sectionNotice(applyCache(EMPTY_SECTION, T0), "pt-BR");
    expect(notice?.kind).toBe("stale");
    if (notice?.kind === "stale") {
      expect(notice.when).toMatch(/\d{2}\/\d{2}/);
      expect(notice.when).toMatch(/\d{2}:\d{2}/);
    }
  });

  it("stale over live data uses the time of the last confirmation", () => {
    const failed = applyFailure(applyLive(T0), "offline");
    const notice = sectionNotice(failed, "en");
    expect(notice?.kind).toBe("stale");
  });

  it("stale with no known time is stated, not invented", () => {
    const rec: SectionRecord = { source: "cache", inFlight: false, error: null, savedAtMs: null };
    expect(sectionNotice(rec, "pt-BR")).toEqual({ kind: "stale-unknown" });
  });

  it("an error with nothing to show carries the reason", () => {
    expect(sectionNotice(applyFailure(EMPTY_SECTION, "falha em tasks"), "pt-BR")).toEqual({ kind: "error", message: "falha em tasks" });
  });
});

describe("the on-machine cache", () => {
  it("round-trips what it wrote", () => {
    const raw = serializeCacheEntry([{ id: "t1" }], T0, null);
    const entry = parseCacheEntry(raw, isListData);
    expect(entry).toEqual({ data: [{ id: "t1" }], savedAtMs: T0, owner: null });
  });

  it("is no cache when the key is empty, the text is not JSON, or the shape is wrong", () => {
    expect(parseCacheEntry(null, isListData)).toBeNull();
    expect(parseCacheEntry("{nope", isListData)).toBeNull();
    expect(parseCacheEntry("[1,2]", isListData)).toBeNull();
    expect(parseCacheEntry(JSON.stringify({ data: [], savedAtMs: "ontem" }), isListData)).toBeNull();
    expect(parseCacheEntry(JSON.stringify({ data: { not: "a list" }, savedAtMs: T0 }), isListData)).toBeNull();
    expect(parseCacheEntry(JSON.stringify({ data: [], savedAtMs: null }), isListData)).toBeNull();
  });

  it("checks each section's own shape", () => {
    expect(isOverviewData({ teams: [], accountId: null, displayName: "A" })).toBe(true);
    expect(isOverviewData({ teams: "x" })).toBe(false);
    expect(isDetailData({ team: { id: "t" }, members: [] })).toBe(true);
    expect(isDetailData({ team: null, members: [] })).toBe(false);
    expect(isDetailData({ team: {}, members: "x" })).toBe(false);
  });

  it("keys a section by team, apart from the account's overview", () => {
    expect(teamCacheKey("tasks", "team-1")).not.toBe(teamCacheKey("tasks", "team-2"));
    expect(teamCacheKey("tasks", "team-1")).not.toBe(teamCacheKey("detail", "team-1"));
    expect(teamCacheKey("overview", "account")).toContain("overview");
  });

  it("shows the overview only to the account that saved it", () => {
    expect(overviewCacheBelongsTo("Ana", "Ana")).toBe(true);
    expect(overviewCacheBelongsTo("Ana", "Bruno")).toBe(false);
    expect(overviewCacheBelongsTo(null, "Ana")).toBe(false);
    expect(overviewCacheBelongsTo("Ana", null)).toBe(false);
  });
});

describe("groupSectionNotices — one line per distinct message", () => {
  const all = (over: Partial<Record<TeamSection, SectionRecord>>): Record<TeamSection, SectionRecord> => ({
    overview: EMPTY_SECTION,
    detail: EMPTY_SECTION,
    sprints: EMPTY_SECTION,
    invites: EMPTY_SECTION,
    tasks: EMPTY_SECTION,
    ...over,
  });

  it("a healthy page has nothing to say", () => {
    expect(groupSectionNotices(all({ overview: applyLive(T0), detail: applyLive(T0) }), "pt-BR")).toEqual([]);
  });

  it("sections saved in the same minute share one stale notice, in page order", () => {
    const cached = applyCache(EMPTY_SECTION, T0);
    const groups = groupSectionNotices(all({ tasks: cached, overview: cached, detail: applyCache(EMPTY_SECTION, T0 + 20_000) }), "pt-BR");
    expect(groups).toHaveLength(1);
    expect(groups[0].sections).toEqual(["overview", "detail", "tasks"]);
    expect(groups[0].notice.kind).toBe("stale");
  });

  it("different stamps stay apart", () => {
    const groups = groupSectionNotices(all({ overview: applyCache(EMPTY_SECTION, T0), tasks: applyCache(EMPTY_SECTION, T0 + 3 * 60_000) }), "pt-BR");
    expect(groups.map((g) => g.sections)).toEqual([["overview"], ["tasks"]]);
  });

  it("an error is never folded into a stale notice, and different failures stay apart", () => {
    const groups = groupSectionNotices(
      all({
        detail: applyCache(EMPTY_SECTION, T0),
        sprints: applyFailure(EMPTY_SECTION, "falha em sprints"),
        invites: applyFailure(EMPTY_SECTION, "falha em convites"),
      }),
      "pt-BR",
    );
    expect(groups.map((g) => [g.sections, g.notice.kind])).toEqual([
      [["detail"], "stale"],
      [["sprints"], "error"],
      [["invites"], "error"],
    ]);
  });

  it("the same failure in two sections is one notice", () => {
    const failed = applyFailure(EMPTY_SECTION, "sem conexão");
    const groups = groupSectionNotices(all({ detail: failed, tasks: failed }), "pt-BR");
    expect(groups).toHaveLength(1);
    expect(groups[0].sections).toEqual(["detail", "tasks"]);
  });
});
