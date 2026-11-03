# Billie

Chatbots, live handover and an email assistant for Media10 shows.

- **Bots** for visitors and exhibitors, each answering only from its own
  knowledge (exhibitor manual, price lists, FAQs, web pages, typed answers),
  with sources under every answer. Bots never share knowledge: each bot's is
  managed in its Knowledge step, or on the Knowledge page.
- **A chat widget** for the show websites (one line of code), a chat page
  with a QR code, and **WhatsApp**.
- **Live handover** to the team: the Inbox, availability, contact details
  when nobody's free, replies by chat, WhatsApp or email.
- **Each bot has its own** look, personality (tone, a description in your
  own words, emoji, email sign-off), knowledge and rules.
- **Event mailboxes**: each bot can have its event's Microsoft 365 mailbox.
  New emails get a reply from that bot's knowledge, saved in the mailbox's
  Drafts in the same thread, and a post in the event's Teams channel that
  @mentions whoever manages the mailbox. A person checks and sends every
  reply. Emails can also be pasted in.
- **Teams messages to people**: the mailbox manager when a reply is waiting
  in Drafts, and whoever is available when a visitor wants a person, get a
  Teams chat with an "Open in Billie" button (one company-wide workflow, set
  up in Settings → Connections).
- **Requests from chat**: a bot can take requests such as extra build-up
  hours as a short form in the chat. Each gets a reference (R-1001) and an
  owner, shows on the Requests page with a Teams message to whoever handles
  it, and the person follows it on a page of its own (and by email once
  email is set up).
- **Knowledge gaps**: questions the bots couldn't answer, fixed in one click
  (the answer goes into the knowledge of the bot that was asked).
- **Knowledge you can change in place**: edit pasted text and typed answers,
  and find and replace across a bot's knowledge (a new email address, say),
  with every change shown before it's made.
- **Knowledge check**: one button and Claude reads all of a bot's knowledge,
  listing contradictions, dates that have passed and contact details that
  don't match, with Edit next to each pasted text or typed answer involved.
- **Learning from what the team sends**: when a draft in Outlook is sent,
  Billie counts it as sent unchanged or changed (Reports shows the share
  sent unchanged), and a fact the team corrected is offered on the
  Knowledge page as a typed answer to save.
- **A Monday post in each event's Teams channel**: last week's chats, the
  share Billie answered alone, emails drafted, the most asked questions,
  new questions it couldn't answer (each a link to answer it) and an
  estimate of the hours saved.
- **Nudges**: a chat passed to the team, or an email that needs a person,
  with no reply after 4 of the bot's working hours gets a Teams message to
  whoever handles it; after 8, admins get one too (Settings → General).
- **Suggested replies in the Inbox**: when a chat is handed to the team,
  Billie drafts a reply from the bot's knowledge (or a holding reply when
  it isn't covered) for the person to use, edit and send.
- **Copy a bot for the next show**: the look, personality, rules, requests,
  test questions, people and all the knowledge come across to a draft, with
  every date in it listed to check.
- **Answers about their own stand**: an exhibitor bot can have the
  exhibitor list (a spreadsheet uploaded on its Exhibitors step). Exhibitors
  tap "Your stand" in the chat, get a six-digit code at the email they
  booked with, and Billie then answers from their own row: their stand,
  orders, stand plan and build-up times. The Inbox shows who is signed in.
  Needs email sending (Resend).
- **Deadline chasers**: on the Exhibitors step, each deadline (stand
  plan, nameboard, electrics) is tied to a column of the exhibitor list
  that shows who has done it. A week before (or when asked), Billie writes
  one reminder from the bot's knowledge for everyone who hasn't, and tells
  whoever set it up in Teams. A person checks the email and who it goes to,
  then sends them all at once (replies go to the event mailbox). Needs
  email sending (Resend).
- **People on each bot**: admins choose who works on each bot. Editors run
  their bots; agents answer their bots' Inbox, requests and emails. Each
  person sees only their bots, with a filter for one bot's Inbox.
- **AI usage and models** (Settings → AI, admins): Claude's tokens and
  cost (Claude credits are US dollars) for today, the last 7 days, this
  month or last month, by model, by what it was for and by day. Costs are
  worked out for each request from Anthropic's list prices. Admins choose
  the model for Fast and Thorough work (Claude Haiku 5.5, Sonnet 5.5 or
  Opus 5.5).
- **Saving tokens** (Settings → AI, both on by default): Thorough bots try
  the Fast model first and ask the Thorough one only when it isn't sure,
  and a first question asked again the same day, with the knowledge
  unchanged, gets the same answer again without asking Claude.
- **Roles** (admin, editor, agent), an audit log, UK GDPR retention.

## How it's built

| Part            | Choice                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| App             | Next.js 16 (App Router, server actions), React 19, TypeScript, Tailwind 4     |
| Database        | Neon Postgres + pgvector, Drizzle ORM, `pg` pool (Neon's guidance for Vercel) |
| Sign-in         | Neon Auth (managed Better Auth); roles and suspensions in Billie              |
| AI              | Claude (Anthropic API), structured outputs, prompt caching, fallback model    |
| Search          | Hybrid: Postgres full-text + Voyage embeddings (HNSW), fused with RRF         |
| Background work | A job queue in Postgres, run straight after each request and by Vercel Cron   |
| Files           | Vercel Blob (private)                                                         |
| Channels        | WhatsApp Cloud API, Microsoft Graph (Outlook), Teams Workflows, Resend        |
| Hosting         | Vercel, London region (`lhr1`)                                                |

## Run it on your computer

Needs Node 22, pnpm 10 and Postgres 16+ with the `vector` extension.

```bash
pnpm install
cp .env.example .env      # then fill in DATABASE_URL and friends
pnpm db:migrate
pnpm dev                  # http://localhost:3000
```

Without API keys, set `AI_PROVIDER=fake`, `EMBEDDINGS_PROVIDER=fake` and
`BILLIE_LOCAL_AUTH=1` to use the built-in stand-ins (they're refused on
Vercel). For real sign-in locally, point `NEON_AUTH_BASE_URL` at a Neon
branch's Auth URL.

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test                 # unit + database tests (needs TEST_DATABASE_URL; it's wiped)
pnpm build && pnpm test:e2e   # browser tests against the production build (E2E_DATABASE_URL; wiped)
```

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`).

## Deploy (Vercel + Neon)

1. Import the GitHub repo into Vercel. Region and cron jobs come from `vercel.json`.
2. Connect Neon to the Vercel project (Vercel → Integrations → Neon) so
   `DATABASE_URL` and the unpooled URL are set. Migrations run on every
   deploy (`vercel-build`).
3. Add environment variables (Settings → Environment Variables):
   - `NEON_AUTH_BASE_URL`: Neon Console → Auth → Configuration.
   - `NEON_AUTH_COOKIE_SECRET`: 32+ random characters; signs session cookies.
   - `CRON_SECRET`: another long random value (`openssl rand -base64 32`).
   - `FIRST_ADMIN_EMAIL`: who may create the first admin account.
   - `ANTHROPIC_API_KEY`, and optionally `VOYAGE_API_KEY`.
   - Add **Vercel Blob** storage to the project for file uploads.
   - Optional: Resend, Microsoft 365 (event mailboxes), WhatsApp and Teams;
     see `.env.example`. Settings → Connections has the IT steps for
     Microsoft 365: one app registration, limited to the event mailboxes
     with RBAC for Applications.
4. In Neon Auth, add the site's address as a trusted domain (Auth →
   Configuration → Domains). Optionally add the sign-up check webhook
   (`/api/webhooks/neon-auth`, event `user.before_create`) so only invited
   people can create a sign-in at all.
5. Scheduled work runs on Vercel Cron (`vercel.json`, Vercel Pro): every
   minute it checks the event mailboxes and retries failed jobs; once a day
   it runs retention, re-reads web pages and sends Monday's summary. Most
   work doesn't wait for either: it starts straight after the request that
   asked for it.
6. Open the site and create the first admin. The set-up page asks for a
   set-up code: the `CRON_SECRET` value, so only whoever deployed Billie can
   claim the first account. Then invite the team from Settings.

Settings → Connections shows what's connected, every event mailbox and its
status, and the webhook addresses to paste into Meta (WhatsApp) and Neon.
Each bot's mailbox, manager and Teams channel are set on its Email step
(admins only).

## Folders

```
app/            pages, server actions, API routes (public chat, webhooks, cron)
components/     UI (ui/ is the shared kit)
lib/            everything else: ai, auth, bots, chat, conversations, db,
                emails, jobs, knowledge, reports, team…
tests/          unit/ (Vitest), e2e/ (Playwright), fixtures/
prototype/      the original clickable prototype (not part of the app)
```

`DECISIONS.md` explains the main choices; `CLAUDE.md` has the conventions
for anyone (or any AI assistant) changing the code.
