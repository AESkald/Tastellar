import { expect, test } from "@playwright/test";

test("Home prompt uses the saved tier order after a library edit", async ({ page }) => {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const makeEntry = (
      id: string,
      title: string,
      overallRating: number,
      importOrder: number,
    ) => ({
      id,
      version: 1,
      title,
      disposition: "experienced",
      mediaTypeId: "anime",
      overallRating,
      coverAssetId: null,
      releaseDate: null,
      reviewText: "",
      shortLabel: null,
      criterionRatings: {},
      tagIds: [],
      createdAt: now,
      updatedAt: now,
      importOrder,
    });
    const entries = [
      makeEntry("aot", "Attack on Titan", 10, 0),
      makeEntry("arcane", "Arcane", 9, 1),
      makeEntry("meters", "100 Meters", 7, 2),
      makeEntry("left", "The Left Hand of Darkness", 10, 3),
      makeEntry("players", "1000 Players", 8, 4),
      makeEntry("outer", "Outer Wilds", 10, 5),
      makeEntry("witch", "Witch Hat Atelier", 10, 6),
    ];
    const library = {
      revision: 0,
      entries,
      mediaTypes: [
        {
          id: "anime",
          name: "Animation",
          sortOrder: 0,
          iconKey: "clapperboard",
          criterionIds: [],
          archivedAt: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      criteria: [],
      tags: [],
    };
    sessionStorage.setItem("tastellar.preview.revision.v1", "0");
    sessionStorage.setItem("tastellar.preview.library.v1", JSON.stringify(library));
    sessionStorage.setItem(
      "tastellar.preview.ranking.v1",
      JSON.stringify({
        placements: entries.map((entry) => [
          entry.id,
          { score: entry.overallRating, placed: entry.id !== "left" },
        ]),
        tierOrders: [
          [10, { placed: ["witch", "outer", "aot"], unplaced: ["left"] }],
          [9, { placed: ["arcane"], unplaced: [] }],
          [8, { placed: ["players"], unplaced: [] }],
          [7, { placed: ["meters"], unplaced: [] }],
        ],
        sequences: [[10, 3], [9, 1], [8, 1], [7, 1]],
        initialized: true,
        session: null,
        judgments: [],
        latestMove: null,
      }),
    );
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "All your favourite media in one place." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add work", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("New 10");
  await editor.getByRole("combobox", { name: "Media type", exact: true }).click();
  await page.getByRole("option", { name: "Animation", exact: true }).click();
  await editor.getByRole("combobox", { name: "Disposition", exact: true }).click();
  await page.getByRole("option", { name: "Already experienced", exact: true }).click();
  await editor.getByRole("combobox", { name: "Overall rating", exact: true }).click();
  await page.getByRole("option", { name: "10 / 10", exact: true }).click();
  await editor.getByRole("button", { name: "Save work", exact: true }).click();

  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  const createPrompt = page.getByRole("button", {
    name: "Create a recommendation prompt",
    exact: true,
  });
  await expect(createPrompt).toBeEnabled();
  await createPrompt.click();

  const prompt = await page
    .getByRole("textbox", { name: "Recommendation prompt" })
    .inputValue();
  const evidence = prompt
    .split("Ranked library evidence")[1]
    .split("Known, planned, or dropped titles")[0];
  const titles = evidence
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(" – ")[0]);
  expect(titles).toEqual([
    "Witch Hat Atelier",
    "Outer Wilds",
    "Attack on Titan",
    "The Left Hand of Darkness",
    "New 10",
    "Arcane",
    "1000 Players",
    "100 Meters",
  ]);
});
