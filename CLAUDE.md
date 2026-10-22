# Working on Billie

Read `README.md` for what Billie is and `DECISIONS.md` for why it's built
this way. These are the rules to keep it reliable.

## Commands

- `pnpm dev` · `pnpm build` · `pnpm lint` (ESLint + Prettier) · `pnpm typecheck`
- `pnpm test` — Vitest; DB tests use `TEST_DATABASE_URL` (wiped each run)
- `pnpm build && pnpm test:e2e` — Playwright against `next start`; uses
  `E2E_DATABASE_URL` (wiped), the fake AI and the local sign-in stand-in
- `pnpm db:generate --name <change>` after editing `lib/db/schema/*`, then
  `pnpm db:migrate`. Never edit a migration that has been applied anywhere;
  add a new one. Migrations run on every Vercel deploy.

## Rules

- **Permissions:** every server action goes through `runAction()`
  (`lib/actions/run.ts`) with an action from `lib/authz.ts`; pages call
  `requireActor(action)`. Never check roles anywhere else.
- **Sign-in:** only through `authProvider()` (`lib/auth/provider.ts`). Neon
  Auth says who someone is; the `users` table says what they may do. A
  Neon Auth account alone must never get anyone in.
- **Public routes** (`app/api/public`, `app/embed`, `app/c`, webhooks) are
  reachable by anyone: validate input with zod, rate limit writes
  (`lib/rate-limit.ts`), and never trust a channel or role the caller sends.
- **Database:** Drizzle queries or `sql` template tags with bound values.
  No string-built SQL from input. Status changes to chats go through
  `nextStatus()` in a transaction that locks the row (`lib/conversations/service.ts`).
- **Slow work** (reading files, Claude calls for emails, sending) goes on the
  job queue (`enqueue()` + `kickJobs()`), never inline in a request that
  could time out.
- **AI:** call Claude only through `lib/ai/provider.ts` (`structured()`),
  which handles retries, the fallback model, caching and the daily cap.
  Answers come only from retrieved passages; keep the prompts' rules.
- **Audit:** anything a person changes writes `writeAudit()` in the same
  transaction. The audit log is append-only (database triggers).
- **Client/server:** files with `"use client"` export components only;
  shared constants live in `lib/`. Server-only modules start with
  `import "server-only"`.
- **Copy:** plain British English, sentence case, short sentences, no
  jargon. Errors say what happened and what to do next.
- **Secrets:** never in code, tests or logs. `.env*` is git-ignored except
  `.env.example`.

## Before you finish a change

`pnpm lint && pnpm typecheck && pnpm test`, and for anything visible,
`pnpm build && pnpm test:e2e`. Add or update a test with every behaviour
change.
