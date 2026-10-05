import { describe, expect, it, vi } from "vitest";
import type { Entry, MediaType } from "../../shared/bridge/libraryTypes";
import { createRecapComposition, recapSupportsOrientation, updateRecapComposition, type RecapTemplateId } from "../../features/recap/domain/recap";
import { findRecapHitTarget, getRecapExportDimensions, layoutRecapScene, loadRecapScene, recapPageCount, resolveRecapSceneCovers, RECAP_EXPORT_MAX_DIMENSION, RECAP_EXPORT_MAX_PIXELS, RECAP_EXPORT_TARGET_LONG_EDGE, RECAP_MAX_DIMENSION } from "./renderer";

const types: MediaType[] = Array.from({ length: 7 }, (_, index) => ({
  id: "type-" + index, name: "Type " + index, sortOrder: index, iconKey: index === 0 ? "book-open" : "shape-circle",
  criterionIds: [], archivedAt: null, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
}));

const entries: Entry[] = types.flatMap((type, typeIndex) => Array.from({ length: 5 }, (_, index) => {
  const id = type.id + "-" + index;
  return {
    id, importOrder: null, version: 1, title: type.name + " story " + index,
    disposition: "experienced" as const, mediaTypeId: type.id, overallRating: 8 + ((typeIndex + index) % 3),
    coverAssetId: null,
    releaseDate: { year: 1960 + typeIndex * 10 + index, precision: "year" as const },
    reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}));

const tiers = [10, 9, 8].map((score) => ({
  score,
  placedIds: entries.filter((entry) => entry.overallRating === score).map((entry) => entry.id),
}));

function composition(templateId: RecapTemplateId, orientation: "portrait" | "landscape" = "portrait") {
  if (templateId === "releaseYear" || templateId === "decade") {
    return periodComposition(templateId, 6, orientation);
  }
  return createRecapComposition(templateId, entries, tiers, types, { kind: "all" }, {
    id: templateId + "-" + orientation, orientation, showTitles: true, now: "2026-01-01T00:00:00.000Z",
  });
}

function periodComposition(templateId: "releaseYear" | "decade", count: number, orientation: "portrait" | "landscape") {
  const base = createRecapComposition("topTen", entries, tiers, types, { kind: "all" }, {
    id: `${templateId}-base`, orientation: "landscape", showTitles: false, now: "2026-01-01T00:00:00.000Z",
  });
  const slots = Array.from({ length: count }, (_, index) => {
    const source = base.slots[index % base.slots.length];
    const value = templateId === "releaseYear" ? 2018 + index : 1980 + index * 10;
    return {
      ...source,
      id: `${templateId}-period-${index}`,
      page: 0,
      entry: { ...source.entry!, id: `period-entry-${index}`, title: `Period winner ${index}` },
      rank: null,
      label: templateId === "releaseYear" ? String(value) : `${value}s`,
      populationCount: 5 + index,
      predicate: templateId === "releaseYear" ? { kind: "year" as const, value } : { kind: "decade" as const, value },
      titleOverride: null,
    };
  });
  return { ...base, templateId, orientation, showTitles: false, slots };
}

function denseYearComposition(firstYear: number, lastYear: number) {
  const yearEntries: Entry[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (let work = 0; work < 5; work += 1) {
      const id = `year-${year}-${work}`;
      yearEntries.push({
        id, importOrder: null, version: 1, title: `${year} title ${work}`,
        disposition: "experienced", mediaTypeId: types[0].id, overallRating: 8,
        coverAssetId: null, releaseDate: { year, precision: "year" },
        reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  const model = createRecapComposition("releaseYear", yearEntries, [{ score: 8, placedIds: yearEntries.map(({ id }) => id) }], types, { kind: "all" }, {
    id: "dense-years", orientation: "landscape", showTitles: false,
  });
  return model;
}

function denseDecadeComposition(firstDecade: number, lastDecade: number) {
  const decadeEntries: Entry[] = [];
  for (let decade = firstDecade; decade <= lastDecade; decade += 10) {
    for (let work = 0; work < 5; work += 1) {
      const id = `decade-${decade}-${work}`;
      decadeEntries.push({
        id, importOrder: null, version: 1, title: `${decade}s title ${work}`,
        disposition: "experienced", mediaTypeId: types[0].id, overallRating: 8,
        coverAssetId: null, releaseDate: { year: decade + 1, precision: "year" },
        reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  return createRecapComposition("decade", decadeEntries, [{ score: 8, placedIds: decadeEntries.map(({ id }) => id) }], types, { kind: "all" }, {
    id: "dense-decades", orientation: "landscape", showTitles: false,
  });
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectSceneGeometry(template: RecapTemplateId, orientation: "portrait" | "landscape" = "portrait") {
  const model = composition(template, orientation);
  const pages = recapPageCount(model);
  expect(pages).toBeGreaterThan(0);
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const scene = layoutRecapScene(model, { pageIndex });
    expect(scene.pageIndex).toBe(pageIndex);
    expect(scene.pageCount).toBe(pages);
    expect(scene.width).toBeLessThanOrEqual(RECAP_MAX_DIMENSION);
    expect(scene.height).toBeLessThanOrEqual(RECAP_MAX_DIMENSION);
    for (const target of scene.hitTargets) {
      expect(target.x).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.x + target.width).toBeLessThanOrEqual(scene.width);
      expect(target.y + target.height).toBeLessThanOrEqual(scene.height);
      const expectedRatio = 2 / 3;
      expect(target.width / target.height).toBeCloseTo(expectedRatio, 2);
    }
    for (let first = 0; first < scene.hitTargets.length; first += 1) {
      for (let second = first + 1; second < scene.hitTargets.length; second += 1) {
        expect(overlaps(scene.hitTargets[first], scene.hitTargets[second])).toBe(false);
      }
    }
  }
}

describe("Recap Canvas2D layout scene", () => {
  it("derives both Top Ten canvases from full-bleed 2:3 portrait covers", () => {
    for (const orientation of ["portrait", "landscape"] as const) {
      const model = composition("topTen", orientation);
      const scene = layoutRecapScene(model);
      expect(scene.hitTargets).toHaveLength(10);
      expect(scene.width > scene.height).toBe(orientation === "landscape");
      const hero = scene.hitTargets.find((target) => target.entryId === model.slots[0].entry!.id)!;
      const smallest = Math.min(...scene.hitTargets.filter((target) => target !== hero).map((target) => target.width * target.height));
      expect(hero.width * hero.height).toBeGreaterThan(smallest * 8);
      expect(hero.width / hero.height).toBeCloseTo(2 / 3, 2);
      if (orientation === "landscape") {
        expect(hero.x).toBe(28);
        expect(hero.y).toBe(76);
        expect(scene.width).toBeGreaterThan(scene.height);
      } else {
        expect(hero.x).toBe(28);
        expect(hero.y).toBe(76);
        expect(scene.height).toBeGreaterThan(scene.width);
      }
      expectSceneGeometry("topTen", orientation);
    }
  });

  it("renders Library-style generated cover art and concise captions in cover mode", () => {
    const model = composition("topTen");
    const first = model.slots[0];
    const shortLabel = "BOTW";
    const personalized = {
      ...model,
      slots: model.slots.map((slot, index) => index === 0
        ? { ...slot, entry: { ...slot.entry!, title: "The Legend of Zelda: Breath of the Wild", shortLabel } }
        : slot),
    };
    const scene = layoutRecapScene(personalized);
    const placeholder = scene.nodes.find((node) => node.kind === "placeholder" && node.entryId === first.entry!.id);
    expect(placeholder).toMatchObject({ iconKey: "book-open", initial: "B", gradientStart: "#302e3a" });
    const caption = scene.nodes.find((node) => node.kind === "text" && node.entryId === first.entry!.id && node.text === "BOTW");
    expect(caption).toMatchObject({ fontSize: 18, color: "#f3f1f8", opacity: 0.84 });
    const captionBand = scene.nodes.find((node) => node.kind === "rect" && node.role === "captionBand" && node.x === 28);
    expect(captionBand).toMatchObject({ fill: "#15151a", opacity: 1 });
    expect(scene.nodes.some((node) => node.kind === "text" && node.text === "Type 0")).toBe(false);

    const namesOff = layoutRecapScene({ ...personalized, showTitles: false });
    expect(namesOff.nodes.some((node) => node.kind === "text" && node.entryId === first.entry!.id && node.text !== "#1")).toBe(false);
    expect(namesOff.nodes.some((node) => node.kind === "placeholder" && node.entryId === first.entry!.id)).toBe(true);
  });

  it("falls back to the generated cover art after a source asset cannot load", async () => {
    const model = composition("topTen");
    const heroId = model.slots[0].entry!.id;
    const broken = {
      ...model,
      showTitles: false,
      slots: model.slots.map((slot, index) => index === 0
        ? { ...slot, entry: { ...slot.entry!, coverAssetId: "missing-asset" } }
        : slot),
    };
    const scene = await loadRecapScene(broken, async () => null);
    expect(scene.nodes.some((node) => node.kind === "image" && node.entryId === heroId)).toBe(false);
    expect(scene.nodes.some((node) => node.kind === "placeholder" && node.entryId === heroId)).toBe(true);
    expect(scene.nodes.some((node) => node.kind === "text" && node.entryId === heroId && node.text !== "#1")).toBe(false);
  });

  it("paints layout synchronously and shows generated art only after a cover load fails", async () => {
    const model = composition("topTen");
    const heroId = model.slots[0].entry!.id;
    const withAsset = {
      ...model,
      slots: model.slots.map((slot, index) => index === 0
        ? { ...slot, entry: { ...slot.entry!, coverAssetId: "pending-asset" } }
        : slot),
    };
    const pending = layoutRecapScene(withAsset);
    const pendingImage = pending.nodes.find((node) => node.kind === "image" && node.entryId === heroId);
    expect(pendingImage).toMatchObject({ image: null, assetId: "pending-asset" });
    expect(pending.nodes.some((node) => node.kind === "placeholder" && node.entryId === heroId)).toBe(false);

    const resolved = await resolveRecapSceneCovers(pending, withAsset, async () => null);
    expect(resolved.nodes.some((node) => node.kind === "placeholder" && node.entryId === heroId)).toBe(true);
    expect(resolved.hitTargets).toEqual(pending.hitTargets);
    expect(pending.nodes.some((node) => node.kind === "image" && node.entryId === heroId)).toBe(true);
  });

  it("loads provider covers through the same canvas-safe image path as local assets", async () => {
    const originalImage = globalThis.Image;
    class LoadedImage {
      decoding = "";
      naturalWidth = 600;
      naturalHeight = 900;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decode() { return Promise.resolve(); }
      set src(_value: string) { this.onload?.(); }
    }
    globalThis.Image = LoadedImage as unknown as typeof Image;
    try {
      const model = composition("topTen");
      const original = model.slots[0].entry!;
      const remoteCover = {
        provider: "igdb",
        url: "https://images.igdb.com/igdb/image/upload/t_cover_big/recap-fixture.jpg",
        sourceUrl: "https://www.igdb.com/games/recap-fixture",
        attribution: "IGDB",
      };
      const remoteModel = {
        ...model,
        slots: model.slots.map((slot, index) => index === 0
          ? { ...slot, entry: { ...slot.entry!, coverAssetId: null, remoteCover } }
          : slot),
      };
      const layout = layoutRecapScene(remoteModel);
      expect(layout.nodes.find((node) => node.kind === "image" && node.entryId === original.id)).toMatchObject({
        assetId: expect.stringContaining("remote:igdb:"),
        remoteCover,
        image: null,
      });
      const loadCover = vi.fn(async () => "data:image/jpeg;base64,canvas-safe");
      const resolved = await resolveRecapSceneCovers(layout, remoteModel, loadCover);
      expect(loadCover).toHaveBeenCalledWith(original.id, null, remoteCover);
      expect(resolved.nodes.some((node) => node.kind === "image" && node.entryId === original.id && node.image instanceof LoadedImage)).toBe(true);
      expect(resolved.nodes.some((node) => node.kind === "placeholder" && node.entryId === original.id)).toBe(false);

      const localAssetId = "cfec0bc9556560431df85115b8ac7c2036aaf091862f9dcbf8a06de9b373337a";
      const localModel = {
        ...model,
        slots: model.slots.map((slot, index) => index === 0
          ? { ...slot, entry: { ...slot.entry!, coverAssetId: localAssetId, remoteCover: null } }
          : slot),
      };
      const localLoader = vi.fn(async () => "data:image/png;base64,local-jpeg-normalized-to-png");
      const localScene = await resolveRecapSceneCovers(layoutRecapScene(localModel), localModel, localLoader);
      expect(localLoader).toHaveBeenCalledWith(original.id, localAssetId, null);
      expect(localScene.nodes.some((node) => node.kind === "image" && node.entryId === original.id && node.image instanceof LoadedImage)).toBe(true);
    } finally {
      globalThis.Image = originalImage;
    }
  });

  it("uses an intentional text poster, always shows work names, and independently toggles type names", () => {
    const model = composition("topTen");
    const first = model.slots[0];
    const entry = { ...first.entry!, shortLabel: "Mushoku" };
    const textModel = {
      ...model, mode: "text" as const, showTitles: false, showMediaTypes: true,
      slots: model.slots.map((slot, index) => index === 0 ? { ...slot, entry } : slot),
    };
    const scene = layoutRecapScene(textModel);
    expect(scene.nodes.some((node) => node.kind === "text" && node.entryId === entry.id && node.text === "Mushoku")).toBe(true);
    expect(scene.nodes.some((node) => node.kind === "text" && node.text === "Type 0")).toBe(true);

    const noTypes = layoutRecapScene({ ...textModel, showMediaTypes: false });
    expect(noTypes.nodes.some((node) => node.kind === "text" && node.text === "Type 0")).toBe(false);
    expect(noTypes.nodes.some((node) => node.kind === "text" && node.entryId === entry.id && node.text === "Mushoku")).toBe(true);
  });

  it("keeps all templates inside the safe canvas with distinct portrait-cover hit targets", () => {
    expect(recapSupportsOrientation("grid3x3")).toBe(false);
    for (const template of ["topTen", "challengers", "grid3x3", "releaseYear", "decade", "format"] as const) {
      for (const orientation of ["portrait", "landscape"] as const) expectSceneGeometry(template, orientation);
    }

    const gridModel = composition("grid3x3", "landscape");
    expect(gridModel.orientation).toBe("portrait");
    const grid = layoutRecapScene(gridModel);
    const center = grid.hitTargets.find((target) => target.entryId === gridModel.slots[0].entry!.id)!;
    expect(center.width).toBeGreaterThan(grid.hitTargets[0].width);
    expect(center.x).toBeGreaterThan(grid.hitTargets[0].x);
    expect(center.y).toBeGreaterThan(grid.hitTargets[0].y);
  });

  it("reflows bounded period grids when switching orientation", () => {
    const timeline = composition("releaseYear", "landscape");
    expect(recapPageCount(timeline)).toBe(1);
    const portraitTimeline = updateRecapComposition(timeline, { orientation: "portrait" });
    expect(portraitTimeline.slots.map(({ id }) => id)).toEqual(timeline.slots.map(({ id }) => id));
    expect(recapPageCount(portraitTimeline)).toBe(1);
    expect(layoutRecapScene(portraitTimeline).height).toBeLessThan(RECAP_MAX_DIMENSION);

    const formats = composition("format", "landscape");
    expect(recapPageCount(formats)).toBe(2);
    expect(layoutRecapScene(formats, { pageIndex: 1 }).hitTargets.length).toBe(1);
    const portraitFormats = updateRecapComposition(formats, { orientation: "portrait" });
    expect(recapPageCount(portraitFormats)).toBe(2);

  });

  it("fills short format and year strips without artificial empty cells", () => {
    for (const count of [2, 6]) {
      const ids = types.slice(0, count).map((type) => type.id);
      for (const orientation of ["landscape", "portrait"] as const) {
        const model = createRecapComposition("format", entries, tiers, types, { kind: "types", typeIds: ids }, { orientation });
        const scene = layoutRecapScene(model);
        expect(scene.hitTargets).toHaveLength(count);
        for (const target of scene.hitTargets) expect(target.width / target.height).toBeCloseTo(2 / 3, 2);
        if (orientation === "landscape") expect(scene.width).toBeGreaterThan(scene.height);
        else expect(scene.height).toBeGreaterThan(scene.width);
        const textScene = layoutRecapScene({ ...model, mode: "text", showMediaTypes: false });
        expect(textScene.nodes.some((node) => node.kind === "text" && node.text === types[0].name)).toBe(false);
        const coverScene = layoutRecapScene({ ...model, showMediaTypes: false });
        expect(coverScene.nodes.some((node) => node.kind === "text" && node.text === types[0].name)).toBe(true);
      }
    }

    const yearStrip = periodComposition("releaseYear", 3, "landscape");
    const scene = layoutRecapScene(yearStrip);
    expect(scene.hitTargets).toHaveLength(3);
    expect(scene.width).toBeGreaterThan(scene.height);
  });

  it("keeps each period grid rectangular and shows population counts with cover titles disabled", () => {
    const expectedShapes: Record<number, { landscape: [number, number]; portrait: [number, number] }> = {
      2: { landscape: [2, 1], portrait: [1, 2] },
      3: { landscape: [3, 1], portrait: [1, 3] },
      4: { landscape: [4, 1], portrait: [2, 2] },
      6: { landscape: [3, 2], portrait: [2, 3] },
      8: { landscape: [4, 2], portrait: [2, 4] },
      9: { landscape: [3, 3], portrait: [3, 3] },
      12: { landscape: [6, 2], portrait: [3, 4] },
    };
    for (const templateId of ["releaseYear", "decade"] as const) for (const [countText, expected] of Object.entries(expectedShapes)) {
      const count = Number(countText);
      for (const orientation of ["landscape", "portrait"] as const) {
        const model = periodComposition(templateId, count, orientation);
        const scene = layoutRecapScene(model);
        const columns = new Set(scene.hitTargets.map(({ x }) => x)).size;
        const rows = new Set(scene.hitTargets.map(({ y }) => y)).size;
        expect([columns, rows]).toEqual(expected[orientation]);
        expect(scene.hitTargets).toHaveLength(count);
        expect(scene.nodes.some((node) => node.kind === "text" && node.text === "5 rated works")).toBe(true);
        expect(scene.hitTargets.every((target) => Math.abs(target.width / target.height - 2 / 3) < 0.01)).toBe(true);
        expect(scene.nodes.filter((node) => node.kind === "image").every((node) => node.fit === "contain")).toBe(true);
      }
    }
  });

  it("exports at print-friendly dimensions without changing logical preview bounds", () => {
    const regular = getRecapExportDimensions({ width: 800, height: 500 });
    expect(Math.max(regular.width, regular.height)).toBe(RECAP_EXPORT_TARGET_LONG_EDGE);
    expect(regular).toMatchObject({ width: 3200, height: 2000 });

    const bounded = getRecapExportDimensions({ width: 4096, height: 4096 });
    expect(Math.max(bounded.width, bounded.height)).toBeLessThanOrEqual(RECAP_EXPORT_MAX_DIMENSION);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(RECAP_EXPORT_MAX_PIXELS);
    for (const dimensions of [{ width: 3273, height: 3952 }, { width: 1224, height: 883 }, { width: 928, height: 2017 }]) {
      const output = getRecapExportDimensions(dimensions);
      expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(RECAP_EXPORT_MAX_DIMENSION);
      expect(output.width * output.height).toBeLessThanOrEqual(RECAP_EXPORT_MAX_PIXELS);
    }

    const preview = layoutRecapScene(periodComposition("releaseYear", 12, "landscape"));
    expect(preview.width).toBeLessThanOrEqual(RECAP_MAX_DIMENSION);
    expect(preview.height).toBeLessThanOrEqual(RECAP_MAX_DIMENSION);
    expect(Math.max(preview.width, preview.height)).toBeLessThan(RECAP_EXPORT_TARGET_LONG_EDGE);
  });

  it("caps a 37-year history at twelve consecutive years and includes the current 2020s", () => {
    const model = denseYearComposition(1990, 2026);
    expect(model.slots).toHaveLength(12);
    expect(model.slots[0].label).toBe("2015");
    expect(model.slots.at(-1)?.label).toBe("2026");
    expect(model.slots.every(({ populationCount }) => populationCount === 5)).toBe(true);
    const scene = layoutRecapScene(model);
    expect(scene.hitTargets).toHaveLength(12);
    expect(new Set(scene.hitTargets.map(({ x }) => x)).size).toBe(6);
    expect(new Set(scene.hitTargets.map(({ y }) => y)).size).toBe(2);
    expect(scene.nodes.some((node) => node.kind === "text" && node.text === "5 rated works")).toBe(true);
  });

  it("keeps the current decade in the consecutive Best of Each Decade grid", () => {
    const model = denseDecadeComposition(1980, 2020);
    expect(model.slots.map(({ label }) => label)).toEqual(["1990s", "2000s", "2010s", "2020s"]);
    expect(model.slots.every(({ populationCount }) => populationCount === 5)).toBe(true);
    const scene = layoutRecapScene(model);
    expect(scene.hitTargets).toHaveLength(4);
    expect(scene.nodes.some((node) => node.kind === "text" && node.text === "5 rated works")).toBe(true);
  });

  it("uses the same hit rectangles for editing and leaves removed works intentionally blank", () => {
    const model = composition("topTen");
    const empty = { ...model.slots[0], entry: null };
    const editable = { ...model, slots: [empty, ...model.slots.slice(1)] };
    const scene = layoutRecapScene(editable);
    const target = scene.hitTargets.find(({ slotId }) => slotId === empty.id)!;
    expect(target.entryId).toBeNull();
    expect(findRecapHitTarget(scene, target.x + target.width / 2, target.y + target.height / 2)).toMatchObject({ slotId: empty.id, entryId: null });
  });

  it("keeps a subtle top watermark and removes it from the shared scene when disabled", () => {
    const model = composition("grid3x3");
    const watermarked = layoutRecapScene(model);
    expect(watermarked.nodes.some((node) => node.kind === "text" && node.text === "Made with Tastellar" && node.y < 40)).toBe(true);
    const clean = layoutRecapScene(model, { watermark: false });
    expect(clean.nodes.some((node) => node.kind === "text" && node.text === "Made with Tastellar")).toBe(false);
  });
});
