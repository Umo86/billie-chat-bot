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
  // Editors build bots but don't manage settings.
  await p.goto("/settings");
  await expect(p).toHaveURL(/\/\?denied=1$/);
  await expect(p.getByText("Your role doesn't include that page.")).toBeVisible();
  await jo.close();

  await page.reload();
  await expect(page.getByTestId("member-row").filter({ hasText: "Jo Editor" })).toBeVisible();
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

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("By bot")).toBeVisible();
  await shot(page, "reports");
});
