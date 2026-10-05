import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

type SampleArchive = {
  library: {
    revision: number;
    entries: Array<{ id: string; disposition: string; overallRating: number | null }>;
    mediaTypes: unknown[];
    criteria: unknown[];
    tags: unknown[];
  };
  history: {
    groupOrder: Array<{ entryId: string; groupId: string; orderKey: string }>;
    ranking: {
      entries: Array<{ entryId: string; score: number; placed: boolean }>;
      tiers: Array<{ score: number; inputSequence: number }>;
    };
  };
};

function readSampleArchive(): SampleArchive | null {
  const path = process.env.TASTELLAR_RECAP_SAMPLE ?? process.env.TASTELLAR_ANALYTICS_SAMPLE;
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SampleArchive;
}

async function seedArchive(page: Page, archive: SampleArchive) {
  // The supplied save has no tags, so add deterministic preview-only tags to
  // prove the Recap filters against actual matching entries.
  const taggedLibrary = {
    ...archive.library,
    tags: [
      { id: "recap-tag-alpha", name: "Recap Alpha" },
      { id: "recap-tag-beta", name: "Recap Beta" },
    ],
    entries: archive.library.entries.map((entry, index) => ({
      ...entry,
      tagIds: [
        ...(index % 2 === 0 ? ["recap-tag-alpha"] : []),
        ...(index % 3 === 0 ? ["recap-tag-beta"] : []),
      ],
    })),
  };
  const rated = archive.library.entries.filter((entry) =>
    entry.disposition === "experienced" && Number.isInteger(entry.overallRating),
  );
  const placements = archive.history.ranking.entries;
  const placementById = new Map(placements.map((item) => [item.entryId, item]));
  const orderById = new Map(archive.history.groupOrder.map((item) => [item.entryId, item.orderKey]));
  const tierOrders = Array.from({ length: 10 }, (_, index) => {
    const score = 10 - index;
    const ids = rated.filter((entry) => entry.overallRating === score).map((entry) => entry.id);
    ids.sort((a, b) => (orderById.get(a) ?? "").localeCompare(orderById.get(b) ?? ""));
    return [score, {
      placed: ids.filter((id) => placementById.get(id)?.placed),
      unplaced: ids.filter((id) => !placementById.get(id)?.placed),
    }];
  });
  await page.addInitScript(({ library, rankingEntries, rankingTiers, tierOrders }) => {
    sessionStorage.setItem("tastellar.preview.revision.v1", String(library.revision));
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify(library));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: rankingEntries.map((item) => [item.entryId, { score: item.score, placed: item.placed }]),
      tierOrders,
      sequences: rankingTiers.map((tier) => [tier.score, tier.inputSequence]),
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  }, {
    library: taggedLibrary,
    rankingEntries: placements,
    rankingTiers: archive.history.ranking.tiers,
    tierOrders,
  });
}

async function openRecap(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Recap", exact: true }).click();
  await expect(page.locator(".recap-page")).toBeVisible();
}

async function expectPngDimensions(page: Page, width: number, height: number) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export image" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("tastellar-recap.png");
  const path = await download.path();
  expect(path).toBeTruthy();
  const png = readFileSync(path!);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const longestEdge = Math.max(width, height);
  const scale = Math.min(
    Math.max(1, 3200 / longestEdge),
    4096 / longestEdge,
    Math.sqrt(12_000_000 / (width * height)),
  );
  const actualWidth = png.readUInt32BE(16);
  const actualHeight = png.readUInt32BE(20);
  expect(actualWidth).toBe(Math.max(1, Math.floor(width * scale + 1e-7)));
  expect(actualHeight).toBe(Math.max(1, Math.floor(height * scale + 1e-7)));
  expect(Math.max(actualWidth, actualHeight)).toBeGreaterThanOrEqual(Math.min(2560, longestEdge));
  expect(actualWidth * actualHeight).toBeLessThanOrEqual(12_000_000);
  console.log("Recap PNG export dimensions", JSON.stringify([actualWidth, actualHeight]));
}

async function expectCanvasPainted(canvas: Locator) {
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    return Boolean(element.width && element.height && context?.getImageData(
      Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1,
    ).data[3]);
  })).toBe(true);
}

test.use({ acceptDownloads: true });

test("Recap feed, editor, and export share a content-sized composition", async ({ page }) => {
  test.setTimeout(90_000);
  const archive = readSampleArchive();
  test.skip(!archive, "Set TASTELLAR_RECAP_SAMPLE to the supplied Tastellar save.");
  await seedArchive(page, archive!);
  await openRecap(page);

  await expect(page.locator(".recap-count")).toContainText("248 rated works");
  await expect(page.locator(".folder-shell:visible")).toHaveCount(0);
  const galleryTemplates = page.locator(".recap-feed-section");
  await expect(galleryTemplates.filter({ has: page.getByRole("heading", { name: "Top ten media" }) })).toHaveCount(1);
  await expect(galleryTemplates.filter({ has: page.getByRole("heading", { name: "The Throne and Its Challengers" }) })).toHaveCount(1);
  await expect(galleryTemplates.filter({ has: page.getByRole("heading", { name: "My #1 by Release Year" }) })).toHaveCount(0);
  await expect(galleryTemplates.filter({ has: page.getByRole("heading", { name: "Best of Each Decade" }) })).toHaveCount(0);
  await expect(galleryTemplates.filter({ has: page.getByRole("heading", { name: "Personal selection" }) })).toHaveCount(0);
  await expect(page.locator(".recap-gallery-style-segmented")).toHaveCount(0);
  const topTenFeed = page.locator('.recap-feed-section[data-recap-template="topTen"]');
  const feedCanvas = topTenFeed.locator("canvas");
  await topTenFeed.scrollIntoViewIfNeeded();
  await expectCanvasPainted(feedCanvas);
  const feedDimensions = await feedCanvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(feedDimensions[0]).toBeGreaterThan(feedDimensions[1]);
  const feedFitsViewport = await feedCanvas.evaluate((element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect();
    return { right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  expect(feedFitsViewport.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(feedFitsViewport.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const feedPixels = await feedCanvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/recap-redesign-gallery-user-save.png", fullPage: true, animations: "disabled" });

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const themePixels = new Set<string>();
  for (const [theme, style, screenshotName] of [
    ["Daylight", "Light", "daylight"],
    ["Dusk", "Dusk", "dusk"],
    ["Reading", "Reading", "reading"],
    ["Midnight", "Dark", "dark"],
  ]) {
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".theme-option").filter({ hasText: theme }).click();
    await nav.getByRole("button", { name: "Recap", exact: true }).click();
    await topTenFeed.scrollIntoViewIfNeeded();
    await expectCanvasPainted(topTenFeed.locator("canvas"));
    themePixels.add(await topTenFeed.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL()));
    await topTenFeed.screenshot({ path: `test-results/recap-gallery-${screenshotName}.png`, animations: "disabled" });
  }
  expect(themePixels.size).toBe(4);

  await topTenFeed.locator(".recap-feed-poster").click();
  const canvas = page.locator(".recap-stage-canvas");
  await expect(canvas).toHaveAttribute("aria-label", "Preview");
  await expectCanvasPainted(canvas);
  const slotHits = page.locator(".recap-slot-hit");
  const firstHit = slotHits.nth(0);
  const secondHit = slotHits.nth(1);
  await expect(slotHits).toHaveCount(10);
  await expect(slotHits.locator('[aria-pressed="true"]')).toHaveCount(0);
  const overlayAlignment = await firstHit.evaluate((hit) => {
    const canvas = hit.parentElement?.querySelector("canvas");
    if (!canvas) throw new Error("Recap slot overlay has no canvas sibling");
    const canvasRect = canvas.getBoundingClientRect();
    const hitRect = hit.getBoundingClientRect();
    const style = (hit as HTMLButtonElement).style;
    return {
      actual: [
        (hitRect.left - canvasRect.left) / canvasRect.width * 100,
        (hitRect.top - canvasRect.top) / canvasRect.height * 100,
        hitRect.width / canvasRect.width * 100,
        hitRect.height / canvasRect.height * 100,
      ],
      expected: [style.left, style.top, style.width, style.height].map((value) => parseFloat(value)),
    };
  });
  overlayAlignment.actual.forEach((value, index) => expect(Math.abs(value - overlayAlignment.expected[index])).toBeLessThan(0.15));
  let dimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(dimensions).toEqual(feedDimensions);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(feedPixels);
  expect(dimensions).not.toEqual([1080, 1920]);
  await expect(page.locator(".recap-library-changed")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Tastellar watermark" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Horizontal", exact: true })).toHaveAttribute("aria-pressed", "true");
  const orientationControl = await page.getByRole("button", { name: "Horizontal", exact: true }).evaluate((button) => {
    const group = button.parentElement!;
    const widths = [...group.querySelectorAll("button")].map((option) => option.getBoundingClientRect().width);
    return { groupWidth: group.getBoundingClientRect().width, widths };
  });
  expect(orientationControl.groupWidth).toBeGreaterThan(220);
  expect(orientationControl.widths.length).toBe(2);
  expect(Math.max(...orientationControl.widths) - Math.min(...orientationControl.widths)).toBeLessThan(1);
  expect(orientationControl.widths[0] + orientationControl.widths[1]).toBeGreaterThanOrEqual(orientationControl.groupWidth * 0.95);
  await page.screenshot({ path: "test-results/recap-redesign-editor-dark.png", fullPage: true, animations: "disabled" });

  await firstHit.click();
  await expect(firstHit).toHaveAttribute("aria-pressed", "true");
  await firstHit.click();
  await expect(slotHits.locator('[aria-pressed="true"]')).toHaveCount(0);
  const firstBeforeSwap = (await firstHit.getAttribute("aria-label"))!.split(": ").slice(1).join(": ");
  const secondBeforeSwap = (await secondHit.getAttribute("aria-label"))!.split(": ").slice(1).join(": ");
  const beforeSwapPixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await firstHit.click();
  await secondHit.click();
  await expect(slotHits.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(firstHit).toHaveAttribute("aria-label", new RegExp(secondBeforeSwap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  await expect(secondHit).toHaveAttribute("aria-label", new RegExp(firstBeforeSwap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(beforeSwapPixels);

  await page.getByRole("button", { name: "Choose types", exact: true }).click();
  await expect(page.locator(".recap-type-filters")).toBeVisible();
  await expect(page.locator(".recap-type-option").first()).toBeVisible();
  await expect(page.locator(".recap-tag-filters .recap-type-option")).toHaveCount(2);
  const slotLabels = () => slotHits.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  const tagOption = (name: string) => page.locator(".recap-tag-filters .recap-type-option").filter({ hasText: name }).locator("input");
  await tagOption("Recap Alpha").check();
  await tagOption("Recap Beta").check();
  const allTypesAnyTag = await slotLabels();
  await page.locator(".recap-type-filters .recap-type-option").filter({ hasText: "Literature" }).locator("input").check();
  for (const option of await page.locator(".recap-type-filters .recap-type-option").all()) {
    if (!(await option.innerText()).includes("Literature")) await option.locator("input").uncheck();
  }
  const literatureAnyTag = await slotLabels();
  expect(literatureAnyTag).not.toEqual(allTypesAnyTag);
  await page.getByRole("button", { name: "All (AND)", exact: true }).click();
  const literatureAllTags = await slotLabels();
  expect(literatureAllTags).not.toEqual(literatureAnyTag);
  await page.getByRole("button", { name: "Any (OR)", exact: true }).click();
  await page.getByRole("button", { name: "All media", exact: true }).click();
  await tagOption("Recap Alpha").uncheck();
  await tagOption("Recap Beta").uncheck();
  await page.getByRole("button", { name: "All media", exact: true }).click();

  const coverNames = page.getByRole("checkbox", { name: "Names on covers" });
  await expect(coverNames).toBeChecked();
  const coveredNamesPixels = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await coverNames.uncheck();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(coveredNamesPixels);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const mediaLabels = page.getByRole("checkbox", { name: "Show media types" });
  await expect(mediaLabels).toBeChecked();
  const textWithTypes = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await mediaLabels.uncheck();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(textWithTypes);
  await page.screenshot({ path: "test-results/recap-redesign-editor-text.png", fullPage: true, animations: "disabled" });

  for (const style of ["Light", "Dark", "Dusk", "Reading"]) {
    const styleButton = page.getByRole("button", { name: style, exact: true });
    await styleButton.click();
    await expect(styleButton).toHaveAttribute("aria-pressed", "true");
    await expectCanvasPainted(canvas);
  }

  await page.getByRole("button", { name: "Covers", exact: true }).click();
  await page.getByRole("checkbox", { name: "Names on covers" }).check();
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expectCanvasPainted(canvas);
  dimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(dimensions[1]).toBeGreaterThan(dimensions[0]);
  expect(dimensions).not.toEqual([1080, 1920]);
  await expectPngDimensions(page, dimensions[0], dimensions[1]);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Show media types" })).not.toBeChecked();
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();

  await page.getByRole("button", { name: "All Recaps", exact: true }).click();
  await expect(page.locator(".recap-saved-item")).toHaveCount(1);

  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".theme-option").filter({ hasText: "Daylight" }).click();
  await nav.getByRole("button", { name: "Recap", exact: true }).click();
  await page.locator(".recap-saved-open").first().click();
  await expect(page.locator(".recap-library-changed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reading", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Text", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "Show media types" })).not.toBeChecked();
  await page.screenshot({ path: "test-results/recap-redesign-editor-daylight.png", fullPage: true, animations: "disabled" });

  const watermark = page.getByRole("checkbox", { name: "Tastellar watermark" });
  await watermark.click();
  const firstDialog = page.getByRole("dialog");
  await expect(firstDialog).toContainText("free, ad-free, non-commercial open-source app");
  const dialogSpacing = await firstDialog.evaluate((element) => {
    const header = element.querySelector(".modal-header");
    const actions = element.querySelector(".modal-actions");
    const headerStyle = header ? getComputedStyle(header) : null;
    const actionStyle = actions ? getComputedStyle(actions) : null;
    return {
      headerLeft: headerStyle ? parseFloat(headerStyle.paddingLeft) : 0,
      headerRight: headerStyle ? parseFloat(headerStyle.paddingRight) : 0,
      actionLeft: actionStyle ? parseFloat(actionStyle.paddingLeft) : 0,
      actionRight: actionStyle ? parseFloat(actionStyle.paddingRight) : 0,
      width: element.getBoundingClientRect().width,
    };
  });
  expect(dialogSpacing.headerLeft).toBeGreaterThanOrEqual(20);
  expect(dialogSpacing.headerRight).toBeGreaterThanOrEqual(20);
  expect(dialogSpacing.actionLeft).toBeGreaterThanOrEqual(20);
  expect(dialogSpacing.actionRight).toBeGreaterThanOrEqual(20);
  expect(dialogSpacing.width).toBeLessThan(page.viewportSize()!.width);
  await page.screenshot({ path: "test-results/recap-redesign-watermark-dialog.png", fullPage: true, animations: "disabled" });
  await firstDialog.getByRole("button", { name: "Remove from all Recaps" }).click();
  await expect(watermark).not.toBeChecked();
  await watermark.click();
  await expect(watermark).toBeChecked();
  await watermark.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Keep watermark" }).click();
  await expect(watermark).toBeChecked();

  await page.getByRole("button", { name: "All Recaps", exact: true }).click();
  await page.getByRole("button", { name: "Delete all Recaps", exact: true }).click();
  const deleteDialog = page.getByRole("dialog");
  await expect(deleteDialog).toContainText("Your works, ratings, and ranking stay in your library");
  await page.screenshot({ path: "test-results/recap-redesign-delete-all.png", fullPage: true, animations: "disabled" });
  await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".recap-saved-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete all Recaps", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete all Recaps", exact: true }).click();
  await expect(page.locator(".recap-saved-item")).toHaveCount(0);
});

test("sparse Recap invites rating and ranking without a personal-selection poster", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:1420", acceptDownloads: true });
  const emptyPage = await context.newPage();
  await emptyPage.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 4 }, (_, index) => ({
      id: `sparse-${index}`, importOrder: index, version: 1, title: `Rated work ${index + 1}`,
      disposition: "experienced", mediaTypeId: null, overallRating: 7, coverAssetId: null,
      releaseDate: null, reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
      createdAt: now, updatedAt: now,
    }));
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries, mediaTypes: [], criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: 7, placed: false }]),
      tierOrders: Array.from({ length: 10 }, (_, index) => [10 - index, { placed: [], unplaced: index === 3 ? entries.map((entry) => entry.id) : [] }]),
      sequences: [], initialized: true, session: null, judgments: [], latestMove: null,
    }));
  });
  await openRecap(emptyPage);
  await expect(emptyPage.getByRole("heading", { name: "A little more to go on" })).toBeVisible();
  await expect(emptyPage.locator(".recap-feed-section")).toHaveCount(0);
  await expect(emptyPage.locator(".recap-gallery-empty")).toContainText("none have a recorded position");
  await emptyPage.screenshot({ path: "test-results/recap-sparse-unplaced.png", fullPage: true, animations: "disabled" });
  await context.close();

  const rankedContext = await browser.newContext({ baseURL: "http://127.0.0.1:1420", acceptDownloads: true });
  const rankedPage = await rankedContext.newPage();
  await rankedPage.addInitScript(() => {
    const now = new Date().toISOString();
    const entry = {
      id: "one-ranked-work", importOrder: 0, version: 1, title: "One ranked work",
      disposition: "experienced", mediaTypeId: null, overallRating: 7, coverAssetId: null,
      releaseDate: null, reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
      createdAt: now, updatedAt: now,
    };
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries: [entry], mediaTypes: [], criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: [[entry.id, { score: 7, placed: true }]],
      tierOrders: Array.from({ length: 10 }, (_, index) => [10 - index, { placed: index === 3 ? [entry.id] : [], unplaced: [] }]),
      sequences: [], initialized: true, session: null, judgments: [], latestMove: null,
    }));
  });
  await openRecap(rankedPage);
  await expect(rankedPage.locator(".recap-feed-section")).toHaveCount(0);
  await expect(rankedPage.locator(".recap-gallery-empty")).toBeVisible();
  await expect(rankedPage.locator(".recap-gallery-empty")).toContainText("rank");
  await expect(rankedPage.getByRole("heading", { name: "Personal selection" })).toHaveCount(0);
  await rankedPage.screenshot({ path: "test-results/recap-sparse-one-ranked.png", fullPage: true, animations: "disabled" });
  await rankedContext.close();
});

test("Recap caps a 120-work release-year history at twelve fully covered periods", async ({ page }) => {
  test.setTimeout(120_000);
  const entryCount = 120;
  await page.addInitScript((count) => {
    const now = new Date().toISOString();
    const mediaTypes = [
      { id: "books", name: "Books", iconKey: "book-open" },
      { id: "films", name: "Films", iconKey: "film" },
      { id: "games", name: "Games", iconKey: "gamepad-2" },
    ].map((type, sortOrder) => ({ ...type, sortOrder, criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now }));
    const entries = Array.from({ length: count }, (_, index) => ({
      id: `perf-work-${String(index + 1).padStart(3, "0")}`,
      importOrder: index,
      version: 1,
      title: `Recap performance work ${String(index + 1).padStart(3, "0")}`,
      shortLabel: `Performance ${index + 1}`,
      disposition: "experienced",
      mediaTypeId: mediaTypes[index % mediaTypes.length].id,
      overallRating: 10 - Math.floor(index / 12),
      coverAssetId: null,
      releaseDate: { year: 1907 + Math.floor(index / 5), month: null, day: null, precision: "year" },
      reviewText: "",
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    const tiers = Array.from({ length: 10 }, (_, index) => {
      const score = 10 - index;
      return [score, { placed: entries.filter((entry) => entry.overallRating === score).map((entry) => entry.id), unplaced: [] }];
    });
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries, mediaTypes, criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: entry.overallRating, placed: true }]),
      tierOrders: tiers,
      sequences: [],
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  }, entryCount);
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    const bootstrap = `
      if (!window.__recapPerfSeed) {
        const __recapLibraryModule = performance.getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/src/shared/bridge/libraryBridge.ts?t="));
        const __recapPerfBridge = await import(__recapLibraryModule || "/src/shared/bridge/libraryBridge.ts");
        window.__recapPerfBridge = __recapPerfBridge;
        const __recapPerfInitial = await __recapPerfBridge.loadLibrary();
        let __recapPerfRevision = __recapPerfInitial.revision;
        let __recapPerfSaved = 0;
        for (let index = 0; index < ${entryCount}; index += 1) {
          const cover = document.createElement("canvas");
          cover.width = 96;
          cover.height = 144;
          const context = cover.getContext("2d");
          if (!context) throw new Error("Canvas is unavailable in the Recap performance fixture");
          const hue = index * 137.508 % 360;
          const gradient = context.createLinearGradient(0, 0, 96, 144);
          gradient.addColorStop(0, "hsl(" + hue + " 70% 60%)");
          gradient.addColorStop(1, "hsl(" + ((hue + 90) % 360) + " 60% 28%)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, cover.width, cover.height);
          context.fillStyle = "#fff";
          context.textAlign = "center";
          context.font = "bold 17px Georgia";
          context.fillText(String(index + 1).padStart(3, "0"), cover.width / 2, cover.height - 16);
          const base64 = cover.toDataURL("image/png").split(",")[1];
          const saved = await __recapPerfBridge.saveEntryCover(__recapPerfRevision, "perf-work-" + String(index + 1).padStart(3, "0"), "image/png", base64);
          __recapPerfRevision = saved.revision;
          __recapPerfSaved += saved.entries.some((entry) => entry.id === "perf-work-" + String(index + 1).padStart(3, "0") && entry.coverAssetId) ? 1 : 0;
        }
        window.__recapPerfSeed = { saved: __recapPerfSaved, revision: __recapPerfRevision };
        __recapPerfBridge.clearEntryCoverCache();
      }
    `;
    if (!source.includes("ReactDOM.createRoot(")) throw new Error("Unable to locate Vite React bootstrap for preview cover seeding");
    source = source.replace("ReactDOM.createRoot(", `${bootstrap}\nReactDOM.createRoot(`);
    await route.fulfill({ response, body: source });
  });

  await page.goto("/");
  await expect(page.getByText("Browser preview · changes last for this session", { exact: true })).toBeVisible();
  await page.waitForTimeout(1_100);
  const rendererMetrics = await page.evaluate(async (count) => {
    const [bridge, domain, renderer] = await Promise.all([
      import("/src/features/recap/domain/recap.ts"),
      import("/src/rendering/recap/renderer.ts"),
    ]).then(([domain, renderer]) => [
      (window as typeof window & { __recapPerfBridge?: any }).__recapPerfBridge,
      domain,
      renderer,
    ]);
    if (!bridge) throw new Error("App cover bridge was not seeded before React mounted");
    const library = await bridge.loadLibrary();
    const seedStatus = (window as typeof window & { __recapPerfSeed?: { saved: number; revision: number } }).__recapPerfSeed;
    const ranking = await (await import("/src/shared/bridge/rankingBridge.ts")).loadRanking();
    const mediaTypes = library.mediaTypes.filter((type) => !type.archivedAt);
    const tiers = ranking.tiers.map((tier) => ({ score: tier.score, placedIds: tier.placedIds }));
    const composition = domain.createRecapComposition("releaseYear", library.entries, tiers, mediaTypes, { kind: "all" }, {
      id: "recap-perf-release-year",
      orientation: "landscape",
      style: "dark",
      mode: "cover",
      showTitles: true,
      watermark: true,
    });
    const pageCount = renderer.recapPageCount(composition);
    const pageRun = async () => {
      const pageMs = [];
      let resolvedImageNodes = 0;
      const coverSamples = [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const started = performance.now();
        const scene = await renderer.loadRecapScene(composition, (entryId, assetId) => bridge.loadEntryCover(entryId, assetId), { pageIndex });
        pageMs.push(performance.now() - started);
        resolvedImageNodes += scene.nodes.filter((node) => node.kind === "image" && node.image).length;
        const rendered = renderer.renderRecapCanvas(scene);
        const context = rendered.getContext("2d");
        if (!context) throw new Error("Recap renderer canvas context is unavailable");
        coverSamples.push(scene.nodes.filter((node) => node.kind === "image" && node.image).map((node) => {
          const x = Math.round((node.x + node.width / 2) * rendered.width / scene.width);
          const y = Math.round((node.y + node.height * 0.42) * rendered.height / scene.height);
          return { x: (node.x + node.width / 2) / scene.width, y: (node.y + node.height * 0.42) / scene.height,
            color: Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)) };
        }));
      }
      return { pageMs, resolvedImageNodes, coverSamples };
    };
    bridge.clearEntryCoverCache();
    const coldStarted = performance.now();
    const cold = await pageRun();
    const coldMs = performance.now() - coldStarted;
    const warmStarted = performance.now();
    const warm = await pageRun();
    const warmMs = performance.now() - warmStarted;
    (window as typeof window & { __recapPerfExpectedSamples?: Array<Array<{ x: number; y: number; color: number[] }>> }).__recapPerfExpectedSamples = warm.coverSamples;
    const cachedEntries = library.entries.filter((entry) => bridge.peekEntryCover(entry.id, entry.coverAssetId) !== null).length;
    return {
      browserPreviewEntries: library.entries.length,
      seedStatus,
      entriesWithCovers: library.entries.filter((entry) => entry.coverAssetId !== null).length,
      pageCount,
      coldMs,
      warmMs,
      coldPageP95Ms: [...cold.pageMs].sort((a, b) => a - b)[Math.floor(cold.pageMs.length * 0.95)] ?? 0,
      warmPageP95Ms: [...warm.pageMs].sort((a, b) => a - b)[Math.floor(warm.pageMs.length * 0.95)] ?? 0,
      coldResolvedImageNodes: cold.resolvedImageNodes,
      warmResolvedImageNodes: warm.resolvedImageNodes,
      cachedEntries,
      count,
    };
  }, entryCount);
  expect(rendererMetrics.browserPreviewEntries).toBe(entryCount);
  console.log("Recap preview cover seed status", JSON.stringify(rendererMetrics.seedStatus));
  expect(rendererMetrics.entriesWithCovers).toBe(entryCount);
  expect(rendererMetrics.cachedEntries).toBe(12);
  expect(rendererMetrics.coldResolvedImageNodes).toBe(12);
  expect(rendererMetrics.warmResolvedImageNodes).toBe(12);
  expect(rendererMetrics.pageCount).toBe(1);

  await page.getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Recap", exact: true }).click();
  await expect(page.locator(".recap-page")).toBeVisible();
  await expect(page.locator(".recap-count")).toContainText("120 rated works");
  const yearFeed = page.locator('.recap-feed-section[data-recap-template="releaseYear"]');
  await yearFeed.scrollIntoViewIfNeeded();
  await expect(yearFeed.locator(".recap-feed-count-periods")).toContainText("12 periods");
  await expect(yearFeed.locator(".recap-feed-count-periods")).toContainText("60 rated works");
  await expect(yearFeed).toHaveAttribute("data-recap-scene-status", "ready");
  const uiCoverProbe = await page.evaluate(async () => {
    const bridge = (window as typeof window & { __recapPerfBridge?: typeof import("/src/shared/bridge/libraryBridge") }).__recapPerfBridge
      ?? await import("/src/shared/bridge/libraryBridge.ts");
    const recapBridge = await import("/src/shared/bridge/recapBridge.ts");
    const library = await bridge.loadLibrary();
    const entry = library.entries.find((item) => item.coverAssetId);
    const source = entry ? await recapBridge.loadRecapCover(entry.id, entry.coverAssetId) : null;
    const moduleUrls = performance.getEntriesByType("resource")
      .map((item) => item.name)
      .filter((url) => url.includes("libraryBridge.ts"));
    return {
      entryId: entry?.id ?? null,
      assetId: entry?.coverAssetId ?? null,
      sourceLoaded: Boolean(source),
      sourcePrefix: source?.slice(0, 32) ?? null,
      moduleUrls: [...new Set(moduleUrls)],
    };
  });
  console.log("Recap UI cover probe", JSON.stringify(uiCoverProbe));
  await expectCanvasPainted(yearFeed.locator("canvas"));
  const expectedSamples = await page.evaluate(() => (window as typeof window & { __recapPerfExpectedSamples?: Array<Array<{ x: number; y: number; color: number[] }>> }).__recapPerfExpectedSamples ?? []);
  expect(expectedSamples.length).toBe(rendererMetrics.pageCount);
  const expectCoverSamples = async (canvas: Locator, samples: Array<{ x: number; y: number; color: number[] }>) => {
    const actual = await canvas.evaluate((element: HTMLCanvasElement, points: Array<{ x: number; y: number }>) => {
      const context = element.getContext("2d");
      if (!context) throw new Error("Recap UI canvas context is unavailable");
      return points.map(({ x, y }) => Array.from(context.getImageData(
        Math.round(x * element.width), Math.round(y * element.height), 1, 1,
      ).data.slice(0, 3)));
    }, samples);
    expect(actual.length).toBe(samples.length);
    for (const [index, expected] of samples.entries()) {
      actual[index].forEach((channel, channelIndex) => expect(Math.abs(channel - expected.color[channelIndex])).toBeLessThanOrEqual(3));
    }
  };
  await expectCoverSamples(yearFeed.locator("canvas"), expectedSamples[0]);
  const yearFeedDimensions = await yearFeed.locator("canvas").evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  await page.screenshot({ path: "test-results/recap-120-covers-gallery.png", fullPage: true, animations: "disabled" });
  await yearFeed.locator(".recap-feed-poster").click();
  const canvas = page.locator(".recap-stage-canvas");
  const pageNext = page.getByRole("button", { name: "Next page" });
  await expect(page.getByRole("button", { name: "Horizontal", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual(yearFeedDimensions);
  await expectCoverSamples(canvas, expectedSamples[0]);
  const navigationMs: number[] = [];
  let currentPage = 0;
  const seenPages = new Set([currentPage]);
  await page.screenshot({ path: "test-results/recap-120-covers-editor-first-page.png", fullPage: true, animations: "disabled" });
  const landscapeDimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(landscapeDimensions[0]).toBeGreaterThan(landscapeDimensions[1]);
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(page.getByRole("button", { name: "Vertical", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).not.toEqual(landscapeDimensions);
  const portraitDimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(portraitDimensions[1]).toBeGreaterThan(portraitDimensions[0]);
  await expectCanvasPainted(canvas);
  await page.screenshot({ path: "test-results/recap-period-portrait-editor.png", fullPage: true, animations: "disabled" });
  await expectPngDimensions(page, portraitDimensions[0], portraitDimensions[1]);
  console.log("Recap period portrait export dimensions", JSON.stringify(portraitDimensions));
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Horizontal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual(landscapeDimensions);
  await page.screenshot({ path: "test-results/recap-period-landscape-editor.png", fullPage: true, animations: "disabled" });
  await expectPngDimensions(page, landscapeDimensions[0], landscapeDimensions[1]);
  console.log("Recap period landscape export dimensions", JSON.stringify(landscapeDimensions));
  while (await pageNext.count() && await pageNext.isEnabled()) {
    const started = Date.now();
    await pageNext.click();
    currentPage += 1;
    await expectCoverSamples(canvas, expectedSamples[currentPage]);
    await expectCanvasPainted(canvas);
    navigationMs.push(Date.now() - started);
    seenPages.add(currentPage);
  }
  expect(seenPages.size).toBe(rendererMetrics.pageCount);
  await page.screenshot({ path: "test-results/recap-120-covers-editor-last-page.png", fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: "All Recaps", exact: true }).click();
  const decadeFeed = page.locator('[data-recap-template="decade"]');
  await decadeFeed.scrollIntoViewIfNeeded();
  await expect(decadeFeed.locator(".recap-feed-count-periods")).toContainText("4 periods");
  await decadeFeed.locator(".recap-feed-poster").click();
  const decadeCanvas = page.locator(".recap-stage-canvas");
  await expect.poll(() => decadeCanvas.evaluate((element: HTMLCanvasElement) => Boolean(element.width && element.height && element.getContext("2d")?.getImageData(2, 2, 1, 1).data[3]))).toBe(true);
  const decadeHits = page.locator(".recap-slot-hit");
  await expect(decadeHits).toHaveCount(4);
  const decadeLandscapeDimensions = await decadeCanvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(decadeLandscapeDimensions[0]).toBeGreaterThan(decadeLandscapeDimensions[1]);
  await page.screenshot({ path: "test-results/recap-decade-poster-landscape.png", fullPage: true, animations: "disabled" });
  await expectPngDimensions(page, decadeLandscapeDimensions[0], decadeLandscapeDimensions[1]);
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect.poll(() => decadeCanvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).not.toEqual(decadeLandscapeDimensions);
  const decadePortraitDimensions = await decadeCanvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(decadePortraitDimensions[1]).toBeGreaterThan(decadePortraitDimensions[0]);
  await page.screenshot({ path: "test-results/recap-decade-poster-portrait.png", fullPage: true, animations: "disabled" });
  await expectPngDimensions(page, decadePortraitDimensions[0], decadePortraitDimensions[1]);
  console.log("Recap 120-cover timings", JSON.stringify({ ...rendererMetrics, uiPageCount: seenPages.size, uiNavigationMedianMs: [...navigationMs].sort((a, b) => a - b)[Math.floor(navigationMs.length / 2)] ?? 0, uiNavigationMaxMs: Math.max(0, ...navigationMs) }));
});
