import { expect, test } from "@playwright/test";

test("ranking reset is separately confirmed and preserves library works and scores", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Add work", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "Add work" });
  await editor.getByPlaceholder("Media title").fill("Ranking reset keeps me");
  await editor.getByRole("combobox", { name: "Media type", exact: true }).click();
  await page.getByRole("option", { name: "Animation", exact: true }).click();
  await editor.getByLabel("Disposition").click();
  await page.getByRole("option", { name: "Already experienced", exact: true }).click();
  await editor.getByLabel("Overall rating").click();
  await page.getByRole("option", { name: "7 / 10", exact: true }).click();
  await editor.getByRole("button", { name: "Save work", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Data & privacy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset media ranking", exact: true })
    .click();

  const confirmation = page.getByRole("dialog", {
    name: "Reset media ranking?",
  });
  await expect(confirmation).toContainText(
    "All rated works return to Unplaced.",
  );
  await expect(confirmation).toContainText("overall ratings");
  await expect(confirmation).toContainText(
    "restoring one may restore its ranking history",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);

  await page
    .getByRole("button", { name: "Reset media ranking", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Reset media ranking?" })
    .getByRole("button", { name: "Reset ranking", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Ranking reset." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ranking reset keeps me", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "7", exact: true }),
  ).toBeVisible();
});
