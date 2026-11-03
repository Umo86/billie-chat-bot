import { expect, test } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";

/** Admin screens: inviting through Settings, connection status, reports. */
test.describe.configure({ mode: "serial" });

test("invite an editor from Settings; they join with the link", async ({ page, browser }) => {
  await signInAsAdmin(page);
  await page.goto("/settings?tab=team");
  await page.getByLabel("Work email").fill("jo.editor@media10.test");
  await page.getByLabel("Name", { exact: true }).fill("Jo Editor");
  await page.getByLabel("Role", { exact: true }).selectOption("editor");
  // Jo works on one of the two bots.
  await page.getByRole("checkbox", { name: "Exhibitor Help" }).check();
  await page.getByRole("button", { name: "Invite" }).click();
  const link = (await page.locator("#invite-link").textContent())?.trim() ?? "";
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
  await expect(page.getByText("Waiting to join")).toBeVisible();
  await shot(page, "settings-team");

  const jo = await browser.newContext();
  const p = await jo.newPage();
  await p.goto(link);
  await p.getByLabel("Password", { exact: true }).fill("editor-password-42");
  await p.getByLabel("Type it again").fill("editor-password-42");
  await p.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(p.getByRole("heading", { name: "Your bots" })).toBeVisible();
  // Only the bot Jo works on, and only its knowledge.
  await expect(p.getByTestId("bot-card")).toHaveCount(1);
  await expect(p.getByTestId("bot-card")).toContainText("Exhibitor Help");
  await p.goto("/knowledge");
  await expect(p.getByRole("navigation", { name: "Bots" }).getByRole("link")).toHaveCount(1);
  await expect(p.getByRole("heading", { name: "Exhibitor Help" })).toBeVisible();
  // Editors build bots but don't manage settings.
  await p.goto("/settings");
  await expect(p).toHaveURL(/\/\?denied=1$/);
  await expect(p.getByText("Your role doesn't include that page.")).toBeVisible();
  await jo.close();

  await page.reload();
  const joRow = page.getByTestId("member-row").filter({ hasText: "Jo Editor" });
  await expect(joRow).toBeVisible();
  await expect(joRow.getByTestId("member-bots")).toHaveText("Works on Exhibitor Help");
  // Suspend Jo: the next request is refused.
  await page
    .getByTestId("member-row")
    .filter({ hasText: "Jo Editor" })
    .getByRole("button", { name: "Suspend" })
    .click();
  await expect(
    page.getByTestId("member-row").filter({ hasText: "Jo Editor" }).getByText("Suspended"),
  ).toBeVisible();
});

test("general settings save, connections and reports render", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings");
  await page.getByLabel("Keep chats and emails for (months)").fill("6");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.").last()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Keep chats and emails for (months)")).toHaveValue("6");

  await page.goto("/settings?tab=connections");
  const signIn = page.getByRole("listitem").filter({ hasText: "Sign-in" });
  await expect(signIn).toContainText(/Neon Auth|Test stand-in/);
  await expect(page.locator("#na-hook")).toContainText("/api/webhooks/neon-auth");
  // The event mailbox set on the bot, with its manager; Microsoft 365 itself isn't connected here.
  await expect(
    page.getByRole("listitem").filter({ hasText: "Microsoft 365 (event mailboxes)" }),
  ).toContainText("Not connected");
  const mailbox = page
    .getByRole("list", { name: "Event mailboxes" })
    .getByRole("listitem")
    .filter({ hasText: "ukcw-exhibitors@media-ten.test" });
  await expect(mailbox).toContainText("Exhibitor Help");
  await expect(mailbox).toContainText("Managed by Umit Bozdag");
  // Teams messages to people: only a Teams Workflows link is taken, and it's never shown again.
  await page.getByLabel("Workflow link").fill("https://hooks.example.com/x");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByText(/isn't a Teams Workflows link/)).toBeVisible();
  await page
    .getByLabel("Workflow link")
    .fill(
      "https://prod-34.uksouth.logic.azure.com:443/workflows/e2e/triggers/manual/paths/invoke?sig=e2e-direct",
    );
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByTestId("teams-direct-status")).toContainText(
    "prod-34.uksouth.logic.azure.com",
  );
  await expect(
    page.getByRole("listitem").filter({ hasText: "Teams messages to people" }).first(),
  ).toContainText("On.");
  await expect(page.locator("body")).not.toContainText("e2e-direct");
  await shot(page, "settings-connections");
  // Turned off again, so nothing later messages anyone.
  await page.getByRole("button", { name: "Turn off" }).click();
  await page.getByRole("button", { name: "Yes, turn off" }).click();
  await expect(page.getByText("Teams messages to people are off.")).toBeVisible();
  await expect(page.getByLabel("Workflow link")).toBeVisible();

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("By bot")).toBeVisible();
  await shot(page, "reports");
});

test("a privacy request: find a visitor's chat and delete it", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/settings?tab=privacy");
  await page.getByLabel("Email or phone number").fill("priya@acme-stands.test");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText(/Found 1 chat, 0 emails and 0 requests/)).toBeVisible();
  await page.getByRole("button", { name: "Delete all of it" }).click();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page.getByText("Deleted 1 chat, 0 emails and 0 requests.")).toBeVisible();
  await page.getByLabel("Email or phone number").fill("priya@acme-stands.test");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Nothing found for priya@acme-stands.test.")).toBeVisible();
});
