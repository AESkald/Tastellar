import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type RankingArchive = {
  library: {
    revision: number;
    entries: Array<{
      id: string;
      disposition: string;
      overallRating: number | null;
      shortLabel?: string | null;
      mediaTypeId?: string | null;
    }>;
  };
  history: {
    ranking: {
      entries: Array<{ entryId: string; score: number; placed: boolean }>;
      tiers: Array<{ score: number; inputSequence: number }>;
    };
  };
};

test("Ranking keeps tier rows readable and dense with both sidebars open", async ({
  page,
}) => {
  const archivePath = process.env.TASTELLAR_RANKING_SAMPLE;
  test.skip(
    !archivePath || !existsSync(archivePath),
    "Set TASTELLAR_RANKING_SAMPLE to the supplied archive path.",
  );
  const archive = JSON.parse(
    readFileSync(archivePath!, "utf8"),
  ) as RankingArchive;
  const rankedEntries = archive.history.ranking.entries;
  const placedIds = new Set<string>();
  for (const entry of rankedEntries) {
    const count =
      entry.score === 10
        ? Number.MAX_SAFE_INTEGER
        : entry.score === 9
          ? 7
          : entry.score === 8
            ? 10
            : 0;
    const sameScore = rankedEntries.filter(
      (candidate) => candidate.score === entry.score,
    );
    if (
      sameScore
        .slice(0, count)
        .some((candidate) => candidate.entryId === entry.entryId)
    ) {
      placedIds.add(entry.entryId);
    }
  }
  const tierOrders = Array.from({ length: 10 }, (_, index) => {
    const score = 10 - index;
    const sameScore = rankedEntries.filter((entry) => entry.score === score);
    return [
      score,
      {
        placed: sameScore
          .filter((entry) => placedIds.has(entry.entryId))
          .map((entry) => entry.entryId),
        unplaced: sameScore
          .filter((entry) => !placedIds.has(entry.entryId))
          .map((entry) => entry.entryId),
      },
    ];
  });
  const placedScoreNine = rankedEntries
    .filter((entry) => entry.score === 9 && placedIds.has(entry.entryId))
  const unplacedScoreNine = rankedEntries
    .filter((entry) => entry.score === 9 && !placedIds.has(entry.entryId));
  const pairedTitles = [
    "A Journey Through the History of Modern Animation",
    "The Remarkable Expedition Across the Northern Mountains and Into the Valley",
  ];
  const libraryEntryById = new Map(archive.library.entries.map((entry) => [entry.id, entry]));
  const pairedEntries: Array<{ placedId: string; unplacedId: string; title: string }> = [];
  const usedUnplacedIds = new Set<string>();
  for (const placed of placedScoreNine) {
    const placedMedia = libraryEntryById.get(placed.entryId);
    const unplaced = unplacedScoreNine.find((candidate) => {
      const candidateMedia = libraryEntryById.get(candidate.entryId);
      return Boolean(candidateMedia?.mediaTypeId) === Boolean(placedMedia?.mediaTypeId)
        && !usedUnplacedIds.has(candidate.entryId);
    });
    if (!placedMedia || !unplaced) continue;
    usedUnplacedIds.add(unplaced.entryId);
    pairedEntries.push({
      placedId: placed.entryId,
      unplacedId: unplaced.entryId,
      title: pairedTitles[pairedEntries.length],
    });
    if (pairedEntries.length === pairedTitles.length) break;
  }
  if (pairedEntries.length !== pairedTitles.length)
    throw new Error("Ranking density fixture lacks placed/unplaced media pairs with matching type icon slots");

  await page.addInitScript(
    ({ library, ranked, orders, tiers, placedEntryIds }) => {
      const placed = new Set(placedEntryIds);
      sessionStorage.setItem(
        "tastellar.preview.revision.v1",
        String(library.revision),
      );
      sessionStorage.setItem(
        "tastellar.preview.library.v1",
        JSON.stringify(library),
      );
      sessionStorage.setItem(
        "tastellar.preview.ranking.v1",
        JSON.stringify({
          placements: ranked.map((entry) => [
            entry.entryId,
            { score: entry.score, placed: placed.has(entry.entryId) },
          ]),
          tierOrders: orders,
          sequences: tiers.map((tier) => [tier.score, tier.inputSequence]),
          initialized: true,
          session: null,
          judgments: [],
          latestMove: null,
        }),
      );
    },
    {
      library: archive.library,
      ranked: rankedEntries.map((entry) => ({
        ...entry,
        placed: placedIds.has(entry.entryId),
      })),
      orders: tierOrders,
      tiers: archive.history.ranking.tiers,
      placedEntryIds: [...placedIds],
    },
  );

  await page.setViewportSize({ width: 1320, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "Ranking", exact: true }).click();
  const toggles = page.locator(".titlebar .panel-toggle");
  await expect(toggles).toHaveCount(2);
  for (const toggle of [toggles.nth(0), toggles.nth(1)]) {
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  }
  await page
    .locator("#ranking-tier-10 .ranking-placed-list .ranking-card-title-button")
    .first()
    .click();
  await expect(page.locator(".ranking-context-panel")).toBeVisible();
  await expect(page.locator("#ranking-tier-10 .placed-card")).toHaveCount(4);
  await expect(page.locator("#ranking-tier-9 .placed-card")).toHaveCount(7);
  await expect(page.locator("#ranking-tier-9 .unplaced-card")).toHaveCount(11);
  await expect(page.locator("#ranking-tier-8 .placed-card")).toHaveCount(10);
  await expect(page.locator("#ranking-tier-8 .unplaced-card")).toHaveCount(61);

  const editor = page.getByRole("dialog", { name: "Edit work" });
  for (const pair of pairedEntries) {
    const placedTitle = page.locator(`#ranking-tier-9 .placed-card[data-ranking-entry="${pair.placedId}"] .ranking-card-title-button`);
    await placedTitle.click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".ranking-context-panel")).toBeVisible();
    await placedTitle.dblclick({ delay: 90 });
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);

    const unplacedTitle = page.locator(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${pair.unplacedId}"] .ranking-card-title-button`);
    await unplacedTitle.click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".ranking-context-panel")).toBeVisible();
    await unplacedTitle.dblclick({ delay: 90 });
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
  }

  const metrics = await page.locator(".content-scroll").evaluate((scroller) => {
    const bounds = scroller.getBoundingClientRect();
    const visible = Array.from(
      scroller.querySelectorAll<HTMLElement>(
        ".ranking-work-card[data-ranking-entry]",
      ),
    );
    const intersecting = visible.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
    });
    const fullyVisible = visible.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.right <= bounds.right && rect.left >= bounds.left;
    });
    const fontSizes = intersecting
      .map((card) => {
        const title = card.querySelector<HTMLElement>(
          ".ranking-card-title-button",
        );
        return title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0;
      })
      .filter((size) => size > 0);
    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      visibleWorks: intersecting.length,
      fullyVisibleWorks: fullyVisible.length,
      smallestTitlePx: Math.min(...fontSizes),
      placedTitlePx: visible
        .filter((card) => card.classList.contains("placed-card"))
        .map((card) => card.querySelector<HTMLElement>(".ranking-card-title-button"))
        .filter((title): title is HTMLElement => Boolean(title))
        .map((title) => Number.parseFloat(getComputedStyle(title).fontSize)),
      unplacedTitlePx: visible
        .filter((card) => card.classList.contains("unplaced-card"))
        .map((card) => card.querySelector<HTMLElement>(".ranking-card-title-button"))
        .filter((title): title is HTMLElement => Boolean(title))
        .map((title) => Number.parseFloat(getComputedStyle(title).fontSize)),
      smallTitleExamples: visible
        .map((card) => ({
          className: card.className,
          title: card.querySelector<HTMLElement>(".ranking-card-title-button"),
        }))
        .filter((item) => item.title && Number.parseFloat(getComputedStyle(item.title).fontSize) < 11)
        .map((item) => ({
          className: item.className,
          title: item.title?.textContent?.trim(),
          fontPx: item.title ? Number.parseFloat(getComputedStyle(item.title).fontSize) : 0,
        }))
        .slice(0, 8),
      rootFontPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      scrollerWidth: Math.round(bounds.width),
      scrollerHeight: Math.round(bounds.height),
      maxPlacedCardPx: Math.max(0, ...visible.filter((card) => card.classList.contains("placed-card")).map((card) => card.getBoundingClientRect().width)),
      maxUnplacedCardPx: Math.max(0, ...visible.filter((card) => card.classList.contains("unplaced-card")).map((card) => card.getBoundingClientRect().width)),
      visibleTierCards: Array.from({ length: 3 }, (_, index) => {
        const score = 10 - index;
        return { score, count: scroller.querySelectorAll<HTMLElement>(`#ranking-tier-${score} .ranking-work-card[data-ranking-entry]`).length };
      }),
    };
  });
  console.info("Ranking density after redesign", JSON.stringify(metrics));
  expect(metrics.visibleWorks).toBeGreaterThan(0);
  expect(metrics.maxPlacedCardPx).toBeLessThanOrEqual(300);
  expect(metrics.maxUnplacedCardPx).toBeLessThanOrEqual(300);
  await page.screenshot({
    path: "test-results/ranking-density-after-desktop.png",
    animations: "disabled",
  });
  await page.evaluate((pairs) => {
    for (const pair of pairs) {
      const placed = document.querySelector<HTMLElement>(`#ranking-tier-9 .placed-card[data-ranking-entry="${CSS.escape(pair.placedId)}"] .ranking-card-title-button`);
      const unplaced = document.querySelector<HTMLElement>(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${CSS.escape(pair.unplacedId)}"] .ranking-card-title-button`);
      if (!placed || !unplaced) throw new Error("Ranking density fixture card is missing");
      placed.textContent = pair.title;
      unplaced.textContent = pair.title;
    }
  }, pairedEntries);
  const desktopChipPairs = await page.evaluate((pairs) => pairs.map((pair) => {
    const placed = document.querySelector<HTMLElement>(`#ranking-tier-9 .placed-card[data-ranking-entry="${CSS.escape(pair.placedId)}"]`);
    const unplaced = document.querySelector<HTMLElement>(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${CSS.escape(pair.unplacedId)}"]`);
    const measure = (card: HTMLElement | null) => {
      const title = card?.querySelector<HTMLElement>(".ranking-card-title-button");
      if (!card || !title) return null;
      const style = getComputedStyle(title);
      const lineHeight = Number.parseFloat(style.lineHeight);
      return {
        width: card.getBoundingClientRect().width,
        titleWidth: title.getBoundingClientRect().width,
        lines: Math.max(1, Math.round(title.getBoundingClientRect().height / lineHeight)),
      };
    };
    return { title: pair.title, placed: measure(placed), unplaced: measure(unplaced) };
  }), pairedEntries);
  for (const pair of desktopChipPairs) {
    expect(pair.placed, pair.title).not.toBeNull();
    expect(pair.unplaced, pair.title).not.toBeNull();
    expect(Math.abs(pair.placed!.titleWidth - pair.unplaced!.titleWidth), pair.title).toBeLessThanOrEqual(1);
    expect(pair.placed!.lines, pair.title).toBe(pair.unplaced!.lines);
    expect(pair.placed!.lines, pair.title).toBeLessThanOrEqual(2);
    expect(pair.unplaced!.lines, pair.title).toBeLessThanOrEqual(2);
    expect(pair.placed!.width, pair.title).toBeLessThanOrEqual(300);
    expect(pair.unplaced!.width, pair.title).toBeLessThanOrEqual(300);
  }
  console.info("Ranking matched desktop chips", JSON.stringify(desktopChipPairs));
  await page.screenshot({ path: "test-results/ranking-chip-pairs-desktop.png", animations: "disabled" });

  const transitionId = unplacedScoreNine.find((entry) => !usedUnplacedIds.has(entry.entryId))?.entryId;
  if (!transitionId) throw new Error("Ranking fixture lacks an extra unplaced work for a state-size transition");
  const transitionSource = page.locator(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${transitionId}"]`);
  await transitionSource.scrollIntoViewIfNeeded();
  const transitionTitle = transitionSource.locator(".ranking-card-title-button");
  const beforeTransition = await transitionSource.evaluate((card) => {
    const title = card.querySelector<HTMLElement>(".ranking-card-title-button")!;
    return {
      text: title.innerText,
      cardWidth: card.getBoundingClientRect().width,
      titleWidth: title.getBoundingClientRect().width,
      lines: Math.max(1, Math.round(title.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(title).lineHeight))),
    };
  });
  const sourceBounds = await transitionTitle.boundingBox();
  const targetBounds = await page.locator("#ranking-tier-9 .ranking-placed-list .placed-card").first().boundingBox();
  if (!sourceBounds || !targetBounds) throw new Error("Ranking transition drag targets are not visible");
  await page.mouse.move(sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBounds.x + sourceBounds.width / 2 + 9, sourceBounds.y + sourceBounds.height / 2 + 4, { steps: 2 });
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2, { steps: 12 });
  await page.mouse.up();
  const transitionedCard = page.locator(`#ranking-tier-9 .placed-card[data-ranking-entry="${transitionId}"]`);
  await expect(transitionedCard).toBeVisible();
  const afterTransition = await transitionedCard.evaluate((card) => {
    const title = card.querySelector<HTMLElement>(".ranking-card-title-button")!;
    return {
      text: title.innerText,
      cardWidth: card.getBoundingClientRect().width,
      titleWidth: title.getBoundingClientRect().width,
      lines: Math.max(1, Math.round(title.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(title).lineHeight))),
    };
  });
  console.info("Ranking same-entry placement dimensions", JSON.stringify({ beforeTransition, afterTransition }));
  expect(afterTransition.text).toBe(beforeTransition.text);
  expect(Math.abs(afterTransition.titleWidth - beforeTransition.titleWidth)).toBeLessThanOrEqual(1);
  expect(beforeTransition.titleWidth).toBeLessThan(220);
  expect(beforeTransition.cardWidth).toBeLessThan(285);
  expect(afterTransition.lines).toBe(beforeTransition.lines);
  expect(Math.abs(afterTransition.cardWidth - beforeTransition.cardWidth)).toBeLessThanOrEqual(30);

  const setPanel = async (index: number, open: boolean) => {
    const toggle = toggles.nth(index);
    const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
    if (pressed !== open) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", String(open));
  };
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [leftOpen, rightOpen] of [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ]) {
      await setPanel(0, leftOpen);
      await setPanel(1, rightOpen);
      await page.screenshot({
        path: `test-results/ranking-${theme}-left-${leftOpen ? "open" : "closed"}-right-${rightOpen ? "open" : "closed"}.png`,
        animations: "disabled",
      });
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((pairs) => {
    for (const pair of pairs) {
      const placed = document.querySelector<HTMLElement>(`#ranking-tier-9 .placed-card[data-ranking-entry="${CSS.escape(pair.placedId)}"] .ranking-card-title-button`);
      const unplaced = document.querySelector<HTMLElement>(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${CSS.escape(pair.unplacedId)}"] .ranking-card-title-button`);
      if (!placed || !unplaced) throw new Error("Ranking mobile density fixture card is missing");
      placed.textContent = pair.title;
      unplaced.textContent = pair.title;
    }
  }, pairedEntries);
  const mobileTitleMetrics = await page.evaluate(() => {
    const placed = document.querySelector<HTMLElement>("#ranking-tier-10 .ranking-placed-list .placed-card .ranking-card-title-button");
    const unplaced = document.querySelector<HTMLElement>("#ranking-tier-9 .ranking-unplaced-tray .unplaced-card .ranking-card-title-button");
    return {
      placedPx: placed ? Number.parseFloat(getComputedStyle(placed).fontSize) : null,
      unplacedPx: unplaced ? Number.parseFloat(getComputedStyle(unplaced).fontSize) : null,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  console.info("Ranking mobile title sizes", JSON.stringify(mobileTitleMetrics));
  expect(mobileTitleMetrics.placedPx).toBeGreaterThanOrEqual(11);
  expect(mobileTitleMetrics.unplacedPx).toBeGreaterThanOrEqual(11);
  expect(mobileTitleMetrics.pageWidth).toBe(390);
  await page.locator("#ranking-tier-9 .ranking-unplaced-tray").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/ranking-chip-pairs-mobile.png", animations: "disabled" });
  const mobileChipPairs = await page.evaluate((pairs) => pairs.map((pair) => {
    const placed = document.querySelector<HTMLElement>(`#ranking-tier-9 .placed-card[data-ranking-entry="${CSS.escape(pair.placedId)}"]`);
    const unplaced = document.querySelector<HTMLElement>(`#ranking-tier-9 .unplaced-card[data-ranking-entry="${CSS.escape(pair.unplacedId)}"]`);
    const measure = (card: HTMLElement | null) => {
      const title = card?.querySelector<HTMLElement>(".ranking-card-title-button");
      if (!card || !title) return null;
      return {
        width: card.getBoundingClientRect().width,
        titleWidth: title.getBoundingClientRect().width,
        lines: Math.max(1, Math.round(title.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(title).lineHeight))),
      };
    };
    return { title: pair.title, placed: measure(placed), unplaced: measure(unplaced) };
  }), pairedEntries);
  console.info("Ranking matched mobile chips", JSON.stringify(mobileChipPairs));
  for (const pair of mobileChipPairs) {
    expect(pair.placed, pair.title).not.toBeNull();
    expect(pair.unplaced, pair.title).not.toBeNull();
    expect(Math.abs(pair.placed!.titleWidth - pair.unplaced!.titleWidth), pair.title).toBeLessThanOrEqual(1);
    expect(pair.placed!.lines, pair.title).toBe(pair.unplaced!.lines);
    expect(pair.placed!.lines, pair.title).toBeLessThanOrEqual(2);
    expect(pair.unplaced!.lines, pair.title).toBeLessThanOrEqual(2);
  }
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [leftOpen, rightOpen] of [
      [false, false],
      [true, true],
    ]) {
      await setPanel(0, leftOpen);
      await setPanel(1, rightOpen);
      await page.screenshot({
        path: `test-results/ranking-mobile-${theme}-left-${leftOpen ? "open" : "closed"}-right-${rightOpen ? "open" : "closed"}.png`,
        animations: "disabled",
      });
    }
  }
});
