import { expect, test, type Page } from "@playwright/test";

const normalTitles = [
  "Outer Wilds",
  "Mushoku Tensei",
  "Mother of Learning",
  "Attack on Titan",
];
const longTitle = "1000 Players Simulate Civilization – Rich & Poor";

async function seedRankingCardFixture(page: Page) {
  await page.addInitScript(({ titles, oversizedTitle }) => {
    const now = new Date().toISOString();
    const typeForTitle = ["games", "literature", "literature", "anime"];
    const mediaTypes = [
      ["literature", "Literature", "book-open"],
      ["anime", "Animation", "clapperboard"],
      ["games", "Games", "gamepad-2"],
    ].map(([id, name, iconKey], sortOrder) => ({
      id,
      name,
      sortOrder,
      iconKey,
      criterionIds: [],
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const entries = [
      ...titles.map((title, index) => ({
        id: `placed-${index}`,
        version: 1,
        title,
        disposition: "experienced",
        mediaTypeId: typeForTitle[index],
        overallRating: 10,
        coverAssetId: null,
        releaseDate: null,
        reviewText: "",
        shortLabel: null,
        criterionRatings: {},
        tagIds: [],
        createdAt: now,
        updatedAt: now,
        importOrder: index,
      })),
      ...titles.map((title, index) => ({
        id: `unplaced-${index}`,
        version: 1,
        title,
        disposition: "experienced",
        mediaTypeId: typeForTitle[index],
        overallRating: 9,
        coverAssetId: null,
        releaseDate: null,
        reviewText: "",
        shortLabel: null,
        criterionRatings: {},
        tagIds: [],
        createdAt: now,
        updatedAt: now,
        importOrder: titles.length + index,
      })),
      {
        id: "unplaced-long",
        version: 1,
        title: oversizedTitle,
        disposition: "experienced",
        mediaTypeId: "games",
        overallRating: 9,
        coverAssetId: null,
        releaseDate: null,
        reviewText: "",
        shortLabel: null,
        criterionRatings: {},
        tagIds: [],
        createdAt: now,
        updatedAt: now,
        importOrder: titles.length * 2,
      },
    ];
    const placedIds = titles.map((_, index) => `placed-${index}`);
    const unplacedIds = [
      ...titles.map((_, index) => `unplaced-${index}`),
      "unplaced-long",
    ];
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem(
      "tastellar.preview.library.v1",
      JSON.stringify({ revision: 0, entries, mediaTypes, criteria: [], tags: [] }),
    );
    sessionStorage.setItem(
      "tastellar.preview.ranking.v1",
      JSON.stringify({
        placements: [
          ...placedIds.map((id) => [id, { score: 10, placed: true }]),
          ...unplacedIds.map((id) => [id, { score: 9, placed: false }]),
        ],
        tierOrders: [
          [10, { placed: placedIds, unplaced: [] }],
          [9, { placed: [], unplaced: unplacedIds }],
        ],
        sequences: [[10, placedIds.length], [9, unplacedIds.length]],
        initialized: true,
        session: null,
        judgments: [],
        latestMove: null,
      }),
    );
  }, { titles: normalTitles, oversizedTitle: longTitle });
}

async function openRankingWithBothSidebars(page: Page) {
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const toggles = page.locator(".titlebar .panel-toggle");
  await expect(toggles).toHaveCount(2);
  for (const toggle of [toggles.nth(0), toggles.nth(1)]) {
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  }
}

async function readCardMetrics(page: Page, score: 9 | 10, kind: "placed" | "unplaced") {
  const tier = page.locator(`#ranking-tier-${score}`);
  const container = kind === "placed" ? ".ranking-placed-list" : ".ranking-unplaced-items";
  const cardSelector = kind === "placed" ? ".placed-card" : ".unplaced-card";
  return tier.locator(container).evaluate((list, selector) => {
    const cards = Array.from(list.querySelectorAll<HTMLElement>(selector));
    return cards.map((card) => {
      const title = card.querySelector<HTMLElement>(".ranking-card-title-button");
      if (!title) throw new Error("Card is missing its title button");
      const titleStyle = getComputedStyle(title);
      const titleBox = title.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(title);
      const textBox = textRange.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const lineHeight = parseFloat(titleStyle.lineHeight);
      return {
        id: card.dataset.rankingEntry,
        title: title.title,
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
        titleWidth: titleBox.width,
        textRight: textBox.right,
        titleRight: titleBox.right,
        cardRight: cardBox.right,
        titleScrollWidth: title.scrollWidth,
        titleClientWidth: title.clientWidth,
        titleHeight: titleBox.height,
        lineHeight,
        lines: Math.max(1, Math.round(titleBox.height / lineHeight)),
        fontSize: titleStyle.fontSize,
        lineClamp: titleStyle.webkitLineClamp,
      };
    });
  }, cardSelector);
}

test("Ranking chips preserve normal titles and keep long unplaced titles compact", async ({ page }) => {
  await seedRankingCardFixture(page);
  await page.setViewportSize({ width: 1320, height: 920 });
  await page.goto("/");
  await openRankingWithBothSidebars(page);

  const placedCards = page.locator("#ranking-tier-10 .ranking-placed-list .placed-card");
  const unplacedCards = page.locator("#ranking-tier-9 .ranking-unplaced-items .unplaced-card");
  await expect(placedCards).toHaveCount(4);
  await expect(unplacedCards).toHaveCount(5);

  const expectNormalTitlesSingleLine = async () => {
    for (const kind of ["placed", "unplaced"] as const) {
      const score = kind === "placed" ? 10 : 9;
      const metrics = await readCardMetrics(page, score, kind);
      const byTitle = new Map(metrics.map((card) => [card.title, card]));
      for (const title of normalTitles) {
        const card = byTitle.get(title);
        expect(card, `${kind} card missing: ${title}`).toBeTruthy();
        expect(card!.lines, `${kind} title wrapped: ${title}`).toBe(1);
        expect(parseFloat(card!.fontSize), `${kind} title fell below 12px`).toBeGreaterThanOrEqual(12);
        expect(card!.textRight, `${kind} title text clips at its own edge: ${title}`).toBeLessThanOrEqual(card!.titleRight + 1);
        expect(card!.textRight, `${kind} title text clips at card edge: ${title}`).toBeLessThanOrEqual(card!.cardRight - 5);
        expect(card!.titleScrollWidth, `${kind} title overflows: ${title}`).toBeLessThanOrEqual(card!.titleClientWidth + 1);
      }
    }
  };
  await expectNormalTitlesSingleLine();

  const desktopLong = (await readCardMetrics(page, 9, "unplaced")).find((card) => card.title === longTitle);
  expect(desktopLong).toBeTruthy();
  expect(desktopLong!.lines).toBeLessThanOrEqual(2);
  expect(desktopLong!.height).toBeLessThanOrEqual(54);
  await page.screenshot({ path: "test-results/ranking-astra-1320.png", animations: "disabled" });

  await page.setViewportSize({ width: 1840, height: 1000 });
  await expectNormalTitlesSingleLine();
  const wideLong = (await readCardMetrics(page, 9, "unplaced")).find((card) => card.title === longTitle);
  expect(wideLong?.lines).toBeLessThanOrEqual(2);
  expect(wideLong?.height).toBeLessThanOrEqual(54);
  await page.screenshot({ path: "test-results/ranking-astra-wide.png", animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Hide left sidebar", "Hide work details"]) {
    const toggle = page.getByRole("button", { name, exact: true });
    if (await toggle.count()) await toggle.click();
  }
  const mobileLong = (await readCardMetrics(page, 9, "unplaced")).find((card) => card.title === longTitle);
  expect(mobileLong).toBeTruthy();
  expect(mobileLong!.lines).toBeLessThanOrEqual(2);
  expect(mobileLong!.height).toBeLessThanOrEqual(58);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await page.screenshot({ path: "test-results/ranking-astra-mobile.png", animations: "disabled" });

  await page.setViewportSize({ width: 1320, height: 920 });
  await openRankingWithBothSidebars(page);
  const firstBefore = await placedCards.nth(0).getAttribute("data-ranking-entry");
  const secondBefore = await placedCards.nth(1).getAttribute("data-ranking-entry");
  const source = await placedCards.nth(0).boundingBox();
  const target = await placedCards.nth(1).boundingBox();
  if (!source || !target) throw new Error("Placed chips are missing from the tier");
  await page.mouse.move(source.x + source.width * 0.65, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 3, target.y + target.height / 2, { steps: 14 });
  await page.mouse.up();
  await expect(placedCards.nth(0)).toHaveAttribute("data-ranking-entry", secondBefore!);
  await expect(placedCards.nth(1)).toHaveAttribute("data-ranking-entry", firstBefore!);

  const doubleClickTarget = page.locator('#ranking-tier-10 .placed-card[data-ranking-entry="placed-2"] .ranking-card-title-button');
  await doubleClickTarget.dblclick();
  const editor = page.getByRole("dialog", { name: "Edit work" });
  await expect(editor).toBeVisible();
  await expect(editor.getByPlaceholder("Media title")).toHaveValue("Mother of Learning");
  await expect(editor.getByLabel("Release year")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
});

test("ranking chip drags across tier labels do not select text and still reorder", async ({ page }) => {
  await seedRankingCardFixture(page);
  await page.setViewportSize({ width: 1320, height: 920 });
  await page.goto("/");
  await openRankingWithBothSidebars(page);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const selectionText = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
  const progress9 = page.locator("#ranking-tier-9 .ranking-tier-label p");
  const toPlace9 = page.locator("#ranking-tier-9 .ranking-unplaced-heading > span").first();
  const rankedCards = page.locator("#ranking-tier-10 .ranking-placed-list .placed-card");
  const firstCard = rankedCards.nth(0);
  const secondCard = rankedCards.nth(1);
  const firstId = await firstCard.getAttribute("data-ranking-entry");
  const secondId = await secondCard.getAttribute("data-ranking-entry");
  const rankedSourceBox = await firstCard.locator(".ranking-card-title-button").boundingBox();
  const reorderTargetBox = await secondCard.boundingBox();
  const progress9Box = await progress9.boundingBox();
  const toPlace9Box = await toPlace9.boundingBox();
  if (!rankedSourceBox || !reorderTargetBox || !progress9Box || !toPlace9Box || !firstId || !secondId) {
    throw new Error("The ranked source, reorder target, or tier label targets are missing");
  }

  await page.mouse.move(rankedSourceBox.x + rankedSourceBox.width / 2, rankedSourceBox.y + rankedSourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(progress9Box.x + progress9Box.width / 2, progress9Box.y + progress9Box.height / 2, { steps: 12 });
  await expect(page.locator("#ranking-media-top")).toHaveClass(/is-dragging/);
  await expect.poll(selectionText).toBe("");
  expect(await progress9.evaluate((element) => getComputedStyle(element).userSelect)).toBe("none");

  await page.mouse.move(toPlace9Box.x + toPlace9Box.width / 2, toPlace9Box.y + toPlace9Box.height / 2, { steps: 12 });
  await expect.poll(selectionText).toBe("");
  expect(await toPlace9.evaluate((element) => getComputedStyle(element).userSelect)).toBe("none");
  await page.screenshot({ path: "test-results/ranking-drag-selection-suppressed.png", animations: "disabled" });
  await page.mouse.move(reorderTargetBox.x + reorderTargetBox.width - 3, reorderTargetBox.y + reorderTargetBox.height / 2, { steps: 14 });
  await expect.poll(selectionText).toBe("");
  await page.mouse.up();
  await expect(page.locator("#ranking-media-top")).not.toHaveClass(/is-dragging/);
  await expect(rankedCards.nth(0)).toHaveAttribute("data-ranking-entry", secondId);
  await expect(rankedCards.nth(1)).toHaveAttribute("data-ranking-entry", firstId);

  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const addDialog = page.getByRole("dialog", { name: "Add work" });
  const titleInput = addDialog.getByPlaceholder("Media title");
  await titleInput.fill("Selectable after drag");
  await expect(titleInput).toHaveValue("Selectable after drag");
});
