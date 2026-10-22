import { expect, test } from "@playwright/test";
import { invite } from "./db";
import { ADMIN } from "./helpers";

/**
 * Sign-in, end to end: first-run set-up, signing out and in, an invitation
 * for an agent, and the role limits that follow. Runs in order: the first
 * test creates the admin the others rely on.
 */
test.describe.configure({ mode: "serial" });

test("first run: set up the admin account", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Your name").fill(ADMIN.name);
  await page.getByLabel("Work email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  await expect(page.getByRole("heading", { name: "Your bots" })).toBeVisible();
  await expect(page.getByText("You're set up.")).toBeVisible();
});

test("sign out, a wrong password, then signing back in", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/); // set-up is closed once someone exists

  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(ADMIN.email); // kept for the next try

  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Your bots" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("an invited agent joins and only sees what agents may use", async ({ page }) => {
  const token = await invite("priya@media10.test", "Priya Shah", "agent");
  await page.goto(`/invite/${token}`);
  await expect(page.getByRole("heading", { name: "Welcome, Priya" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("agent-password-123");
  await page.getByLabel("Type it again").fill("agent-password-123");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Hello, Priya" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // The link works once.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(`/invite/${token}`);
  await expect(page.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
});

test("a sign-in that isn't on the team gets nowhere", async ({ page }) => {
  // An invitation that was never accepted gives no access by itself.
  await invite("stranger@elsewhere.test", "Stranger", "agent");
  await page.goto("/login");
  await page.getByLabel("Email").fill("stranger@elsewhere.test");
  await page.getByLabel("Password").fill("whatever-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
});
