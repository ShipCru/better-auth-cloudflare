# Next.js + OpenNext + Tailwind + DO adapter

Full React frontend for the DO-backed Better Auth flow. Replaces the
Hono inline-HTML demo in `examples/hono-do/` with a proper Next.js app.

**Stack:** Next.js 15 (App Router) + React 19 + Tailwind v4 + OpenNext
deploy target on Cloudflare Workers + the `do` adapter from this fork.

## What's here

| Route | Purpose |
|---|---|
| `/` | Home — signin / signup tabs, anonymous + Google buttons |
| `/dashboard` | Post-auth view with session details + recent users from D1 |
| `/api/auth/*` | BA catch-all handler |
| `/admin/users` | D1-backed paginated user list (consumed by the dashboard) |

All auth state lives in `UserDurableObject` + `IdentityDurableObject`.
D1 (`AUTH_DB`) holds an eventually-consistent sync (DO outbox + alarm
+ waitUntil, ~10s bounded). Sessions go to KV via BA's secondaryStorage.

## Local dev

```bash
# From repo root: build the package first
pnpm install && pnpm build

# Now the demo
cd examples/opennextjs-do
pnpm install

# Provision local resources
wrangler kv namespace create KV          # paste id into wrangler.toml
wrangler d1 execute ba-cf-do-recovery --local --file ../hono-do/auth-data-schema.sql

# Optional: enable Google OAuth
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# Next.js dev server (uses OpenNext's Cloudflare dev binding)
pnpm dev
```

Then visit http://localhost:3000.

## Deploy

```bash
pnpm deploy   # opennextjs-cloudflare build && deploy
```

OpenNext bundles Next.js into a single Cloudflare Worker. The DO classes
are re-exported via `open-next.config.ts` so wrangler can register them.

## Forgot password

Wired in `src/lib/auth.ts` via BA's `sendResetPassword` callback. In dev,
the reset URL is logged to the worker console. In production, hook this
to your transactional email service.

The reset link goes to `/api/auth/reset-password` which BA handles.

## Google OAuth

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` via `wrangler secret put`.
Register the callback URL in Google Console:
`https://your-worker-url/api/auth/callback/google`

## What's NOT included

- E2E tests — the Hono demo already covers them
- Forgot password dedicated UI page — uses BA's default reset link flow
- Theme switcher — Tailwind's `dark:` classes respond to OS preference
- Admin auth on `/admin/users` — wrap in your own admin check for prod

## Provenance

Companion to `examples/opennextjs/` (D1-backed) — same UI shape but
backed by DOs instead of D1 for the hot path. See the fork root
[README](../../README.md) for the full architecture.
