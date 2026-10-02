import { expect, test, type Locator } from "@playwright/test";

async function expectImportBeforeExport(panel: Locator) {
  const buttons = panel.locator(".transfer-actions > button");
  await expect(buttons).toHaveText([
    "Import library archive",
    "Export library archive",
  ]);
  await expect(buttons.nth(0)).toHaveClass(/button primary/);
  await expect(buttons.nth(1)).toHaveClass(/button secondary/);
  await expect(buttons.nth(0).locator("svg")).toHaveClass(/lucide-download/);
  await expect(buttons.nth(1).locator("svg")).toHaveClass(/lucide-upload/);
}

test("Settings and Library expose the same story-inclusive archive controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Import / export", exact: true })
    .first()
    .click();

  const libraryPanel = page.locator(".transfer-panel");
  await expectImportBeforeExport(libraryPanel);
  await expect(libraryPanel).toContainText(
    "all stories, ratings, tags, and media types",
  );
  await expect(
    libraryPanel.getByRole("button", {
      name: "Export library archive",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    libraryPanel.getByRole("button", {
      name: "Import library archive",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(libraryPanel).toContainText(
    "This browser preview does not store data.",
  );
  expect(
    await libraryPanel.evaluate((element) => getComputedStyle(element).padding),
  ).toBe("17px 19px 28px");
  await page.locator(".library-context-panel").screenshot({
    path: "test-results/library-transfer-panel.png",
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Data & privacy", exact: true })
    .click();

  const settingsPanel = page.locator(".transfer-panel");
  await expectImportBeforeExport(settingsPanel);
  await expect(settingsPanel).toContainText(
    "all stories, ratings, tags, and media types",
  );
  await expect(
    settingsPanel.getByRole("button", {
      name: "Export library archive",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    settingsPanel.getByRole("button", {
      name: "Import library archive",
      exact: true,
    }),
  ).toBeDisabled();
});

test("About displays the short 0.4 release version", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "About", exact: true })
    .click();
  await expect(page.locator(".about-card")).toContainText("Version 0.4");
  await expect(page.locator(".about-card")).not.toContainText("0.4.0");
});
