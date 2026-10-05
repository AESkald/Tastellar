import { expect, test } from "@playwright/test";

const sidebarFreeSections = ["Home", "Recap", "Analytics", "Settings"] as const;

test("sidebars stay hidden on sidebar-free sections and return in Library and Ranking", async ({
  page,
}) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const leftToggle = page.locator(".titlebar .left-sidebar-toggle");
  const rightToggle = page.locator(".titlebar .panel-toggle:not(.left-sidebar-toggle)");
  const leftSidebar = page.locator(".app-empty-left-sidebar, .library-groups, .ranking-workspace > .folder-shell");
  const rightSidebar = page.locator(".library-context-panel, .details-shell");

  await expect(leftToggle).toBeHidden();
  await expect(rightToggle).toBeHidden();
  await expect(leftSidebar).toHaveCount(0);
  await expect(rightSidebar).toHaveCount(0);

  await navigation.getByRole("button", { name: "Library", exact: true }).click();
  await expect(leftToggle).toBeVisible();
  await expect(rightToggle).toBeVisible();
  await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  await rightToggle.click();
  await expect(page.locator(".library-context-panel .library-details-empty")).toBeVisible();
  await page.screenshot({
    path: "test-results/app-shell-library-sidebars-desktop.png",
    animations: "disabled",
  });

  for (const section of ["Library", "Ranking"]) {
    await navigation.getByRole("button", { name: section, exact: true }).click();
    await expect(leftToggle).toBeVisible();
    await expect(rightToggle).toBeVisible();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");

    if (section === "Library")
      await expect(page.locator(".library-groups")).toBeVisible();
    else if (section === "Ranking")
      await expect(page.locator(".ranking-workspace > .folder-shell")).toBeVisible();

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

    await leftToggle.click();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
  }

  for (const section of sidebarFreeSections) {
    await navigation.getByRole("button", { name: section, exact: true }).click();

    await expect(leftToggle).toBeHidden();
    await expect(rightToggle).toBeHidden();
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
    await expect(rightToggle).toHaveAttribute("aria-pressed", "true");
    await expect(leftSidebar).toHaveCount(0);
    await expect(rightSidebar).toHaveCount(0);
    await page.screenshot({
      path: `test-results/app-shell-${section.toLowerCase()}-sidebars-hidden.png`,
      animations: "disabled",
    });
  }

  await navigation.getByRole("button", { name: "Library", exact: true }).click();
  await expect(leftToggle).toBeVisible();
  await expect(rightToggle).toBeVisible();
  await expect(page.locator(".library-groups")).toBeVisible();
  await expect(page.locator(".library-context-panel .library-details-empty")).toBeVisible();
  await navigation.getByRole("button", { name: "Ranking", exact: true }).click();
  await expect(leftToggle).toBeVisible();
  await expect(rightToggle).toBeVisible();
  await expect(page.locator(".ranking-workspace > .folder-shell")).toBeVisible();

  await navigation.getByRole("button", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(leftToggle).toBeHidden();
  await expect(rightToggle).toBeHidden();
  await expect(leftSidebar).toHaveCount(0);
  await expect(rightSidebar).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/app-shell-home-sidebars-hidden-mobile.png",
    animations: "disabled",
  });
});
