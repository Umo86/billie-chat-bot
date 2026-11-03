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

A job whose worker is stopped mid-way (a function's time limit) is taken
again when its lease runs out, but only while it has tries left; on its
last try it's failed instead, so it can't run for ever. Long jobs (the
knowledge check, one Claude call of up to a few minutes) only run where the
function has five minutes: the sweep, and the page that queued them. Never
straight after a chat message, whose function stops at 60 seconds.

## Event mailboxes: one per bot, drafts in Outlook, a post in Teams

Each event has its own Microsoft 365 mailbox and Teams channel, so both
belong to the event's bot (`bot_mailboxes`, `bots.teams_webhook_url`), not
to company settings. One app registration serves every mailbox; IT limits it
to the event mailboxes with Exchange RBAC for Applications, so Billie can't
open anyone else's mail. Only admins connect a mailbox or a Teams link,
because everyone on the team then sees that mailbox's emails in Billie.

- **Sync**: a Graph delta query per mailbox, every minute, a few mailboxes
  at a time. Billie drafts only mail that arrives after it starts reading
  (its first sync, or being switched back on), so connecting a mailbox
  doesn't draft its backlog. The delta query also returns old mail when
  something changes on it (read, flagged); anything older than a week, or
  from before Billie started, is left alone, so emails removed by
  retention never come back. Emails erased on a privacy request are
  remembered (`email_tombstones`, 30 days) so the sync never takes them in
  again. The sync point is saved after every page; one mailbox failing
  never stops the others, and its problem is saved in words for the
  screen. Auto-replies, bounces and meeting replies are skipped.
- **Drafting and delivery are two jobs.** `process_email` calls Claude and
  saves the reply; `deliver_email_draft` puts it in Outlook and tells the
  team. A Teams or Graph failure retries the delivery without paying for
  the drafting again.
- **One draft per text, and never someone else's work.** The email keeps
  the Outlook draft's id, its etag and a hash of the text it holds. A new
  text (after "Write it again") gets a new draft, recorded only if nothing
  changed meanwhile (else the spare is thrown away); Billie's old draft is
  then deleted with `If-Match` on the etag Billie saved, so a draft someone
  has edited, or sent, is never removed.
- **When Outlook refuses** (no write access, the email has gone) or on the
  last try, the reason is saved on the email and the mailbox, and the team
  is still told: the post says the reply is in Billie. "Check the mailbox"
  makes and removes a test draft, so it catches read-only access.
- **The draft is HTML.** Graph's `createReply` comment loses line breaks, so
  Billie makes an empty reply and writes its text (escaped, with `<br>`)
  above the quoted email. The sign-off is added in code, word for word,
  never left to Claude.
- **Teams posts** go to a Teams Workflows link. Only Microsoft's hosts are
  accepted (no requests elsewhere), redirects are refused, and the link is
  never shown or logged once saved. What visitors and senders wrote goes in
  plain text runs, not Markdown, so nobody can slip a link into a channel.
  The mailbox manager is @mentioned by their Billie email, which must be
  their Microsoft 365 address.
- **Deploys overlap.** Migrations run before a new version goes live, while
  the old one is still serving, so they only add; a column is dropped one
  release after the code stops using it (`settings.outlook_delta_link` is
  next). A job kind the running version doesn't know is retried, not
  failed, so the new version picks it up.
- **Logs and stored job errors** never carry query values (an email's
  text, a Teams link): `safeError()` leaves them out.

## Teams messages to people: one workflow, not a Teams app

Microsoft Graph doesn't let an app start a 1:1 Teams chat, and a Teams bot
needs an Azure Bot, a Teams app package and admin approval. One Power
Automate workflow does the job with the Teams connector that comes with
Microsoft 365: "When a Teams webhook request is received", then "Post card
in a chat or channel" to "Chat with Flow bot". Billie sends the person's
Microsoft 365 address and the card; the link is stored like the Teams
channel links (admins only, never shown again).

- **Who**: the mailbox manager when a reply is waiting (or an email needs a
  person); whoever is available when a visitor wants a person, or the
  event's mailbox manager when nobody is.
- **Once**: each message is its own `teams_direct` job, queued with `once`
  (a dedupe key that holds while the job is kept), so a retry of the job
  that queued it never messages someone twice.
- **Answering stays in Billie.** Answering visitors from inside Teams would
  need the Teams app; the message links to the chat in the Inbox instead.

## Personality is style only

Each bot's tone, personality (in the team's own words), emoji choice and
email sign-off go into its prompts as style. The prompt says the rules win,
answers still come only from the knowledge, and emails never get emoji.

## The weekly post goes to each event's own channel

The knowledge only improves if someone sees the questions Billie couldn't
answer, so every Monday each bot with its own Teams channel (live, or with
chats last week) gets a post: chats, the share answered alone, emails
drafted, the five most asked questions, new unanswered questions (each a
link straight to it on the Knowledge page) and hours saved. Hours saved is
an estimate and the card says how it's counted (4 minutes per chat Billie
answered alone, 8 per email it drafted), so nobody mistakes it for a
measurement. One job per bot, queued once per day, so a retry never posts
twice; the company-wide email summary is unchanged. Everything people wrote
goes in as plain text runs, never Markdown, as with the other Teams posts.

## Nudges count the bot's working hours, and go once

The bot promises people the team will come back to them, so a chat passed
to the team (waiting or with details left) or an email that needs a person
gets a Teams message when nobody has replied after N of the bot's own team
hours (Settings, default 4): to whoever has the chat, else the event
mailbox's manager, as long as they work on the bot. After the second number
(default 8) admins get one too. Hours are counted in the bot's team hours,
UK time, in 15-minute steps, so a Friday-evening handover isn't "late" on
Saturday. The job runs every 15 minutes and each message is queued once per
handover (keyed by it), so a handover back and forth can nudge again but a
rerun never repeats one. Drafts in Outlook aren't nudged: Billie can't yet
tell when one was sent.

## Suggested replies are written once, on the queue, and never sent

Handovers are the hard questions, so a starting draft saves the most time
there. When a chat is handed to the team, a "suggest_reply" job asks Claude
for a reply from the bot's knowledge (same rules as answers: only the
passages, today's date, no invented facts), or a holding reply when the
knowledge doesn't cover it. It's stored on the chat, so everyone who opens
it sees the same suggestion and it costs one call per handover, not one per
look. "Use this" only fills the reply box; a person always presses Send. A
newer message from the person marks it out of date, and "Suggest again"
writes a fresh one.

## Copying a bot copies its knowledge, not its show

Media10 runs the same shows every year, some in two cities, so most of a
bot carries over. A copy gets the look, personality, rules, requests, test
questions, people and every source with its passages (embeddings too, so
nothing is read or paid for twice; files share the stored file, which is
only deleted once no source uses it). The show's own settings stay behind:
websites, mailbox, Teams channel, test results and going live. Dates are
what changes, so the copy's Knowledge step lists every date in its
knowledge and its own words (a pure date finder, no Claude call) until
someone says they're checked.

## People work on bots; admins on all of them

Each event has its own staff, so each bot has its own people (`bot_members`),
chosen by an admin on the bot's People step, or when inviting someone.
Whoever makes a bot is put on it. What someone may do still comes from
their role (`MATRIX`); the bots they may do it on come from `bot_members`,
and both are checked in one place: `canOnBot()` in `lib/authz.ts`, with the
lookups in `lib/auth/bots.ts`. Admins work on every bot without a row.
Every list (Home, Inbox, Requests, Emails, Knowledge, Try a bot, Reports and
the nav counts) shows only the actor's bots, with a bot filter when they have
more than one; every action that takes a chat, request, email, knowledge
base, source or unanswered question checks the bot it belongs to. Something
with no bot (an old shared knowledge base, an email pasted with no bot) is
for admins only. Teams messages go only to people on the bot, a live
handover counts only people on the bot as available, and a mailbox manager
or request handler must be on the bot. Moving over (migration 0012), everyone
already on the team was put on every bot that existed, so nobody lost access.

## Each bot has its own knowledge, never shared

A bot is made with a knowledge base of its own, named after it
(`knowledge_bases.bot_id`, unique). Bots used to choose shared bases, but
then a change for one show could change another show's answers, and
nobody could tell from a bot what it knew. Now a bot's knowledge is
managed in its Knowledge step (the same view as on the Knowledge page),
unanswered questions and "Save an answer" in the Inbox go straight into
the asking bot's knowledge, and a bot's knowledge goes with the bot (its
files too, when the bin is emptied; a file another source still uses is
kept). Moving over (migration 0011), each bot took the least shared base
it answered from, and anything else it answered from was copied into it,
so no bot lost an answer. A base no bot used is listed apart ("Not used by
a bot") so it can be deleted. `bot_knowledge_bases` is kept in step for a
release (one row per bot) so a rollback still answers; nothing reads it.
A bot made by the old release while both were running gets its knowledge
base the first time it, or the Knowledge page, is opened.

## Knowledge is changed in place, never half-read

Pasted text and typed answers can be edited, and a piece of text can be
replaced across a bot's whole knowledge (when exhibitor questions move to a
new address, every section must change on the same day). Files and web
pages can't be changed by Billie: the preview lists them, to be changed at
the source and read again. Each change queues a read with a key of its own
for that version of the text, so it isn't blocked by a read of the old
text still running; and a read only writes its passages if the text it
read is still the text in the database (if not, it queues a fresh read of
the newest text). Bots keep answering from the old passages until the new
ones are written, in one transaction: search uses sources that are ready,
or waiting or reading again. The Edit dialog won't save over a change made
after it opened, and the history records that text was replaced, never the
text itself (it's often an email address or phone number, and the history
is kept for good).

## The knowledge check is one call, on demand

A bot repeats whatever its knowledge says, so two sections that disagree
become two answers to one question. The check sends a whole knowledge
base (up to about 160,000 characters, loaded source by source until it's
full; larger ones are checked in part, and the screen says how much) to
the thorough model with today's date, and gets back at most 20 problems:
contradictions, passed dates, mismatched contact details and unclear
wording, each with the exact words and the sources' labels (S1, S2…, so two
sources with one title can't be mixed up). Titles are quoted like the rest,
as a web page's title is written by the page. It runs on the job queue,
only when someone presses the button, and counts towards the daily cap.
Each try is bounded (100 seconds, no SDK retries, one try on the fallback
model) and a job has three tries, so a check can't keep costing money; one
still open after 15 minutes shows as not finished and can be run again.

## Requests from chat are forms, not free text

A bot can take the requests the team handles by email today (extra
build-up hours, a vehicle on a stand, rigging…). The team picks which on
the bot's Rules step, from ready-made ones or their own, with the
questions to ask. Claude only decides whether someone wants one (a request
id in its structured reply, checked against the bot's list); the details
come from a form the person fills in, so nothing is guessed or copied
wrong. Each request gets a reference (R-1001…), an owner (its own handler,
else whoever manages the event mailbox), a Teams message to that person, a
status and a message to the person. The person follows it on a page of its
own at /r/<token> (it shows what they sent and the team's message, never
their email or phone), and is emailed when it changes once email is set
up. Forms show on websites and the chat page, not WhatsApp. Files aren't
taken yet: uploads from a public chat need their own safe path (size and
type checks, private storage, clean-up), so people add a link for now.
Requests follow the chat retention period and the privacy tools.

A request can only be sent for a form Billie offered in that chat (the
offer is kept with Billie's answer, which also brings the form back when
the page reloads). The team's screen saves only what the person changed,
and never over a newer version someone else saved. Each change to the
status or the message is emailed as it was at that change; test chats
email nobody. Rate limits count complete forms only, per chat and
generously per address, as exhibitors at a venue share its Wi-Fi.

## Search: hybrid full-text + vectors

Postgres full-text (a generated `tsvector`) and Voyage embeddings (HNSW
index) are fused with reciprocal rank fusion. Small knowledge bases are
sent whole. Without a Voyage key, search falls back to full-text only.

## Answers only from the knowledge, with a person behind every bot

Claude gets the retrieved passages and must answer only from them, cite
them, and hand over when unsure, for "always a person" topics, or when
asked. Every handover lands in the Inbox; email drafts are never sent
automatically. A daily answer cap is a spending safety net.

Each question and each email to draft comes with today's date in the UK
("Today is Tuesday 3 November 2026 (UK time)."). Exhibitor knowledge is
full of deadlines and prices that change by date, and without the date
the bot could only say "if that date hasn't passed". The date goes in the
message, not the system part, so the cached rules and knowledge stay the
same all day.

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
