import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";

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

async function assertPngDimensions(download: Download, width: number, height: number, expectedFilename: string) {
  expect(download.suggestedFilename()).toBe(expectedFilename);
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

async function expectPngDimensions(page: Page, width: number, height: number, pageCount = 1): Promise<Download[]> {
  const filenames = Array.from({ length: pageCount }, (_, index) => pageCount > 1
    ? `tastellar-recap-${index + 1}-of-${pageCount}.png`
    : "tastellar-recap.png");
  const waits = filenames.map((filename) => page.waitForEvent("download", {
    predicate: (download) => download.suggestedFilename() === filename,
  }));
  const [downloads] = await Promise.all([
    Promise.all(waits),
    page.getByRole("button", { name: "Export image" }).click(),
  ]);
  await expect(page.getByText("Your Recap image is ready.", { exact: true })).toBeVisible();
  expect(downloads).toHaveLength(pageCount);
  for (const [index, download] of downloads.entries()) {
    await assertPngDimensions(download, width, height, filenames[index]);
  }
  return downloads;
}

async function expectPngCoverSamples(page: Page, download: Download, samples: Array<{ x: number; y: number; color: number[] }>) {
  const path = await download.path();
  expect(path).toBeTruthy();
  const base64 = readFileSync(path!).toString("base64");
  const actual = await page.evaluate(async ({ imageBase64, points }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${imageBase64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Export PNG canvas context is unavailable");
    context.drawImage(image, 0, 0);
    return points.map(({ x, y }) => Array.from(context.getImageData(
      Math.min(canvas.width - 1, Math.round(x * canvas.width)),
      Math.min(canvas.height - 1, Math.round(y * canvas.height)), 1, 1,
    ).data.slice(0, 3)));
  }, { imageBase64: base64, points: samples });
  expect(actual).toHaveLength(samples.length);
  for (const [index, expected] of samples.entries()) {
    actual[index].forEach((channel, channelIndex) => expect(Math.abs(channel - expected.color[channelIndex])).toBeLessThanOrEqual(3));
  }
}

async function expectCanvasPainted(canvas: Locator) {
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    return Boolean(element.width && element.height && context?.getImageData(
      Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1,
    ).data[3]);
  })).toBe(true);
}

test("Recap repaints a ready gallery canvas after returning from its editor", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 10 }, (_, index) => ({
      id: `ready-gallery-${index + 1}`,
      importOrder: index,
      version: 1,
      title: `Ready gallery work ${index + 1}`,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: 10,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    const placed = entries.map((entry) => entry.id);
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0,
      entries,
      mediaTypes: [],
      criteria: [],
      tags: [],
    }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: 10, placed: true }]),
      tierOrders: Array.from({ length: 10 }, (_, index) => [10 - index, {
        placed: index === 0 ? placed : [],
        unplaced: [],
      }]),
      sequences: [],
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  });

  await openRecap(page);
  const topTen = page.locator('.recap-feed-section[data-recap-template="topTen"]');
  await topTen.scrollIntoViewIfNeeded();
  await expect(topTen).toHaveAttribute("data-recap-scene-status", "ready");
  const galleryCanvas = topTen.locator("canvas");
  await expectCanvasPainted(galleryCanvas);
  const readyPixels = await galleryCanvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());

  await topTen.locator(".recap-feed-poster").click();
  const editorCanvas = page.locator(".recap-stage-canvas");
  await expectCanvasPainted(editorCanvas);
  await page.getByRole("button", { name: "All Recaps", exact: true }).click();

  await expect(topTen).toHaveAttribute("data-recap-scene-status", "ready");
  await expectCanvasPainted(galleryCanvas);
  await expect.poll(() => galleryCanvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(readyPixels);
});

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

test("Recap resumes delayed covers after editing, filtering, and reordering", async ({ page }) => {
  test.setTimeout(45_000);
  const requested = new Set<string>();
  const release = new Map<string, () => void>();
  let selectedCoverAttempts = 0;
  let coverBytes: Buffer;
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const mediaTypes = [{
      id: "films", name: "Films", sortOrder: 0, iconKey: "film", criterionIds: [],
      archivedAt: null, version: 1, createdAt: now, updatedAt: now,
    }];
    const entries = Array.from({ length: 11 }, (_, index) => ({
      id: `delayed-work-${index + 1}`, importOrder: index, version: 1,
      title: index === 10 ? "Delayed new cover media" : `Existing work ${index + 1}`,
      disposition: "experienced", mediaTypeId: "films", overallRating: index < 10 ? 10 : 9,
      coverAssetId: null,
      remoteCover: index === 0 || index === 10 ? {
        provider: "igdb",
        url: `https://images.igdb.com/igdb/image/upload/t_cover_big/${index === 0 ? "gallery" : "selected"}-cover.jpg`,
      } : null,
      releaseDate: null, reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
      createdAt: now, updatedAt: now,
    }));
    const placed = entries.slice(0, 10).map((entry) => entry.id);
    const unplaced = [entries[10].id];
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries, mediaTypes, criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry, index) => [entry.id, { score: index < 10 ? 10 : 9, placed: index < 10 }]),
      tierOrders: [[10, { placed, unplaced: [] }], [9, { placed: [], unplaced }]],
      sequences: [[10, 10], [9, 1]], initialized: true, session: null, judgments: [], latestMove: null,
    }));
  });
  await page.goto("/");
  const coverBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 144;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 96, 144);
    gradient.addColorStop(0, "#f04159");
    gradient.addColorStop(1, "#301042");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 96, 144);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  coverBytes = Buffer.from(coverBase64, "base64");
  await page.route("https://images.igdb.com/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    if (name === "selected-cover.jpg") {
      selectedCoverAttempts += 1;
      if (selectedCoverAttempts === 1) {
        await route.fulfill({ status: 404, contentType: "image/png", body: "" });
        return;
      }
    }
    requested.add(name);
    await new Promise<void>((resolve) => release.set(name, resolve));
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
      body: coverBytes,
    });
  });

  const resumeAll = () => {
    for (const resolve of release.values()) resolve();
  };
  try {
    await page.getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Recap", exact: true }).click();
    const topTen = page.locator('.recap-feed-section[data-recap-template="topTen"]');
    await topTen.scrollIntoViewIfNeeded();
    await expect.poll(() => requested.has("gallery-cover.jpg"), { timeout: 5000 }).toBe(true);

    await topTen.locator(".recap-feed-poster").click();
    const canvas = page.locator(".recap-stage-canvas");
    await expect(canvas).toBeVisible();

    await page.getByRole("button", { name: "Choose types", exact: true }).click();
    await page.locator(".recap-type-filters .recap-type-option").filter({ hasText: "Films" }).locator("input").check();
    const slots = page.locator(".recap-slot-hit");
    await slots.nth(0).click();
    await page.getByRole("button", { name: "Choose a replacement", exact: true }).click();
    await page.getByRole("option", { name: /Delayed new cover media/ }).click();
    await expect.poll(() => selectedCoverAttempts, { timeout: 5000 }).toBe(2);

    const beforeLoad = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    release.get("selected-cover.jpg")?.();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()), { timeout: 5000 }).not.toBe(beforeLoad);
    await expect(slots.nth(0)).toHaveAttribute("aria-label", /Delayed new cover media$/);
    const loadedWithoutReordering = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await page.screenshot({ path: "test-results/recap-delayed-cover-auto-retry.png", animations: "disabled" });

    await slots.nth(1).click();
    await expect(slots.nth(1)).toHaveAttribute("aria-label", /Delayed new cover media$/);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()), { timeout: 5000 }).not.toBe(loadedWithoutReordering);
    release.get("gallery-cover.jpg")?.();
    await page.waitForTimeout(100);
    await page.screenshot({ path: "test-results/recap-delayed-cover-after-reorder.png", animations: "disabled" });

    await page.getByRole("button", { name: "All Recaps", exact: true }).click();
    await expect(topTen).toHaveAttribute("data-recap-scene-status", "ready", { timeout: 5000 });
    await expectCanvasPainted(topTen.locator("canvas"));
  } finally {
    resumeAll();
  }
});

test("period Recap posters keep balanced rows through the latest qualifying year", async ({ page }) => {
  test.setTimeout(120_000);
  const yearCount = 22;
  const featuredCount = 22;
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const years = Array.from({ length: 22 }, (_, index) => 2005 + index);
    const populationForYear = (year: number) => year === 2005 ? 40 : year === 2006 ? 9 : year <= 2022 ? 9 : 8;
    const featured = years.map((year, index) => ({
      id: "period-winner-" + String(index + 1).padStart(3, "0"),
      title: "Year poster winner " + year,
      releaseDate: { year, month: null, day: null, precision: "year" },
      overallRating: year === 2026 ? 9 : 8,
    }));
    const extras = years.flatMap((year) => Array.from(
      { length: populationForYear(year) - 1 },
      (_, index) => ({
        id: "period-extra-" + year + "-" + String(index + 1).padStart(2, "0"),
        title: "Year poster extra " + year + " " + String(index + 1),
        releaseDate: { year, month: null, day: null, precision: "year" },
        overallRating: 8,
      }),
    ));
    const mediaTypes = [
      { id: "books", name: "Books", iconKey: "book-open" },
      { id: "films", name: "Films", iconKey: "film" },
      { id: "games", name: "Games", iconKey: "gamepad-2" },
    ].map((type, sortOrder) => ({
      ...type,
      sortOrder,
      criterionIds: [],
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const entries = [...featured, ...extras].map((entry, importOrder) => ({
      ...entry,
      importOrder,
      version: 1,
      disposition: "experienced",
      mediaTypeId: mediaTypes[importOrder % mediaTypes.length].id,
      coverAssetId: null,
      reviewText: "",
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    if (entries.length !== 225) throw new Error("The period Recap fixture must contain 225 rated works");
    const tiers = Array.from({ length: 10 }, (_, index) => {
      const score = 10 - index;
      return [score, {
        placed: entries.filter((entry) => entry.overallRating === score).map((entry) => entry.id),
        unplaced: [],
      }];
    });
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0,
      entries,
      mediaTypes,
      criteria: [],
      tags: [],
    }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: entry.overallRating, placed: true }]),
      tierOrders: tiers,
      sequences: [],
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  });
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    const bootstrap = [
      "if (!window.__recapPeriodSeed) {",
      "  const bridgeUrl = performance.getEntriesByType('resource').map((entry) => entry.name).find((url) => url.includes('/src/shared/bridge/libraryBridge.ts?t='));",
      "  const bridge = await import(bridgeUrl || '/src/shared/bridge/libraryBridge.ts');",
      "  let revision = (await bridge.loadLibrary()).revision;",
      "  let saved = 0;",
      "  for (let index = 0; index < 22; index += 1) {",
      "    const year = 2005 + index;",
      "    const cover = document.createElement('canvas');",
      "    cover.width = 96;",
      "    cover.height = 144;",
      "    const context = cover.getContext('2d');",
      "    if (!context) throw new Error('Canvas is unavailable in the period Recap fixture');",
      "    const hue = index * 137.508 % 360;",
      "    const gradient = context.createLinearGradient(0, 0, 96, 144);",
      "    gradient.addColorStop(0, 'hsl(' + hue + ' 70% 60%)');",
      "    gradient.addColorStop(1, 'hsl(' + ((hue + 90) % 360) + ' 60% 28%)');",
      "    context.fillStyle = gradient;",
      "    context.fillRect(0, 0, cover.width, cover.height);",
      "    context.fillStyle = '#fff';",
      "    context.textAlign = 'center';",
      "    context.font = 'bold 17px Georgia';",
      "    context.fillText(String(year), cover.width / 2, cover.height - 16);",
      "    const base64 = cover.toDataURL('image/png').split(',')[1];",
      "    const id = 'period-winner-' + String(index + 1).padStart(3, '0');",
      "    const result = await bridge.saveEntryCover(revision, id, 'image/png', base64);",
      "    revision = result.revision;",
      "    if (result.entries.some((entry) => entry.id === id && entry.coverAssetId)) saved += 1;",
      "  }",
      "  window.__recapPeriodSeed = { saved, revision };",
      "  bridge.clearEntryCoverCache();",
      "}",
    ].join("\n");
    if (!source.includes("ReactDOM.createRoot(")) throw new Error("Unable to locate Vite React bootstrap for period Recap cover seeding");
    source = source.replace("ReactDOM.createRoot(", bootstrap + "\nReactDOM.createRoot(");
    await route.fulfill({ response, body: source });
  });

  await page.goto("/");
  await expect(page.getByText("Browser preview · changes last for this session", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __recapPeriodSeed?: { saved: number };
  }).__recapPeriodSeed?.saved ?? 0)).toBe(featuredCount);

  const periodMetrics = async (orientation: "landscape" | "portrait") => page.evaluate(async (selectedOrientation) => {
    const [domain, renderer, bridge, rankingBridge] = await Promise.all([
      import("/src/features/recap/domain/recap.ts"),
      import("/src/rendering/recap/renderer.ts"),
      import("/src/shared/bridge/libraryBridge.ts"),
      import("/src/shared/bridge/rankingBridge.ts"),
    ]);
    const library = await bridge.loadLibrary();
    const ranking = await rankingBridge.loadRanking();
    const mediaTypes = library.mediaTypes.filter((type) => !type.archivedAt);
    const composition = domain.createRecapComposition(
      "releaseYear",
      library.entries,
      ranking.tiers.map((tier) => ({ score: tier.score, placedIds: tier.placedIds })),
      mediaTypes,
      { kind: "all" },
      {
        id: "period-e2e-" + selectedOrientation,
        orientation: selectedOrientation,
        style: "dark",
        mode: "cover",
        showTitles: true,
        watermark: true,
      },
    );
    const scene = await renderer.loadRecapScene(
      composition,
      (entryId, assetId) => bridge.loadEntryCover(entryId, assetId),
    );
    const slotsById = new Map(composition.slots.map((slot) => [slot.id, slot]));
    return {
      totalPeriods: composition.slots.length,
      pageCount: scene.pageCount,
      dimensions: [scene.width, scene.height],
      visibleYears: scene.hitTargets.map((target) => {
        const slot = slotsById.get(target.slotId);
        return slot?.predicate.kind === "year" ? slot.predicate.value : null;
      }),
      labels: scene.nodes.filter((node) => node.kind === "text").map((node) => node.text),
      images: scene.nodes.filter((node) => node.kind === "image" && node.image).length,
    };
  }, orientation);

  const landscapeMetrics = await periodMetrics("landscape");
  expect(landscapeMetrics.totalPeriods).toBe(yearCount);
  expect(landscapeMetrics.pageCount).toBe(1);
  expect(landscapeMetrics.visibleYears).toEqual(Array.from({ length: 21 }, (_, index) => 2006 + index));
  expect(landscapeMetrics.labels).toContain("2026");
  expect(landscapeMetrics.labels).not.toContain("2005");
  expect(landscapeMetrics.images).toBe(21);

  await page.getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Recap", exact: true }).click();
  await expect(page.locator(".recap-page")).toBeVisible();
  await expect(page.locator(".recap-count")).toContainText("225 rated works");
  const yearFeed = page.locator('.recap-feed-section[data-recap-template="releaseYear"]');
  await yearFeed.scrollIntoViewIfNeeded();
  await expect(yearFeed.locator(".recap-feed-count-periods"))
    .toHaveText("21 periods · 185 rated works");
  await expect(yearFeed).toHaveAttribute("data-recap-scene-status", "ready");
  await expectCanvasPainted(yearFeed.locator("canvas"));
  await yearFeed.screenshot({
    path: "test-results/recap-years-2006-2026-gallery.png",
    animations: "disabled",
  });

  await yearFeed.locator(".recap-feed-poster").click();
  const canvas = page.locator(".recap-stage-canvas");
  await expect(page.getByRole("button", { name: "Horizontal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectCanvasPainted(canvas);
  const pageNext = page.getByRole("button", { name: "Next page" });
  await expect(pageNext).toHaveCount(0);

  const inspectGrid = async (expectedRows: number, expectedColumns: number, expectedLatestYear: number) => {
    await expect(page.locator(".recap-slot-hit")).toHaveCount(expectedRows * expectedColumns);
    const result = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".recap-stage-canvas");
      if (!canvas) throw new Error("The period Recap canvas is missing");
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".recap-slot-hit"));
      const positions = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          x: Math.round(rect.left / 4),
          y: Math.round(rect.top / 4),
          label: button.getAttribute("aria-label") ?? "",
        };
      });
      const rowCounts = new Map<number, number>();
      positions.forEach(({ y }) => rowCounts.set(y, (rowCounts.get(y) ?? 0) + 1));
      return {
        columns: [...new Set(positions.map(({ x }) => x))].length,
        rowCounts: [...rowCounts.values()],
        labels: positions.map(({ label }) => label),
      };
    });
    expect(result.columns).toBe(expectedColumns);
    expect(result.rowCounts).toEqual(Array.from({ length: expectedRows }, () => expectedColumns));
    expect(result.labels.at(-1)).toMatch(new RegExp(String(expectedLatestYear) + "$"));
    await expect(page.locator(".recap-slot-hit").last())
      .toHaveAttribute("aria-label", new RegExp(String(expectedLatestYear) + "$"));
  };

  const latestCoverSample = async (expectedYear: number) => page.evaluate((year) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".recap-stage-canvas");
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>(".recap-slot-hit")).at(-1);
    if (!canvas || !target) throw new Error("The latest period has no visible poster slot");
    const label = target.getAttribute("aria-label") ?? "";
    if (!label.endsWith(String(year))) throw new Error("The latest visible poster slot does not match year " + year);
    const canvasRect = canvas.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const x = (targetRect.left + targetRect.width / 2 - canvasRect.left) / canvasRect.width;
    const y = (targetRect.top + targetRect.height * 0.42 - canvasRect.top) / canvasRect.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Recap canvas context is unavailable");
    const pixel = context.getImageData(
      Math.min(canvas.width - 1, Math.round(x * canvas.width)),
      Math.min(canvas.height - 1, Math.round(y * canvas.height)),
      1,
      1,
    ).data;
    return { x, y, color: Array.from(pixel.slice(0, 3)) };
  }, expectedYear);

  const landscapeDimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(landscapeDimensions[0]).toBeGreaterThan(landscapeDimensions[1]);
  await inspectGrid(3, 7, 2026);
  await page.screenshot({ path: "test-results/recap-years-2006-2026-landscape-editor.png", fullPage: true, animations: "disabled" });
  const landscapeSample = await latestCoverSample(2026);
  const landscapeDownload = (await expectPngDimensions(page, landscapeDimensions[0], landscapeDimensions[1]))[0];
  await expectPngCoverSamples(page, landscapeDownload, [landscapeSample]);
  await landscapeDownload.saveAs("test-results/recap-years-2006-2026-landscape.png");

  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(page.getByRole("button", { name: "Vertical", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]))
    .not.toEqual(landscapeDimensions);
  await expectCanvasPainted(canvas);
  const portraitDimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  expect(portraitDimensions[1]).toBeGreaterThan(portraitDimensions[0]);
  const portraitMetrics = await periodMetrics("portrait");
  expect(portraitMetrics.totalPeriods).toBe(yearCount);
  expect(portraitMetrics.pageCount).toBe(1);
  expect(portraitMetrics.visibleYears).toEqual(Array.from({ length: 20 }, (_, index) => 2007 + index));
  expect(portraitMetrics.labels).toContain("2026");
  expect(portraitMetrics.labels).not.toContain("2005");
  expect(portraitMetrics.labels).not.toContain("2006");
  expect(portraitMetrics.images).toBe(20);
  await inspectGrid(4, 5, 2026);
  await page.screenshot({ path: "test-results/recap-years-2007-2026-portrait-editor.png", fullPage: true, animations: "disabled" });
  const portraitSample = await latestCoverSample(2026);
  const portraitDownload = (await expectPngDimensions(page, portraitDimensions[0], portraitDimensions[1]))[0];
  await expectPngCoverSamples(page, portraitDownload, [portraitSample]);
  await portraitDownload.saveAs("test-results/recap-years-2007-2026-portrait.png");

  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Horizontal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]))
    .toEqual(landscapeDimensions);
  await expectCanvasPainted(canvas);
  await inspectGrid(3, 7, 2026);

  await page.getByRole("button", { name: "All Recaps", exact: true }).click();
  const decadeFeed = page.locator('[data-recap-template="decade"]');
  await decadeFeed.scrollIntoViewIfNeeded();
  await expect(decadeFeed.locator(".recap-feed-count-periods"))
    .toHaveText("3 periods · 225 rated works");
  await expect(decadeFeed).toHaveAttribute("data-recap-scene-status", "ready");
  await decadeFeed.locator(".recap-feed-poster").click();
  const decadeCanvas = page.locator(".recap-stage-canvas");
  await expectCanvasPainted(decadeCanvas);
  await expect(page.locator(".recap-slot-hit")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
  await expect(page.locator(".recap-slot-hit").last())
    .toHaveAttribute("aria-label", /2026$/);
  const decadeDimensions = await decadeCanvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
  const decadeSample = await latestCoverSample(2026);
  const decadeDownload = (await expectPngDimensions(page, decadeDimensions[0], decadeDimensions[1]))[0];
  await expectPngCoverSamples(page, decadeDownload, [decadeSample]);
  await decadeDownload.saveAs("test-results/recap-decades-2000-2020.png");
});
