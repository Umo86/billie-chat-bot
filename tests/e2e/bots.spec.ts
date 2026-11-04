import path from "node:path";
import { expect, test } from "@playwright/test";
import { shot, signInAsAdmin } from "./helpers";
import { signToken } from "../../lib/exhibitors/blueprint-rules";

/**
 * A bot and its own knowledge: the bot's steps (look, personality, its
 * knowledge with a typed answer and a file, rules, email and Teams, test)
 * through to a passing test run and going live.
 */
test.describe.configure({ mode: "serial" });

/** The exhibitor bot's BluePrint key, shown once when it's made (first test), as BluePrint keeps it. */
let blueprintKey = "";

test("build a bot with its own knowledge, test it and put it live", async ({ page }) => {
  await signInAsAdmin(page);

  // Step 1: look.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "New bot" }).first().click();
  await expect(page.getByText(/^Eight short steps/)).toBeVisible();
  await page.getByLabel("Bot name").fill("Exhibitor Help");
  await page.getByLabel("Show name").fill("UK Construction Week 2027");
  await page.getByLabel("First day of build-up").fill("2027-03-08");
  await page.getByLabel("Last day of breakdown").fill("2027-03-12");
  // Its own questions on the website's exhibit pages (the widget test checks them).
  await page.getByRole("button", { name: "Add starters for a page" }).click();
  await page.getByLabel("The page address contains").fill("/exhibit");
  await page.getByLabel("Page 1, starter question 1").fill("Where do we unload?");
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

  // Step 3: its own knowledge, starting empty: a typed answer and a CSV file.
  await expect(page.getByRole("heading", { name: "What it knows" })).toBeVisible();
  await expect(page.getByText("Nothing in here yet")).toBeVisible();
  await page.getByRole("tab", { name: "Typed answer" }).click();
  await page.getByLabel("Question").fill("When does build-up start?");
  await page
    .getByLabel("Answer", { exact: true })
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
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 4 (exhibitor bots only): the exhibitor list, and answers about their own stand.
  const list = page.getByTestId("exhibitor-list");
  await expect(list.getByRole("heading", { name: "Exhibitor list" })).toBeVisible();
  await expect(list.getByText("No list yet.")).toBeVisible();
  await page
    .locator("#exhibitor-file")
    .setInputFiles(path.join(__dirname, "..", "fixtures", "exhibitors.csv"));
  await list.getByRole("button", { name: "Upload list" }).click();
  await expect(
    page.getByText("Uploaded 3 exhibitors. 1 row without an email address left out."),
  ).toBeVisible();
  await expect(list).toContainText(
    "exhibitors.csv: 3 exhibitors, uploaded just now by Umit Bozdag.",
  );
  await expect(list.getByRole("cell", { name: "Acme Displays Ltd" })).toBeVisible();
  await expect(list.getByRole("cell", { name: "jo@bolt-co.test, ops@bolt-co.test" })).toBeVisible();
  // Signing in needs email sending for the codes, which isn't set up in tests.
  const personal = page.getByTestId("personal-answers");
  await personal.getByRole("switch", { name: "Answers about their own stand" }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await expect(personal).toContainText("Not yet");
  await expect(personal).toContainText("Signing in needs email sending set up");
  // Columns only for the team can be kept from Billie.
  const columns = list.getByTestId("list-columns");
  await expect(columns.getByRole("checkbox", { name: "Stand plan approved" })).toBeChecked();
  await columns.getByRole("checkbox", { name: "Electrics ordered" }).uncheck();
  await expect(page.getByText("Saved.", { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await columns.getByRole("button", { name: "Save columns" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(columns.getByRole("checkbox", { name: "Electrics ordered" })).not.toBeChecked();
  await expect(columns.getByRole("checkbox", { name: "Stand type" })).toBeChecked();
  // BluePrint, the exhibitor manual: an admin connects it, and its key is shown once.
  const blueprint = page.getByTestId("blueprint");
  await expect(blueprint).toContainText("For whoever sets up BluePrint");
  await blueprint.getByRole("button", { name: "Connect BluePrint" }).click();
  const key = blueprint.locator("#blueprint-key");
  await expect(key).toHaveText(/^bp_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
  blueprintKey = (await key.textContent())!.trim();
  await expect(blueprint.getByTestId("blueprint-status")).toContainText("Connected");
  await expect(blueprint).toContainText("BluePrint hasn't sent the exhibitor list yet.");
  // Signed in from the manual, exhibitors need no code: so no email sending either.
  await expect(personal).toContainText("Exhibitors are signed in from the exhibitor manual.");
  await shot(page, "bot-exhibitors");
  await blueprint.getByRole("button", { name: "I've copied it" }).click();
  await expect(key).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("blueprint")).not.toContainText(blueprintKey.slice(16));
  // Removing the list asks first, on the page.
  await list.getByRole("button", { name: "Remove list" }).click();
  await expect(list.getByText(/Remove the list\?/)).toBeVisible();
  await list.getByRole("button", { name: "Keep it" }).click();
  await expect(list.getByRole("cell", { name: "Acme Displays Ltd" })).toBeVisible();
  // Deadlines: Billie drafts reminders, and a person checks them before anything is sent.
  const panel = page.getByTestId("deadlines");
  await panel.getByRole("button", { name: "Add a deadline" }).click();
  await panel.getByLabel("What's due").fill("Stand plan");
  await panel.getByLabel("Due date").fill("2027-02-14");
  await panel.getByLabel("Which column shows who has done it?").selectOption("Stand plan approved");
  // Billie guesses that "Yes" means done, and says who that leaves.
  await expect(panel.getByRole("checkbox", { name: /^Yes/ })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: /^No/ })).not.toBeChecked();
  await expect(panel).toContainText("With these answers, 2 exhibitors haven't done it.");
  await panel.getByRole("button", { name: "Add deadline" }).click();
  await expect(page.getByText("Deadline saved.")).toBeVisible();
  const deadline = panel.getByTestId("deadline").filter({ hasText: "Stand plan" });
  await expect(deadline).toContainText("2 exhibitors haven't done it yet (of 3).");
  await expect(deadline).toContainText("Billie drafts reminders 7 days before");
  await shot(page, "deadlines");
  await deadline.getByRole("button", { name: "Draft reminders now" }).click();

  // Billie writes it on the job queue; the page updates by itself.
  await expect(page.getByRole("heading", { name: "Reminders: Stand plan" })).toBeVisible();
  const preview = page.getByTestId("reminder-preview");
  await expect(preview).toContainText("Hi Sam,", { timeout: 30_000 });
  await expect(preview).toContainText("Acme Displays Ltd (stand B12)");
  await expect(preview).toContainText("sam@acme-displays.test");
  const recipients = page.getByTestId("reminder-recipients");
  await expect(recipients).toContainText("Northwind Stands");
  await expect(recipients).not.toContainText("Bolt & Co");
  // Email sending isn't set up in tests, so nothing can be sent.
  await expect(page.getByText(/Email sending isn't set up yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send 2 reminders" })).toBeDisabled();
  await recipients.getByRole("checkbox", { name: "Send to Northwind Stands, stand D7" }).uncheck();
  await expect(page.getByRole("button", { name: "Send 1 reminder" })).toBeVisible();
  // A placeholder Billie can't fill in is flagged before anything goes.
  const body = page.getByLabel("Email", { exact: true });
  await body.fill(`${await body.inputValue()}\n\nSee {portal_link}.`);
  await expect(page.getByText(/Billie can't fill in \{portal_link\}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await shot(page, "reminders-review");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Discarded.").first()).toBeVisible();
  await expect(
    page
      .getByTestId("deadline")
      .filter({ hasText: "Stand plan" })
      .getByText("Discarded", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Continue to Rules" }).click();

  // Step 5: rules. A new bot's team works Mon–Fri, 9 to 5; this one has no hours yet (tests run
  // at any time of day), so asking for a person takes details until the live chat test below.
  await expect(page.getByRole("heading", { name: "Always pass these to a person" })).toBeVisible();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("17:00");
  const days = page.getByRole("group", { name: "Days" });
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"])
    await days.getByRole("button", { name: day }).click();
  await expect(days.getByRole("button", { pressed: true })).toHaveCount(0);
  await shot(page, "bot-rules");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 6: people. Priya (an agent) works on this bot; admins are on every bot.
  const people = page.getByTestId("people-step");
  await expect(people.getByRole("heading", { name: "Who works on Exhibitor Help" })).toBeVisible();
  await expect(people).toContainText("Always on it, as admins: Umit Bozdag.");
  const priya = people.getByRole("checkbox", { name: "Priya Shah" });
  await expect(priya).not.toBeChecked();
  await priya.check();
  // The Rules step's "Saved." can still be showing: wait for it to go, then for this one.
  const saved = page.getByText("Saved.", { exact: true });
  await expect(saved).toHaveCount(0, { timeout: 10_000 });
  await people.getByRole("button", { name: "Save people" }).click();
  await expect(saved.first()).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId("people-step").getByRole("checkbox", { name: "Priya Shah" }),
  ).toBeChecked();
  // Who handles what: electrics questions go to Priya first.
  const routes = page.getByTestId("routes");
  await routes.getByRole("button", { name: "Add a topic" }).click();
  await routes.getByLabel("Topic", { exact: true }).fill("Electrics");
  await routes.getByLabel("Words that mean it").fill("electric, power, socket");
  await routes.getByRole("button", { name: "Save who handles what" }).click();
  await expect(routes).toContainText("Topic 1: Choose who it goes to.");
  await routes.getByLabel("Goes to").selectOption({ label: "Priya Shah" });
  await expect(saved).toHaveCount(0, { timeout: 10_000 });
  await routes.getByRole("button", { name: "Save who handles what" }).click();
  await expect(saved.first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("routes").getByLabel("Words that mean it")).toHaveValue(
    "electric, power, socket",
  );
  await expect(page.getByTestId("routes").getByLabel("Goes to")).toHaveValue(/.+/);
  await shot(page, "bot-people");
  await page.getByRole("link", { name: "Continue to Email" }).click();

  // Step 7: the event's mailbox and Teams channel (Microsoft 365 isn't connected in tests).
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

  // Step 8: test.
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

  // Step 9: go live.
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

  // The show days from step 1 were kept; the last day can't be before the first.
  await page.getByRole("navigation", { name: "Steps" }).getByRole("link", { name: /Look/ }).click();
  await expect(page.getByLabel("First day of build-up")).toHaveValue("2027-03-08");
  await expect(page.getByLabel("Last day of breakdown")).toHaveValue("2027-03-12");
  await page.getByLabel("Last day of breakdown").fill("2027-03-01");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("The last day can't be before the first.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Last day of breakdown")).toHaveValue("2027-03-12");
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

  // Outside the team's hours (this bot has none yet), asking for a person collects details:
  // for an exhibitor bot, their name, email and stand.
  await page.getByLabel("Your message").fill("Can I get a refund on my stand?");
  await page.getByRole("button", { name: "Send" }).click();
  const form = page.getByRole("form", { name: "Leave your details" });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel("Name").fill("Priya Shah");
  await form.getByLabel("Email").fill("priya@acme"); // the browser accepts this; Billie asks again
  await form.getByLabel("Stand number").fill("B12");
  await expect(form.getByLabel(/Company/)).toHaveCount(0);
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

  // BluePrint, the exhibitor manual, sends the exhibitor list with the bot's key.
  const api = "/api/public/blueprint/exhibitors";
  const list = {
    exhibitors: [
      {
        id: "acme",
        company: "Acme Displays Ltd",
        stand: "B12",
        name: "Sam Patel",
        emails: ["sam@acme-displays.test"],
        fields: {
          "Stand type": "Shell scheme",
          "Stand plan approved": false,
          "Electrics ordered": true,
        },
      },
      {
        id: "bolt",
        company: "Bolt & Co",
        stand: "C4",
        name: "Jo Bloggs",
        emails: ["jo@bolt-co.test", "ops@bolt-co.test"],
        fields: {
          "Stand type": "Space only",
          "Stand plan approved": true,
          "Electrics ordered": false,
        },
      },
      {
        id: "northwind",
        company: "Northwind Stands",
        stand: "D7",
        name: "Alex Kim",
        emails: ["alex@northwind-stands.test"],
        fields: { "Stand type": "Space only", "Stand plan approved": false },
      },
      { id: "contoso", company: "Contoso Build", stand: "A1", emails: [] },
    ],
  };
  const wrong = await visitor.request.post(api, {
    headers: { Authorization: `Bearer ${blueprintKey.slice(0, -4)}xxxx` },
    data: list,
  });
  expect(wrong.status()).toBe(401);
  const sent = await visitor.request.post(api, {
    headers: { Authorization: `Bearer ${blueprintKey}` },
    data: list,
  });
  expect(await sent.json()).toEqual({
    exhibitors: 3,
    added: 3,
    updated: 0,
    removed: 3,
    skipped: 1,
  });
  const check = await visitor.request.get(api, {
    headers: { Authorization: `Bearer ${blueprintKey}` },
  });
  expect(await check.json()).toMatchObject({
    bot: "Exhibitor Help",
    exhibitors: 3,
    from: "blueprint",
  });

  // Sam, signed in to the manual, opens the chat on this laptop: it opens signed in as Sam,
  // with a chat of their own (Priya's stays hers), and the sign-in leaves the address.
  const signIn = (email: string) =>
    `/c/exhibitor-help#exhibitor-token=${signToken(blueprintKey, email)}`;
  await page.goto("about:blank"); // a new page load, not a jump within this one
  await page.goto(signIn("sam@acme-displays.test"));
  await expect(page.getByRole("button", { name: "Stand B12" })).toBeVisible();
  await expect(page).toHaveURL(/\/c\/exhibitor-help$/);
  await expect(page.getByText(/Thanks, Priya/)).toHaveCount(0);
  await page.getByLabel("Your message").fill("Has our stand plan been approved?");
  await page.getByLabel("Your message").press("Enter");
  await expect(page.getByText(/Stand plan approved: No/).first()).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(
    page.getByText(/Signed in from the exhibitor manual as Sam Patel, Acme Displays Ltd/),
  ).toBeVisible();
  await shot(page, "chat-signed-in-from-manual");
  // Next on the same laptop, someone the manual vouches for but who isn't on the list yet:
  // told why, and never shown Sam's chat.
  await page.goto("about:blank");
  await page.goto(signIn("stranger@nowhere.test"));
  await expect(page.getByText(/can't find your email on this show's exhibitor list/)).toBeVisible();
  await expect(page.getByText(/Stand plan approved/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stand B12" })).toHaveCount(0);
  // Jo, next, gets a chat of their own too.
  await page.goto("about:blank");
  await page.goto(signIn("jo@bolt-co.test"));
  await expect(page.getByRole("button", { name: "Stand C4" })).toBeVisible();
  await expect(page.getByText(/Stand plan approved/)).toHaveCount(0);
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
  // On the exhibit page: that page's starter question.
  await expect(chat.getByLabel("Suggested questions").getByRole("button")).toHaveText([
    "Where do we unload?",
  ]);
  await chat.getByLabel("Your message").fill("When does build-up start?");
  await chat.getByLabel("Your message").press("Enter");
  await expect(chat.getByText(/Monday 8 March at 8am/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "widget-open");
  // This visitor didn't find it helpful: the team sees it on the Knowledge page (knowledge.spec).
  await chat.getByRole("button", { name: "Not helpful", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Not helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await chat.getByRole("button", { name: "Close chat" }).click();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // An encoded address can't reach the chat frame without its policy.
  const sneaky = await visitor.request.get(`${app}/embed/exhibitor%2Dhelp`);
  expect(sneaky.status()).toBe(404);
  const direct = await visitor.request.get(`${app}/embed/exhibitor-help`);
  expect(direct.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self' https://ukconstructionweek.com https://*.ukconstructionweek.com",
  );

  // On the exhibitor manual (a page of the show's own site), the chat opens signed in.
  await visitor.route("https://manual.ukconstructionweek.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: hostPage("").replace(
        'data-bot="exhibitor-help"',
        `data-bot="exhibitor-help" data-exhibitor-token="${signToken(blueprintKey, "alex@northwind-stands.test")}"`,
      ),
    }),
  );
  const manual = await visitor.newPage();
  await manual.goto("https://manual.ukconstructionweek.com/my-stand");
  await manual.getByRole("button", { name: "Chat with Exhibitor Help" }).click();
  const signedIn = manual.frameLocator('iframe[title="Chat with Exhibitor Help"]');
  await expect(signedIn.getByRole("button", { name: "Stand D7" })).toBeVisible({ timeout: 15_000 });
  await manual.close();

  // Copied onto another website, the button doesn't appear.
  const other = await visitor.newPage();
  await other.goto("https://copycat.example/");
  await other.waitForTimeout(2500);
  await expect(other.getByRole("button", { name: "Chat with Exhibitor Help" })).toHaveCount(0);
  await visitor.close();
});

test("live handover: the team replies from the Inbox and hands back", async ({ page, browser }) => {
  await signInAsAdmin(page);
  // In the team's hours, a chat that needs a person goes to them live: here, every day.
  await page.goto("/");
  await page
    .getByTestId("bot-card")
    .filter({ hasText: "Exhibitor Help" })
    .getByRole("link", { name: "Edit" })
    .click();
  await page
    .getByRole("navigation", { name: "Steps" })
    .getByRole("link", { name: /Rules/ })
    .click();
  const days = page.getByRole("group", { name: "Days" });
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    await days.getByRole("button", { name: day }).click();
  await expect(days.getByRole("button", { pressed: true })).toHaveCount(7);
  await page.getByLabel("From", { exact: true }).fill("00:00");
  await page.getByLabel("To", { exact: true }).fill("23:59");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByTestId("people-step")).toBeVisible();
  await page.goto("/inbox");
  // Without Slack or Teams messages there's nothing to switch on: hours decide.
  await expect(page.getByRole("switch", { name: /live chats/ })).toHaveCount(0);

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
  // Billie suggests a reply from the knowledge: a holding reply here, as nothing in it covers this.
  const suggestion = page.getByTestId("suggestion");
  await expect(suggestion).toContainText("Billie suggests a holding reply", { timeout: 15_000 });
  await suggestion.getByRole("button", { name: "Use this" }).click();
  await expect(page.getByLabel("Reply")).toHaveValue(/checking this now/);
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
  // They've written since: ask for a new suggestion.
  await expect(page.getByTestId("suggestion")).toContainText("They've written since");
  await page.getByTestId("suggestion").getByRole("button", { name: "Suggest again" }).click();
  await expect(page.getByTestId("suggestion")).not.toContainText("They've written since", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("suggestion")).toContainText("Billie suggests");
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
