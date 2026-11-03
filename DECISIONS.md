# Decisions

Short records of the choices that shape Billie, newest first.

## Security review fixes (before the first deploy)

An independent review found these; all are fixed and tested.

- **First admin:** set-up also asks for the `CRON_SECRET` value, so only
  the person who deployed Billie can claim the first account, and the page
  no longer shows `FIRST_ADMIN_EMAIL`.
- **Session secret:** `NEON_AUTH_COOKIE_SECRET` is required and never
  derived from another secret (whoever holds it could sign in as anyone).
- **Chat frame:** every `/embed/…` request goes through the proxy; odd
  spellings (`/embed/uk%63w`) get a 404, and the page refuses requests the
  proxy didn't mark, so no path reaches a bot without its CSP.
- **Budget:** visitors get a daily limit per address (IPv6 counted by
  /64), WhatsApp senders an hourly and daily limit, and visitor answers stop
  at 85% of the daily cap so the team keeps the rest.
- **Web pages:** private addresses are refused in every IPv6 spelling
  (mapped, NAT64, 6to4…), checked again where the socket actually
  connected, and the whole fetch has a deadline.
- **WhatsApp:** each reply records the WhatsApp id it was sent as, so a
  retried job resends only what didn't go out.
- **Invitations:** a sender's open invitations stop working when they're
  suspended or no longer admin; password resets work for invited people
  (so a sign-in someone registered in advance can't lock them out).
- **Page addresses:** chats keep the page's address without its query
  string, which can hold private tokens.
- **Kept on purpose:** agents can download a transcript of a chat they
  can already read in the Inbox; bulk and per-person exports are admin-only.

## Sign-in: Neon Auth, with roles kept in Billie

Neon Auth (Neon's managed Better Auth) stores identities, passwords and
sessions in the `neon_auth` schema of our own database, so there's no
password handling in our code. Billie's `users` table keeps what someone may
do (admin, editor, agent; active or suspended), linked by `auth_user_id`.

- An account is linked only by the first-run set-up (restricted to
  `FIRST_ADMIN_EMAIL` on Vercel) or by a one-time invitation link (token
  stored as SHA-256). Signing up with Neon Auth directly gets nobody in.
- Sessions that started before an account was linked (`linked_at`, with a
  60-second clock allowance) are refused, so a sign-in made in advance by
  someone else can never become a way in.
- Suspension is checked on every request, so it takes effect immediately.
- All sign-in calls are server actions; Neon Auth's API isn't proxied
  through our domain because nothing in the browser needs it.
- The `user.before_create` webhook (`/api/webhooks/neon-auth`, Ed25519 JWS
  verified) keeps sign-ups invite-only at the source. It's optional: the
  team list already protects the app.
- Tests and offline work use an in-memory stand-in with the same behaviour
  (`BILLIE_LOCAL_AUTH=1`), refused on Vercel.
- Earlier, sign-in was self-hosted Better Auth; migration 0005 drops its
  tables (they never held data in production).

## Database driver: `pg` pool with `attachDatabasePool`

Neon's guidance for Vercel Fluid compute: node-postgres over TCP with a
small pool, registered so idle connections close before an instance
sleeps. Transactions and row locks (`FOR UPDATE`) work normally.

## Background work: a Postgres job queue

Reading files, drafting emails, alerts and WhatsApp replies run as jobs
(`FOR UPDATE SKIP LOCKED`, leases, retries with backoff, de-duplication).
Each request that queues work starts it straight after the response
(`after()`); Vercel Cron (Pro) sweeps every minute as a safety net and
checks the event mailboxes. No extra service to run or pay for.

## Event mailboxes: one per bot, drafts in Outlook, a post in Teams

Each event has its own Microsoft 365 mailbox and Teams channel, so both
belong to the event's bot (`bot_mailboxes`, `bots.teams_webhook_url`), not
to company settings. One app registration serves every mailbox; IT limits it
to the event mailboxes with Exchange RBAC for Applications, so Billie can't
open anyone else's mail. Only admins connect a mailbox or a Teams link,
because everyone on the team then sees that mailbox's emails in Billie.

- **Sync**: a Graph delta query per mailbox, every minute, a few mailboxes
  at a time. The first sync asks for the last two days only. The sync point
  is saved after every page, so a busy inbox is never re-read from the top.
  One mailbox failing (no access, wrong address) never stops the others;
  its problem is saved in words for the screen. Auto-replies, bounces and
  meeting replies are skipped, so a mailshot doesn't fill Drafts and Teams.
- **Drafting and delivery are two jobs.** `process_email` calls Claude and
  saves the reply; `deliver_email_draft` puts it in Outlook and posts to
  Teams. A Teams or Graph failure retries the delivery without paying for
  the drafting again, and the Outlook draft is made once (its id is saved).
- **The draft is HTML.** Graph's `createReply` comment loses line breaks, so
  Billie makes an empty reply and writes its text (escaped, with `<br>`)
  above the quoted email. "Write it again" replaces Billie's own draft, and
  only while it is still an unsent draft.
- **Teams posts** go to a Teams Workflows link. Only Microsoft's hosts are
  accepted (no requests elsewhere), redirects are refused, and the link is
  never shown or logged once saved. What visitors and senders wrote goes in
  plain text runs, not Markdown, so nobody can slip a link into a channel.
  The mailbox manager is @mentioned by their Billie email, which must be
  their Microsoft 365 address.
- **Migrations only add.** They run before a new version goes live, while
  the old one is still serving, so a column is dropped one release after
  the code stops using it (`settings.outlook_delta_link` is next).

## Personality is style only

Each bot's tone, personality (in the team's own words), emoji choice and
email sign-off go into its prompts as style. The prompt says the rules win,
answers still come only from the knowledge, and emails never get emoji.

## Search: hybrid full-text + vectors

Postgres full-text (a generated `tsvector`) and Voyage embeddings (HNSW
index) are fused with reciprocal rank fusion. Small knowledge bases are
sent whole. Without a Voyage key, search falls back to full-text only.

## Answers only from the knowledge, with a person behind every bot

Claude gets the retrieved passages and must answer only from them, cite
them, and hand over when unsure, for "always a person" topics, or when
asked. Every handover lands in the Inbox; email drafts are never sent
automatically. A daily answer cap is a spending safety net.

## Chats belong to whoever holds the token

Visitors are anonymous. A chat's random token lives in the visitor's
browser; the database stores only its SHA-256. No cookies for visitors.
Draft bots answer only signed-in staff (the Try page).

## The widget only works on the bot's own websites

`widget.js` asks for the bot's settings with the page's origin, and the
chat frame's `frame-ancestors` lists only the bot's allowed websites, so
copied embed code doesn't work elsewhere.

## Single company, single settings row

Billie serves one company (Media10). There's no tenant column; settings are
one row. Adding tenants later means a `company_id` on bots, knowledge and
users.
