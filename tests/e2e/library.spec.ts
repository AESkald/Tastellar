import { expect, test, type Locator, type Page } from "@playwright/test";

type WorkOptions = {
  title: string;
  type: string;
  disposition: "planned" | "experienced" | "dropped";
  score?: string;
  year?: string;
  shortLabel?: string;
  criterion?: { name: string; score: string };
  review?: string;
  newTag?: string;
  existingTag?: string;
};

async function chooseCustomOption(page: Page, within: Locator, label: string, optionName: string) {
  await within.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

const dispositionLabel = {
  planned: "Plan to Watch",
  experienced: "Already experienced",
  dropped: "Dropped",
} as const;

async function addWork(page: Page, work: WorkOptions) {
  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill(work.title);
  await chooseCustomOption(page, editor, "Media type", work.type);
  await chooseCustomOption(page, editor, "Disposition", dispositionLabel[work.disposition]);
  if (work.score)
    await chooseCustomOption(page, editor, "Overall rating", `${work.score} / 10`);
  if (work.year) await editor.getByLabel("Release year").fill(work.year);
  if (work.shortLabel)
    await editor.getByLabel("Short label").fill(work.shortLabel);
  if (work.criterion)
    await chooseCustomOption(page, editor, work.criterion.name, work.criterion.score);
  if (work.newTag) {
    await editor.getByLabel("New tag name").fill(work.newTag);
    await editor.getByRole("button", { name: "Add tag", exact: true }).click();
  }
  if (work.existingTag)
    await editor
      .locator(".tag-picker label")
      .filter({ hasText: work.existingTag })
      .click();
  if (work.review) await editor.getByLabel("Your thoughts").fill(work.review);
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

test("saving a work and opening its details keeps the shared revision current", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, {
    title: "Revision Garden",
    type: "Animation",
    disposition: "experienced",
  });

  // The Library save and its follow-up workspace update both write the same
  // native metadata version. The browser preview adapter mirrors that contract.
  await page.waitForTimeout(150);
  await expect(
    page.getByRole("alert").filter({
      hasText: "Saved data changed in another tab. Reload and retry.",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Revision Garden", exact: true }),
  ).toBeVisible();
});

test("switching sections after choosing rank sort does not show a save error", async ({
  page,
}) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, {
    title: "Rank sort tab snapshot",
    type: "Animation",
    disposition: "planned",
  });
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Sort works", exact: true }),
  ).toContainText("Rank");

  const saveError = page
    .getByRole("alert")
    .filter({ hasText: "Some information could not be saved." });
  for (const section of ["Home", "Ranking", "Recap", "Analytics", "Library", "Home"]) {
    await navigation.getByRole("button", { name: section, exact: true }).click();
    await page.waitForTimeout(150);
    await expect(saveError).toHaveCount(0);
  }
});

test("card and table views omit edit buttons while details and double-click retain Edit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Midnight/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, {
    title: "Card menu check",
    type: "Animation",
    disposition: "experienced",
    score: "8",
  });

  const card = page.locator(".library-work-card").filter({
    hasText: "Card menu check",
  });
  await expect(card).toHaveCount(1);
  await card.hover();
  await expect(card.locator(".work-card-edit")).toHaveCount(0);
  await page.screenshot({ path: "test-results/library-card-no-hover-edit.png" });

  await card.locator(".work-card-select").click();
  await expect(
    page.getByRole("button", { name: "Edit work", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Compact grid" }).click();
  await card.hover();
  await expect(card.locator(".work-card-edit")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit work", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit work", exact: true }),
  ).toBeVisible();
  const tableRow = page
    .locator(".library-table tbody tr")
    .filter({ hasText: "Card menu check" });
  await expect(tableRow).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Edit Card menu check", exact: true }),
  ).toHaveCount(0);
  await tableRow.dblclick();
  const editor = page.getByRole("dialog", { name: "Edit work" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.screenshot({
    path: "test-results/library-after-closing-edit-dark.png",
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Reading/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "reading");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Table" }).click();
  const readingRow = page.locator(".library-table tbody tr").filter({
    hasText: "Card menu check",
  });
  await readingRow.click();
  await page.getByRole("button", { name: "Edit work", exact: true }).click();
  const readingEditor = page.getByRole("dialog", { name: "Edit work" });
  await expect(readingEditor).toBeVisible();
  await readingEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(readingEditor).toHaveCount(0);
  await page.screenshot({
    path: "test-results/library-after-closing-edit-reading.png",
    animations: "disabled",
  });
});

test("Library adds, searches, filters, and inspects a work", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Plan to Watch", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("The Glass Garden");
  await chooseCustomOption(page, editor, "Media type", "Animation");
  await chooseCustomOption(page, editor, "Disposition", "Already experienced");
  await chooseCustomOption(page, editor, "Overall rating", "8 / 10");
  await editor.getByLabel("Release year").fill("2024");
  await chooseCustomOption(page, editor, "Plot", "9");
  await editor.getByLabel("New tag name").fill("favorites");
  await editor.getByRole("button", { name: "Add tag", exact: true }).click();
  await editor
    .getByLabel("Your thoughts")
    .fill("A thoughtful story with a vivid world.");
  await editor.getByRole("button", { name: "Save work", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "8", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The Glass Garden" }),
  ).toBeVisible();
  // A rating alone does not assign a ranked position. Unplaced works must
  // not display rank or percentile claims until the user places them.
  await expect(page.locator(".detail-rank-grid")).toHaveCount(0);
  await expect(
    page.getByText("A thoughtful story with a vivid world."),
  ).toBeVisible();

  const search = page.getByRole("textbox", {
    name: "Search works by title or short label",
  });
  await search.fill("favorites");
  await page.getByLabel("Search tags").check();
  await expect(
    page.getByRole("option", { name: /The Glass Garden/ }),
  ).toBeVisible();
  await page.getByRole("option", { name: /The Glass Garden/ }).click();
  await expect(
    page.getByText(
      "Showing the selected search result outside the current filters.",
    ),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Open filters" }).click();
  await expect(page.getByText("Refine your library")).toBeVisible();
  await page.getByLabel("Animation", { exact: true }).check();
  await expect(page.getByText("1 matching works")).toBeVisible();

  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page
    .getByRole("button", { name: /Import \/ export/ })
    .first()
    .click();
  await expect(
    page.getByRole("complementary", { name: "Import and export" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export library archive", exact: true }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Manage types & tags" }).click();
  await expect(
    page.getByRole("dialog", { name: "Manage library vocabulary" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
});

test("Library search can include reviews and tags, and respect active filters", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();

  await addWork(page, {
    title: "Northbound",
    type: "Animation",
    disposition: "experienced",
    score: "9",
    year: "2024",
    shortLabel: "Quiet road",
    review: "A candlelit mystery with a gentle ending.",
    newTag: "favorites",
  });
  await addWork(page, {
    title: "Southern Light",
    type: "Literature",
    disposition: "planned",
    year: "2018",
    review: "Another candlelit mystery.",
    existingTag: "favorites",
  });

  const search = page.getByRole("textbox", {
    name: "Search works by title or short label",
  });
  await search.fill("candlelit");
  const results = page.locator(
    ".library-search-results .library-pane-caption span",
  );
  await expect(results).toHaveText("0");
  await page.getByLabel("Search reviews").check();
  await expect(results).toHaveText("2");

  await page.getByRole("button", { name: "Open filters" }).click();
  await page.getByLabel("Animation", { exact: true }).check();
  await expect(page.getByText("1 matching works")).toBeVisible();
  await page.getByLabel("Within current filters").check();
  await expect(results).toHaveText("1");

  await search.fill("favorites");
  await page.getByLabel("Search tags").check();
  await expect(results).toHaveText("1");
  await expect(page.getByRole("option", { name: /Northbound/ })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Southern Light/ }),
  ).toHaveCount(0);
});

test("Library groups, table sorting, and list modes follow the selected collection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, {
    title: "Willow",
    type: "Literature",
    disposition: "experienced",
    score: "8",
    year: "2020",
  });
  await addWork(page, {
    title: "Amber",
    type: "Literature",
    disposition: "experienced",
    score: "8",
    year: "2022",
  });
  await addWork(page, {
    title: "Pine",
    type: "Films",
    disposition: "experienced",
    score: "9",
    year: "2024",
  });

  const groups = page.getByRole("navigation", { name: "Work groups" });
  await expect(
    page.getByRole("heading", { name: "9", exact: true }),
  ).toBeVisible();
  await groups.getByRole("button", { name: /^8\s+2$/ }).click();
  await expect(
    page.getByRole("heading", { name: "8", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Table", exact: true }).click();
  await chooseCustomOption(page, page, "Sort works", "Title");
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Amber");
  await expect(rows.nth(1)).toContainText("Willow");

  await page.getByRole("button", { name: "Compact grid" }).click();
  await expect(page.locator(".library-work-grid.compact")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "8", exact: true }),
  ).toBeVisible();
});

test("Library editor confirms discard and keeps criterion scores when types change", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await addWork(page, {
    title: "Criterion Keeper",
    type: "Animation",
    disposition: "experienced",
    score: "8",
    criterion: { name: "Animation", score: "7" },
  });

  await page.getByRole("button", { name: "Edit work", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit work" });
  await editor.getByPlaceholder("Media title").fill("Unsaved title");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Criterion Keeper" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Unsaved title" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Edit work", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit work" });
  await chooseCustomOption(page, edit, "Media type", "Literature");
  await expect(edit.getByText("Previous criteria (1)")).toBeVisible();
  await edit.getByText("Previous criteria (1)").click();
  await expect(edit.getByText("Animation: 7/10")).toBeVisible();
  await edit.getByRole("button", { name: "Save work", exact: true }).click();

  await page.getByText("Previous criteria", { exact: true }).click();
  await expect(page.locator(".retained-score-details")).toContainText(
    "Animation",
  );
  await expect(page.locator(".retained-score-details")).toContainText("7/10");

  await page.getByRole("button", { name: "Edit work", exact: true }).click();
  const reopenedEditor = page.getByRole("dialog", { name: "Edit work" });
  await chooseCustomOption(page, reopenedEditor, "Media type", "Animation");
  await expect(
    reopenedEditor.getByRole("combobox", { name: "Animation", exact: true }),
  ).toHaveText("7");
  await reopenedEditor
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();

  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page
    .getByRole("textbox", {
      name: "Search works by title or short label",
    })
    .fill("Criterion Keeper");
  await expect(
    page.getByRole("heading", { name: /Results for/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Search works by title or short label" }),
  ).toHaveValue("Criterion Keeper");
  await expect(
    page.getByRole("button", { name: "Table", exact: true }),
  ).toHaveClass(/selected/);
  await expect(
    page.getByRole("heading", { name: /Results for/ }),
  ).toBeVisible();
});
