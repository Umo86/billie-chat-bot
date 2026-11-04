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

## Starter questions follow the page, worked out where the chat opens

A bot can have rules on its Look step: "the page address contains …" with
up to three questions, at most ten rules, first match wins, and a rule
with no questions shows none on those pages. The chat frame already gets
the page it's on (`?page=`, its address without the query string), so the
embed page picks the starters before it renders, and the rules never go
to the browser. The hosted chat page isn't on the website, so it gets the
usual starters. Copies keep the rules: the website usually stays.

## Personality is style only

Each bot's tone, personality (in the team's own words), emoji choice and
email sign-off go into its prompts as style. The prompt says the rules win,
answers still come only from the knowledge, and emails never get emoji.

## Cheapest first: the Fast model, then the Thorough one; answers given again

Haiku 5.5 costs a twentieth of Sonnet 5.5, and most show questions are
look-ups it answers as well. So a Thorough bot's chat answer (and the
team's suggested reply) is asked of the Fast model first, and of the
Thorough model only when the Fast one says it isn't sure, can't answer,
replies in the wrong shape or is busy. A question nobody can answer costs
both calls, which at Haiku's price adds a twentieth. Email drafts always
use the Thorough model: they're long, read by a person, and fewer. A
switch in Settings → AI turns this off.

At shows many people ask the same first question. The same first
question (case, punctuation, greetings and thanks ignored), to the same
bot, with the same knowledge and settings (a stamp of the bot's and its
sources' and passages' times and counts), on the same UK day and channel,
gets the answer Claude gave before, at no cost. Only confident answers that
didn't need a person; never a follow-up (it depends on the chat), a test,
a signed-in exhibitor, or a question with an email address or phone
number; and an answer marked unhelpful is forgotten. Kept for their day
only. Settings → AI shows how many were given again and what that saved.

Only plain questions are kept: letters, digits, spaces and a little
everyday punctuation. The key ignores case and punctuation, so a question
that carried extra words the key can't see (invisible Unicode tag
characters, letter emoji, Morse in dots and dashes) could otherwise let one
person's wording decide the answer everyone else gets that day. Invisible
characters are taken out of everything that reaches Claude anyway
(`stripInvisible`). And an answer is only kept if every web address, email
address and phone number in it is in the passages it came from.

Each question also sends less: the last three exchanges of the chat (not
four), each cut at 800 characters.

## Claude's cost is counted per request, and the models are a setting

Each Claude call is costed when it's made, from the price list in
`lib/ai/pricing.ts` (checked against Anthropic's pricing page; change it
there when prices change), and stored in millionths of a dollar in
`ai_usage` by day, use and model. Per call, because Haiku 5.5 costs more
for prompts over 100,000 tokens and cache writes, cache reads and fresh
input are priced differently; stored, so a later price change never
rewrites the past. `usage_daily` stays as it was for the daily cap, and so
the version still serving during a deploy keeps working. Use from before
models were recorded was copied across with its tokens and no cost.

Not from Anthropic's Usage and Cost API: it needs an Admin key
(`sk-ant-admin…`), and it reports the whole Claude account, which may be
shared with other apps. The page says the Claude Console has the bill.

Admins choose the Fast and Thorough models in Settings → AI; that wins over
`ANTHROPIC_MODEL_FAST` / `ANTHROPIC_MODEL_SMART`, which win over the
defaults (Haiku 5.5, Sonnet 5.5). Only models with a known price can be
chosen, so every cost is known. The backup is the other model; if both are
the same, a different default, so there's always one. Claude Fable 5.1
isn't offered: it always thinks before answering (billed as output, so
Billie's short answer limits would cut replies off), it costs five times
Sonnet, and it needs 30-day data retention on the account.

## A monthly budget, with the stop optional

The daily answer cap counts answers, which keeps a flood of messages from
running up a bill, but a show team budgets in money by the month. So
admins can set a monthly budget in US dollars (as Anthropic bills), counted
from `ai_usage` costs for the UK calendar month. Every 15 minutes a job
compares the month's spend with it, and admins get a Teams message as it
passes 80% and 100%: once each, keyed on the month and the budget, so
raising the budget sets them up again, and past 100% only that message
goes. The stop is a separate switch, off by default: at a show, an answer
that costs a fraction of a penny is usually worth more than the budget
line. With it on, once the budget is used up every Claude call refuses
(the same path as the daily cap): chats offer the team, email drafts,
suggested replies, checks and reminders wait and say why, and answers
given again carry on because they cost nothing.

## Exhibitors sign in with a code, and only ever see their own row

Personal answers come from the team's own exhibitor list, uploaded on the
bot's Exhibitors step (Excel or CSV, replaced whole by each upload). It's
read inline rather than on the queue because it's small (4 MB, 5,000 rows)
and whoever uploads it needs to see at once which columns Billie found. The
Email column is required; Company, Stand and Contact are found by their
headings and every other column is kept as it is.

To sign in, an exhibitor types the email they booked with. The chat always
says the same thing ("if that email is on the list, we've sent a code"),
and the look-up, the code and the email all happen after the response, so
neither the words, the timing nor a failed send tells anyone who is on the
list. An address that isn't listed gets a code row too (one nobody is ever
sent), and every way a code can fail says the same ("That code didn't
work"), so typing a code can't tell either. Codes are six digits, kept only
as a hash tied to that chat, last ten minutes, work once and allow five
tries (counted outside the transaction that rejects them, so a wrong try
can't be rolled back). Asking for codes is limited per chat, per visitor
address, and per email address (5 an hour, 10 a day, listed or not), which
stops anyone flooding an exhibitor's inbox and keeps guessing hopeless.

A signed-in chat is linked to the exhibitor's row and to the address the
code went to: a row can list several people at one company, and each is
their own person (their own contact in the Inbox, their own privacy
request: deleting one takes their address off the row and leaves their
colleagues signed up). A sign-in lasts 12 hours, a show day: on a shared
stand laptop or a show-floor iPad, the next person isn't them. A new list
or a privacy deletion signs it out.

Every column of the list reaches Billie unless the team unticks it on the
Exhibitors step ("Columns Billie may use"). Columns that sound like the
team's own notes (notes, credit, invoices, comments) start unticked; the
choice carries over to the next upload with the same headings. Unticked
columns still work for deadline chasers.

Uploads are read with limits: an .xlsx is a zip, so each part is unpacked
with a ceiling (40 MB in all) before Excel parsing; at most 200 columns and
15,000 rows are read, and headings are cut at 100 characters. A small file
can't use up the server's memory.

Their row goes to Claude as the last numbered passage, with the message
rather than in the cached knowledge, and the prompt says to use it only for
their own stand. Billie only tells people to sign in when they really can
(setting on, list uploaded, and email sending set up or BluePrint
connected). The
team's suggested reply gets the row too. Not on WhatsApp: there's no way to
show a code form there. The list is personal data: only people on the bot
see it, it's in privacy requests (by email), it goes with the bot, and a
list nobody has uploaded again within the retention time is deleted.

## BluePrint signs exhibitors in, and sends the whole list

BluePrint, the exhibitor manual, already knows who an exhibitor is: they
signed in to it. So an exhibitor bot can trust it instead of a code by
email (docs/blueprint.md is the guide for BluePrint's side). An admin
connects it on the Exhibitors step: Billie makes one key per bot, shows it
once, and keeps only its SHA-256 (to check list updates) and a signing key
made from it (SHA-256 of "billie-sign-in:" and the key, to check
sign-ins). Someone who reads Billie's database could sign people in to
chats with what they find (and could read the list anyway), but couldn't
change the list. The key's first 12 characters say which bot it is, so a
request needs nothing else. A new key replaces the old one at once.

A sign-in is a JWT, HS256 only (never "none", never a key the token
names), with the key id in the header, from "blueprint" to "billie", the
exhibitor's email as the subject, and at most 12 hours between when it was
made and when it ends (a minute's clock difference allowed). The signature
is checked before anything it says. It goes to the chat after the "#" of
the frame's address (from the widget's data-exhibitor-token, or a link to
the chat page), so it never reaches a server log; the chat takes it out of
the address at once. It only signs in an email on the bot's list, and only
a chat that isn't someone else's: one signed in as another address (even
if that sign-in has run out) or where someone left another email gets left
alone, and the browser starts a new chat, so on a shared laptop nobody
sees the last person's chat. That's checked before the old chat is shown.
With no chat yet, nothing is kept until they ask something: the first
message carries the sign-in again and starts the chat signed in, so empty
chats never reach the reports. Signing in from the manual needs no email
sending; the prompt then tells people to open the chat from the manual
rather than pointing to a button that isn't there.

The list comes whole each time (POST /api/public/blueprint/exhibitors,
the key as a bearer token), not as changes: a missed update can't leave it
wrong for long, and BluePrint needs no record of what it sent. Exhibitors
match on BluePrint's own id, so the same exhibitor keeps the same row
(changed ones are updated in place, a few hundred to a statement) and stay
signed in; those left out are removed, with their sign-ins. It's checked
like a spreadsheet (5,000 exhibitors, 40 fields, 500 characters a value)
and kept like one: the team's hidden columns carry over, new ones that
sound internal start hidden, and the retention clock restarts with each
update. An empty list is refused as a mistake. One change to a bot's list
happens at a time (an advisory lock, shared with uploads). Updates are
limited per address before the key is checked and per key after it, and
audited only when something changed. A spreadsheet upload still works; it
lasts until BluePrint next sends the list.

## Deadline reminders are written once, checked by a person, sent gently

A deadline says which column of the exhibitor list shows who has done it,
and which answers mean done (Billie guesses yes-like words, or "any
answer" for a column of dates; the person ticks the rest). Everyone else
gets the reminder. If the list is replaced by one without that column,
Billie refuses to chase anyone, rather than chasing everybody.

Billie writes one email per round, not one per exhibitor: a single Claude
call on the queue, from the bot's knowledge, with {first_name}, {company}
and {stand} filled in for each person when it's sent. Unknown placeholders
are refused, so nobody gets "{portal_link}". Rounds start a set number of
days before the deadline (once per reminder day, after 08:00 UK time so
nobody's phone buzzes at dawn) or on request, never more than one open at a
time, and nothing is sent until a person checks the email and the
recipients and confirms. Anyone who has done it since (by the current list)
is left out at send time.

Sending is one job per round that sends one email at a time with a pause,
and queues itself again when its time is up: the job runner runs five jobs
at once, which would trip the email service's rate limit. Each reminder is
claimed before it's sent (so two jobs can't both send it), then marked sent
or failed; Resend gets a key for each (`deadline-reminder/<id>/<retries>`)
and won't send the same key twice within a day, so one claimed by a job
that died is safely picked up again after five minutes. Failed ones can be
tried again once the round has finished, never while it's still sending.
Only addresses still on the exhibitor list are sent to. Replies go to the
event mailbox when there is one, and every round is in privacy requests
and goes with retention.

## A thumbs down is a fix to make, not just a number

Unanswered questions were already caught (gaps), but an answer that was
wrong or weak only showed as a lower "helpful" share in Reports. Now each
thumbs down notes the visitor's question with Billie's answer, grouped by
the same wording rule as gaps, on the Knowledge page under To improve. The
team fixes it in place: the answer box starts as what Billie said, and the
better answer is saved as a typed answer, which retrieval and the prompt
already prefer. It's noted after the rating is saved, so a problem with
the list never fails the rating; the chat row lock keeps double taps to one
count, and a thumbs down changed to a thumbs up takes it back off. After a
fix, a thumbs down on an answer given before the fix changes nothing; one
on a newer answer reopens it, counting afresh. Dismissed stays dismissed.

## Past emails become suggested answers, never knowledge on their own

A show's mailbox already holds the answers to most questions, in the team's
replies. On request, a job reads the mailbox's Sent Items for the chosen
months (up to 300 replies) and the mail that came in (any folder), each
with only its own words (Outlook's uniqueBody, so quoted threads aren't
read twice), and pairs each reply with the latest email in its thread from
someone else before it, skipping automatic replies, no-reply senders and
the mailbox itself. The Fast model reads 15 pairs at a time and lists the
general questions with the team's answers, leaving out anything about one
exhibitor and every name, address, number and company. The same question
from different batches is counted together; those asked at least twice
(or the top ten, if none were) are offered on the Knowledge page, not
already a typed answer, and never again once saved or dismissed. A person
checks each one: an answer from last year's show may be out of date. The
emails exist only in the job's memory; what's kept is the question, the
answer and the count. Read only: Billie never changes the mailbox.

## Billie learns from sent drafts, but a person saves what it learns

Message ids are immutable, so Billie's Outlook draft keeps its id once it's
sent. Every ten minutes (only while there are drafts from the last 14 days
to look for) Billie checks each draft: still a draft, sent, or deleted.
Sent drafts are compared with Billie's text, above the quoted email and
ignoring spacing and quote marks: "sent unchanged" is the number that says
how far to trust the drafts (Reports). A draft sent with changes goes to
Claude once (a job) to ask whether the team corrected or added a fact that
would answer the same question next time; wording, tone and anything about
just that person don't count. A fact is offered on the Knowledge page with
both texts, for a person to edit and save as a typed answer, or dismiss:
nothing goes into the knowledge by itself. The email is marked sent, and
what was sent is kept with it (in privacy exports, deleted with it).

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

## The end-of-show report is a page and a PDF made on the server

The report covers the bot's show days (or days chosen on the page, at most
120), with UK midnights worked out by Postgres. The PDF is drawn with
pdf-lib in the request (A4, Helvetica, no browser or headless Chrome on
the server): the page can't be printed from an artifact-style frame, and a
file is what gets emailed round after a show. Helvetica only draws Western
European characters, so text is made safe first (ş to s, ı to i; anything
it can't show is left out). Claude's cost per chat is for admins only, as
everywhere else; email drafts aren't counted per bot (their use is "email"
in Settings → AI), so the cost is for chat answers.

## Show week gets a morning post, from the bot's own show days

The Monday post is right for the months before a show; during it, the
team needs yesterday and now. So a bot can have show days (from the first
day of build-up to the last of breakdown, at most 31) on its Look step,
and on each of them, plus the day after the last (for breakdown day
itself), its Teams channel gets a post at 7:30 UK time. The minute tick
queues the morning's work once a day from 07:30, which queues one post per
bot, once, so a retry never posts twice; a bot whose days changed since
then posts nothing. "Yesterday" is the UK day, worked out by Postgres
(`AT TIME ZONE 'Europe/London'`) so the clocks changing can't move it. The
post: chats and the share Billie answered alone, emails in, new requests,
thumbs down, why chats went to the team, what's waiting now, and the
questions to fix (not answered, marked unhelpful, most asked), each a link.
Copying a bot doesn't copy its days: each show has its own.

## Who handles what is words, not Claude

A bot's People step can list topics, each with the words that mean it and
the person who handles it. When a chat is passed to the team, its visitor's
messages are matched against the words (at the start of a word, so
"electric" finds "electrics"; the topic with most words found wins, the
first on a tie). The person gets the Teams message first, and the chat if
nobody has it yet, so the nudges go to them too. For a live chat, whoever
is available is told as well unless the person is available themselves;
for a ticket they're told instead of the event mailbox's manager. Emails
that need a person are matched on their subject, summary and text, and
the person is named in the channel post, sent the Teams message and
nudged, in place of the manager. Words rather than another Claude call:
the team can see exactly why something went to someone, it's instant, and
it costs nothing. Only someone still active and on the bot is chosen;
otherwise things go as before.

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

## A whole website is a list of web pages, kept up to date weekly

Rather than a crawler, Billie asks the website for its own list: the
sitemaps robots.txt names (or /sitemap.xml, or a sitemap address typed in),
up to 10 of them through sitemap indexes. With no sitemap, it takes the
home page and the pages it links to. Only pages on the same site (with or
without www) are kept, web pages only (no PDFs, pictures or feeds), each
once, none robots.txt keeps BillieBot out of (the longest matching rule
decides), none whose address contains what the team left out, at most the
number they set (200 to start, 500 at most). Each page is then an ordinary
web page source, read through the same safe fetcher (no private addresses,
every redirect checked, 5 MB and 15 seconds a page) and spread out a second
and a half apart so the show's website isn't hit all at once.

The website is looked at again weekly (and on "Read again now"): new pages
are added, pages no longer listed go to the bin, and pages are read again
when the sitemap says they changed or a week has passed, which the existing
"page unchanged" check makes cheap. The pages show on the website's own
card, not one by one in the sources list. Removing the website puts its
pages in the bin; one restored from there stands on its own. Copies of a
bot keep its websites.

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

Writes to the public chat API come only from the chat's own pages: a POST
whose Origin is another website is refused, and it must be JSON (a plain
form or text/plain from another site needs no permission from us; JSON
does). So no other website can make its visitors' browsers ask for codes
or send messages from their addresses.

## The widget only works on the bot's own websites

`widget.js` asks for the bot's settings with the page's origin, and the
chat frame's `frame-ancestors` lists only the bot's allowed websites, so
copied embed code doesn't work elsewhere.

## Single company, single settings row

Billie serves one company (Media10). There's no tenant column; settings are
one row. Adding tenants later means a `company_id` on bots, knowledge and
users.
