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

## The team works in Slack: a thread per chat, answered there

Media10's team lives in Slack, so once Slack is connected (docs/slack.md),
everything Billie tells the team goes there, and Teams stops: chats that
need a person, tickets, email replies to check, the bots' weekly and
show-day posts and requests in each event's channel, and messages to one
person as Slack direct messages. The company-wide channel only gets a short
alert about chats from bots without a channel of their own (what they
asked and who they are, as the Teams alert had; not their email or phone,
the chat, or what they write next), answered in Billie: anyone in that
channel would see it, whichever bots they work on, while Billie shows each
person only their bots' chats. Email replies to check and requests never
go there.
The Teams code stays, for anyone without Slack, and its settings are
hidden once Slack is on. Billie's existing Teams cards are turned into
Slack blocks rather than written twice; everything anyone wrote goes in as
plain text, never Slack markup, so nobody can slip a link or an @channel
into the team's channel, and links are Billie's own buttons.

A chat that needs a person is one post with the chat so far, and its
thread is the conversation: Slack's Events API sends the team's thread
replies to Billie, which hands them to the same staff reply the Inbox uses
(so they reach the chat, WhatsApp, or email for a ticket), and the
visitor's messages, and replies written in the Inbox, are posted into the
thread. Two-way chat needs an app, not a webhook; Slack's is a manifest
an admin pastes in, about ten minutes, against a week and IT approval for
a Teams app. Who may answer is Billie's own rule, not channel membership:
the Slack user's email must be a Billie user who works on that bot, and
the Slack user must be in Media10's own workspace (not someone from another
company in a shared channel, whose email that company controls), or they
get a private note and nothing goes. "note:" (also bold or quoted) keeps a
message to the team, and so does any message that @mentions someone:
"@Sam can you take this?" is said to the team, never to the visitor.
Visitors' words go in Slack's plain-text blocks, and the `text` beside them
(what notifications show) is escaped, so they can't make a mention or a
link. Each reply is kept under its Slack message's id, so a job that runs
again never sends it twice; one by WhatsApp or email gets its tick once
it's sent, or a line in the thread saying why it couldn't go. A channel
post that fails never stops the rest: the people still get their direct
messages and the alert email (its own job, sent once), and Slack is tried
again only when it was busy, not when Billie was taken out of the channel.
Every request from Slack is signed (HMAC of the timestamp and body with
the signing secret, at most five minutes old) and checked before it's
read, except the one-off address check Slack makes while the app is being
made, which only echoes a challenge. Slack wants an answer in three
seconds, so each event and button press is queued once (by Slack's event
id) and handled straight after. Billie's buttons say which chat they're for,
and a press only acts on the chat of the post it's on.

Whether a chat goes live is now the bot's working hours (its Rules step,
UK time; new bots Mon–Fri 9 to 5, and 23:59 means until midnight), not
who has switched "Available" on in the Inbox: in Slack nobody sits on a
switch. So nobody waits on a chat nobody is watching, a live chat nobody
answers in five minutes gets the details form instead, and the thread says
so. Outside the hours Billie asks for details at once: name, email and stand
for exhibitor bots (the exhibitor manual's people), name, email and phone
for visitor bots (to call back). Someone Billie already knows (WhatsApp,
or an exhibitor signed in from BluePrint) isn't asked: it's a ticket
straight away. "Available" remains only to choose who gets a Teams message
while Teams is used.

Each show's bot has its own Slack people (its People step), Billie users on
that bot found in Slack by email: they're @mentioned on its posts instead of
@here, so the UKCW team hears about UKCW and the Ideal Home Show team about
theirs, in one workspace. It's a list on the bot, not a Slack user group,
so Billie needs no extra Slack permission and nobody has to keep a group in
step with Billie.

Email replies to check are one post for about two minutes of emails, not
one per email: each email goes in one post only (claimed and marked in the
same transaction as the post, so a failed post is tried again rather than
lost), naming the mailbox's manager and whoever handles an email's topic.

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

## Two kinds of chatbot, chosen first

Billie supports both of a show's sites: BluePrint, the exhibitor manual,
has an exhibitor chatbot, and the event website a visitor chatbot. The kind
is the first thing chosen when a bot is made, and nothing is picked for
you, because so much follows from it: who the answers are written for, the
topics that always go to a person, what it asks for outside working hours
(name, email and stand; or name, email and phone, to call back), its answer
quality, and whether it has an Exhibitors step (the list, BluePrint and
deadlines). It can be changed later on the Look step: whatever was still on
the old kind's defaults moves to the new kind's, and anything the team chose
stays. An exhibitor chatbot can't become a visitor one while it has an
exhibitor list, BluePrint connected or deadlines: a visitor chatbot has no
Exhibitors step, so that list of people's details would sit out of sight.
They're removed there first, and answers about their own stand go off with
them. The change is in the audit log.

## Personality is style only

Each bot's tone, answer length, personality (in the team's own words),
emoji choice, use of names, words to avoid and email sign-off go into its
prompts as style. The prompt says the rules win, answers still come only
from the knowledge, and emails never get emoji.

Chats sounded robotic, so every prompt now says how to sound like a person
on the show's team: answer first without stock filler, acknowledge a
problem before the answer, say kindly what happens next when it can't
help, and reply naturally to a hello or thanks (with no handover) instead
of treating it as off-topic or unanswerable. Ready-made styles
(`lib/bots/style.ts`) fill in the settings and are recognised again while
they still match; a seasonal one (Christmas) offers its own colours but
never changes them unasked, and still gives dates, prices and rules plainly.
A style change changes the bot's `updated_at`, so answers given again are
written afresh. The chat window's logo and second colour are small data
URLs like the picture; the chat button's words are set as text, never HTML.

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

Elsewhere Claude is only asked when the answer can be worth it:

- A suggested reply is written straight away only when Billie hadn't tried
  the knowledge (they asked for a person, or the topic always goes to one).
  After "Billie didn't have the answer" the same knowledge only gives a
  holding reply, so the team presses "Suggest a reply" if they want one.
- An email goes with its own words and the first 1,500 characters of the
  thread it quotes, not up to 8,000 characters of old emails, and that saving
  counts twice (tagging, then drafting). Newsletters and system
  notifications are left alone like auto-replies.
- A sent draft the team changed is only looked at by Claude when the change
  could hold a fact: a number, date, price, address, link or "not", or more
  than a few new words. A new greeting isn't a fact.
- Reading files, web pages and whole websites never uses Claude.

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
if that sign-in has run out), or where someone left their details (any of
them, not just an email), gets left alone, and the browser starts a new
chat, so on a shared laptop nobody sees the last person's chat. That's
checked before the old chat is shown, and if the sign-in doesn't work (run
out, not on the list yet, too many tries) the old chat isn't shown either.
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
signed in; those left out are removed, with their sign-ins. An address
taken off a row signs its chats out, and a sign-in only counts while its
address is still on the row (checked each time the row is read). It's checked
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
and a half apart so the show's website isn't hit all at once. A sitemap is
read in one pass that never goes back (a hostile one, thousands of tags that
never close, can't stall the job queue), taking at most 2,000 addresses of
at most 2,048 characters; robots.txt gives at most 1,000 rules; the home
page's links come from a real HTML parser; and finding the pages has 90
seconds in all.

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

## Manual tasks are requests, aimed by the exhibitor list

A task from BluePrint (the electrics order, the nameboard) is a request
type with three more things: who it's for (a column of the exhibitor list
and its answers, e.g. Stand type: Space only), an optional deadline, and
optional items with prices. Building on requests keeps one form, one
Requests page, one status the person follows and one set of notifications.
Who it's for needs to know the stand, so only signed-in exhibitors get a
task for some stands; it's left out of what Claude may offer anyone else,
and checked again when the form is sent. The buttons for what's still to
do come from the database, never a Claude call. Done is "sent through the
chat and not declined", or the deadline's column says so, which BluePrint
keeps up to date. An order's total is worked out on the server at the
prices the team set, never taken from the page, and Billie never takes
payment: BluePrint collects the tasks with the show's key (oldest first,
by request number, so it never misses one) and posts back how each is
going, which the person hears about like any change from the team.

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

## The chat bar: obvious, reacts a little, never nags

A round button in the corner is easy to miss. A bot's website chat can be a
bar along the bottom instead (Look step): "Ask me about" plus topics that
come round every three seconds, a small robot (or the bot's picture) and a
send arrow. It reacts to the visitor without getting in the way: the
robot's eyes follow the pointer and the way the page scrolls, topics pause
under the pointer, and after 15 quiet seconds the arrow pulses once, and
only once. A cross tucks the bar away for the visit (session storage) and
the round button takes its place. All movement is off when the team turns
it off or the visitor's device asks for less motion. Like the rest of
`public/widget.js`, it sets styles through the DOM and animates with the
Web Animations API, so it works under a strict Content-Security-Policy, and
every word is set as text. A screen reader hears the whole line at once.

## "Read again now" reads every page

A whole website reads itself again every week, and then only pages that
are new, a week old, or newer by the sitemap's date. That saves fetches,
but an agenda can change with no date to show it, so the manual button
reads every page. It costs nothing extra in credits: a page whose words
are the same is not embedded again. When a read finds different words the
page's `content_changed_at` is set, so the team can see which pages
changed in the last week, and that the change was picked up.

## Off-topic is declined; suspicious is a fixed reply, then a stop

Claude says what kind of message it was answering ("flag": none,
off_topic or suspicious) in the same structured reply, so it costs no
extra call. Off-topic questions get a polite one-line refusal and never
count against the chat: someone asking about the weather is not a threat.
A suspicious message (getting round the rules, other people's details,
pretending to be staff, abuse, threats, fraud) never shows what Claude
wrote: Billie gives a fixed line pointing to the event team's email,
which every bot must have before it goes live. Two of those and the chat
stops answering, with no further Claude calls, so a persistent attacker
costs nothing. The count is on the chat row, increased in the same
transaction as the reply. An unknown or missing flag counts as none, so a
garbled reply never stops a real chat, and flagged answers are never
given again to someone else.

## Links are the team's, chosen by id

The team gives each link an address and when to offer it (Rules step).
Claude sees the label and when, never the address, and answers with ids;
Billie shows only ids the bot really has, at most two, as buttons. So an
address can't be invented, mistyped or out of date in an answer, and a
changed address changes every answer at once. A link can answer on its
own ("How do I register?" with nothing in the knowledge), which is the
one exception to "say you don't know". No buttons on WhatsApp.

## Leads go to Twenty on the queue, found before they're made

A form marked as a sales lead goes to Twenty CRM's REST API from the job
queue, never in the visitor's request. Each step looks before it makes:
the company by its web address (from a work email, never a free one),
then its name; the person by email; and what was made is kept on the
request, so a job retried after a failure part way makes nothing twice.
Busy or down is tried again (six tries); a refused key or a record Twenty
won't accept fails at once with the reason on the request's page, where
the team can send it again. Without a key, leads wait rather than fail.
Twenty's field names come from its source, not its docs pages, which
showed an older shape. The key is read on the server only.

## Repeat reminders reuse the approved email

A plan per bot says what happens after a deadline's first round: nothing,
or another round every week or every 3 days until it's done or due. A
repeat sends the email a person checked and sent last time, with
"Reminder:" on the subject, to those still not done: no Claude call, so a
round costs nothing, and nothing goes out that no person has read. So the
draft prompt asks for the due date, never "in 5 days", and the review page
says why. Repeats can still wait for a check. Without an approved round
(the first was discarded), the next is a fresh draft to check, whatever
the plan says. One open round per deadline at a time, still. Nobody gets
two reminder emails within the plan's gap, counted across deadlines from
what was sent or queued: skipped exhibitors get the next round, and in a
round a person checks they start unticked. Weekdays only by default. The
plan has its own table, so saving it never touches the bot's row (and the
answers kept for reuse). Automatic repeats only start when email can be
sent.

## The checklist is the deadlines, read from the exhibitor's row

"Before the show" in the chat is the bot's deadlines, each done or not by
the same column and answers the chasers use, plus the tasks: nothing new
for the team to keep up. A deadline tied to a task that isn't for their
stand isn't theirs; one whose column has gone, or is kept from Billie,
isn't shown. It shows when the chat opens while anything's still to do,
and goes once all is done, so it reminds without nagging. Billie gets it
with the exhibitor's record.
