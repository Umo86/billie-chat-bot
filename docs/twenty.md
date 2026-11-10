# Billie and Twenty CRM

How a visitor who wants to exhibit becomes a lead for Media10's sales team.

## What happens

1. **A visitor shows interest.** On the show's website they ask about
   exhibiting, or a page nudge on the exhibiting page invites them to ask
   ("Thinking of exhibiting? I can put you in touch with our sales team.").
2. **Billie offers the form.** The visitor bot's _Interested in exhibiting_
   form asks for their name, company, email and phone, and what the company
   does. It says plainly where the details go: "We'll pass your details to
   our sales team, who will contact you about exhibiting."
3. **Billie sends it to Twenty, on the job queue.** In this order:
   - **Company:** found by its web address (from a work email, never Gmail
     or Outlook), then by name, or made.
   - **Person:** found by email, or made, at that company. Someone who asks
     twice is one person, not two.
   - **Opportunity:** "Acme Ltd – exhibiting at UKCW London 2027", with the
     person as the point of contact.
   - **Note:** what they said, the page they were on and a link to the chat
     in Billie, on all three.
4. **The team sees it in Billie too.** The request's page says "In Twenty
   as a lead." with an _Open in Twenty_ link, or what went wrong.

The request is a normal Billie request as well: it's on the Requests page,
and the team is told about it the usual way.

## Set it up

1. **Make a key in Twenty:** Settings → Developers → API → **+ Create key**.
   Copy it straight away: Twenty shows it once. If you give the key a role
   (Settings → Members → Roles), it needs to create and read people,
   companies, opportunities and notes.
2. **Add it in Vercel** (Project → Settings → Environment Variables,
   Production, marked Sensitive):
   - `TWENTY_API_KEY`: the key.
   - `TWENTY_API_URL`: only if Twenty runs on your own server, e.g.
     `https://crm.media10.com`. Leave it out for Twenty's cloud.
   - `TWENTY_APP_URL`: the address you open Twenty at, e.g.
     `https://media10.twenty.com`, for the _Open in Twenty_ links.
   - `TWENTY_LEAD_STAGE`: optional, the stage new opportunities start at, as
     Twenty names it (e.g. `NEW`). Leave it out for Twenty's default.
3. **Redeploy** so the new values are used.
4. **Check it:** Settings → Connections → Twenty CRM → _Test the
   connection_.
5. **Add the form to the visitor bot:** the bot's Rules step → Requests →
   _Interested in exhibiting_. It's marked "A sales lead: send it to Twenty
   CRM too." Any other form can be marked the same way.

## When something goes wrong

- **Twenty isn't connected yet:** leads wait ("Waiting: Twenty isn't
  connected yet."). Once the key is added, press _Send to Twenty_ on each
  request.
- **Twenty is busy or down:** Billie tries again, six tries in all over
  about 15 minutes, then marks it failed with the reason. Press _Try again_
  to resend.
- **Twenty refuses the key:** it fails straight away with what to check.
- **A phone number Twenty won't take:** the person is made without it. The
  number is still in the note.

Trying again never makes a second company or person: they're found again by
web address, name and email, and parts already made are skipped.

## What Billie never does

- Send anything a visitor didn't put in the form, or anything from an
  exhibitor bot (only forms marked as sales leads go).
- Show the key, or write it in logs.
- Change or delete records already in Twenty, except to link a person it
  found to their company when they had none.
