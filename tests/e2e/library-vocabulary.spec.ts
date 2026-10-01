import { expect, test } from "@playwright/test";

test("Library vocabulary creates ordered scoring types and merges tags", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Manage types & tags" }).click();

  const editor = page.getByRole("dialog", {
    name: "Manage library vocabulary",
  });
  await editor.getByRole("tab", { name: "Criteria" }).click();
  await editor.getByRole("button", { name: "Add criterion" }).click();
  await editor.getByRole("textbox", { name: "Name" }).fill("Editorial focus");
  await editor
    .getByLabel("Description (optional)")
    .fill("How focused the work feels");
  await editor.getByRole("button", { name: "Save criterion" }).click();
  await expect(editor.getByRole("status")).toContainText("Criterion saved.");

  await editor.getByRole("tab", { name: "Media types" }).click();
  await editor.getByRole("button", { name: "Add type" }).click();
  await editor.getByRole("textbox", { name: "Name" }).fill("Audio dramas");
  await editor.getByRole("checkbox", { name: "Editorial focus" }).check();
  await editor.getByRole("button", { name: "Save type" }).click();
  await expect(editor.getByRole("status")).toContainText("Media type saved.");
  await expect(
    editor.getByRole("button", { name: /Audio dramas/ }).first(),
  ).toContainText("1 criterion");

  await editor.getByRole("tab", { name: "Tags" }).click();
  await editor.getByRole("textbox", { name: "Name" }).fill("Quiet pick");
  await editor.getByRole("button", { name: "Create tag" }).click();
  await expect(editor.getByRole("status")).toContainText("Tag created.");

  await editor.getByRole("button", { name: "Add tag" }).click();
  await editor.getByRole("textbox", { name: "Name" }).fill("Revisit");
  await editor.getByRole("button", { name: "Create tag" }).click();
  await expect(editor.getByRole("status")).toContainText("Tag created.");

  await editor.getByRole("combobox", { name: "Merge from", exact: true }).click();
  await page.getByRole("option", { name: "Quiet pick", exact: true }).click();
  await editor.getByRole("combobox", { name: "Merge into", exact: true }).click();
  await page.getByRole("option", { name: "Revisit", exact: true }).click();
  await editor.getByRole("button", { name: "Preview merge" }).click();
  await expect(editor.getByText("0 affected works")).toBeVisible();
  await editor.getByRole("button", { name: "Confirm merge" }).click();
  await expect(editor.getByRole("status")).toContainText(
    "“Quiet pick” merged into “Revisit”.",
  );
  await expect(editor.getByRole("button", { name: "Quiet pick" })).toHaveCount(
    0,
  );
  await expect(
    editor.getByRole("button", { name: "Revisit 0 works" }),
  ).toBeVisible();
});
