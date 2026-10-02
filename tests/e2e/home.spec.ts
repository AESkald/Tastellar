import { test, expect, type Locator, type Page } from "@playwright/test";

async function chooseCustomOption(page: Page, within: Locator, label: string, optionName: string) {
  await within.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test("Home editing, explicit radar, guidelines and recommendation prompt", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "All your favourite media in one place.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Give your taste a shape" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .last()
    .click();
  await page.getByLabel("Nickname", { exact: true }).fill("Alex");
  await page
    .getByLabel("What draws you in?")
    .fill(
      "Quiet worlds, memorable characters, and stories with heart. I enjoy stories that take their time to let a place feel lived in, and I return to characters whose choices remain interesting after the ending.\nA second thought that should stay visible on Home.",
    );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Alex", exact: true }),
  ).toBeVisible();
  const profileBio = page.locator(".profile-copy > p");
  const avatar = page.locator(".profile-main .avatar");
  const profileCopy = page.locator(".profile-copy");
  expect(await avatar.evaluate((el) => el.getBoundingClientRect().top)).toBe(
    await profileCopy.evaluate((el) => el.getBoundingClientRect().top),
  );
  await expect(profileBio).toContainText(
    "A second thought that should stay visible on Home.",
  );
  expect(
    await profileBio.evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Choose your qualities", exact: true })
    .click();
  for (const label of ["Plot", "World", "Characters", "Atmosphere"])
    await page.getByLabel(label, { exact: true }).check();
  await page.getByLabel("Characters importance").fill("9");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("svg.radar")).toBeVisible();
  await page
    .getByRole("button", { name: "Define your scale", exact: true })
    .click();
  await page
    .getByLabel("Your definition of 10 out of 10", { exact: true })
    .fill("Something I carry with me long after it ends.");
  await page
    .getByLabel("Your definition of 7 out of 10", { exact: true })
    .fill("A good time with a few imperfections.");
  await page
    .getByLabel("Your definition of 2 out of 10", { exact: true })
    .fill(
      "I struggled to find anything that worked.\nA second line worth keeping.",
    );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("3 scores defined")).toBeVisible();
  const scoreTwo = page.locator(".score-row").filter({ hasText: "2/10" });
  await expect(scoreTwo).toContainText("A second line worth keeping.");
  expect(
    await scoreTwo
      .locator(".score-description")
      .evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  await page
    .getByRole("button", {
      name: "Create a recommendation prompt",
      exact: true,
    })
    .click();
  const prompt = page.getByRole("textbox", { name: "Recommendation prompt" });
  await expect(prompt).toHaveValue(/Quiet worlds/);
  await expect(prompt).toHaveValue(/Something I carry/);
  await expect(page.getByLabel("Private notes", { exact: true })).toHaveCount(
    0,
  );
  await expect(prompt).not.toHaveValue(/Private notes/);
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copied to clipboard", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Quiet worlds",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".content-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: "test-results/home-personalized.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 360, height: 740 });
  expect(
    await profileBio.evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  expect(
    await scoreTwo
      .locator(".score-description")
      .evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  expect(
    await page
      .locator(".content-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/home-personalized-compact.png",
    fullPage: true,
    animations: "disabled",
  });
  const tasteCard = page.locator(".taste-card");
  await tasteCard.scrollIntoViewIfNeeded();
  await tasteCard.screenshot({
    path: "test-results/home-personalized-compact-taste.png",
    animations: "disabled",
  });
  const philosophyCard = page.locator(".philosophy-card");
  await philosophyCard.scrollIntoViewIfNeeded();
  await philosophyCard.screenshot({
    path: "test-results/home-personalized-compact-philosophy.png",
    animations: "disabled",
  });
});

test("Home prompt and favorite chart use Library entries", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("The Integration Tale");
  await chooseCustomOption(page, editor, "Media type", "Animation");
  await chooseCustomOption(page, editor, "Disposition", "Already experienced");
  await chooseCustomOption(page, editor, "Overall rating", "9 / 10");
  await chooseCustomOption(page, editor, "Plot", "8");
  await editor
    .getByLabel("Your thoughts")
    .fill("An inventive story that stays with me.");
  await editor.getByRole("button", { name: "Save work", exact: true }).click();

  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await page.getByRole("button", { name: "Choose your qualities" }).click();
  const qualities = page.getByRole("dialog", { name: "What matters to you?" });
  await qualities.getByLabel("Plot", { exact: true }).check();
  await qualities.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByRole("button", { name: "Qualities in my favorites", exact: true })
    .click();
  await expect(page.locator(".taste-empty")).toHaveCount(0);
  const scores = page.locator(".chart-values");
  await scores.locator("summary").click();
  await expect(scores).toContainText("Plot");
  await expect(scores).toContainText("8 / 10");
  await page.screenshot({
    path: "test-results/home-library-favorite-chart.png",
    fullPage: true,
    animations: "disabled",
  });

  await page
    .getByRole("button", {
      name: "Create a recommendation prompt",
      exact: true,
    })
    .click();
  const prompt = page.getByRole("textbox", { name: "Recommendation prompt" });
  await expect(
    page.getByText("No library entries yet.", { exact: false }),
  ).toHaveCount(0);
  await expect(prompt).toHaveValue(/The Integration Tale/);
  await expect(prompt).toHaveValue(/An inventive story that stays with me\./);
  await expect(prompt).toHaveValue(/Plot 8\/10/);
  await expect(prompt).not.toHaveValue(/Animation/);
  await page.getByLabel("Include media type labels").check();
  await expect(prompt).toHaveValue(/The Integration Tale – 9 \(Animation\)/);
  await page.screenshot({
    path: "test-results/home-library-recommendation-prompt.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("Unsaved profile is preserved until explicit discard", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .last()
    .click();
  await page.getByLabel("Nickname", { exact: true }).fill("Unsaved name");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveValue(
    "Unsaved name",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your library", exact: true }),
  ).toBeVisible();
});

test("Theme choices, shortcuts, multiple tabs and deliberately empty sections", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const [name, theme] of [
    ["Daylight", "light"],
    ["Dusk", "dusk"],
    ["Reading", "reading"],
    ["Midnight", "dark"],
  ]) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({
      path: `test-results/settings-${theme}.png`,
      animations: "disabled",
    });
  }
  await page.screenshot({
    path: "test-results/settings-midnight.png",
    fullPage: true,
    animations: "disabled",
  });
  const settingsNav = page.getByRole("navigation", {
    name: "Settings categories",
  });
  await settingsNav.getByRole("button", { name: "Data & privacy" }).click();
  const resetButton = page.getByRole("button", {
    name: "Reset workspace",
    exact: true,
  });
  await expect(resetButton).toBeVisible();
  await resetButton.click();
  await expect(
    page.getByRole("heading", { name: "Delete all Tastellar data?" }),
  ).toBeVisible();
  await expect(page.getByText("This cannot be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({
    path: "test-results/settings-data-privacy.png",
    fullPage: true,
    animations: "disabled",
  });
  await settingsNav.getByRole("button", { name: "Your workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Reset workspace", exact: true }),
  ).toHaveCount(0);
  const previousShortcut = page.getByRole("button", {
    name: "⌥ ←",
    exact: true,
  });
  await expect(page.getByRole("heading", { name: "Left tab" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Right tab" })).toBeVisible();
  await expect(previousShortcut).toBeVisible();
  await previousShortcut.click();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(
    page.getByRole("button", { name: "⌥ ⇧ ←", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset shortcuts" }).click();
  await expect(
    page.getByRole("button", { name: "⌥ ←", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page
    .locator(".tab-chooser")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(
    page.getByRole("heading", { name: "Make room for your style." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Plan to Watch", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Library groups and search" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add work", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Library groups and search" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle details panel", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A space for the details" }),
  ).toBeVisible();
});

test("Workspace tabs reorder with a pointer drag while clicks still activate", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".section-toolbar")).toHaveCount(0);
  const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
  const openTab = async (section: string) => {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page
      .locator(".tab-chooser")
      .getByRole("button", { name: section, exact: true })
      .click();
  };

  await openTab("Library");
  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("Preserved table state");
  await editor.getByRole("combobox", { name: "Media type", exact: true }).click();
  await editor.getByRole("option", { name: "Literature" }).click();
  await editor.getByRole("combobox", { name: "Disposition", exact: true }).click();
  await editor
    .getByRole("option", { name: "Already experienced", exact: true })
    .click();
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.waitForTimeout(550);
  await openTab("Analytics");
  const labels = async () =>
    tabs
      .getByRole("tab")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim()));
  expect(await labels()).toEqual(["Home", "Library", "Analytics"]);
  await expect(tabs.getByRole("tab", { name: "Analytics" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    tabs.getByRole("button", { name: /Move .* tab (left|right)/ }),
  ).toHaveCount(0);
  const tabItems = tabs.locator(".app-tab");
  const initialIdentities = await tabItems.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-tab-id")),
  );
  const homeItem = tabItems.nth(0);
  const libraryTab = tabs.getByRole("tab", { name: "Library" });
  await libraryTab.evaluate((button) => {
    button.dataset.nativeDragStarted = "false";
    document.addEventListener(
      "dragstart",
      (event) => {
        if (event.target === button) button.dataset.nativeDragStarted = "true";
      },
      { capture: true },
    );
  });
  const from = await libraryTab.boundingBox();
  const to = await homeItem.boundingBox();
  if (!from || !to) throw new Error("Workspace tab bounds were not available");
  await page.mouse.move(from.x + from.width * 0.62, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width * 0.62 + 3,
    from.y + from.height / 2,
    { steps: 2 },
  );
  await page.mouse.up();
  expect(await labels()).toEqual(["Home", "Library", "Analytics"]);
  await expect(libraryTab).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Analytics" }).click();

  await page.mouse.move(from.x + from.width * 0.62, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width * 0.62 + 16,
    from.y + from.height / 2,
    {
      steps: 3,
    },
  );
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
  await expect(homeItem).toHaveClass(/drop-before/);
  await page.screenshot({
    path: "test-results/tab-drag-insertion.png",
    animations: "disabled",
  });
  await page.mouse.up();
  await expect(libraryTab).toHaveAttribute("data-native-drag-started", "false");
  expect(await labels()).toEqual(["Library", "Home", "Analytics"]);
  expect(
    await tabItems.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-tab-id")),
    ),
  ).toEqual([initialIdentities[1], initialIdentities[0], initialIdentities[2]]);
  await expect(tabs.getByRole("tab", { name: "Analytics" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("button", { name: "Close Home tab" }).click();
  await expect(tabs.getByRole("tab", { name: "Home" })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Analytics" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("tab", { name: "Analytics" }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  expect(await labels()).toEqual(["Analytics", "Library"]);
  await expect(tabs.getByRole("tab", { name: "Analytics" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByRole("table")).toBeVisible();
});

test("sidebar visibility can be remembered per tab or shared globally", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Workspace tabs" });
  const left = page.locator(".titlebar .left-sidebar-toggle");
  const right = page.locator(".titlebar .panel-toggle:not(.left-sidebar-toggle)");
  await expect(left).toHaveAttribute("aria-pressed", "true");
  await expect(right).toHaveAttribute("aria-pressed", "false");

  const tabStripBox = await page.locator(".tab-strip").boundingBox();
  const addTabBox = await page.getByRole("button", { name: "New tab", exact: true }).boundingBox();
  if (!tabStripBox || !addTabBox) throw new Error("Workspace tab controls should be measurable");
  expect(addTabBox.x).toBeGreaterThanOrEqual(tabStripBox.x + tabStripBox.width - 2);
  await page.screenshot({ path: "test-results/new-tab-after-tab-strip.png", animations: "disabled" });

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.locator(".tab-chooser").getByRole("button", { name: "Home", exact: true }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await left.click();
  await right.click();
  await expect(left).toHaveAttribute("aria-pressed", "false");
  await expect(right).toHaveAttribute("aria-pressed", "true");

  await tabs.getByRole("tab").nth(0).click();
  await expect(left).toHaveAttribute("aria-pressed", "true");
  await expect(right).toHaveAttribute("aria-pressed", "false");
  await tabs.getByRole("tab").nth(1).click();
  await expect(left).toHaveAttribute("aria-pressed", "false");
  await expect(right).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Your workspace" }).click();
  const remember = page.getByRole("switch", { name: "Remember sidebar visibility per tab", exact: true });
  await expect(remember).toHaveAttribute("aria-checked", "true");
  await remember.click();
  await expect(remember).toHaveAttribute("aria-checked", "false");

  await tabs.getByRole("tab").nth(0).click();
  await expect(left).toHaveAttribute("aria-pressed", "false");
  await expect(right).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Your workspace" }).click();
  await page.getByRole("switch", { name: "Remember sidebar visibility per tab", exact: true }).click();
  await tabs.getByRole("tab").nth(0).click();
  await expect(left).toHaveAttribute("aria-pressed", "true");
  await expect(right).toHaveAttribute("aria-pressed", "false");
  await tabs.getByRole("tab").nth(1).click();
  await expect(left).toHaveAttribute("aria-pressed", "false");
  await expect(right).toHaveAttribute("aria-pressed", "true");
});

test("Reading theme keeps Settings and Library selects legible", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Reading/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "reading");
  await expect(page.getByLabel("Text size", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/settings-reading-selects.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Sort works", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/library-reading-selects.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("Reset workspace confirms full deletion and clears preview data", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .last()
    .click();
  await page.getByLabel("Nickname", { exact: true }).fill("Reset sample");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("Work to delete");
  await chooseCustomOption(page, editor, "Media type", "Literature");
  await chooseCustomOption(page, editor, "Disposition", "Already experienced");
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await editor.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsNav = page.getByRole("navigation", {
    name: "Settings categories",
  });
  await settingsNav.getByRole("button", { name: "Data & privacy" }).click();
  await page
    .getByRole("button", { name: "Reset workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Delete all Tastellar data?" }),
  ).toBeVisible();
  await expect(
    page.getByText("Exported archive files saved elsewhere are not affected."),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/reset-workspace-confirmation.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect(
    page.getByRole("heading", { name: "Reset sample", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Work to delete", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Data & privacy" })
    .click();
  await page
    .getByRole("button", { name: "Reset workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete all data", exact: true })
    .click();

  await expect(
    page.getByRole("heading", {
      name: "All your favourite media in one place.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reset sample", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".library-work-card")).toHaveCount(0);
  await expect(page.getByText("Work to delete", { exact: true })).toHaveCount(
    0,
  );
});

test("Home empty state and compact window stay within viewport", async ({
  page,
}) => {
  await page.goto("/");
  await page.screenshot({
    path: "test-results/home-empty.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(
    page.getByRole("heading", {
      name: "All your favourite media in one place.",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".content-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/home-compact.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  expect(
    await page
      .locator(".content-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});
