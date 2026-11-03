import { expect, test, type Locator, type Page } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";

/**
 * Each bot's own knowledge, changed in place: a second bot starts with
 * empty knowledge; edit a pasted text, then replace an email address
 * everywhere in it, with a preview first. The first bot's knowledge is
 * never touched.
 */
test("a bot's own knowledge: edit it, then find and replace across it", async ({ page }) => {
  await signInAsAdmin(page);
  const main = page.getByRole("navigation", { name: "Main" });
  await main.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "New bot" }).first().click();
  await page.getByLabel("Bot name").fill("Christmas Show Help");
  await page.getByLabel("Show name").fill("Ideal Home Show Christmas 2026");
  await page.getByRole("button", { name: "Create bot and continue" }).click();
  await expect(page.getByText("Bot created.")).toBeVisible();

  // The Knowledge page has each bot's knowledge; the new bot's is empty.
  await main.getByRole("link", { name: "Knowledge" }).click();
  const bots = page.getByRole("navigation", { name: "Bots" });
  await expect(bots.getByRole("link")).toHaveCount(2);
  await bots.getByRole("link", { name: /Christmas Show Help/ }).click();
  await expect(page.getByRole("heading", { name: "Christmas Show Help" })).toBeVisible();
  await expect(page.getByText("Nothing in here yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New knowledge base" })).toHaveCount(0);

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

  // The first bot's knowledge is its own: none of this is in it.
  await bots.getByRole("link", { name: /Exhibitor Help/ }).click();
  await expect(page.getByRole("heading", { name: "Exhibitor Help" })).toBeVisible();
  await expect(
    page.getByTestId("source-row").filter({ hasText: "When does build-up start?" }),
  ).toBeVisible();
  await expect(page.getByTestId("source-row").filter({ hasText: "Who to contact" })).toHaveCount(0);

  // Copy the second bot for next year's show: everything comes across, with its dates to check.
  await bots.getByRole("link", { name: /Christmas Show Help/ }).click();
  // Wait for the page to switch, or "Open the bot" is still the other bot's link.
  await expect(page.getByRole("heading", { name: "Christmas Show Help", level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "Open the bot" }).click();
  await expect(page.getByRole("heading", { name: "Christmas Show Help", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Copy for another show" }).click();
  const copy = page.getByRole("dialog");
  await expect(copy.getByLabel("Show name")).toHaveValue("Ideal Home Show Christmas 2027");
  await copy.getByLabel("Name of the copy").fill("Christmas Show Help 2027");
  await copy.getByRole("button", { name: "Make the copy" }).click();
  await expect(page.getByText(/^Copied\. Its knowledge/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Christmas Show Help 2027" })).toBeVisible();
  const dates = page.getByTestId("dates-to-check");
  await expect(dates).toContainText("Copied from Christmas Show Help.");
  await expect(dates).toContainText("26 October 2026");
  await expect(page.getByTestId("source-row").filter({ hasText: "Deadlines" })).toBeVisible();
  await shot(page, "bot-copy-dates");
  await dates.getByRole("button", { name: "Done: dates checked" }).click();
  await expect(page.getByTestId("dates-to-check")).toHaveCount(0);
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
