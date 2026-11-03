import { expect, test } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";

/**
 * Requests from chat, end to end: the team chooses a ready-made request on
 * the bot's Rules step; an exhibitor asks for it in the chat and fills in
 * the form; the team handles it on the Requests page; the exhibitor sees
 * the outcome on their request's page. Uses the live "Exhibitor Help" bot
 * from bots.spec.ts.
 */
test("a request from chat, handled by the team and followed by the exhibitor", async ({
  page,
  browser,
}) => {
  await signInAsAdmin(page);
  await page.getByRole("link", { name: "Edit", exact: true }).first().click(); // the only bot
  await page.getByRole("link", { name: "4 Rules" }).click();
  const panel = page.getByTestId("requests-panel");
  await expect(panel).toContainText("This bot doesn't take any requests yet.");
  await panel
    .getByLabel("Add a ready-made request")
    .selectOption({ label: "Extra build-up or breakdown hours" });
  await expect(panel.getByLabel("Request", { exact: true })).toHaveValue(
    "Extra build-up or breakdown hours",
  );
  await shot(page, "bot-requests");
  await panel.getByRole("button", { name: "Save requests" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // An exhibitor on the chat page asks for extra hours and gets the form.
  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto("/c/exhibitor-help");
  await chat
    .getByLabel("Your message")
    .fill("We need extra hours on Wednesday evening. Can we book them?");
  await chat.getByLabel("Your message").press("Enter");
  const form = chat.getByRole("form", { name: "Request: Extra build-up or breakdown hours" });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel(/Which days and times/).fill("Wednesday 25 November until 22:00");
  await form.getByLabel("Name").fill("Sam Lee");
  await form.getByLabel(/Company/).fill("Northern Stands Ltd");
  await form.getByLabel(/Stand number/).fill("N3-210");
  await form.getByLabel("Email").fill("sam@northern-stands.test");
  await shot(chat, "chat-request-form");
  await form.getByRole("button", { name: "Send the request" }).click();
  const thanks = chat.getByText(
    /Your request R-\d+ \(Extra build-up or breakdown hours\) is with the team/,
  );
  await expect(thanks).toBeVisible();
  const line = (await thanks.textContent()) ?? "";
  const ref = /R-\d+/.exec(line)![0];
  const track = /https?:\/\/\S+\/r\/[A-Za-z0-9_-]+/.exec(line)![0];
  await expect(form).toBeHidden();

  // The team: the Requests page shows it, given to whoever manages the event mailbox.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /Requests/ })
    .click();
  const row = page.getByTestId("request-row").filter({ hasText: ref });
  await expect(row).toContainText("Extra build-up or breakdown hours");
  await expect(row).toContainText("Northern Stands Ltd, stand N3-210, Sam Lee");
  await expect(row).toContainText("Umit Bozdag");
  await row.click();
  const view = page.getByTestId("request-view");
  await expect(view).toContainText("Wednesday 25 November until 22:00");
  await expect(view).toContainText("sam@northern-stands.test");
  await view.getByLabel("Status").selectOption({ label: "Done" });
  await view
    .getByLabel(/Message to them/)
    .fill("Approved: you can build until 22:00 on Wednesday.");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(view).toContainText(`marked ${ref} as done`);
  await shot(page, "requests");

  // The exhibitor's page shows the outcome.
  await chat.goto(track);
  await expect(
    chat.getByRole("heading", { name: "Extra build-up or breakdown hours" }),
  ).toBeVisible();
  await expect(chat.getByText("Your request is done.")).toBeVisible();
  await expect(chat.getByText("Approved: you can build until 22:00 on Wednesday.")).toBeVisible();
  await expect(chat.getByText("sam@northern-stands.test")).toHaveCount(0);
  await visitor.close();
});
