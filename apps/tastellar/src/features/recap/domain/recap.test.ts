import { describe, expect, it } from "vitest";
import type { Entry, MediaType } from "../../../shared/bridge/libraryTypes";
import {
  createRecapComposition,
  getDefaultRecapOrientation,
  getRecapPeriodPosterGrid,
  getRecapPeriodPosterWindow,
  getVisibleRecapPeriodSlots,
  getCanonicalRecapEntries,
  getDefaultRecapStyle,
  getRecapReplacementCandidates,
  getRecapTemplates,
  getRatedRecapEntries,
  getRecapSourceFingerprint,
  normalizeRecapComposition,
  normalizeRecapFilter,
  recapSupportsOrientation,
  removeRecapSlotEntry,
  replaceRecapSlotEntry,
  swapRecapSlots,
  updateRecapComposition,
  type RecapRankedTier,
} from "./recap";

const makeEntry = (
  id: string,
  options: { score?: number | null; year?: number | null; typeId?: string | null; disposition?: Entry["disposition"]; tags?: string[] } = {},
): Entry => ({
  id,
  importOrder: null,
  version: 1,
  title: `Work ${id}`,
  disposition: options.disposition ?? "experienced",
  mediaTypeId: options.typeId === undefined ? "book" : options.typeId,
  overallRating: options.score === undefined ? 8 : options.score,
  coverAssetId: null,
  releaseDate: options.year == null ? null : { year: options.year, precision: "year" },
  reviewText: "",
  shortLabel: null,
  criterionRatings: {},
  tagIds: options.tags ?? [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeType = (id: string, sortOrder = 0): MediaType => ({
  id,
  name: id,
  sortOrder,
  iconKey: "shape-circle",
  criterionIds: [],
  archivedAt: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const rows = (entries: Entry[], tiers: readonly RecapRankedTier[], types = [makeType("book")]) =>
  getCanonicalRecapEntries(entries, tiers, types);

describe("Recap canonical source and sparse eligibility", () => {
  it("hides cover names by default and retains an explicit saved title choice", () => {
    const entry = makeEntry("title-default");
    const type = makeType("book");
    const tiers = [{ score: 8, placedIds: [entry.id] }];
    const created = createRecapComposition("topTen", [entry], tiers, [type]);
    expect(created.showTitles).toBe(false);

    const savedWithNames = normalizeRecapComposition({ ...created, showTitles: true }, [entry], [type]);
    expect(savedWithNames?.showTitles).toBe(true);

    const legacyWithoutPreference = { ...created } as Record<string, unknown>;
    delete legacyWithoutPreference.showTitles;
    expect(normalizeRecapComposition(legacyWithoutPreference, [entry], [type])?.showTitles).toBe(false);
  });

  it("normalizes legacy styles and hydrates only missing library labels/icons", () => {
    const entry = { ...makeEntry("legacy", { year: 2020 }), shortLabel: "HPMoR", coverAssetId: "saved-cover" };
    const type = { ...makeType("book"), iconKey: "book-open" as const };
    const original = createRecapComposition("topTen", [entry], [{ score: 8, placedIds: [entry.id] }], [type], undefined, {
      id: "legacy-draft", now: "2026-01-01T00:00:00.000Z",
    });
    const legacySlot = { ...original.slots[0], entry: { ...original.slots[0].entry! } };
    delete (legacySlot.entry as { shortLabel?: string | null }).shortLabel;
    delete (legacySlot.entry as { iconKey?: string | null }).iconKey;
    const legacy = {
      ...original,
      templateId: "selection",
      style: "paper",
      mode: "mixed",
      orientation: "landscape",
      slots: [legacySlot],
    };
    const normalized = normalizeRecapComposition(legacy, [entry], [type])!;
    expect(normalized).toMatchObject({ style: "reading", mode: "cover", orientation: "landscape" });
    expect(normalized.templateId).toBe("selection");
    expect(normalized.slots[0].entry).toMatchObject({
      id: entry.id, title: entry.title, shortLabel: "HPMoR", iconKey: "book-open", coverAssetId: "saved-cover",
    });
    expect(normalized.slots.map(({ id, rank }) => [id, rank])).toEqual(original.slots.map(({ id, rank }) => [id, rank]));
    expect(getDefaultRecapStyle("light")).toBe("daylight");
    expect(getDefaultRecapStyle("reading")).toBe("reading");
    expect(getDefaultRecapOrientation("releaseYear")).toBe("landscape");
    expect(getDefaultRecapOrientation("decade")).toBe("landscape");
    expect(recapSupportsOrientation("topTen")).toBe(true);
    expect(recapSupportsOrientation("grid3x3")).toBe(false);
    expect(recapSupportsOrientation("releaseYear")).toBe(true);
    expect(recapSupportsOrientation("decade")).toBe(true);
  });

  it("uses only active rated IDs in canonical tier order and applies media filters afterward", () => {
    const entries = [
      makeEntry("low", { score: 8, typeId: "film" }),
      makeEntry("top", { score: 10, typeId: "book" }),
      makeEntry("same-tier-first", { score: 10, typeId: "book" }),
      makeEntry("unplaced", { score: 9 }),
      makeEntry("planned", { score: 9, disposition: "planned" }),
      makeEntry("unrated", { score: null }),
    ];
    const tiers = [
      { score: 8, placedIds: ["low"] },
      { score: 10, placedIds: ["same-tier-first", "top", "top"] },
      { score: 9, placedIds: ["planned", "unrated"] },
    ];
    const types = [makeType("book"), makeType("film", 1)];

    expect(getCanonicalRecapEntries(entries, tiers, types).map(({ entry, rank }) => [entry.id, rank])).toEqual([
      ["same-tier-first", 1], ["top", 2], ["low", 3],
    ]);
    expect(getCanonicalRecapEntries(entries, tiers, types, { kind: "types", typeIds: ["film"] }).map(({ entry }) => entry.id)).toEqual(["low"]);
    expect(getCanonicalRecapEntries(entries, tiers, types, { kind: "types", typeIds: ["missing"] })).toEqual([]);
  });

  it("does not advertise a sparse Selection template and hides ranked templates below their minima", () => {
    const entries = [makeEntry("one"), makeEntry("unplaced", { score: 8 })];
    const catalog = getRecapTemplates(entries, [{ score: 8, placedIds: ["one"] }], [makeType("book")]);
    expect(catalog.ratedCount).toBe(2);
    expect(catalog.rankedCount).toBe(1);
    expect(catalog.templates.map(({ id }) => id)).toEqual(["topTen", "challengers", "grid3x3", "releaseYear", "decade", "format"]);
    expect(catalog.templates.find(({ id }) => id === "topTen")?.eligible).toBe(false);
  });

  it("combines media-type and any/all tag filters consistently across rated, canonical, catalog, replacement and fingerprints", () => {
    const entries = [
      makeEntry("both", { typeId: "book", tags: ["space", "magic"] }),
      makeEntry("space", { typeId: "book", tags: ["space"] }),
      makeEntry("film-magic", { typeId: "film", tags: ["magic"] }),
      makeEntry("other", { typeId: "book", tags: ["other"] }),
    ];
    const tiers = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const types = [makeType("book"), makeType("film", 1)];
    const any = { kind: "types" as const, typeIds: ["book"], tagIds: ["space", "magic"], tagMode: "any" as const };
    const all = { ...any, tagMode: "all" as const };
    expect(getRatedRecapEntries(entries, any).map(({ id }) => id)).toEqual(["both", "space"]);
    expect(getRatedRecapEntries(entries, all).map(({ id }) => id)).toEqual(["both"]);
    expect(getCanonicalRecapEntries(entries, tiers, types, all).map(({ entry }) => entry.id)).toEqual(["both"]);
    expect(getRecapTemplates(entries, tiers, types, all).ratedCount).toBe(1);
    const draft = createRecapComposition("topTen", entries, tiers, types, all, { id: "tagged" });
    expect(draft.filter).toEqual(all);
    expect(getRecapReplacementCandidates({ ...draft, slots: draft.slots.map((slot) => ({ ...slot, entry: null })) }, draft.slots[0].id, entries, tiers, types).map(({ id }) => id)).toEqual(["both"]);
    expect(getRecapSourceFingerprint(entries, tiers, types, any)).not.toBe(getRecapSourceFingerprint(entries, tiers, types, all));
    const tagMembershipChanged = entries.map((entry) => entry.id === "both" ? { ...entry, tagIds: ["space"] } : entry);
    expect(getRecapSourceFingerprint(entries, tiers, types, all)).not.toBe(getRecapSourceFingerprint(tagMembershipChanged, tiers, types, all));
    expect(getRatedRecapEntries(entries, { kind: "all", tagIds: ["space", "magic"] }).map(({ id }) => id)).toEqual(["both", "space", "film-magic"]);
    expect(normalizeRecapFilter({ kind: "all" })).toEqual({ kind: "all" });
    expect(normalizeRecapFilter({ kind: "types", typeIds: ["book"], tagIds: ["space"] })).toEqual({ kind: "types", typeIds: ["book"], tagIds: ["space"] });
    expect(normalizeRecapFilter({ kind: "types", typeIds: ["book"], tagMode: "neither" })).toBeNull();
    expect(normalizeRecapFilter({ kind: "all", tagIds: [""] })).toBeNull();
  });

  it("counts all rated works after filters and includes the current decade", () => {
    const entries = [
      ...[2018, 2021, 2022, 2023].flatMap((year) =>
        Array.from({ length: 5 }, (_, index) => makeEntry(`${year}-${index}`, { year }))),
      makeEntry("no-date", { year: null }),
    ];
    entries[11] = { ...entries[11], overallRating: 10 };
    const tiers = [
      { score: 10, placedIds: [entries[11].id] },
      { score: 8, placedIds: entries.filter((entry) => entry.id !== entries[11].id).map(({ id }) => id) },
    ];
    const catalog = getRecapTemplates(entries, tiers, [makeType("book")]);
    const years = catalog.templates.find(({ id }) => id === "releaseYear")!;
    const decades = catalog.templates.find(({ id }) => id === "decade")!;
    expect(years).toMatchObject({ eligible: true, eligibleCount: 3, missingReleaseDateCount: 1 });
    expect(years.periods).toEqual([
      { value: 2021, label: "2021", count: 5 },
      { value: 2022, label: "2022", count: 5 },
      { value: 2023, label: "2023", count: 5 },
    ]);
    expect(decades.periods).toEqual([
      { value: 2010, label: "2010s", count: 5 },
      { value: 2020, label: "2020s", count: 15 },
    ]);

    const timeline = createRecapComposition("releaseYear", entries, tiers, [makeType("book")]);
    expect(timeline.slots.map(({ label, entry, populationCount }) => [label, entry?.id, populationCount])).toEqual([
      ["2021", "2021-0", 5], ["2022", "2022-1", 5], ["2023", "2023-0", 5],
    ]);
  });

  it("uses the newest uninterrupted qualifying run and permits one qualifying year", () => {
    const spacedEntries = [
      ...[2018, 2020, 2022].flatMap((year) =>
        Array.from({ length: 5 }, (_, index) => makeEntry(`${year}-${index}`, { year }))),
      ...Array.from({ length: 4 }, (_, index) => makeEntry(`2024-low-${index}`, { year: 2024, score: 7 })),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`2026-${index}`, { year: 2026 })),
    ];
    const tiers = [{ score: 8, placedIds: spacedEntries.map(({ id }) => id) }];
    const catalog = getRecapTemplates(spacedEntries, tiers, [makeType("book")]);
    expect(catalog.templates.find(({ id }) => id === "releaseYear")).toMatchObject({ eligible: true, eligibleCount: 1, periods: [
      { value: 2026, label: "2026", count: 5 },
    ] });
    expect(catalog.templates.find(({ id }) => id === "decade")).toMatchObject({ eligible: true, periods: [
      { value: 2010, label: "2010s", count: 5 },
      { value: 2020, label: "2020s", count: 19 },
    ] });

    const sparseOnly = spacedEntries.filter((entry) => entry.releaseDate?.year === 2024 || entry.releaseDate?.year === 2026);
    const sparseOnlyTiers = [{ score: 8, placedIds: sparseOnly.map(({ id }) => id) }];
    const sparseCatalog = getRecapTemplates(sparseOnly, sparseOnlyTiers, [makeType("book")]);
    expect(sparseCatalog.templates.find(({ id }) => id === "releaseYear")).toMatchObject({ eligible: true, eligibleCount: 1, periods: [
      { value: 2026, label: "2026", count: 5 },
    ] });
    expect(createRecapComposition("releaseYear", sparseOnly, sparseOnlyTiers, [makeType("book")]).slots.map(({ label }) => label)).toEqual(["2026"]);

    const laterRunEntries = [
      makeEntry("2009-high", { year: 2009, score: 8 }),
      makeEntry("2010-low", { year: 2010, score: 7 }),
      ...Array.from({ length: 16 }, (_, index) => makeEntry(`later-${2011 + index}`, { year: 2011 + index, score: 8 })),
    ];
    const laterRunTiers = [8, 7].map((score) => ({
      score,
      placedIds: laterRunEntries.filter((entry) => entry.overallRating === score).map(({ id }) => id),
    }));
    const laterRun = createRecapComposition("releaseYear", laterRunEntries, laterRunTiers, [makeType("book")]);
    expect(laterRun.slots.map(({ label }) => label)).toEqual(Array.from({ length: 16 }, (_, index) => String(2011 + index)));
  });

  it("includes a period for one rating of 8 and excludes periods with only 7s", () => {
    const entries = [
      makeEntry("2000-low-0", { year: 2001, score: 7 }),
      makeEntry("2000-low-1", { year: 2002, score: 7 }),
      makeEntry("2000-low-2", { year: 2003, score: 7 }),
      makeEntry("2000-low-3", { year: 2004, score: 7 }),
      makeEntry("2000-low-4", { year: 2005, score: 7 }),
      makeEntry("2010-single-high", { year: 2018, score: 8 }),
      makeEntry("2020-high-and-lows-0", { year: 2020, score: 8 }),
      ...Array.from({ length: 4 }, (_, index) => makeEntry(`2020-high-and-lows-low-${index}`, { year: 2020, score: 7 })),
      makeEntry("2021-single-high", { year: 2021, score: 8 }),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`2022-only-low-${index}`, { year: 2022, score: 7 })),
    ];
    const tiers = [8, 7].map((score) => ({
      score,
      placedIds: entries.filter((entry) => entry.overallRating === score).map(({ id }) => id),
    }));
    const catalog = getRecapTemplates(entries, tiers, [makeType("book")]);
    const years = catalog.templates.find(({ id }) => id === "releaseYear")!;
    const decades = catalog.templates.find(({ id }) => id === "decade")!;

    expect(years.periods).toEqual([
      { value: 2020, label: "2020", count: 5 },
      { value: 2021, label: "2021", count: 1 },
    ]);
    expect(decades.periods).toEqual([
      { value: 2010, label: "2010s", count: 1 },
      { value: 2020, label: "2020s", count: 11 },
    ]);
  });

  it("includes unplaced 8+ periods and keeps canonical ranking when a bucket has one", () => {
    const entries = [
      makeEntry("unplaced-2013", { year: 2013, score: 9 }),
      makeEntry("ranked-low-2012", { year: 2012, score: 7 }),
      makeEntry("ranked-2014", { year: 2014, score: 8 }),
      makeEntry("unplaced-higher-2014", { year: 2014, score: 10 }),
      makeEntry("unplaced-low-2020", { year: 2020, score: 7 }),
    ];
    const tiers = [
      { score: 8, placedIds: ["ranked-2014"] },
      { score: 7, placedIds: ["ranked-low-2012"] },
    ];
    const types = [makeType("book")];
    const catalog = getRecapTemplates(entries, tiers, types);
    const years = catalog.templates.find(({ id }) => id === "releaseYear")!;
    expect(years).toMatchObject({ eligible: true, eligibleCount: 2, requiredCount: 1, periods: [
      { value: 2013, label: "2013", count: 1 },
      { value: 2014, label: "2014", count: 2 },
    ] });

    const composition = createRecapComposition("releaseYear", entries, tiers, types);
    expect(composition.slots.map(({ label, entry, rank }) => [label, entry?.id, rank])).toEqual([
      ["2013", "unplaced-2013", null],
      ["2014", "ranked-2014", null],
    ]);
  });

  it("keeps the newest qualifying run in one complete-row poster", () => {
    const entries = Array.from({ length: 14 * 6 }, (_, index) => {
      const year = 2013 + Math.floor(index / 6);
      return makeEntry(`${year}-${index % 6}`, { year, tags: [index % 6 < 5 ? "included" : "excluded"] });
    });
    const tiers = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const catalog = getRecapTemplates(entries, tiers, [makeType("book")], { kind: "all", tagIds: ["included"] });
    const releaseYear = catalog.templates.find(({ id }) => id === "releaseYear")!;
    expect(releaseYear.eligibleCount).toBe(14);
    expect(releaseYear.requiredCount).toBe(1);
    expect(releaseYear.periods.map(({ value }) => value)).toEqual(Array.from({ length: 14 }, (_, index) => 2013 + index));
    expect(catalog.templates.find(({ id }) => id === "decade")?.periods).toEqual([
      { value: 2010, label: "2010s", count: 35 },
      { value: 2020, label: "2020s", count: 35 },
    ]);
    const composition = createRecapComposition("releaseYear", entries, tiers, [makeType("book")], { kind: "all", tagIds: ["included"] });
    expect(composition.slots.map(({ label, page }) => [label, page])).toEqual(
      Array.from({ length: 14 }, (_, index) => [String(2013 + index), 0]),
    );
    expect(getVisibleRecapPeriodSlots(composition.slots, "landscape").map(({ label }) => label))
      .toEqual(Array.from({ length: 14 }, (_, index) => String(2013 + index)));
  });

  it("crops only the oldest periods to complete equal rows and keeps the newest year", () => {
    for (let available = 1; available <= 50; available += 1) {
      for (const orientation of ["landscape", "portrait"] as const) {
        const grid = getRecapPeriodPosterGrid(available, orientation);
        const window = getRecapPeriodPosterWindow(
          Array.from({ length: available }, (_, index) => index),
          orientation,
        );
        expect(grid.rows * grid.columns).toBe(grid.count);
        expect(grid.count).toBeLessThanOrEqual(available);
        expect(window).toHaveLength(grid.count);
        expect(window.at(-1)).toBe(available - 1);
        expect(window[0]).toBe(available - grid.count);
        if (available === 1) {
          expect(grid).toMatchObject({ rows: 1, columns: 1 });
        } else {
          expect(grid.rows).toBeGreaterThanOrEqual(2);
          expect(grid.rows).toBeLessThanOrEqual(4);
        }
      }
    }

    const expectedLandscape: Array<[number, number, number]> = [
      [13, 12, 2015],
      [17, 16, 2011],
      [22, 21, 2006],
      [24, 24, 2003],
      [37, 32, 1995],
    ];
    for (const [available, visible, firstYear] of expectedLandscape) {
      const periods = Array.from({ length: available }, (_, index) => ({
        value: 2026 - available + 1 + index,
        label: String(2026 - available + 1 + index),
        count: 1,
      }));
      const grid = getRecapPeriodPosterGrid(available, "landscape");
      const poster = getVisibleRecapPeriodSlots(
        periods.map((period) => ({
          id: period.label,
          page: 0,
          entry: null,
          rank: null,
          label: period.label,
          populationCount: period.count,
          predicate: { kind: "year" as const, value: period.value },
          titleOverride: null,
        })),
        "landscape",
      );
      expect(grid.count).toBe(visible);
      expect(grid.rows * grid.columns).toBe(visible);
      expect(poster).toHaveLength(visible);
      expect(poster[0].label).toBe(String(firstYear));
      expect(poster.at(-1)?.label).toBe("2026");
    }

    const twentyTwoYears = Array.from({ length: 22 }, (_, index) =>
      makeEntry(`year-${2005 + index}`, { year: 2005 + index }),
    );
    const tiers = [{ score: 8, placedIds: twentyTwoYears.map(({ id }) => id) }];
    const catalog = getRecapTemplates(twentyTwoYears, tiers, [makeType("book")]);
    const years = catalog.templates.find(({ id }) => id === "releaseYear")!;
    expect(years.eligibleCount).toBe(21);
    expect(years.periods.map(({ value }) => value)).toEqual(
      Array.from({ length: 21 }, (_, index) => 2006 + index),
    );

    const fullDraft = createRecapComposition("releaseYear", twentyTwoYears, tiers, [makeType("book")]);
    const portraitDraft = updateRecapComposition(fullDraft, { orientation: "portrait" });
    const returnedToLandscape = updateRecapComposition(portraitDraft, { orientation: "landscape" });
    expect(getVisibleRecapPeriodSlots(fullDraft.slots, "landscape").map(({ label }) => label))
      .toEqual(Array.from({ length: 21 }, (_, index) => String(2006 + index)));
    expect(getVisibleRecapPeriodSlots(portraitDraft.slots, "portrait")).toHaveLength(20);
    expect(getVisibleRecapPeriodSlots(returnedToLandscape.slots, "landscape").map(({ label }) => label))
      .toEqual(Array.from({ length: 21 }, (_, index) => String(2006 + index)));
  });

  it("preserves every period while changing the display orientation", () => {
    const entries = Array.from({ length: 9 * 5 }, (_, index) => {
      const year = 2018 + Math.floor(index / 5);
      return makeEntry(`${year}-${index % 5}`, { year });
    });
    const tiers = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const types = [makeType("book")];
    const yearCatalog = getRecapTemplates(entries, tiers, types).templates.find(({ id }) => id === "releaseYear")!;
    expect(yearCatalog.periods.map(({ value }) => value)).toEqual(Array.from({ length: 9 }, (_, index) => 2018 + index));
    expect(yearCatalog.periods.reduce((total, period) => total + period.count, 0)).toBe(45);

    const horizontal = createRecapComposition("releaseYear", entries, tiers, types);
    expect(horizontal.slots.map(({ predicate }) => predicate.kind === "year" ? predicate.value : null)).toEqual(yearCatalog.periods.map(({ value }) => value));
    const vertical = createRecapComposition("releaseYear", entries, tiers, types, undefined, { orientation: "portrait" });
    expect(vertical.slots).toHaveLength(9);
    const switchedToHorizontal = updateRecapComposition(vertical, { orientation: "landscape" });
    expect(switchedToHorizontal.slots).toHaveLength(9);
    expect(switchedToHorizontal.slots.at(-1)?.label).toBe("2026");

    const reopenedPortrait = normalizeRecapComposition({ ...vertical, orientationChosen: true }, entries, types)!;
    expect(reopenedPortrait).toMatchObject({ orientation: "portrait", orientationChosen: true });
    expect(reopenedPortrait.slots).toHaveLength(9);
    const migratedLegacyPortrait = normalizeRecapComposition({ ...vertical, orientationChosen: undefined }, entries, types)!;
    expect(migratedLegacyPortrait).toMatchObject({ orientation: "landscape", orientationChosen: false });
    expect(migratedLegacyPortrait.slots).toHaveLength(9);
  });

  it("expands untouched legacy period drafts and preserves edited snapshots", () => {
    const entries = Array.from({ length: 14 * 6 }, (_, index) => {
      const year = 2013 + Math.floor(index / 6);
      return makeEntry(`${year}-${index % 6}`, { year, tags: [index % 6 < 5 ? "selected" : "excluded"] });
    });
    const tiers = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const filter = { kind: "all" as const, tagIds: ["selected"] };
    const created = createRecapComposition("releaseYear", entries, tiers, [makeType("book")], filter);
    const legacySlots = created.slots
      .filter(({ predicate }) => predicate.kind === "year" && predicate.value >= 2015)
      .map(({ populationCount: _populationCount, ...slot }) => slot);
    const normalized = normalizeRecapComposition({ ...created, slots: legacySlots }, entries, [makeType("book")])!;
    expect(normalized.slots.map(({ label, populationCount, page }) => [label, populationCount, page])).toEqual(
      Array.from({ length: 14 }, (_, index) => [String(2013 + index), 5, 0]),
    );
    expect(normalizeRecapComposition(created, [], [makeType("book")])?.slots).toEqual([]);

    const edited = normalizeRecapComposition({
      ...created,
      updatedAt: "2026-01-02T00:00:00.000Z",
      slots: legacySlots,
    }, entries, [makeType("book")])!;
    expect(edited.slots.map(({ label, page }) => [label, page])).toEqual(
      Array.from({ length: 12 }, (_, index) => [String(2015 + index), 0]),
    );
  });

  it("migrates legacy decade defaults to horizontal while preserving an explicit newer choice", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`2010-${index}`, { year: 2011 })),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`2020-${index}`, { year: 2021 })),
    ];
    const tiers = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const created = createRecapComposition("decade", entries, tiers, [makeType("book")]);
    const oldDraft = normalizeRecapComposition({ ...created, orientation: "portrait" }, entries, [makeType("book")])!;
    expect(oldDraft).toMatchObject({ orientation: "landscape", orientationChosen: false });

    const changed = updateRecapComposition(created, { orientation: "portrait" });
    expect(changed).toMatchObject({ orientation: "portrait", orientationChosen: true });
    const reopened = normalizeRecapComposition(changed, entries, [makeType("book")])!;
    expect(reopened).toMatchObject({ orientation: "portrait", orientationChosen: true });
  });

  it("counts five ratings per active format but requires a canonical winner", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`book-${index}`, { typeId: "book" })),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`film-${index}`, { typeId: "film" })),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`custom-${index}`, { typeId: "custom" })),
      ...Array.from({ length: 5 }, (_, index) => makeEntry(`unplaced-${index}`, { typeId: "unplaced" })),
    ];
    const types = [makeType("book"), makeType("film", 1), makeType("custom", 2), makeType("unplaced", 3)];
    types[2] = { ...types[2], name: "My own format" };
    const tiers = [{ score: 8, placedIds: ["book-0", "film-0", "custom-0"] }];
    const catalog = getRecapTemplates(entries, tiers, types);
    expect(catalog.templates.find(({ id }) => id === "format")).toMatchObject({ eligible: true, eligibleCount: 3 });
    const composition = createRecapComposition("format", entries, tiers, types);
    expect(composition.slots.map(({ label, entry }) => [label, entry?.id])).toEqual([
      ["book", "book-0"], ["film", "film-0"], ["My own format", "custom-0"],
    ]);
  });

  it("keeps empty slots editable and prevents cross-predicate swaps, invalid replacements, and duplicates", () => {
    const entries = [
      ...[2018, 2019, 2020].flatMap((year) =>
        Array.from({ length: 5 }, (_, index) => makeEntry(`${year}-${index}`, { year }))),
      makeEntry("available-unplaced", { year: 2018 }),
    ];
    const tiers = [{ score: 8, placedIds: ["2018-0", "2019-0", "2020-0"] }];
    const types = [makeType("book")];
    const timeline = createRecapComposition("releaseYear", entries, tiers, types);
    expect(getRecapReplacementCandidates(timeline, timeline.slots[0].id, entries, tiers, types).map(({ id }) => id)).toContain("available-unplaced");
    expect(swapRecapSlots(timeline, timeline.slots[0].id, timeline.slots[1].id)).toBe(timeline);
    const emptied = removeRecapSlotEntry(timeline, timeline.slots[0].id);
    expect(emptied.slots[0]).toMatchObject({ entry: null, rank: null, label: "2018" });
    expect(emptied.slots).toHaveLength(3);
    const replacement = getRecapReplacementCandidates(emptied, emptied.slots[0].id, entries, tiers, types);
    expect(replacement.map(({ id }) => id)).toContain("2018-0");
    expect(replacement.map(({ id }) => id)).toContain("available-unplaced");
    expect(replaceRecapSlotEntry(emptied, emptied.slots[0].id, replacement[0]).rankingLabel).toBe("mySelection");
    const illegalReplacement = replaceRecapSlotEntry(emptied, emptied.slots[0].id, {
      id: "2019-0", title: "Work 2019-0", mediaTypeId: "book", mediaTypeName: "book", year: 2019, coverAssetId: null,
    });
    expect(illegalReplacement).toBe(emptied);

    const grid = createRecapComposition("grid3x3", entries, tiers, types);
    const swap = swapRecapSlots(grid, grid.slots[0].id, grid.slots[1].id);
    expect(swap.slots[0].entry?.id).toBe("2019-0");
    expect(swap.slots[0].rank).toBe(1);
    expect(swap.rankingLabel).toBe("mySelection");
    const duplicate = replaceRecapSlotEntry(grid, grid.slots[0].id, grid.slots[1].entry!);
    expect(duplicate).toBe(grid);
  });
});
