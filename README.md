# Billie

Chatbots, live handover and an email assistant for Media10 shows.

- **Bots** for visitors and exhibitors, each answering only from its own
  knowledge (exhibitor manual, price lists, FAQs, web pages, typed answers),
  with sources under every answer.
- **A chat widget** for the show websites (one line of code), a chat page
  with a QR code, and **WhatsApp**.
- **Live handover** to the team: the Inbox, availability, contact details
  when nobody's free, replies by chat, WhatsApp or email.
- **Exhibitor emails** get a draft reply from the knowledge base that a
  person checks before sending (pasted, or straight from the Outlook mailbox).
- **Knowledge gaps**: questions the bots couldn't answer, fixed in one click.
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
   - Optional: Resend, Outlook (Microsoft Graph), WhatsApp and Teams; see
     `.env.example`.
4. In Neon Auth, add the site's address as a trusted domain (Auth →
   Configuration → Domains). Optionally add the sign-up check webhook
   (`/api/webhooks/neon-auth`, event `user.before_create`) so only invited
   people can create a sign-in at all.
5. Scheduled work runs on Vercel Cron (`vercel.json`, Vercel Pro): every
   minute it checks the Outlook mailbox and retries failed jobs; once a day
   it runs retention, re-reads web pages and sends Monday's summary. Most
   work doesn't wait for either: it starts straight after the request that
   asked for it.
6. Open the site and create the first admin. The set-up page asks for a
   set-up code: the `CRON_SECRET` value, so only whoever deployed Billie can
   claim the first account. Then invite the team from Settings.

Settings → Connections shows what's connected and the webhook addresses to
paste into Meta (WhatsApp) and Neon.

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
