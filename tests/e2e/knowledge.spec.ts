import { expect, test, type Locator, type Page } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";

/**
 * Changing knowledge in place: edit a pasted text, then replace an email
 * address everywhere in the knowledge base, with a preview first.
 */
test("edit knowledge, then find and replace across a knowledge base", async ({ page }) => {
  await signInAsAdmin(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Knowledge" })
    .click();
  await page.getByRole("button", { name: "New knowledge base" }).click();
  await page.getByLabel("Name").fill("Christmas show contacts");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Christmas show contacts" })).toBeVisible();

  await page.getByRole("tab", { name: "Paste text" }).click();
  await page.getByLabel("Title").fill("Who to contact");
  await page
    .getByLabel("Text", { exact: true })
    .fill("Exhibitor questions: email idealhomeshow@eventcreate.co.uk. Lifting: L-T-D.");
  await page.getByRole("button", { name: "Add text" }).click();
  const row = page.getByTestId("source-row").filter({ hasText: "Who to contact" });
  await expect(row.getByText(/Ready · 1 passage/)).toBeVisible({ timeout: 20_000 });

  // Edit: the dialog opens with the text, and Billie reads the new version.
  await row.getByRole("button", { name: "Edit Who to contact" }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByLabel("Text", { exact: true })).toHaveValue(/Lifting: L-T-D\./);
  await edit
    .getByLabel("Text", { exact: true })
    .fill(
      "Exhibitor questions: email idealhomeshow@eventcreate.co.uk. Lifting: L-T-D, 07799 606 262.",
    );
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved. Billie is reading it again.")).toBeVisible();
  await expect(edit).toBeHidden();
  await passagesShow(page, row, "07799 606 262");

  // Find and replace: preview first, then change it everywhere.
  await page.getByRole("button", { name: "Find and replace" }).click();
  const replace = page.getByRole("dialog");
  await replace.getByLabel("Find", { exact: true }).fill("IDEALHOMESHOW@eventcreate.co.uk");
  await replace.getByLabel("Replace with").fill("ops@media10.test");
  await replace.getByRole("button", { name: "Preview" }).click();
  const preview = replace.getByTestId("replace-preview");
  await expect(preview).toContainText("Found 1 time in 1 source.");
  await expect(preview).toContainText("email ops@media10.test.");
  await shot(page, "knowledge-replace");
  await replace.getByRole("button", { name: "Replace in 1 source" }).click();
  await expect(page.getByText("Replaced in 1 source. Billie is reading it again.")).toBeVisible();
  await expect(replace).toBeHidden();
  await passagesShow(page, row, "email ops@media10.test.");
  await row.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog")).not.toContainText("eventcreate");
  await page.keyboard.press("Escape");

  // Knowledge check: a deadline that has passed is listed, with Edit to fix it.
  await page.getByLabel("Title").fill("Deadlines");
  await page
    .getByLabel("Text", { exact: true })
    .fill("Early bird electrics: 26 October 2026. Stand plans by 9 November 2099.");
  await page.getByRole("button", { name: "Add text" }).click();
  const deadlines = page.getByTestId("source-row").filter({ hasText: "Deadlines" });
  await expect(deadlines.getByText(/Ready · 1 passage/)).toBeVisible({ timeout: 20_000 });
  const check = page.getByTestId("knowledge-check");
  await check.getByRole("button", { name: "Check now" }).click();
  await expect(check).toContainText("1 thing to look at", { timeout: 30_000 });
  await expect(check).toContainText("Date passed");
  await expect(check).toContainText("26 October 2026 has passed");
  await shot(page, "knowledge-check");
  await check.getByRole("button", { name: "Edit Deadlines" }).click();
  await expect(page.getByRole("dialog").getByLabel("Text", { exact: true })).toHaveValue(
    /26 October 2026/,
  );
  await page.keyboard.press("Escape");
  await expect(check.getByRole("button", { name: "Check again" })).toBeEnabled();
});

/** Billie reads in the background: open View until the passages show the new text. */
async function passagesShow(page: Page, row: Locator, text: string) {
  await expect(async () => {
    await expect(row.getByText(/Ready · 1 passage/)).toBeVisible();
    await row.getByRole("button", { name: "View" }).click();
    try {
      await expect(page.getByRole("dialog")).toContainText(text, { timeout: 2_000 });
    } finally {
      await page.keyboard.press("Escape");
    }
  }).toPass({ timeout: 30_000 });
}
