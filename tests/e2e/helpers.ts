import { expect, type Page } from "@playwright/test";

export const ADMIN = {
  name: "Umit Bozdag",
  email: "umit@media10.test",
  password: "correct-horse-battery",
};

/** Signs in as the admin, setting Billie up first if this is a fresh run. */
export async function signInAsAdmin(page: Page) {
  await page.goto("/setup");
  if (page.url().endsWith("/setup")) {
    await page.getByLabel("Your name").fill(ADMIN.name);
    await page.getByLabel("Work email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** Full-page screenshot when SHOTS=<folder> is set (for reviewing the design). */
export async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
