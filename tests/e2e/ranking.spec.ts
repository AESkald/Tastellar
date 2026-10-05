import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function chooseCustomOption(page: Page, within: Locator, label: string, optionName: string) {
  await within.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function addRatedWork(page: Page, title: string, score = "8") {
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await dialog.getByPlaceholder("Media title").fill(title);
  await chooseCustomOption(page, dialog, "Disposition", "Already experienced");
  if (score) await chooseCustomOption(page, dialog, "Overall rating", `${score} / 10`);
  await dialog.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function uploadCoverForEntry(page: Page, title: string, label: string, color: string, score = 8) {
  await page.locator(`#ranking-tier-${score} .ranking-placed-list .placed-card`)
    .filter({ hasText: title })
    .locator(".ranking-card-title-button")
    .click();
  const details = page.locator(".ranking-context-panel");
  await details.getByRole("button", { name: "Edit work", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit work" });
  const dataUrl = await page.evaluate(({ label: coverLabel, color: coverColor }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    const gradient = context.createLinearGradient(0, 0, 240, 320);
    gradient.addColorStop(0, coverColor);
    gradient.addColorStop(1, "#17151f");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 240, 320);
    context.fillStyle = "#ffffff";
    context.font = "bold 24px sans-serif";
    context.fillText(coverLabel, 20, 170, 200);
    return canvas.toDataURL("image/png");
  }, { label, color });
  const base64 = dataUrl.split(",")[1];
  if (!base64) throw new Error("Could not encode the synthetic cover");
  await editor.locator('input[type="file"]').setInputFiles({
    name: `${label.toLowerCase().replace(/\s+/g, "-")}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(editor.locator(".cover-upload-preview img")).toBeVisible();
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(editor).toHaveCount(0);
  return dataUrl;
}

test("Ranking starts with a seed duel and per-work actions use binary placement", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const topPanelToggles = page.locator(".titlebar .panel-toggle");
  await expect(topPanelToggles).toHaveCount(2);
  await expect(page.locator(".ranking-header .panel-toggle")).toHaveCount(0);
  const leftToggleBox = await topPanelToggles.nth(0).boundingBox();
  const rightToggleBox = await topPanelToggles.nth(1).boundingBox();
  if (!leftToggleBox || !rightToggleBox) throw new Error("The paired sidebar controls are missing");
  expect(rightToggleBox.x - (leftToggleBox.x + leftToggleBox.width)).toBeLessThan(20);

  const tierList = page.locator(".ranking-tier-list");
  await expect(tierList.locator(".ranking-tier")).toHaveCount(10);
  await expect(page.locator(".ranking-header h1")).toHaveText("Ranking");
  await expect(page.getByRole("tab", { name: "Duels" }).locator("svg.lucide-swords")).toBeVisible();
  const caption = page.locator(".ranking-library-sidebar .groups-caption");
  await expect(caption.locator("strong")).toHaveText("Media");
  await expect(caption.locator("span")).toContainText(/\d+/);
  await expect(page.locator(".ranking-library-sidebar").getByRole("button", { name: "Media", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Why compare apples to oranges?" }).click();
  const tierHelp = page.getByRole("dialog", { name: "Why keep ranking works?" });
  await expect(tierHelp).toContainText("Recap and Analysis");
  const sidebarDivider = await page.locator(".ranking-workspace > .folder-shell").evaluate((element) => ({
    border: getComputedStyle(element).borderRightColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    width: getComputedStyle(element).borderRightWidth,
  }));
  expect(sidebarDivider.border).not.toBe(sidebarDivider.accent);
  expect(sidebarDivider.width).toBe("1px");
  await page.screenshot({ path: "test-results/ranking-tier-help.png", animations: "disabled" });
  await tierHelp.getByRole("button", { name: "Done" }).click();

  await addRatedWork(page, "First ranked story");
  await addRatedWork(page, "Second ranked story");
  const tier = page.locator("#ranking-tier-8");
  await expect(tier.locator(".ranking-unplaced-tray")).toContainText("First ranked story");
  await expect(tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).locator("svg.lucide-swords")).toBeVisible();
  await expect(tier.getByRole("button", { name: "Place first", exact: true })).toHaveCount(0);
  await tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).click();
  await expect(page.getByRole("heading", { name: "Build your starting order" })).toBeVisible();
  await expect(page.getByText("Which of these two works do you prefer?", { exact: true })).toBeVisible();
  await expect(page.locator(".ranking-duel-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose another tier", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-seed-duel.png", animations: "disabled" });
  await page.getByRole("button", { name: "Choose First ranked story" }).click();
  await page.getByRole("tab", { name: "Tier list" }).click();
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(2);
  await expect(tier.locator(".ranking-move-controls")).toHaveCount(0);
  await expect(tier.locator(".ranking-placed-list")).toContainText("First ranked story");
  await expect(tier.locator(".ranking-placed-list")).toContainText("Second ranked story");

  await addRatedWork(page, "Third ranked story");
  await tier.locator(".ranking-unplaced-tray").getByRole("button", { name: "Place with duels", exact: true }).click();
  await expect(page.getByText(/Quick placement/)).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-binary-placement.png", animations: "disabled" });
  for (let step = 0; step < 4; step += 1) {
    if (await page.getByRole("heading", { name: "Does this spot look right?" }).count()) break;
    await page.getByRole("button", { name: "Choose Third ranked story" }).click();
  }
  await expect(page.getByRole("heading", { name: "Does this spot look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Place it here", exact: true }).click();
  const binaryOffer = page.locator(".ranking-binary-offer");
  if (await binaryOffer.count()) {
    await expect(binaryOffer.getByRole("button", { name: "Why compare works?" })).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Tier list" }).click();
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(3);
  await page.locator(".content-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: "test-results/ranking-tier-list-desktop.png", animations: "disabled" });
  const placedListBounds = await tier.locator(".ranking-placed-list").boundingBox();
  const placedCardBounds = await tier.locator(".ranking-placed-list .placed-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
  if (!placedListBounds || !placedCardBounds.length) throw new Error("The placed tier rows are missing");
  expect(Math.max(...placedCardBounds)).toBeLessThan(placedListBounds.width - 80);

  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByRole("button", { name: "How duels work?" }).first().click();
  const duelHelp = page.getByRole("dialog", { name: "Why compare works?" });
  await expect(duelHelp).toContainText("same tier list you edit by hand");
  await page.screenshot({ path: "test-results/ranking-duel-help.png", animations: "disabled" });
  await duelHelp.getByRole("button", { name: "Done" }).click();
  await page.screenshot({ path: "test-results/ranking-duels-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole("button", { name: "Hide left sidebar" }).count()) {
    await page.getByRole("button", { name: "Hide left sidebar" }).click();
  }
  if (await page.getByRole("button", { name: "Hide work details" }).count()) {
    await page.getByRole("button", { name: "Hide work details" }).click();
  }
  await page.getByRole("tab", { name: "Tier list" }).click();
  await page.locator(".content-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: "test-results/ranking-tier-list-mobile.png", animations: "disabled" });
  await page.getByRole("tab", { name: "Duels" }).click();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalOverflow).toBe(false);
  await page.screenshot({ path: "test-results/ranking-duels-mobile.png", animations: "disabled" });
});

test("placed titles grow naturally and wrap at two lines on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const titles = [
      ["title-short", "Ashen"],
      ["title-medium", "The Lanterns of Veridia: Chronicle of the Northern Road"],
      ["title-long", "A richly detailed chronicle of forgotten kingdoms, distant constellations, and the quiet travelers who carry their stories across the winter road. ".repeat(3)],
    ];
    const entries = titles.map(([id, title]) => ({
      id,
      version: 1,
      title,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: 8,
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
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0,
      entries,
      mediaTypes: [],
      criteria: [],
      tags: [],
    }));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  for (const name of ["Hide left sidebar", "Hide work details"]) {
    const toggle = page.getByRole("button", { name, exact: true });
    if (await toggle.count()) await toggle.click();
  }
  const tier = page.locator("#ranking-tier-8");
  const cards = tier.locator('.ranking-placed-list .placed-card[data-ranking-entry]');
  await expect(cards).toHaveCount(3);

  const measureCards = async () => tier.locator(".ranking-placed-list").evaluate((list) => {
    const listWidth = list.getBoundingClientRect().width;
    const cards = Array.from(list.querySelectorAll<HTMLElement>(".placed-card"));
    return {
      listWidth,
      cards: cards.map((card) => {
        const title = card.querySelector<HTMLElement>(".ranking-card-title-button")!;
        const style = getComputedStyle(title);
        return {
          id: card.dataset.rankingEntry,
          width: card.getBoundingClientRect().width,
          title: title.textContent,
          lines: Math.round(title.getBoundingClientRect().height / parseFloat(style.lineHeight)),
          whiteSpace: style.whiteSpace,
          lineClamp: style.webkitLineClamp,
        };
      }),
    };
  });

  const desktop = await measureCards();
  const desktopById = Object.fromEntries(desktop.cards.map((card) => [card.id, card]));
  expect(desktopById["title-short"]!.width).toBeLessThan(desktopById["title-medium"]!.width);
  expect(desktopById["title-short"]!.lines).toBe(1);
  expect(desktopById["title-medium"]!.title).toBe("The Lanterns of Veridia: Chronicle of the Northern Road");
  expect(desktopById["title-medium"]!.lines).toBeLessThanOrEqual(2);
  expect(desktopById["title-medium"]!.width).toBeLessThanOrEqual(441);
  expect(desktopById["title-long"]!.width).toBeLessThanOrEqual(441);
  expect(desktopById["title-long"]!.lines).toBe(2);
  expect(desktopById["title-long"]!.whiteSpace).toBe("normal");
  expect(desktopById["title-long"]!.lineClamp).toBe("2");
  await page.screenshot({ path: "test-results/ranking-placed-title-widths-desktop.png", animations: "disabled" });

  await tier.locator('[data-ranking-entry="title-short"] .ranking-card-title-button').click();
  await expect(page.locator(".library-detail-content .detail-title-block h2")).toHaveText("Ashen");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Hide left sidebar", "Hide work details"]) {
    const toggle = page.getByRole("button", { name, exact: true });
    if (await toggle.count()) await toggle.click();
  }
  const mobile = await measureCards();
  const mobileById = Object.fromEntries(mobile.cards.map((card) => [card.id, card]));
  expect(mobileById["title-short"]!.width).toBeLessThan(mobileById["title-medium"]!.width);
  expect(mobileById["title-short"]!.lines).toBe(1);
  expect(mobileById["title-medium"]!.title).toBe("The Lanterns of Veridia: Chronicle of the Northern Road");
  expect(mobileById["title-medium"]!.lines).toBeLessThanOrEqual(2);
  expect(mobileById["title-medium"]!.width).toBeLessThanOrEqual(mobile.listWidth + 1);
  expect(mobileById["title-long"]!.width).toBeLessThanOrEqual(mobile.listWidth + 1);
  expect(mobileById["title-long"]!.lines).toBe(2);
  expect(mobileById["title-long"]!.lineClamp).toBe("2");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await page.screenshot({ path: "test-results/ranking-placed-title-widths-mobile.png", animations: "disabled" });
});

test("a normal duel updates the same shared tier order", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = ["First normal work", "Second normal work"].map((title, index) => ({
      id: `normal-tier-${index}`,
      version: 1,
      title,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: 8,
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
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0,
      entries,
      mediaTypes: [],
      criteria: [],
      tags: [],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const tier = page.locator("#ranking-tier-8");
  const initialOrder = tier.locator(".ranking-placed-list .placed-card .ranking-card-title-button");
  await expect(initialOrder).toHaveCount(2);
  await expect(initialOrder.nth(0)).toHaveText("First normal work");
  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByLabel("Choose a score tier").selectOption("8");
  await page.getByRole("button", { name: "Start duels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Which work do you prefer in this score tier?" })).toBeVisible();
  await page.getByRole("button", { name: "Choose Second normal work" }).click();
  await expect(page.locator(".ranking-duel-card")).toHaveCount(0);
  await expect(page.locator(".ranking-updated-tier-bottom")).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-duel-updated-tier-footer.png", animations: "disabled" });
  await page.getByRole("button", { name: "View updated tier", exact: true }).click();
  await page.getByRole("tab", { name: "Tier list" }).click();
  const updatedOrder = tier.locator(".ranking-placed-list .placed-card .ranking-card-title-button");
  await expect(updatedOrder.nth(0)).toHaveText("Second normal work");
  await expect(updatedOrder.nth(1)).toHaveText("First normal work");
  await page.locator(".content-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: "test-results/ranking-normal-order-updated.png", animations: "disabled" });
});

test("duel choices can be undone and skipping advances to a different pair", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = ["Undo story one", "Undo story two", "Undo story three", "Undo story four"].map((title, index) => ({
      id: `undo-story-${index}`,
      version: 1,
      title,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: 8,
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
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0, entries, mediaTypes: [], criteria: [], tags: [],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByLabel("Choose a score tier").selectOption("8");
  await page.getByRole("button", { name: "Start duels", exact: true }).click();

  const titles = page.locator(".ranking-duel-card-title");
  await expect(titles).toHaveCount(2);
  const firstPair = await titles.allTextContents();
  const pairKey = (pair: string[]) => [...pair].sort().join(" | ");
  await page.getByRole("button", { name: `Choose ${firstPair[0]}` }).click();
  const undo = page.getByRole("button", { name: "Undo last choice", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(titles).toHaveText(firstPair);

  await page.getByRole("button", { name: `Choose ${firstPair[0]}` }).click();
  await expect.poll(async () => {
    const next = await titles.allTextContents();
    return next.length === 2 ? pairKey(next) : "ended";
  }).not.toBe(pairKey(firstPair));
  const secondPair = await titles.allTextContents();
  await page.getByRole("button", { name: "Skip this pair", exact: true }).click();
  await expect.poll(async () => {
    const next = await titles.allTextContents();
    return next.length === 2 ? pairKey(next) : "ended";
  }).not.toBe(pairKey(secondPair));
});

test("duel artwork follows each work and falls back cleanly when no cover exists", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = [
      ["cover-alpha", "Cover Alpha", 8, "film"],
      ["cover-bravo", "Cover Bravo", 8, "book"],
      ["cover-charlie", "Cover Charlie", 7, "game"],
      ["cover-delta", "Cover Delta", 7, "book"],
    ].map(([id, title, score, mediaTypeId]) => ({
      id,
      version: 1,
      title,
      disposition: "experienced",
      mediaTypeId,
      overallRating: score,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }));
    const mediaTypes = [
      ["film", "Films", "film"],
      ["book", "Books", "book-open"],
      ["game", "Games", "gamepad-2"],
    ].map(([id, name, iconKey], sortOrder) => ({
      id, name, sortOrder, iconKey, criterionIds: [], archivedAt: null,
      version: 1, createdAt: now, updatedAt: now,
    }));
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0, entries, mediaTypes, criteria: [], tags: [],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const detailsToggle = page.getByRole("button", { name: "Show work details", exact: true });
  if (await detailsToggle.count()) await detailsToggle.click();
  const expectedCovers = new Map<string, string>();
  expectedCovers.set("Cover Alpha", await uploadCoverForEntry(page, "Cover Alpha", "ALPHA", "#8958d6", 8));
  expectedCovers.set("Cover Bravo", await uploadCoverForEntry(page, "Cover Bravo", "BRAVO", "#cf724e", 8));
  expectedCovers.set("Cover Charlie", await uploadCoverForEntry(page, "Cover Charlie", "CHARLIE", "#378a72", 7));

  const verifyArtwork = async (expectedTitles: string[]) => {
    const cards = page.locator(".ranking-duel-card");
    await expect(cards).toHaveCount(2);
    const shownTitles = await page.locator(".ranking-duel-card-title").allTextContents();
    expect([...shownTitles].sort()).toEqual([...expectedTitles].sort());
    for (let index = 0; index < 2; index += 1) {
      const title = shownTitles[index];
      const art = cards.nth(index).locator(".ranking-duel-art");
      const expectedCover = expectedCovers.get(title);
      if (expectedCover) {
        await expect(art.locator("img")).toHaveAttribute("src", expectedCover);
        await expect(art).toHaveClass(/has-cover/);
      } else {
        await expect(art).toHaveClass(/no-cover/);
        await expect(art.locator(".ranking-duel-monogram")).toHaveText(title.slice(0, 1));
      }
    }
  };

  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByLabel("Choose a score tier").selectOption("8");
  await page.getByRole("button", { name: "Start duels", exact: true }).click();
  await verifyArtwork(["Cover Alpha", "Cover Bravo"]);
  await page.screenshot({ path: "test-results/ranking-duel-covers-dark.png", animations: "disabled" });
  const firstTitle = (await page.locator(".ranking-duel-card-title").first().textContent())?.trim();
  if (!firstTitle) throw new Error("The first duel work title is missing");
  await page.getByRole("button", { name: `Choose ${firstTitle}` }).click();
  await expect(page.getByRole("heading", { name: "This duel session has ended" })).toBeVisible();
  await page.getByRole("button", { name: "View the tier list", exact: true }).click();
  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByLabel("Choose a score tier").selectOption("7");
  await page.getByRole("button", { name: "Start duels", exact: true }).click();
  await verifyArtwork(["Cover Charlie", "Cover Delta"]);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: "test-results/ranking-duel-covers-light-fallback.png", animations: "disabled" });
});

test("the supplied archive can seed its all-unplaced tiers", async ({ page }) => {
  const archivePath = process.env.TASTELLAR_RANKING_SAMPLE;
  test.skip(!archivePath || !existsSync(archivePath), "Set TASTELLAR_RANKING_SAMPLE to the supplied archive path.");
  const archive = JSON.parse(readFileSync(archivePath!, "utf8")) as {
    library: { revision: number; entries: Array<{ id: string; overallRating: number | null; disposition: string }> };
    history: { ranking: { entries: Array<{ entryId: string; score: number; placed: boolean }>; tiers: Array<{ score: number; inputSequence: number }> } };
  };
  const ranking = archive.history.ranking;
  const byId = new Map(ranking.entries.map((entry) => [entry.entryId, entry]));
  const tierOrders = Array.from({ length: 10 }, (_, index) => {
    const score = 10 - index;
    return [score, {
      placed: ranking.entries.filter((entry) => entry.score === score && entry.placed).map((entry) => entry.entryId),
      unplaced: archive.library.entries.filter((entry) => entry.disposition === "experienced" && byId.get(entry.id)?.score === score && !byId.get(entry.id)?.placed).map((entry) => entry.id),
    }];
  });
  await page.addInitScript(({ library, rankedEntries, orders, tiers }) => {
    sessionStorage.setItem("tastellar.preview.revision.v1", String(library.revision));
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify(library));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      placements: rankedEntries.map((entry) => [entry.entryId, { score: entry.score, placed: entry.placed }]),
      tierOrders: orders,
      sequences: tiers.map((tier) => [tier.score, tier.inputSequence]),
      initialized: true,
      session: null,
      judgments: [],
      latestMove: null,
    }));
  }, { library: archive.library, rankedEntries: ranking.entries, orders: tierOrders, tiers: ranking.tiers });

  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const tier = page.locator("#ranking-tier-8");
  await expect(tier.locator(".ranking-unplaced-tray .unplaced-card")).toHaveCount(71);
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(0);
  await page.screenshot({ path: "test-results/ranking-supplied-archive-tier.png", animations: "disabled" });
  await tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).click();
  await expect(page.getByRole("heading", { name: "Build your starting order" })).toBeVisible();
  await expect(page.locator(".ranking-duel-card")).toHaveCount(2);
  await page.screenshot({ path: "test-results/ranking-supplied-archive-seed.png", animations: "disabled" });
  await page.locator(".ranking-duel-card").first().click();
  await page.getByRole("tab", { name: "Tier list" }).click();
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(2);
  await expect(tier.locator(".ranking-unplaced-tray .unplaced-card")).toHaveCount(69);

  const candidate = tier.locator(".ranking-unplaced-tray .unplaced-card").first();
  const candidateBox = await candidate.boundingBox();
  const placeActionBox = await candidate.locator(".ranking-inline-action").boundingBox();
  if (!candidateBox || !placeActionBox) throw new Error("The unplaced card action is missing");
  expect(candidateBox.x + candidateBox.width - placeActionBox.x - placeActionBox.width).toBeLessThanOrEqual(10);
  const candidateTitle = await candidate.locator(".ranking-card-title-button").getAttribute("title");
  await candidate.locator(".ranking-inline-action").click();
  await expect(page.getByText(/Quick placement/)).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-supplied-archive-binary.png", animations: "disabled" });
  await expect(page.locator(".ranking-duel-card").first()).toContainText(candidateTitle ?? "");
  for (let step = 0; step < 8; step += 1) {
    if (await page.getByRole("heading", { name: "Does this spot look right?" }).count()) break;
    await page.getByRole("button", { name: `Choose ${candidateTitle}` }).click();
  }
  await expect(page.getByRole("heading", { name: "Does this spot look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Place it here", exact: true }).click();
  const nextBinaryOffer = page.locator(".ranking-binary-offer");
  await expect(nextBinaryOffer).toBeVisible();
  await expect(nextBinaryOffer.getByRole("button", { name: "Why compare works?" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/ranking-binary-offer.png", animations: "disabled" });
  await page.getByRole("tab", { name: "Tier list" }).click();
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(3);
  await expect(tier.locator(".ranking-unplaced-tray .unplaced-card")).toHaveCount(68);
});

test("unrated works can be assigned a score without being silently placed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await dialog.getByPlaceholder("Media title").fill("Unrated work");
  await chooseCustomOption(page, dialog, "Disposition", "Already experienced");
  await dialog.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(page.locator(".ranking-unscored")).toContainText("Unrated work");

  await page.getByLabel("Choose an overall score for Unrated work").selectOption("7");
  const tier = page.locator("#ranking-tier-7");
  await expect(tier.locator(".ranking-unplaced-tray")).toContainText("Unrated work");
  await expect(tier.locator(".ranking-placed-list")).not.toContainText("Unrated work");
  await expect(page.getByLabel("Move Unrated work to a tier")).toHaveCount(0);
  await expect(tier.locator(".ranking-tier-move-select")).toHaveCount(0);
  await expect(tier.locator(".ranking-unplaced-tray")).toContainText("Unrated work");
  await page.locator(".content-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: "test-results/ranking-unplaced-controls-desktop.png", animations: "disabled" });
  await expect(tier.getByRole("button", { name: "Place it here" })).toHaveCount(0);
  await expect(tier.locator(".ranking-unplaced-tray .ranking-inline-action")).toBeVisible();
  await expect(tier.getByRole("button", { name: "Place first", exact: true })).toHaveCount(0);
  await tier.locator(".ranking-unplaced-tray").getByRole("button", { name: "Place with duels", exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Does this spot look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Place it here", exact: true }).click();
  await page.getByRole("tab", { name: "Tier list" }).click();
  await expect(tier.locator(".ranking-placed-list")).toContainText("Unrated work");
});

test("long drag can place an unrated work and a scored unplaced work can change tiers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await addRatedWork(page, "Waiting work", "6");
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add work" });
  await dialog.getByPlaceholder("Media title").fill("Unrated by drag");
  await chooseCustomOption(page, dialog, "Disposition", "Already experienced");
  await dialog.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const unratedHandle = page.locator('.unscored-card[data-ranking-entry]').filter({ hasText: "Unrated by drag" });
  const unratedTitle = unratedHandle.locator(".ranking-card-title-button");
  const contentScroll = page.locator(".content-scroll");
  await contentScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const source = await unratedHandle.boundingBox();
  if (!source) throw new Error("Ranking drag source is missing");
  const scroller = await contentScroll.boundingBox();
  if (!scroller) throw new Error("Ranking scroll area is missing");
  const titleBox = await unratedTitle.boundingBox();
  if (!titleBox) throw new Error("The unrated work title is missing");
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  const startingScroll = await contentScroll.evaluate((element) => element.scrollTop);
  await page.mouse.move(titleBox.x + titleBox.width / 2, scroller.y + 8, { steps: 12 });
  await page.waitForTimeout(800);
  await expect.poll(() => contentScroll.evaluate((element) => element.scrollTop)).toBeLessThan(startingScroll);
  const sidebarTier = page.locator('.ranking-sidebar-tier[data-ranking-drop-score="8"]');
  await expect(sidebarTier).toBeInViewport();
  const sidebarBox = await sidebarTier.boundingBox();
  if (!sidebarBox) throw new Error("The score tier drop target is missing from the sidebar");
  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + sidebarBox.height / 2, { steps: 10 });
  await page.mouse.up();
  const targetTier = page.locator("#ranking-tier-8");
  await expect(targetTier.locator(".ranking-unplaced-tray")).toContainText("Unrated by drag");
  await expect(page.locator(".ranking-unscored")).not.toContainText("Unrated by drag");

  const unplacedHandle = page.locator('.unplaced-card[data-ranking-entry]').filter({ hasText: "Waiting work" });
  const unplacedTitle = unplacedHandle.locator(".ranking-card-title-button");
  const unplacedTitleBox = await unplacedTitle.boundingBox();
  if (!unplacedTitleBox) throw new Error("The scored unplaced work title is not visible");
  await page.mouse.move(unplacedTitleBox.x + unplacedTitleBox.width / 2, unplacedTitleBox.y + unplacedTitleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + sidebarBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(targetTier.locator(".ranking-unplaced-tray")).toContainText("Waiting work");
  await expect(targetTier.locator(".ranking-placed-list")).not.toContainText("Waiting work");
  await expect(page.locator("#ranking-tier-6 .ranking-unplaced-tray")).not.toContainText("Waiting work");
});

test("large tiers ask for an explicit subset after binary placement", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 201 }, (_, index) => ({
      id: `large-tier-${index}`,
      version: 1,
      title: `Existing ranked work ${String(index + 1).padStart(3, "0")}`,
      disposition: "experienced",
      mediaTypeId: null,
      overallRating: 8,
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
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0,
      entries,
      mediaTypes: [],
      criteria: [],
      tags: [],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const tier = page.locator("#ranking-tier-8");
  await expect(tier.locator(".ranking-placed-list .placed-card")).toHaveCount(201);

  await tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).click();
  const directPicker = page.getByRole("dialog", { name: "Choose works for 8/10 duels" });
  await expect(directPicker).toBeVisible();
  await expect(directPicker.getByRole("group", { name: "Placed works available for duels" }).locator(".ranking-subset-option")).toHaveCount(201);
  await directPicker.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("tab", { name: "Tier list" }).click();
  await addRatedWork(page, "New work for binary placement");
  await tier.locator(".ranking-unplaced-tray").getByRole("button", { name: "Place with duels", exact: true }).click();
  for (let step = 0; step < 12; step += 1) {
    if (await page.getByRole("heading", { name: "Does this spot look right?" }).count()) break;
    await page.getByRole("button", { name: "Choose New work for binary placement" }).click();
  }
  await expect(page.getByRole("heading", { name: "Does this spot look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Place it here", exact: true }).click();

  await expect(page.getByRole("heading", { name: "This duel session has ended" })).toBeVisible();
  await page.getByRole("tab", { name: "Tier list" }).click();
  await tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).click();
  const transitionPicker = page.getByRole("dialog", { name: "Choose works for 8/10 duels" });
  await expect(transitionPicker).toBeVisible();
  await expect(transitionPicker.getByText("0 of 200 selected")).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-subset-picker-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await page.screenshot({ path: "test-results/ranking-subset-picker-mobile.png", animations: "disabled" });
  await transitionPicker.getByRole("button", { name: "Select matching works (up to 200)" }).click();
  await expect(transitionPicker.getByText("200 of 200 selected")).toBeVisible();
  await transitionPicker.getByRole("button", { name: "Start duels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Which work do you prefer in this score tier?" })).toBeVisible();
});

test("filters keep visible rows scoped and binary pivots use the full tier order", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const make = (id: string, title: string, mediaTypeId: string, tagIds: string[], placed: boolean) => ({
      id, version: 1, title, disposition: "experienced", mediaTypeId, overallRating: 8,
      coverAssetId: null, releaseDate: null, reviewText: "", shortLabel: null,
      criterionRatings: {}, tagIds, createdAt: now, updatedAt: now,
    });
    const entries = [
      make("film-pivot", "Film pivot", "film", ["other"], true),
      make("book-candidate", "Favorite book candidate", "book", ["favorite"], false),
      make("hidden-candidate", "Hidden book candidate", "book", ["other"], false),
    ];
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0, entries,
      mediaTypes: [
        { id: "book", name: "Books", sortOrder: 0, iconKey: "book-open", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
        { id: "film", name: "Films", sortOrder: 1, iconKey: "film", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
      ], criteria: [],
      tags: [
        { id: "favorite", name: "Favorites", createdAt: now, updatedAt: now, version: 1 },
        { id: "other", name: "Other", createdAt: now, updatedAt: now, version: 1 },
      ],
    }));
    sessionStorage.setItem("tastellar.preview.ranking.v1", JSON.stringify({
      initialized: true,
      placements: [
        ["film-pivot", { score: 8, placed: true }],
        ["book-candidate", { score: 8, placed: false }],
        ["hidden-candidate", { score: 8, placed: false }],
      ],
      tierOrders: [[8, { placed: ["film-pivot"], unplaced: ["book-candidate", "hidden-candidate"] }]],
      sequences: [], boundaries: [], recentNormalPairs: [], skippedSeedPairsByScore: [], session: null, judgments: [],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const tier = page.locator("#ranking-tier-8");
  const typeFilter = page.getByRole("button", { name: "Media type" });
  const tagFilter = page.getByRole("button", { name: "Tags" });
  await typeFilter.click();
  await expect(typeFilter).toHaveAttribute("aria-expanded", "true");
  await expect(tagFilter).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("group", { name: "Media type" }).getByLabel("Books").check();
  await tagFilter.click();
  await expect(typeFilter).toHaveAttribute("aria-expanded", "false");
  await expect(tagFilter).toHaveAttribute("aria-expanded", "true");
  const typePopover = page.locator(".ranking-filter-popover");
  const popoverStyle = await typePopover.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    box: element.getBoundingClientRect().toJSON(),
    zIndex: Number(getComputedStyle(element).zIndex),
    viewportWidth: document.documentElement.clientWidth,
    page: document.querySelector(".ranking-page")!.getBoundingClientRect().toJSON(),
    heading: document.querySelector(".ranking-header h1")!.getBoundingClientRect().toJSON(),
  }));
  expect(popoverStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(popoverStyle.zIndex).toBeGreaterThan(1);
  expect(popoverStyle.box.left).toBeGreaterThanOrEqual(0);
  expect(popoverStyle.box.right).toBeLessThanOrEqual(popoverStyle.viewportWidth);
  expect(popoverStyle.box.left).toBeGreaterThanOrEqual(popoverStyle.page.left);
  expect(popoverStyle.box.right).toBeLessThanOrEqual(popoverStyle.page.right);
  expect(popoverStyle.box.top).toBeGreaterThan(popoverStyle.heading.bottom);
  await page.screenshot({ path: "test-results/ranking-filter-menu-desktop.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: "test-results/ranking-filter-menu-light-desktop.png", animations: "disabled" });
  const lightMenuBg = await typePopover.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(lightMenuBg).not.toBe("rgba(0, 0, 0, 0)");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.getByRole("group", { name: "Tags" }).getByLabel("Favorites").check();
  await expect(tier.locator(".placed-card")).toHaveCount(0);
  await expect(tier.locator(".unplaced-card")).toHaveCount(1);
  await expect(tier.locator(".unplaced-card")).toContainText("Favorite book candidate");
  await tier.locator(".unplaced-card").getByRole("button", { name: "Place with duels" }).click();
  await expect(page.locator(".ranking-duel-card-title")).toHaveText(["Favorite book candidate", "Film pivot"]);
  await page.getByRole("button", { name: "Choose Favorite book candidate" }).click();
  await expect(page.getByRole("heading", { name: "Does this spot look right?" })).toBeVisible();
  await page.getByRole("button", { name: "Place it here" }).click();
  await expect(page.getByText("That placement is saved")).toBeVisible();
  await expect(page.getByText("Unplaced works are hidden by these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page.getByRole("button", { name: /Place a random unplaced work/ })).toBeVisible();
  await page.getByRole("button", { name: /Place a random unplaced work/ }).click();
  await expect(page.locator(".ranking-duel-card-title")).toHaveText(["Hidden book candidate", "Film pivot"]);
});

test("duel filters limit regular participants and side navigation remains reachable", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const make = (id: string, title: string, mediaTypeId: string, tagIds: string[], rating: number | null) => ({
      id, version: 1, title, disposition: "experienced", mediaTypeId, overallRating: rating,
      coverAssetId: null, releaseDate: null, reviewText: "", shortLabel: null,
      criterionRatings: {}, tagIds, createdAt: now, updatedAt: now,
    });
    const entries = [
      make("book-one", "Book one", "book", ["favorite"], 8),
      make("film-one", "Film one", "film", ["other"], 8),
      make("book-two", "Book two", "book", ["favorite"], 8),
      make("unrated-one", "Unrated one", "book", ["favorite"], null),
    ];
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify({
      revision: 0, entries,
      mediaTypes: [
        { id: "book", name: "Books", sortOrder: 0, iconKey: "book-open", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
        { id: "film", name: "Films", sortOrder: 1, iconKey: "film", criterionIds: [], archivedAt: null, version: 1, createdAt: now, updatedAt: now },
      ], criteria: [],
      tags: [
        { id: "favorite", name: "Favorites", createdAt: now, updatedAt: now, version: 1 },
        { id: "other", name: "Other", createdAt: now, updatedAt: now, version: 1 },
      ],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await page.getByRole("tab", { name: "Duels" }).click();
  await page.getByRole("button", { name: "Media type" }).click();
  await page.getByRole("group", { name: "Media type" }).getByLabel("Books").check();
  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByRole("group", { name: "Tags" }).getByLabel("Favorites").check();
  await page.getByLabel("Choose a score tier").selectOption("8");
  await page.getByRole("button", { name: "Start duels", exact: true }).click();
  const cards = page.locator(".ranking-duel-card");
  const cardTitles = page.locator(".ranking-duel-card-title");
  await expect(cards).toHaveCount(2);
  await expect(cardTitles).toHaveText(["Book one", "Book two"]);

  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Choose another tier", exact: true }).click();
  await expect(page.getByLabel("Choose a score tier")).toBeVisible();
  await page.getByRole("tab", { name: "Tier list" }).click();
  await page.locator("#ranking-tier-8 .placed-card").filter({ hasText: "Book one" }).locator(".ranking-card-title-button").click();
  await expect(page.locator(".ranking-context-panel")).toContainText("Book one");
  await expect(page.locator(".ranking-context-panel").getByRole("button", { name: "Edit work", exact: true })).toBeVisible();
  await expect(page.locator(".ranking-context-panel").getByRole("button", { name: "Move to Trash", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/ranking-library-sidebars-desktop.png", animations: "disabled" });
  await page.getByRole("button", { name: "Hide work details" }).click();
  await expect(page.locator(".ranking-context-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Show work details" }).click();
  await expect(page.locator(".ranking-context-panel")).toContainText("Book one");
  const sidebar = page.locator(".ranking-library-sidebar");
  await expect(sidebar.locator(".groups-caption")).toContainText("Media");
  await expect(sidebar.getByRole("button", { name: "Media", exact: true })).toHaveCount(0);
  await sidebar.locator('[data-ranking-drop-score="8"]').click();
  await expect(page.locator("#ranking-tier-8")).toBeInViewport();
  await sidebar.getByRole("button", { name: "Plan to Watch" }).click();
  await expect(page.locator("#ranking-planned-title")).toBeInViewport();
  await sidebar.getByRole("button", { name: "Dropped" }).click();
  await expect(page.locator("#ranking-dropped-title")).toBeInViewport();
  await page.getByRole("button", { name: "Hide left sidebar" }).click();
  await expect(page.locator(".folder-shell")).toBeHidden();
  await page.getByRole("button", { name: "Show left sidebar" }).click();
  await expect(page.locator(".folder-shell")).toBeVisible();
  await page.locator(".ranking-sidebar-tier.unrated").click();
  await expect(page.getByRole("tab", { name: "Tier list" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#ranking-unscored-title")).toBeInViewport();
  await page.getByRole("button", { name: "Hide work details" }).click();
  await expect(page.locator(".ranking-context-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide left sidebar" }).click();
  await expect(page.locator(".folder-shell")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Media type" }).click();
  await page.getByRole("button", { name: "Tags" }).click();
  await expect(page.getByRole("button", { name: "Media type" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Tags" })).toHaveAttribute("aria-expanded", "true");
  const mobilePopover = page.locator(".ranking-filter-popover");
  const mobilePopoverBounds = await mobilePopover.boundingBox();
  if (!mobilePopoverBounds) throw new Error("The mobile filter popover did not open");
  expect(mobilePopoverBounds.x).toBeGreaterThanOrEqual(0);
  expect(mobilePopoverBounds.x + mobilePopoverBounds.width).toBeLessThanOrEqual(390);
  const mobilePageBounds = await page.locator(".ranking-page").boundingBox();
  const mobileHeadingBounds = await page.locator(".ranking-header h1").boundingBox();
  if (!mobilePageBounds || !mobileHeadingBounds) throw new Error("Ranking mobile bounds are missing");
  expect(mobilePopoverBounds.x).toBeGreaterThanOrEqual(mobilePageBounds.x);
  expect(mobilePopoverBounds.x + mobilePopoverBounds.width).toBeLessThanOrEqual(mobilePageBounds.x + mobilePageBounds.width);
  expect(mobilePopoverBounds.y).toBeGreaterThan(mobileHeadingBounds.y + mobileHeadingBounds.height);
  await page.screenshot({ path: "test-results/ranking-filter-menu-mobile.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: "test-results/ranking-filter-menu-light-mobile.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.getByRole("button", { name: "Tags" }).click();
  for (let index = 0; index < 6; index += 1) {
    await page.getByRole("button", { name: "New tab" }).click();
    await page.locator(".tab-chooser").getByRole("button", { name: "Ranking" }).click();
  }
  const tabStrip = page.locator(".tab-strip");
  expect(await tabStrip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await tabStrip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.screenshot({ path: "test-results/ranking-mobile-tabs-sidebar.png", animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("Ranking uses the full Library work editor and shared details actions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await page.locator(".ranking-library-sidebar").getByRole("button", { name: "Add work", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("Shared editor story");
  await chooseCustomOption(page, editor, "Disposition", "Already experienced");
  await chooseCustomOption(page, editor, "Overall rating", "8 / 10");
  await editor.getByLabel("Release year").fill("2024");
  await editor.getByLabel("Short label").fill("Shared label");
  await editor.getByLabel("New tag name").fill("ranking-editor-tag");
  await editor.getByRole("button", { name: "Add tag", exact: true }).click();
  await editor.getByLabel("Your thoughts").fill("A note kept by the shared editor.");
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(editor).toHaveCount(0);

  const tier = page.locator("#ranking-tier-8");
  const added = tier.locator('.ranking-unplaced-tray [data-ranking-entry]').filter({ hasText: "Shared label" });
  await expect(added).toBeVisible();
  await added.getByRole("button", { name: "Shared label" }).click();
  const details = page.locator(".ranking-context-panel");
  await expect(details).toContainText("Shared editor story");
  await expect(details).toContainText("ranking-editor-tag");
  await expect(details).toContainText("A note kept by the shared editor.");
  await expect(details.locator(".detail-rank-grid")).toHaveCount(0);

  await details.getByRole("button", { name: "Edit work", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit work" });
  await edit.getByPlaceholder("Media title").fill("Updated shared editor story");
  await edit.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(details).toContainText("Updated shared editor story");

  page.once("dialog", (dialog) => void dialog.accept());
  await details.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(tier.locator(".ranking-unplaced-tray")).not.toContainText("Updated shared editor story");
});

test("a whole tier row can be pointer dragged to reorder without a handle", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  await addRatedWork(page, "Pointer drag one");
  await addRatedWork(page, "Pointer drag two");
  const tier = page.locator("#ranking-tier-8");
  await tier.getByRole("button", { name: "Start duels in the 8 out of 10 tier" }).click();
  await page.getByRole("button", { name: "Choose Pointer drag one" }).click();
  await page.getByRole("tab", { name: "Tier list" }).click();
  const cards = tier.locator(".ranking-placed-list .placed-card");
  await expect(cards).toHaveCount(2);
  await expect(tier.locator(".ranking-drag-handle")).toHaveCount(0);
  const before = await cards.nth(0).locator(".ranking-card-title-button").innerText();
  const after = await cards.nth(1).locator(".ranking-card-title-button").innerText();
  const source = await cards.nth(0).boundingBox();
  const target = await cards.nth(1).boundingBox();
  if (!source || !target) throw new Error("The tier rows are not visible for pointer dragging");
  await page.mouse.move(source.x + source.width * 0.65, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 3, target.y + target.height / 2, { steps: 14 });
  await page.mouse.up();
  await expect(cards.nth(0).locator(".ranking-card-title-button")).toHaveText(after);
  await expect(cards.nth(1).locator(".ranking-card-title-button")).toHaveText(before);
  await page.screenshot({ path: "test-results/ranking-row-reordered.png", animations: "disabled" });
});
