import path from "node:path";
import { expect, test } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";

/**
 * Knowledge in, bot out: a knowledge base with a typed answer and a file,
 * then the bot's steps (look, personality, knowledge, rules, email and
 * Teams, test) through to a passing test run and going live.
 */
test.describe.configure({ mode: "serial" });

test("build knowledge, then a bot that answers from it", async ({ page }) => {
  await signInAsAdmin(page);

  // Knowledge: a base, a typed answer and a CSV file.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Knowledge" })
    .click();
  await page.getByRole("button", { name: "New knowledge base" }).click();
  await page.getByLabel("Name").fill("Exhibitor knowledge");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Exhibitor knowledge" })).toBeVisible();

  await page.getByRole("tab", { name: "Typed answer" }).click();
  await page.getByLabel("Question").fill("When does build-up start?");
  await page
    .getByLabel("Answer")
    .fill("Build-up starts on Monday 8 March at 8am. Bring your contractor badge.");
  await page.getByRole("button", { name: "Save answer" }).click();
  const qa = page.getByTestId("source-row").filter({ hasText: "When does build-up start?" });
  await expect(qa.getByText(/Ready · 1 passage/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("tab", { name: "Files" }).click();
  await page
    .locator("#file-input")
    .setInputFiles(path.join(__dirname, "..", "fixtures", "parking.csv"));
  // The upload panel follows the file: "Billie is learning", then a tick and "Billie is ready".
  const learning = page.getByTestId("learning-panel");
  await expect(learning.getByRole("heading", { name: "Billie is ready" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(learning).toContainText(/Learned \d+ passages? from parking\.csv\./);
  await shot(page, "knowledge-ready");
  const file = page.getByTestId("source-row").filter({ hasText: "parking" });
  await expect(file.getByText(/Ready · \d+ passage/)).toBeVisible({ timeout: 30_000 });
  await shot(page, "knowledge");
  // "Add another file" brings the drop zone back.
  await learning.getByRole("button", { name: "Add another file" }).click();
  await expect(page.getByText("Drop files here, or click to choose")).toBeVisible();
  await file.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog")).toContainText(/passage|Row|Sheet|park/i);
  await page.keyboard.press("Escape");

  // Step 1: look.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "New bot" }).first().click();
  await page.getByLabel("Bot name").fill("Exhibitor Help");
  await page.getByLabel("Show name").fill("UK Construction Week 2027");
  await page.getByRole("button", { name: "Suggest a welcome message" }).click();
  await expect(page.getByLabel("Welcome message")).toHaveValue(/Exhibitor Help/);
  await shot(page, "bot-look");
  await page.getByRole("button", { name: "Create bot and continue" }).click();

  // Step 2: personality.
  await expect(page.getByText("Bot created.")).toBeVisible();
  await page.getByRole("tab", { name: "Formal" }).click();
  await page.getByRole("button", { name: "Use the example" }).click();
  await expect(page.getByLabel("Personality, in your own words")).toHaveValue(/ops manager/);
  await page.getByRole("switch", { name: "Emoji in chats" }).click();
  await page.getByLabel("Email sign-off").fill("Best wishes,\nThe UKCW team");
  await shot(page, "bot-personality");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 3: knowledge.
  await expect(
    page.getByRole("heading", { name: "Which knowledge should it answer from?" }),
  ).toBeVisible();
  await page.getByLabel(/Exhibitor knowledge/).check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 4: rules (defaults are fine).
  await expect(page.getByRole("heading", { name: "Always pass these to a person" })).toBeVisible();
  await shot(page, "bot-rules");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 5: the event's mailbox and Teams channel (Microsoft 365 isn't connected in tests).
  await expect(page.getByRole("heading", { name: "Event mailbox" })).toBeVisible();
  await expect(page.getByText(/Microsoft 365 isn't connected yet/)).toBeVisible();
  await page.getByLabel("Mailbox address").fill("UKCW-Exhibitors@media-ten.test");
  await page.getByLabel("Managed by").selectOption({ label: "Umit Bozdag (umit@media10.test)" });
  await page.getByRole("button", { name: "Save mailbox" }).click();
  await expect(page.getByText("Mailbox saved.")).toBeVisible();
  await expect(page.getByTestId("mailbox-status")).toContainText(
    "Billie starts once Microsoft 365 is connected",
  );
  await expect(page.getByLabel("Mailbox address")).toHaveValue("ukcw-exhibitors@media-ten.test");
  // Only a Teams Workflows link is taken, and it's never shown again once saved.
  await page.getByLabel("Teams Workflows link").fill("https://hooks.example.com/abc");
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByText(/isn't a Teams Workflows link/)).toBeVisible();
  await page
    .getByLabel("Teams Workflows link")
    .fill(
      "https://prod-12.uksouth.logic.azure.com:443/workflows/e2e/triggers/manual/paths/invoke?sig=e2e-signature",
    );
  await page.getByRole("button", { name: "Save link" }).click();
  await expect(page.getByTestId("teams-status")).toContainText("prod-12.uksouth.logic.azure.com");
  await expect(page.locator("body")).not.toContainText("e2e-signature");
  await shot(page, "bot-email");
  // Removed again, so later tests never post to Microsoft.
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByText("Teams channel removed.")).toBeVisible();
  await expect(page.getByLabel("Teams Workflows link")).toBeVisible();
  await page.getByRole("link", { name: "Continue to Test" }).click();

  // Step 6: test.
  await expect(page.getByRole("heading", { name: "Try it" })).toBeVisible();
  await page.getByLabel("Question", { exact: true }).fill("When does build-up start?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/Monday 8 March at 8am/).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Save as a test question" }).click();
  await page.getByLabel("Words the answer must mention, test 1").fill("8am, Monday");
  await page.getByRole("button", { name: "Run all tests" }).click();
  await expect(page.getByTestId("test-run")).toContainText("1 of 1 passed", { timeout: 30_000 });

  // A refund question goes to a person, not answered.
  await page.getByLabel("Question", { exact: true }).fill("Can I get a refund on my stand?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/would go to the team/).first()).toBeVisible({ timeout: 20_000 });

  await shot(page, "bot-test");

  // Step 7: go live.
  await page.getByRole("button", { name: "Continue to Go live" }).click();
  await expect(page.locator("#embed-code")).toContainText('data-bot="exhibitor-help"');
  await page
    .getByLabel("Websites allowed to show it")
    .fill("https://www.ukconstructionweek.com/exhibit");
  await page.getByRole("button", { name: "Save websites" }).click();
  await expect(page.getByText("Saved.").last()).toBeVisible();
  await expect(page.getByLabel("Websites allowed to show it")).toHaveValue(
    "ukconstructionweek.com",
  );
  await expect(
    page.getByText(/New emails in ukcw-exhibitors@media-ten.test get a draft reply/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Put live" }).click();
  await expect(page.getByText("Exhibitor Help is live.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take offline" })).toBeVisible();
  await shot(page, "bot-live");
  await page.reload();
  await expect(page.getByLabel("Websites allowed to show it")).toHaveValue(
    "ukconstructionweek.com",
  );
});

test("a visitor chats on the chat page: answer, rating, then the team", async ({ browser }) => {
  const visitor = await browser.newContext(); // no staff session: an anonymous visitor
  const page = await visitor.newPage();
  await page.goto("/c/exhibitor-help");
  await expect(page.getByRole("heading", { name: "Exhibitor Help" })).toBeVisible();
  await expect(page.getByText(/AI assistant/)).toBeVisible(); // the notice before chatting

  await page.getByLabel("Your message").fill("When does build-up start?");
  await page.getByLabel("Your message").press("Enter");
  await expect(page.getByText(/Monday 8 March at 8am/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Source: /).first()).toBeVisible();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(page.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await shot(page, "chat-answer");

  // Nobody is marked available, so asking for a person collects details.
  await page.getByLabel("Your message").fill("Can I get a refund on my stand?");
  await page.getByRole("button", { name: "Send" }).click();
  const form = page.getByRole("form", { name: "Leave your details" });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel("Name").fill("Priya Shah");
  await form.getByLabel("Email").fill("priya@acme"); // the browser accepts this; Billie asks again
  await form.getByLabel(/Company/).fill("Acme Stands Ltd");
  await form.getByRole("button", { name: "Send my details" }).click();
  await expect(page.getByText("That email doesn't look right.")).toBeVisible();
  await form.getByLabel("Email").fill("priya@acme-stands.test");
  await form.getByRole("button", { name: "Send my details" }).click();
  await expect(page.getByText(/Thanks, Priya\. The team will reply/)).toBeVisible();
  await shot(page, "chat-ticket");

  // The chat is remembered in this browser.
  await page.reload();
  await expect(page.getByText(/Thanks, Priya\. The team will reply/)).toBeVisible();
  await expect(page.getByText(/Monday 8 March at 8am/).first()).toBeVisible();
  await visitor.close();
});

test("the website widget shows only on the bot's own websites", async ({ browser }) => {
  const app = "http://localhost:3100";
  const hostPage = (body: string) => `<!doctype html><html><head><title>Show</title></head>
    <body><h1>UK Construction Week</h1>${body}
    <script src="${app}/widget.js" data-bot="exhibitor-help" async></script></body></html>`;

  const visitor = await browser.newContext();
  await visitor.route("https://www.ukconstructionweek.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: hostPage("") }),
  );
  await visitor.route("https://copycat.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: hostPage("") }),
  );
  const page = await visitor.newPage();

  await page.goto("https://www.ukconstructionweek.com/exhibit");
  const button = page.getByRole("button", { name: "Chat with Exhibitor Help" });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const chat = page.frameLocator('iframe[title="Chat with Exhibitor Help"]');
  await expect(chat.getByRole("heading", { name: "Exhibitor Help" })).toBeVisible({
    timeout: 15_000,
  });
  await chat.getByLabel("Your message").fill("When does build-up start?");
  await chat.getByLabel("Your message").press("Enter");
  await expect(chat.getByText(/Monday 8 March at 8am/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "widget-open");
  await chat.getByRole("button", { name: "Close chat" }).click();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // An encoded address can't reach the chat frame without its policy.
  const sneaky = await visitor.request.get(`${app}/embed/exhibitor%2Dhelp`);
  expect(sneaky.status()).toBe(404);
  const direct = await visitor.request.get(`${app}/embed/exhibitor-help`);
  expect(direct.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self' https://ukconstructionweek.com https://*.ukconstructionweek.com",
  );

  // Copied onto another website, the button doesn't appear.
  const other = await visitor.newPage();
  await other.goto("https://copycat.example/");
  await other.waitForTimeout(2500);
  await expect(other.getByRole("button", { name: "Chat with Exhibitor Help" })).toHaveCount(0);
  await visitor.close();
});

test("live handover: the team replies from the Inbox and hands back", async ({ page, browser }) => {
  await signInAsAdmin(page);
  await page.goto("/inbox");
  await page.getByRole("switch", { name: "Available for live chats" }).click();
  await expect(page.getByText("You're available for live chats")).toBeVisible();

  const visitor = await browser.newContext();
  const chat = await visitor.newPage();
  await chat.goto("/c/exhibitor-help");
  await chat.getByLabel("Your message").fill("Can I speak to a person please?");
  await chat.getByLabel("Your message").press("Enter");
  await expect(chat.getByText("Connecting you to the team…")).toBeVisible({ timeout: 20_000 });

  // The chat waits in "Needs you"; open it and reply.
  const row = page.getByTestId("inbox-row").filter({ hasText: "speak to a person" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.getByLabel("Reply").fill("Hi, it's Umit from the ops team. How can I help?");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(chat.getByText("Hi, it's Umit from the ops team.", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(chat.getByText("Chatting with Umit")).toBeVisible();
  await shot(chat, "chat-live");

  await chat.getByLabel("Your message").fill("Where do we unload on build-up day?");
  await chat.getByLabel("Your message").press("Enter");
  await expect(page.getByText("Where do we unload on build-up day?")).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "inbox");

  // Teach Billie from the chat, then hand back.
  await page.getByRole("button", { name: "Save an answer for this" }).last().click();
  await page.getByLabel("Answer", { exact: true }).fill("Unload at Gate B from 7am.");
  await page.getByRole("button", { name: "Save answer" }).click();
  await expect(page.getByText(/use this answer from now on/)).toBeVisible();
  await page.getByRole("button", { name: "Back to Billie" }).click();
  await expect(chat.getByText("You're back with Billie. Ask me anything.")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("switch", { name: "Available for live chats" }).click();
  await expect(page.getByText("You're not taking live chats")).toBeVisible();
  await visitor.close();
});

test("an exhibitor email gets a draft reply from the knowledge", async ({ page }) => {
  await signInAsAdmin(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Emails" })
    .click();
  await page.getByRole("button", { name: "Paste an email" }).click();
  await page.getByLabel("From (name)").fill("Sam Carter");
  await page.getByLabel("From (email)").fill("sam@stands.example");
  await page.getByLabel("Subject").fill("Build-up question");
  await page
    .getByLabel("Email", { exact: true })
    .fill("Hi, when does build-up start for exhibitors? Thanks, Sam");
  await page.getByRole("button", { name: "Write a draft" }).click();

  await expect(page.getByLabel("Draft reply")).toHaveValue(/8am/, { timeout: 30_000 });
  await expect(page.getByText(/Draft ready/).first()).toBeVisible();
  await shot(page, "emails");
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText("Marked as sent.")).toBeVisible();
  await page.getByRole("link", { name: "Done" }).click();
  await expect(
    page.getByTestId("email-row").filter({ hasText: "Build-up question" }),
  ).toBeVisible();
});
