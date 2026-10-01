import { expect, test } from "@playwright/test";

const emptyLeftSections = ["Home", "Recap", "Analytics", "Settings"] as const;

test("the topbar left-sidebar toggle follows every workspace section", async ({
  page,
}) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const leftToggle = page.locator(".titlebar .left-sidebar-toggle");
  const rightToggle = page.locator(".titlebar .panel-toggle:not(.left-sidebar-toggle)");
  const emptyLeft = page.locator(".app-empty-left-sidebar");

  await expect(leftToggle).toBeVisible();
  await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  await expect(emptyLeft).toBeVisible();
  await rightToggle.click();
  await expect(page.locator(".details-shell .details-empty")).toBeVisible();
  await page.screenshot({
    path: "test-results/app-shell-empty-sidebars-desktop.png",
    animations: "disabled",
  });
  await rightToggle.click();

  for (const section of ["Library", "Ranking", ...emptyLeftSections]) {
    await navigation.getByRole("button", { name: section, exact: true }).click();
    await expect(leftToggle).toBeVisible();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");

    if (section === "Library")
      await expect(page.locator(".library-groups")).toBeVisible();
    else if (section === "Ranking")
      await expect(page.locator(".ranking-workspace > .folder-shell")).toBeVisible();
    else await expect(emptyLeft).toBeVisible();

    await page.mouse.move(700, 150);
    await page.screenshot({
      path: `test-results/app-shell-${section.toLowerCase()}-sidebar.png`,
      animations: "disabled",
    });

    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "false");
    if (section === "Library")
      await expect(page.locator(".library-groups")).toHaveCount(0);
    else if (section === "Ranking")
      await expect(page.locator(".ranking-workspace > .folder-shell")).toBeHidden();
    else await expect(emptyLeft).toHaveCount(0);

    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  }

  await navigation.getByRole("button", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(emptyLeft).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/app-shell-empty-left-sidebar-mobile.png",
    animations: "disabled",
  });
});
