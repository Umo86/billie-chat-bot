# Billie and Slack

How Media10's team works with Billie in Slack. Once Slack is connected,
Billie posts everything for the team there instead of Teams.

## What happens

- **A chat needs a person, during the bot's working hours.** Billie posts it
  in the event's Slack channel with what was said so far, and @mentions that
  show's people (or @here, if none are chosen). The team
  answers in the post's thread. Each reply goes to the visitor straight
  away, with the person's first name, and gets a tick when it's delivered.
  What the visitor writes next comes into the same thread.
- **Nobody answers within 5 minutes.** Billie asks the visitor for their
  details instead, and says so in the thread. When they leave them, the
  details go in the same thread.
- **Outside working hours.** Billie asks for details straight away:
  - Exhibitor bots: name, email and stand number.
  - Visitor bots: name, email and phone number, to call them back.

  An exhibitor signed in from BluePrint isn't asked: Billie already knows
  them. The ticket is posted in the channel, and a reply in its thread goes
  to them by email (or on WhatsApp, if that's where they wrote).

- **Email replies to check.** When Billie has drafted replies in the event
  mailbox, it posts "I've prepared these replies, please review and send",
  listing them. It names whoever manages the mailbox, and whoever handles
  an email's topic. One post covers about two minutes of emails. Billie
  never sends an email itself.
- **Everything else.** The Monday post, show-day posts and new requests go
  to the bot's channel. Messages meant for one person (nudges, reminders
  ready, budget alerts) are Slack direct messages from Billie.

Each show has its own bot, and each bot its own channel (its Email step)
and its own people in Slack (its People step, "Who's told in Slack"):
Billie @mentions them on its chats, tickets, email replies to check and
requests. A topic with its own person (People step, "Who handles what")
goes to that person first. The People step shows whether each person was
found in Slack, by their Billie email. A company-wide
channel (Settings → Connections) gets a short alert about chats from bots
without one: what they asked and who they are, but not how to reach them
or the chat, since everyone in that channel sees it. Those are answered in
Billie. Email replies to check and requests only go to a bot's own channel.

## Answering in a thread

- Reply in the thread: it goes to the visitor. Slack formatting is taken
  out, and links are written out in full. A reply also sent to the channel
  counts too.
- Start a message with `note:` (or `//`) to keep it to the team. A message
  that @mentions someone ("@Sam can you take this?") stays with the team
  too.
- A reply gets a tick once it reached them: straight away in the chat, or
  once it's sent by WhatsApp or email. If it can't go (say, it's over 24
  hours since they wrote on WhatsApp), Billie says why in the thread.
- **Hand back to Billie** gives the chat back to Billie. **Close the chat**
  closes it. The post then says who did it.
- Only people on Billie who work on that bot can answer, matched by their
  Slack email. Anyone else gets a private note saying so, and nothing
  reaches the visitor. People from other companies in a shared channel
  can't answer.
- Editing or deleting a message in Slack doesn't change what the visitor
  got. Files can't be sent to visitors.
- Replies written in Billie's Inbox are copied into the thread too, so the
  thread always has the whole chat.

## Setting it up (an admin, about 10 minutes)

1. Go to **api.slack.com/apps** → **Create New App** → **From a manifest**,
   and choose Media10's workspace. In the box, choose the **YAML** tab, paste
   the manifest below, then **Next** → **Create**. Settings → Connections in
   Billie shows the same manifest, ready to copy (and as JSON, for the
   **JSON** tab).
2. If Slack says the **Request URL** isn't verified (under Event
   Subscriptions, or App Manifest), press **Verify** or **Retry**. Billie
   answers it straight away, even before step 4.
3. Choose **Install to Workspace**, and allow it.
4. In Vercel → billie → Settings → Environment Variables, add these two for
   Production, then redeploy:
   - `SLACK_BOT_TOKEN`: OAuth & Permissions → **Bot User OAuth Token**
     (starts `xoxb-`).
   - `SLACK_SIGNING_SECRET`: Basic Information → **Signing Secret**.
5. In each event's channel, type `/invite @billie`. A private channel is
   best: posts include visitors' names and contact details.
6. In Billie, choose each bot's channel on its **Email** step. Choose the
   company-wide one in **Settings → Connections**. Then press **Send a
   test post**.
7. Make sure everyone who answers is on Billie, with the same email as
   their Slack account, and on the bots they answer for (each bot's People
   step). On the same step, tick **Who's told in Slack** for that show.

```yaml
display_information:
  name: Billie
  description: Media10's chat and email assistant. Chats that need a person come here.
  background_color: "#0d6a5b"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
  bot_user:
    display_name: billie
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - channels:history
      - groups:history
      - users:read
      - users:read.email
      - im:write
      - reactions:write
settings:
  event_subscriptions:
    request_url: https://billie-teal.vercel.app/api/webhooks/slack/events
    bot_events:
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
    request_url: https://billie-teal.vercel.app/api/webhooks/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The bot's name in the manifest is lowercase (`billie`): Slack only allows
a-z, 0-9, `-`, `_` and `.` there, and refuses the manifest otherwise. People
still see the app as Billie.

What each permission is for:

| Permission                           | Why                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `chat:write`                         | Post chats, tickets and email replies to check; update a post's buttons   |
| `channels:read`, `groups:read`       | List the channels Billie is in, to choose from                            |
| `channels:history`, `groups:history` | Hear the replies in its posts' threads (only in channels it's invited to) |
| `users:read`, `users:read.email`     | Match whoever replies to their Billie account, by email                   |
| `im:write`                           | Send one person a direct message                                          |
| `reactions:write`                    | Tick a reply once it reached the visitor                                  |

## Privacy

Posts include visitors' names, contact details and what they wrote. Slack
keeps its own copy under the workspace's retention settings, and Billie
can't delete it. Use private channels for the team. If someone asks
Media10 to delete their data, delete it in Billie (Settings → Privacy
requests) and remove the posts in Slack too.
