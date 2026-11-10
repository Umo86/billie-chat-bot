# Billie and BluePrint

How BluePrint, the exhibitor manual, works with Billie. Billie never calls
BluePrint: BluePrint sends everything, with a key for each show.

With BluePrint connected to an exhibitor bot:

- **Exhibitors are signed in to the chat.** An exhibitor signed in to the
  manual opens the chat on a manual page, and it opens signed in as them,
  with no code to type. Billie answers from their own row of the exhibitor
  list: their stand, orders, plans and times.
- **The exhibitor list stays up to date.** BluePrint sends the whole list
  whenever it changes. The deadline chasers then see what each exhibitor
  has sent, without anyone uploading a spreadsheet.
- **Manual tasks are done in the chat.** The electrics order for a space
  only stand, the nameboard for a shell scheme one, or any other task the
  team sets up: a signed-in exhibitor gets a button for each one still to
  do for their stand, fills it in (with quantities and a total for orders),
  and BluePrint collects it to record and invoice (section 3).
- **A checklist for the show.** Each time a signed-in exhibitor opens the
  chat, they see "Before the show": every deadline, ticked off from the
  list BluePrint sends, with a button for the tasks and the team's link for
  things done elsewhere (badges in Visit Connect, say). It goes once
  everything is done.

The examples use Billie's live address, `https://billie-teal.vercel.app`.

## 1. In Billie (an admin)

1. Open the bot, then its **Exhibitors** step.
2. Turn on **Answers about their own stand**.
3. Under **BluePrint, the exhibitor manual**, choose **Connect BluePrint**.
   Billie shows the key once. Copy it into that show's settings in
   BluePrint straight away.
4. On the **Go live** step, add BluePrint's web address to the bot's
   websites (for example `manual.ukconstructionweek.com`). The chat only
   opens on the bot's own websites.
5. Optional: turn on **Only exhibitors who are signed in can chat** (under
   Answers about their own stand). Anyone who reaches the chat without
   signing in (its chat page link, or WhatsApp) is shown how to sign in
   instead of the message box, and Billie isn't asked anything for them.

The key looks like `bp_k3x9w2m4q8za_` followed by 43 more characters. The
12 characters after `bp_` are the key's id.

- **Make a new key** replaces it: the old one stops working at once.
- **Disconnect** stops both sign-ins and list updates. The list stays.

Billie keeps only a hash of the key, so nobody can read it back. If it's
lost, make a new one.

## 2. In BluePrint

Keep each show's key with that show's settings, encrypted like any other
secret. It's only ever used on BluePrint's server: never in a page, a
browser or a log.

### Sign exhibitors in to the chat

On each manual page shown to a signed-in exhibitor, put the chat's script
tag with a sign-in made for them:

```html
<script
  src="https://billie-teal.vercel.app/widget.js"
  data-bot="BOT-NAME"
  data-exhibitor-token="SIGN-IN"
  async
></script>
```

`BOT-NAME` is the bot's address name (it's in the embed code on the Go
live step). Make a new sign-in each time the page is shown.

A link works too. This opens the chat page signed in:

```
https://billie-teal.vercel.app/c/BOT-NAME#exhibitor-token=SIGN-IN
```

The sign-in always goes after the `#`. Browsers never send that part to a
server, so it never ends up in a log. Never put it in a query string.

The sign-in is a JWT, signed with HS256:

| Part         | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Header `alg` | `HS256` (Billie takes nothing else)                                      |
| Header `kid` | The key's id: the 12 characters after `bp_`                              |
| `iss`        | `blueprint`                                                              |
| `aud`        | `billie`                                                                 |
| `sub`        | The exhibitor's email: one that's on the bot's exhibitor list            |
| `iat`        | Now, in seconds                                                          |
| `exp`        | When it stops working: 2 hours on is right. At most 12 hours after `iat` |

The secret is the SHA-256 of `billie-sign-in:` followed by the key (the
raw 32 bytes, not hex). In TypeScript, with nothing to install:

```ts
import { createHash, createHmac, randomUUID } from "node:crypto";

/** A sign-in for Billie's chat, for an exhibitor signed in to the manual. */
export function billieSignIn(key: string, email: string): string {
  const keyId = key.slice(3, 15); // the 12 characters after "bp_"
  const now = Math.floor(Date.now() / 1000);
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = part({ alg: "HS256", typ: "JWT", kid: keyId });
  const body = part({
    iss: "blueprint",
    aud: "billie",
    sub: email.trim().toLowerCase(),
    iat: now,
    exp: now + 2 * 60 * 60,
    jti: randomUUID(),
  });
  const secret = createHash("sha256").update(`billie-sign-in:${key}`).digest();
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}
```

A JWT library does the same: sign with HS256, `kid` in the header, and the
SHA-256 above as the secret.

What Billie does with it:

- It signs the chat in only if the email is on the bot's exhibitor list,
  and **Answers about their own stand** is on.
- Nothing is kept until they ask something. Their first question starts
  the chat, signed in, so Billie's first answer can use their row.
- A sign-in lasts 12 hours, a show day.
- It never signs someone in to a chat that's someone else's. On a shared
  laptop, the next exhibitor gets a chat of their own and never sees the
  last one.
- If it doesn't work, the chat says why in plain words: the sign-in has run
  out (reload the page), or their email isn't on the list yet. They can
  still ask anything; Billie just can't answer about their own stand. The
  chat starts afresh, so they never see one from before.

### Keep the exhibitor list up to date

Send the whole list whenever it changes, and once a night:

```
POST https://billie-teal.vercel.app/api/public/blueprint/exhibitors
Authorization: Bearer <the show's key>
Content-Type: application/json
```

```json
{
  "exhibitors": [
    {
      "id": "ex_1042",
      "company": "Acme Displays Ltd",
      "stand": "B12",
      "name": "Sam Patel",
      "emails": ["sam@acme-displays.co.uk", "ops@acme-displays.co.uk"],
      "fields": {
        "Stand type": "Shell scheme",
        "Stand plan approved": false,
        "Electrics ordered": true,
        "Build-up slot": "Monday 8am"
      }
    }
  ]
}
```

- **The whole list, every time.** Exhibitors missing from it are removed
  from Billie's list, and their sign-ins end. So do the sign-ins of
  addresses taken off an exhibitor.
- **`id`** is BluePrint's own id for the exhibitor (text or a number, up
  to 200 characters), one per exhibitor. The same id keeps the same row in
  Billie, so an exhibitor who's signed in stays signed in.
- **`emails`**: the addresses they can sign in with, at least one. An
  exhibitor with none is left out (and counted as `skipped`).
- **`company`, `stand`, `name`**: optional text.
- **`fields`**: anything else Billie may answer from, by name. Text,
  numbers, or `true` and `false` (Billie shows those as Yes and No).
  `null` or empty is left out. Up to 40 names (the first 40 it sees);
  values are cut at 500 characters.
- Keep field names the same from one update to the next. The deadline
  chasers check a field by its name ("Stand plan approved"), and the team
  chooses on the Exhibitors step which fields Billie may never see (notes,
  credit status). Those choices stay with each name.
- Up to 5,000 exhibitors and 4 MB.
- At most once a minute: changes made close together can go in one update.
  Billie takes up to 60 updates an hour for each show.

The answer, when it worked (`200`):

```json
{ "exhibitors": 650, "added": 3, "updated": 12, "removed": 1, "skipped": 2 }
```

When it didn't, nothing changes, and `error` says what to do:

| Status | Why                                                                                  |
| ------ | ------------------------------------------------------------------------------------ |
| `400`  | The list isn't right: `error` says where, for example `Check exhibitors.3.emails: …` |
| `401`  | The key is wrong, or it's been replaced. Make a new one in Billie.                   |
| `409`  | The bot isn't an exhibitor bot.                                                      |
| `413`  | Over 4 MB. Leave out fields Billie doesn't need.                                     |
| `415`  | Not sent as JSON.                                                                    |
| `422`  | No exhibitor with an email address: an empty list is treated as a mistake.           |
| `429`  | Too many updates: wait a few minutes, then send the whole list again.                |
| `500`  | Something went wrong in Billie: try again in a minute.                               |

To check a key, `GET` the same address with the key:

```json
{
  "bot": "Exhibitor Help",
  "show": "UK Construction Week 2027",
  "exhibitors": 650,
  "from": "blueprint",
  "updatedAt": "2027-03-01T09:30:00.000Z"
}
```

`from` is `blueprint` when the list came from BluePrint, `spreadsheet` when
someone uploaded one in Billie (the next update from BluePrint replaces
it), or `null` with no list yet.

### Try it

```sh
curl -s https://billie-teal.vercel.app/api/public/blueprint/exhibitors \
  -H "Authorization: Bearer $BILLIE_KEY"

curl -s https://billie-teal.vercel.app/api/public/blueprint/exhibitors \
  -H "Authorization: Bearer $BILLIE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"exhibitors":[{"id":"test-1","company":"Test Ltd","stand":"Z1","emails":["you@media10.com"]}]}'
```

The second one replaces the bot's whole list, so try it on a test bot.

## 3. Tasks done in the chat

### Setting a task up (in Billie)

On the bot's **Rules** step, under **Requests it can take**, add one
(**Electrics order** and **Nameboard** are ready-made), then:

- Tick **A task from the exhibitor manual**.
- **Who it's for**: a column of the exhibitor list, and the answers in it,
  e.g. Stand type: `Space only`. Only signed-in exhibitors with one of those
  get it, as a button and in Billie's answers.
- **Its deadline** (optional): a deadline from the Exhibitors step. The
  task's button sits with that deadline in the exhibitor's checklist, and
  anyone the deadline counts as done (from the list BluePrint sends)
  doesn't get it.
- **Things to order, with prices** (optional): each item and its price in
  pounds. The chat asks how many of each and shows the total. Billie works
  the total out itself, at these prices, and never takes payment.

A task is done, for that exhibitor, once they've sent it (unless it's
declined), or once its deadline's column says so.

### Collecting them (BluePrint)

```
GET https://billie-teal.vercel.app/api/public/blueprint/tasks?after=1041
Authorization: Bearer <the show's key>
```

Everything sent through that bot's chat after request 1041, oldest first,
up to 100 at a time. Keep `next` and ask with `after=<next>` next time
(every minute or so is plenty); `more` is `true` when there are more now.

```json
{
  "tasks": [
    {
      "ref": "R-1042",
      "number": 1042,
      "type": "Electrics order",
      "typeId": "k3x9w2m4",
      "status": "new",
      "exhibitorId": "ex-1042",
      "exhibitor": {
        "name": "Sam Patel",
        "company": "Acme Displays Ltd",
        "stand": "B12",
        "email": "sam@acme-displays.co.uk",
        "phone": ""
      },
      "answers": [
        { "label": "16A single socket", "value": "2 × £120.00 = £240.00" },
        { "label": "Total", "value": "£240.00 (invoiced through BluePrint)" }
      ],
      "order": {
        "lines": [{ "name": "16A single socket", "quantity": 2, "price": 120 }],
        "total": 240
      },
      "note": "",
      "createdAt": "2027-02-10T10:15:00.000Z",
      "updatedAt": "2027-02-10T10:15:00.000Z"
    }
  ],
  "next": 1042,
  "more": false
}
```

`exhibitorId` is BluePrint's own id for the exhibitor (the `id` it sends
with the list), when they were signed in; otherwise `null`, and the
`exhibitor` details are what they typed. `order` is `null` for a task with
nothing to order. Prices are in pounds, as set in Billie.

### Saying how it's going (BluePrint)

```
POST https://billie-teal.vercel.app/api/public/blueprint/tasks
Authorization: Bearer <the show's key>
Content-Type: application/json

{ "ref": 1042, "status": "done", "note": "Ordered. Your invoice is in BluePrint." }
```

`status` is `in_progress`, `done` or `declined`; `note` (optional) is shown
to the exhibitor. They get an email about it (when email is set up), as when
the team changes it, and it's on the Requests page in Billie. `ref` can be
`1042` or `"R-1042"`. A key only ever sees and changes its own bot's tasks.

```sh
curl -s "https://billie-teal.vercel.app/api/public/blueprint/tasks?after=0" \
  -H "Authorization: Bearer $BILLIE_KEY"
```

## Privacy

The exhibitor list is personal data. If someone asks Media10 to delete
theirs, delete it in BluePrint as well as in Billie (Settings → Privacy
requests). Otherwise BluePrint's next update adds them back.
