import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

type SaveArchive = {
  library: {
    revision: number;
    entries: Array<{ id: string; disposition: string; overallRating: number | null; mediaTypeId?: string | null }>;
    mediaTypes: Array<{ id: string; name: string }>;
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

function deriveCanonicalPlacedOrder(archive: SaveArchive) {
  const byScore = new Map<number, string[]>();
  const placementById = new Map(archive.history.ranking.entries.map((item) => [item.entryId, item]));
  const ratedById = new Map(archive.library.entries
    .filter((entry) => entry.disposition === "experienced" && Number.isInteger(entry.overallRating))
    .map((entry) => [entry.id, entry.overallRating!]));
  const keyById = new Map(archive.history.groupOrder.map((item) => [item.entryId, item.orderKey]));
  for (const score of new Set(ratedById.values())) {
    const expectedIds = [...ratedById].filter(([, rating]) => rating === score).map(([id]) => id);
    if (expectedIds.some((id) => placementById.get(id)?.score !== score)) {
      throw new Error(`The archive rating placements do not match active works rated ${score}.`);
    }
    const order = expectedIds.sort((idA, idB) => {
      const keyA = keyById.get(idA) ?? "";
      const keyB = keyById.get(idB) ?? "";
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
    if (order.some((id) => !keyById.has(id))) {
      throw new Error(`The archive does not contain a canonical order key for every rated score ${score} work.`);
    }
    byScore.set(score, order);
  }
  return byScore;
}

async function seedArchivePreview(page: Page, archive: SaveArchive, forcedUnplacedIds: readonly string[] = []) {
  const ranking = archive.history.ranking;
  const forcedUnplaced = new Set(forcedUnplacedIds);
  const rankedEntries = ranking.entries.map((item) => forcedUnplaced.has(item.entryId) ? { ...item, placed: false } : item);
  const byId = new Map(rankedEntries.map((item) => [item.entryId, item]));
  const canonicalPlacedOrder = deriveCanonicalPlacedOrder(archive);
  const tiers = Array.from({ length: 10 }, (_, index) => {
    const score = 10 - index;
    const tierOrder = canonicalPlacedOrder.get(score) ?? [];
    const placed = tierOrder.filter((id) => byId.get(id)?.placed);
    return [score, {
      placed,
      unplaced: tierOrder.filter((id) => !byId.get(id)?.placed),
    }];
  });
  await page.addInitScript(({ library, rankedEntries, tierOrders, sequences }) => {
    sessionStorage.setItem("tastellar.preview.revision.v1", String(library.revision));
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify(library));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: rankedEntries.map((item) => [item.entryId, { score: item.score, placed: item.placed }]),
      tierOrders,
      sequences,
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  }, { library: archive.library, rankedEntries, tierOrders: tiers, sequences: ranking.tiers.map((tier) => [tier.score, tier.inputSequence]) });
}

async function seedRatedCount(page: Page, count: number, singleScore?: number) {
  await page.addInitScript(({ total, singleScore }) => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: total }, (_, index) => ({
      id: `sparse-${index}`,
      importOrder: index,
      version: 1,
      title: `Rated work ${index + 1}`,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: singleScore ?? index % 10 + 1,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries, mediaTypes: [], criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: entry.overallRating, placed: false }]),
      tierOrders: Array.from({ length: 10 }, (_, index) => [10 - index, { placed: [], unplaced: entries.filter((entry) => entry.overallRating === 10 - index).map((entry) => entry.id) }]),
      sequences: [], initialized: true, session: null, judgments: [], latestMove: null,
    }));
  }, { total: count, singleScore });
}

async function seedSingleScoreRanked(page: Page) {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `single-score-${index}`,
      importOrder: index,
      version: 1,
      title: `Single score work ${index + 1}`,
      disposition: "experienced",
      mediaTypeId: index % 2 === 0 ? "single-books" : "single-films",
      overallRating: 7,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    const placedIds = entries.map((entry) => entry.id);
    const mediaTypes = [
      { id: "single-books", name: "Books", sortOrder: 0, iconKey: "book-open", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
      { id: "single-films", name: "Films", sortOrder: 1, iconKey: "film", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
    ];
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({ revision: 0, entries, mediaTypes, criteria: [], tags: [] }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: entries.map((entry) => [entry.id, { score: 7, placed: true }]),
      tierOrders: Array.from({ length: 10 }, (_, index) => [index + 1, { placed: index === 6 ? placedIds : [], unplaced: [] }]),
      sequences: [], initialized: true, session: null, judgments: [], latestMove: null,
    }));
  });
}

async function expectSingleMarkCentered(chart: Locator, selector: string, left: number) {
  const geometry = await chart.evaluate((element, { markSelector, left }) => {
    const svg = element as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const mark = svg.querySelector(markSelector) as SVGGraphicsElement;
    const scale = bounds.width / viewBox.width;
    const center = (x: number) => bounds.left + x * scale;
    const circleX = mark.getAttribute("cx");
    const actualX = circleX === null
      ? mark.getBBox().x + mark.getBBox().width / 2
      : Number(circleX);
    return {
      actual: center(actualX),
      expected: center(left + (viewBox.width - left - 16) / 2),
    };
  }, { markSelector: selector, left });
  expect(Math.abs(geometry.actual - geometry.expected)).toBeLessThan(1);
}

async function openAnalytics(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Analytics", exact: true }).click();
}

test("Analytics stays empty below 20 rated works and offers the library", async ({ page }) => {
  await seedRatedCount(page, 19);
  await openAnalytics(page);
  await expect(page.locator(".analytics-empty")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This page needs a little more to go on." })).toBeVisible();
  await expect(page.locator(".analytics-section")).toHaveCount(0);
  await expect(page.locator(".analytics-histogram, .analytics-media-chart, .analytics-bin-share")).toHaveCount(0);
  await page.getByRole("button", { name: "Explore your library", exact: true }).click();
  await expect(page.locator(".library-main")).toBeVisible();
});

test("rank analysis stays hidden when every rating is unplaced and section numbers remain consecutive", async ({ page }) => {
  await seedRatedCount(page, 20, 7);
  await openAnalytics(page);
  const feed = page.locator(".analytics-page");
  await expect(feed.locator(".analytics-histogram")).toBeVisible();
  await expect(feed.locator(".analytics-media-chart")).toBeVisible();
  await expect(feed.locator(".analytics-histogram-bin")).toHaveCount(1);
  await expect(feed.locator(".analytics-histogram-bin")).toHaveAttribute("data-score", "7");
  await expect(feed.locator(".analytics-media-score")).toHaveCount(1);
  await expect(feed.locator(".analytics-media-score")).toHaveAttribute("data-score", "7");
  const centeredHistogram = await feed.locator(".analytics-histogram").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const bar = svg.querySelector(".analytics-bin-bar")!.getBBox();
    const scale = bounds.width / viewBox.width;
    const center = (x: number) => bounds.left + x * scale;
    return {
      actual: center(bar.x + bar.width / 2),
      expected: center(45 + (viewBox.width - 45 - 16) / 2),
    };
  });
  expect(Math.abs(centeredHistogram.actual - centeredHistogram.expected)).toBeLessThan(1);
  const centeredMediaPoint = await feed.locator(".analytics-media-chart").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const point = svg.querySelector(".analytics-point-visible")!;
    const scale = bounds.width / viewBox.width;
    const center = (x: number) => bounds.left + x * scale;
    return {
      actual: center(Number(point.getAttribute("cx"))),
      expected: center(45 + (viewBox.width - 45 - 16) / 2),
    };
  });
  expect(Math.abs(centeredMediaPoint.actual - centeredMediaPoint.expected)).toBeLessThan(1);
  await expect(feed.locator('[data-section="ranked-media"]')).toHaveCount(0);
  await expect(feed.locator(".analytics-section")).toHaveCount(4);
  await expect(feed.locator(".analytics-section-index").allTextContents()).resolves.toEqual(["01", "02", "03", "04"]);

  const rankedPage = await page.context().newPage();
  await seedSingleScoreRanked(rankedPage);
  await openAnalytics(rankedPage);
  const rankedFeed = rankedPage.locator(".analytics-page");
  const rankedAxis = rankedFeed.locator('[data-section="ranked-media"]');
  await expect(rankedFeed.locator(".analytics-histogram-bin")).toHaveCount(1);
  await expect(rankedFeed.locator(".analytics-histogram-bin")).toHaveAttribute("data-score", "7");
  await expect(rankedFeed.locator(".analytics-media-score")).toHaveCount(1);
  await expect(rankedFeed.locator(".analytics-media-score")).toHaveAttribute("data-score", "7");
  await expect(rankedAxis.locator(".analytics-ranked-position")).toHaveCount(1);
  await expect(rankedAxis.locator(".analytics-ranked-position")).toHaveAttribute("data-score", "7");
  await expect(rankedAxis.locator(".analytics-ranked-point")).toHaveCount(2);
  const singleTierWeights = await rankedAxis.locator(".analytics-ranked-point").evaluateAll((points) =>
    points.map((point) => Number(point.getAttribute("data-weight"))),
  );
  expect(singleTierWeights.every(Number.isFinite)).toBe(true);
  expect(singleTierWeights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  await expectSingleMarkCentered(rankedFeed.locator(".analytics-histogram"), ".analytics-bin-bar", 45);
  await expectSingleMarkCentered(rankedFeed.locator(".analytics-media-chart"), ".analytics-point-visible", 45);
  await expectSingleMarkCentered(rankedAxis.locator(".analytics-ranked-chart"), ".analytics-ranked-point .analytics-point-visible", 48);
  await rankedPage.close();
});

test("the supplied save renders readable analytics and supports inspection, refresh and confirmation", async ({ page }) => {
  const archivePath = process.env.TASTELLAR_ANALYTICS_SAMPLE;
  test.skip(!archivePath || !existsSync(archivePath), "Set TASTELLAR_ANALYTICS_SAMPLE to SAVE 1.tastellar.json.");
  const archive = JSON.parse(readFileSync(archivePath!, "utf8")) as SaveArchive;
  const rankedById = new Map(archive.history.ranking.entries.map((item) => [item.entryId, item]));
  const entriesById = new Map(archive.library.entries.map((item) => [item.id, item]));
  const ratedEntries = archive.library.entries.filter((entry) =>
    entry.disposition === "experienced" && Number.isInteger(entry.overallRating),
  );
  const expectedRatingScores = [...new Set(ratedEntries.map((entry) => entry.overallRating!))].sort((a, b) => a - b);
  const mediaCountByType = new Map<string | null, number[]>();
  for (const entry of ratedEntries) {
    const counts = mediaCountByType.get(entry.mediaTypeId ?? null) ?? Array(10).fill(0);
    counts[entry.overallRating! - 1] += 1;
    mediaCountByType.set(entry.mediaTypeId ?? null, counts);
  }
  const expectedMediaScores = Array.from({ length: 10 }, (_, index) => index + 1).filter((score) =>
    [...mediaCountByType.values()].some((counts) => counts.reduce((sum, count) => sum + count, 0) >= 5 && counts[score - 1] > 0),
  );
  const scoreEightUnplaced = deriveCanonicalPlacedOrder(archive).get(8)?.find((id) => rankedById.get(id)?.placed);
  const scoreNineTypeCounts = new Map<string, number>();
  for (const id of deriveCanonicalPlacedOrder(archive).get(9) ?? []) {
    const typeId = entriesById.get(id)?.mediaTypeId;
    if (typeId) scoreNineTypeCounts.set(typeId, (scoreNineTypeCounts.get(typeId) ?? 0) + 1);
  }
  const singleScoreNineType = [...scoreNineTypeCounts].find(([, count]) => count === 1)?.[0];
  const scoreNineUnplaced = deriveCanonicalPlacedOrder(archive).get(9)?.find((id) =>
    rankedById.get(id)?.placed && entriesById.get(id)?.mediaTypeId === singleScoreNineType,
  );
  expect(scoreEightUnplaced).toBeTruthy();
  expect(scoreNineUnplaced).toBeTruthy();
  await seedArchivePreview(page, archive, [scoreEightUnplaced!, scoreNineUnplaced!]);
  await openAnalytics(page);

  const feed = page.locator(".analytics-page");
  await expect(feed).toBeVisible();
  await expect(feed.locator(".analytics-section")).toHaveCount(5);
  await expect(feed.locator(".analytics-section").evaluateAll((sections) =>
    sections.map((section) => section.getAttribute("data-section")),
  )).resolves.toEqual(["ratings", "media", "ranked-media", "top", "boundary"]);
  await expect(feed.locator(".analytics-histogram")).toBeVisible();
  await expect(feed.locator(".analytics-media-chart")).toBeVisible();
  const rankedMedia = feed.locator('[data-section="ranked-media"]');
  await expect(rankedMedia.getByRole("heading", { name: "Position within score groups" })).toBeVisible();
  await expect(rankedMedia.getByRole("group", { name: /Relative rank weight by score and media type/ })).toBeVisible();
  const rankedMethod = rankedMedia.locator(".analytics-ranked-note").filter({ hasText: /mean position becomes a relative weight/ });
  await expect(rankedMethod).toHaveCount(1);
  const tierTen = rankedMedia.locator('.analytics-ranked-position[data-score="10"]');
  await expect(tierTen).toHaveAttribute("data-available", "true");
  await expect(tierTen).toHaveAttribute("data-total-rated", "4");
  await expect(tierTen).toHaveAttribute("data-ranked-count", "4");
  const tierTenWeights = await rankedMedia.locator('.analytics-ranked-point[data-score="10"]').evaluateAll((points) =>
    points.map((point) => Number(point.getAttribute("data-weight"))),
  );
  expect(tierTenWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  const partialTierEight = rankedMedia.locator('.analytics-ranked-position[data-score="8"]');
  await expect(partialTierEight).toHaveAttribute("data-available", "true");
  const partialCoverage = Number(await partialTierEight.getAttribute("data-coverage"));
  expect(partialCoverage).toBeGreaterThan(0);
  expect(partialCoverage).toBeLessThan(1);
  await expect(partialTierEight.locator(".analytics-ranked-coverage")).toHaveText("98.5%");
  const partialRanks = await rankedMedia.locator('.analytics-ranked-point[data-score="8"]').evaluateAll((points) =>
    points.map((point) => Number(point.getAttribute("data-mean-rank"))),
  );
  const partialRankedCount = Number(await partialTierEight.getAttribute("data-ranked-count"));
  expect(partialRanks.every((rank) => Number.isFinite(rank) && rank <= partialRankedCount)).toBe(true);
  const unplacedTypeTier = rankedMedia.locator('.analytics-ranked-position[data-score="9"]');
  await expect(unplacedTypeTier).toHaveAttribute("data-available", "true");
  await expect(unplacedTypeTier.locator(".analytics-ranked-coverage")).toHaveText(/%/);
  const unplacedTypeId = singleScoreNineType!;
  await expect(rankedMedia.locator(`.analytics-ranked-point[data-score="9"][data-type-id="${unplacedTypeId}"]`)).toHaveCount(0);
  await rankedMedia.locator('.analytics-ranked-point[data-score="9"]').first().click();
  const unplacedTypeDialog = page.getByRole("dialog");
  await expect(unplacedTypeDialog).toBeVisible();
  const unrankedRows = await unplacedTypeDialog.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? "")),
  );
  expect(unrankedRows.some((row) => row[1] === "–" && row[2] === "0 / 1" && row[3] === "0")).toBe(true);
  await expect(unplacedTypeDialog).not.toContainText(/mean position becomes a relative weight/);
  await unplacedTypeDialog.getByRole("button", { name: "Close", exact: true }).click();
  const tierFive = rankedMedia.locator('.analytics-ranked-position[data-score="5"]');
  await expect(tierFive).toHaveAttribute("data-available", "false");
  await expect(rankedMedia.locator('.analytics-ranked-point[data-score="5"]')).toHaveCount(0);
  const rankedScores = await rankedMedia.locator(".analytics-ranked-score").evaluateAll((labels) =>
    labels.map((label) => Number(label.parentElement?.getAttribute("data-score"))),
  );
  expect(rankedScores).toEqual(expectedRatingScores);
  await expect(rankedMedia.locator('.analytics-ranked-position[data-score="1"]')).toHaveCount(0);
  await expect(rankedMedia.locator('.analytics-ranked-position[data-score="2"]')).toHaveCount(0);
  await expect(rankedMedia.locator('.analytics-ranked-position[data-score="3"]')).toHaveCount(0);
  await expect(rankedMedia.locator('.analytics-ranked-position[data-score="4"]')).toHaveCount(0);
  const histogramBins = feed.locator(".analytics-histogram-bin");
  await expect(histogramBins).toHaveCount(expectedRatingScores.length);
  expect(await histogramBins.evaluateAll((bins) => bins.map((bin) => Number(bin.getAttribute("data-score"))))).toEqual(expectedRatingScores);
  expect(await histogramBins.evaluateAll((bins) => bins.map((bin) => Number(bin.getAttribute("data-count"))))).toEqual(
    expectedRatingScores.map((score) => ratedEntries.filter((entry) => entry.overallRating === score).length),
  );
  const mediaScores = await feed.locator(".analytics-media-score").evaluateAll((labels) =>
    labels.map((label) => Number(label.getAttribute("data-score"))),
  );
  expect(mediaScores).toEqual(expectedMediaScores);
  for (const score of mediaScores) {
    const eligibleTypeTotal = [...mediaCountByType.values()]
      .filter((counts) => counts.reduce((sum, count) => sum + count, 0) >= 5)
      .reduce((sum, counts) => sum + counts[score - 1], 0);
    expect(eligibleTypeTotal, `score ${score} is occupied by at least one plotted media series`).toBeGreaterThan(0);
  }
  const plottedTypeIds = await rankedMedia.locator(".analytics-ranked-point").evaluateAll((points) =>
    [...new Set(points.map((point) => point.getAttribute("data-type-id")))].sort(),
  );
  const rankedLineRuns = await rankedMedia.locator(".analytics-ranked-line").evaluateAll((lines) => {
    const scoreTicks = [...document.querySelectorAll(".analytics-ranked-position")].map((position, index) => ({
      index,
      score: Number(position.getAttribute("data-score")),
      available: position.getAttribute("data-available") === "true",
      x: Number(position.querySelector(".analytics-ranked-score")?.getAttribute("x")),
    }));
    return lines.map((line) => [...(line as SVGPolylineElement).points].map((point) => {
      const tick = scoreTicks.find((item) => Math.abs(item.x - point.x) < 0.01);
      return tick ? { score: tick.score, index: tick.index, available: tick.available } : null;
    }));
  });
  for (const run of rankedLineRuns) {
    expect(run.every((point) => point?.available)).toBe(true);
    for (let index = 1; index < run.length; index += 1) {
      expect(run[index]!.index - run[index - 1]!.index).toBe(1);
    }
  }
  const rankedLegendNames = await rankedMedia.locator(".analytics-ranked-legend [role='listitem']").allTextContents();
  const expectedRankedLegendNames = plottedTypeIds.map((typeId) => {
    if (typeId === "__no-type__") return "No type";
    const name = archive.library.mediaTypes.find((type) => type.id === typeId)?.name ?? typeId;
    return name === "Anime" ? "Animation" : name;
  }).sort();
  expect(rankedLegendNames.map((name) => name.trim()).sort()).toEqual(expectedRankedLegendNames);
  if (!plottedTypeIds.includes("__no-type__")) await expect(rankedMedia.locator(".analytics-ranked-legend")).not.toContainText(/No type/);
  const scoresWithMultipleMediaPoints = await rankedMedia.locator(".analytics-ranked-position[data-available='true']").evaluateAll((tiers) =>
    tiers.map((tier) => Number(tier.getAttribute("data-score"))).filter((score) =>
      document.querySelectorAll(`.analytics-ranked-point[data-score='${score}']`).length > 1,
    ),
  );
  expect(scoresWithMultipleMediaPoints.length).toBeGreaterThan(0);
  const sharedTierScore = scoresWithMultipleMediaPoints[0];
  const sameTierPoints = rankedMedia.locator(`.analytics-ranked-point[data-score='${sharedTierScore}']`);
  await sameTierPoints.nth(0).click();
  const firstTierDialog = page.getByRole("dialog");
  const firstTierRows = await firstTierDialog.locator("tbody").innerText();
  await expect(firstTierDialog).toContainText(`${sharedTierScore}`);
  await expect(firstTierDialog).not.toContainText(/mean position becomes a relative weight/);
  await firstTierDialog.getByRole("button", { name: "Close", exact: true }).click();
  await sameTierPoints.nth(1).click();
  const secondTierRows = await page.getByRole("dialog").locator("tbody").innerText();
  expect(secondTierRows).toBe(firstTierRows);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(feed.locator("[data-section='rarity']")).toHaveCount(0);
  await expect(feed).toContainText("247 rated works");
  await expect(feed).not.toContainText(/analytics\.(?:observation|obs)\./);
  await expect(feed).not.toContainText(/\{(?:score|percentage|count|type)\}/);
  await expect(feed.locator(".analytics-top-selection h3")).not.toContainText(/released in the/);

  const legend = feed.locator(".analytics-media-legend");
  await expect(legend).toContainText("Animation");
  await expect(legend).not.toContainText(/\bAnime\b/);
  await expect(feed.locator(".analytics-media-summaries")).toContainText("Animation");
  await expect(feed.locator(".analytics-media-summaries")).not.toContainText(/\bAnime\b/);
  const comparisons = feed.locator(".analytics-media-comparison");
  await expect(comparisons).toHaveCount(3);
  await expect(comparisons.first().locator(".analytics-comparison-title")).toContainText("Animation vs Films");
  await expect(comparisons.first().locator(".analytics-comparison-peak")).toContainText("Animation");
  await expect(comparisons.first().locator(".analytics-comparison-peak")).toContainText("Films");
  await expect(feed.locator(".analytics-media-comparisons")).not.toContainText("Their most common scores");
  await expect(feed.locator(".analytics-high-share")).toContainText("Games");

  const chart = feed.locator(".analytics-histogram");
  await expect(chart.getByRole("button", { name: /rated 7 out of 10/ })).toBeVisible();
  const mostCommonBin = chart.getByRole("button", { name: /124 works rated 7 out of 10/ });
  await expect(mostCommonBin.locator(".analytics-bin-share")).toHaveText("50.2%");
  const countLabel = await mostCommonBin.locator(".analytics-bin-count").boundingBox();
  const tallestBar = await mostCommonBin.locator(".analytics-bin-bar").boundingBox();
  expect(countLabel, "the tallest histogram label has a rendered box").not.toBeNull();
  expect(tallestBar, "the tallest histogram bar has a rendered box").not.toBeNull();
  expect(countLabel!.y + countLabel!.height).toBeLessThanOrEqual(tallestBar!.y + 1);
  const yTicks = await chart.locator(".analytics-y-tick").allTextContents();
  expect(yTicks.length).toBeGreaterThan(1);
  const numericTicks = yTicks.map((tick) => Number(tick.replaceAll(",", "")));
  expect(numericTicks).toEqual([0, 20, 40, 60, 80, 100, 120, 140]);
  await chart.getByRole("button", { name: /rated 7 out of 10/ }).click();
  const inspection = page.getByRole("dialog");
  await expect(inspection).toBeVisible();
  await expect(inspection).toBeInViewport();
  const modalBody = inspection.locator(".analytics-inspection-body");
  const modalInner = inspection.locator(".modal-inner");
  const modalList = inspection.locator(".analytics-inspection-list");
  const bodyBox = await modalBody.boundingBox();
  const innerBox = await modalInner.boundingBox();
  const listBox = await modalList.boundingBox();
  expect(bodyBox, "inspection body has a rendered box").not.toBeNull();
  expect(innerBox, "dialog inner frame has a rendered box").not.toBeNull();
  expect(listBox, "inspection rows have a rendered box").not.toBeNull();
  expect(listBox!.x - bodyBox!.x).toBeGreaterThanOrEqual(20);
  expect(bodyBox!.x + bodyBox!.width - listBox!.x - listBox!.width).toBeGreaterThanOrEqual(20);
  await expect(inspection.locator(".analytics-inspection-list li")).toHaveCount(124);
  await inspection.getByRole("button", { name: "Close", exact: true }).click();

  const firstLegend = feed.locator(".analytics-media-legend button").first();
  await firstLegend.click();
  await expect(firstLegend).toHaveAttribute("aria-pressed", "false");
  await firstLegend.click();
  await expect(firstLegend).toHaveAttribute("aria-pressed", "true");

  const topTitle = feed.locator(".analytics-top-selection h3");
  const firstSelection = (await topTitle.textContent())?.trim();
  await expect(feed.getByRole("button", { name: "Refresh selection", exact: true })).toBeVisible();
  await feed.getByRole("button", { name: "Refresh selection", exact: true }).click();
  await expect(topTitle).not.toHaveText(firstSelection ?? "");
  let selectedTitle = (await topTitle.textContent())?.trim();

  const content = page.locator(".content-scroll");
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const section of await feed.locator(".analytics-section").all()) {
    const box = await section.boundingBox();
    expect(box, "every analytics section should remain in the page's visible column").not.toBeNull();
    expect(box!.width).toBeGreaterThan(500);
    expect(box!.height).toBeGreaterThan(100);
  }
  await content.evaluate((element) => { element.scrollTop = 0; });
  const paletteProperties = ["--analytics-violet", "--analytics-cyan", ...Array.from({ length: 10 }, (_, index) => `--analytics-series-${index + 1}`)];
  const readPalette = () => feed.evaluate((element, properties) => {
    const style = getComputedStyle(element);
    return properties.map((property) => style.getPropertyValue(property).trim());
  }, paletteProperties);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const darkPalette = await readPalette();
  await page.screenshot({ path: "test-results/analytics-save-dark-wide.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await feed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/analytics-save-dark-narrow.png", fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 1320, height: 920 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const lightPalette = await readPalette();
  expect(lightPalette).toEqual(darkPalette);
  await page.screenshot({ path: "test-results/analytics-save-light-wide.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await feed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/analytics-save-light-narrow.png", fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 1320, height: 920 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "reading"; });
  const readingPalette = await readPalette();
  expect(readingPalette.slice(2).filter(Boolean).length).toBe(10);
  expect(new Set(readingPalette.slice(2)).size).toBe(10);
  const readingGradientStops = await chart.locator("linearGradient stop").evaluateAll((stops) =>
    stops.map((stop) => getComputedStyle(stop).stopColor),
  );
  expect(readingGradientStops).toEqual(["rgb(101, 144, 131)", "rgb(56, 127, 130)"]);
  await page.screenshot({ path: "test-results/analytics-save-reading-wide.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await feed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/analytics-save-reading-narrow.png", fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 1320, height: 920 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await feed.locator('[data-section="ratings"]').screenshot({ path: "test-results/analytics-ratings-section.png", animations: "disabled" });
  await feed.locator('[data-section="media"]').screenshot({ path: "test-results/analytics-media-section.png", animations: "disabled" });
  await rankedMedia.screenshot({ path: "test-results/analytics-ranked-media-section.png", animations: "disabled" });
  await feed.locator('[data-section="top"]').screenshot({ path: "test-results/analytics-top-section.png", animations: "disabled" });
  await feed.locator('[data-section="boundary"]').screenshot({ path: "test-results/analytics-boundary-section.png", animations: "disabled" });

  for (const theme of ["dark", "light", "reading"] as const) {
    await page.evaluate((selectedTheme) => { document.documentElement.dataset.theme = selectedTheme; }, theme);
    await page.setViewportSize({ width: 1320, height: 920 });
    await rankedMedia.screenshot({ path: `test-results/analytics-ranked-${theme}-wide.png`, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await rankedMedia.screenshot({ path: `test-results/analytics-ranked-${theme}-narrow.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1320, height: 920 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(topTitle).not.toHaveText(selectedTitle ?? "");
  selectedTitle = (await topTitle.textContent())?.trim();

  const boundary = feed.locator('[data-section="boundary"]');
  await expect(boundary.locator(".analytics-boundary-pair")).toBeVisible();
  await expect(boundary.locator(".analytics-boundary-prompt")).toContainText("10/10");
  const upperTitle = (await boundary.locator(".analytics-boundary-work").first().locator("strong").textContent())?.trim();
  await boundary.getByRole("button", { name: /Move .* to 9 out of 10/ }).click();
  await expect(boundary.locator(".analytics-boundary-work").first().locator("strong")).not.toHaveText(upperTitle ?? "");
  await expect(feed.locator(".analytics-histogram").getByRole("button", { name: "3 works rated 10 out of 10" })).toBeVisible();
  await expect(topTitle).toHaveText(selectedTitle ?? "");
  await expect(boundary.getByRole("alert")).toHaveCount(0);
  const nextTenNineBoundary = await boundary.locator(".analytics-boundary-prompt").textContent();
  await boundary.getByRole("button", { name: "Keep both scores", exact: true }).click();
  await expect(boundary.locator(".analytics-boundary-prompt")).not.toHaveText(nextTenNineBoundary ?? "");
  await expect(topTitle).toHaveText(selectedTitle ?? "");
  await expect(boundary.getByRole("alert")).toHaveCount(0);

});
