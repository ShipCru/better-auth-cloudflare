# DO adapter — Hono example

Same shape as [`examples/hono`](../hono/) but uses the new
`do` adapter option. **No D1, no Hyperdrive.** All auth state lives in
Durable Objects on the hot path; sessions go to KV via BA's
`secondaryStorage`.

## What's different from `examples/hono`

| Concern | examples/hono | examples/hono-do |
| --- | --- | --- |
| User + account storage | D1 (sqlite via Drizzle) | UserDurableObject (per principal) |
| Email uniqueness | D1 unique constraint | IdentityDurableObject |
| Sessions | D1 | KV (BA `secondaryStorage`) |
| Verification tokens | D1 | KV |
| Hot-path DB calls | several per request | zero |

## Setup

```bash
cd examples/hono-do
pnpm install
wrangler kv namespace create KV
# paste the id into wrangler.toml
pnpm dev
```

The DO namespaces (`USER_DO`, `IDENTITY_DO`) are declared in
`wrangler.toml` and don't need separate provisioning.

## Wiring

The two important hooks: re-export the DO classes (so Cloudflare
registers them) and pass `do` instead of `d1`:

```ts
// src/index.ts — Worker entry
export { UserDurableObject, IdentityDurableObject } from 'better-auth-cloudflare';
```

```ts
// src/auth/index.ts — withCloudflare config
withCloudflare(
  {
    do: { userDo: env.USER_DO, identityDo: env.IDENTITY_DO },
    kv: env.KV,
    cf: request.cf,
  },
  { emailAndPassword: { enabled: true }, plugins: [anonymous()] },
)
```

## Flows demonstrated

- Anonymous sign-in (no email; just one UserDO created)
- Email/password signup (IdentityDO.reserve → UserDO.create → IdentityDO.commit)
- Email/password signin (IdentityDO.lookup → UserDO.findPrincipal)
- Session validation (cookie cache 5min, BA secondaryStorage from KV on miss)
- Protected route
- Geolocation enrichment (from the `cloudflare` plugin, automatic)
- Sign out

## Telemetry

If you bind an Analytics Engine dataset (`AUTH_ANALYTICS` in
`wrangler.toml`), the adapter writes one data point per operation.
Query via SQL:

```sql
SELECT
  blob1 AS operation,
  blob2 AS model,
  COUNT() AS count,
  AVG(double1) AS avg_ms
FROM ba_cf_do_events
WHERE timestamp > NOW() - INTERVAL '5' MINUTE
GROUP BY 1, 2
```

## Production notes

This example uses defaults — for production tune:

- `session.cookieCache.maxAge` (5min is reasonable for most apps)
- Rate limit windows and limits
- Email verification flow (BA's `requireEmailVerification`)
- Add OAuth providers via `socialProviders`
