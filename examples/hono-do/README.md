# DO adapter — Hono example

Same shape as [`examples/hono`](../hono/) but uses the new
`do` adapter option. **No D1, no Hyperdrive.** Users and accounts live
in Durable Objects on the hot path; sessions live in KV via BA's
`secondaryStorage`.

> Verified working end-to-end against `wrangler dev --local` on
> 2026-05-18: anonymous signin, email signup, email signin, session
> validation, protected route, wrong-password rejection, duplicate-email
> rejection, sign-out. See [Local dev](#local-dev) below.

## What's different from `examples/hono`

| Concern                | examples/hono           | examples/hono-do                  |
| ---------------------- | ----------------------- | --------------------------------- |
| User + account storage | D1 (sqlite via Drizzle) | UserDurableObject (per principal) |
| Email uniqueness       | D1 unique constraint    | IdentityDurableObject             |
| Sessions               | D1                      | KV (BA `secondaryStorage`)        |
| Verification tokens    | D1                      | KV                                |
| Hot-path DB calls      | several per request     | zero                              |

## Local dev

```bash
# From the repo root: build the package once, then start the demo
pnpm install
pnpm build                  # builds dist/ that the demo consumes

cd examples/hono-do
pnpm install
pnpm dev                    # = wrangler dev --local
```

`wrangler dev --local` runs Miniflare with in-memory KV and SQLite-backed
DOs. The `REPLACE_WITH_KV_NAMESPACE_ID` placeholder in `wrangler.toml` is
fine for local — wrangler ignores it. For deploy, run
`wrangler kv namespace create KV` and paste the id.

### Smoke test (curl)

```bash
# Anonymous sign-in
curl -s -c /tmp/c.txt -X POST http://localhost:8787/api/auth/sign-in/anonymous \
  -H "Content-Type: application/json" -d '{}'

# Email signup
curl -s -X POST http://localhost:8787/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!","name":"Alice"}'

# Email signin
curl -s -c /tmp/alice.txt -X POST http://localhost:8787/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!"}'

# Authenticated request
curl -s -b /tmp/alice.txt http://localhost:8787/protected
# → {"ok":true,"userId":"...","sessionId":"...","isAnonymous":false,"storedIn":"durable-object"}
```

Each successful signup creates an IdentityDO entry (for email uniqueness)
and a UserDO entry. Re-running the signup with the same email returns
`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` — proving the IdentityDO
uniqueness primitive works without any database call.

## Wiring

The two important hooks: re-export the DO classes (so Cloudflare
registers them) and pass `do` instead of `d1`:

```ts
// src/index.ts — Worker entry
export { UserDurableObject, IdentityDurableObject } from "better-auth-cloudflare";
```

```ts
// src/auth/index.ts — withCloudflare config
withCloudflare(
    {
        do: { userDo: env.USER_DO, identityDo: env.IDENTITY_DO },
        kv: env.KV,
        cf: request.cf,
    },
    { emailAndPassword: { enabled: true }, plugins: [anonymous()] }
);
```

## Flows demonstrated

- Anonymous sign-in (no email; just one UserDO created)
- Email/password signup (IdentityDO.reserve → UserDO.create → IdentityDO.commit)
- Email/password signin (IdentityDO.lookup → UserDO.findPrincipal)
- Session validation (cookie cache 5min, BA secondaryStorage from KV on miss)
- Protected route
- Geolocation enrichment (from the `cloudflare` plugin, automatic)
- Sign out
- `/debug/region` endpoint (request cf data + DO mapping)
- Dev UI metadata panel (per-call response time, loading indicator)

## E2E tests

The demo ships with a vitest suite that exercises every BA flow end-to-end
against `wrangler dev`:

```bash
# In one terminal
pnpm dev

# In another
pnpm test:e2e
```

18 tests covering anonymous + email/password signup/signin/signout, duplicate
rejection, wrong-password rejection, protected route, session expiry,
multiple-user independence, geolocation. All green on the standard local
config.

## D1 auth data store for DO restore (optional)

### Architecture: auth never falls back to the DB

The Durable Objects are the **sole source of truth** for auth state.
Sign-in, session validation, find-user-by-email — all go through the DOs.
The DB is not queried during any auth flow.

When configured, every successful DO write is **one-way** mirrored to a
D1 database (the auth data store) on a best-effort basis. If a DO loses
its storage, `restorePrincipal` replays users +
accounts from D1 back into the DO. That is the only read path.

> **Future:** user-data and resume-data services (separate from auth)
> will need a different pattern — DO-primary with the DB kept queryable
> for admin/search/analytics. That's tracked in the package roadmap.

**Password hashes are deliberately NOT mirrored** to the auth data store —
they stay in the DO only. A restored user will need to reset their
password. This is an intentional security trade-off: a recovery-store
leak does not expose credentials.

Enable in three steps:

```bash
# 1. Create the D1 database
wrangler d1 create ba-cf-do-recovery

# 2. Paste the id into wrangler.toml (uncomment the [[d1_databases]] block)
#    and apply the schema:
wrangler d1 execute ba-cf-do-recovery --remote --file ./auth-data-schema.sql

# 3. Pass the binding to d1AuthDataStore() in src/auth/index.ts:
#    (already wired in this demo — fires only when AUTH_DB is bound)
```

Recovery flow from the Worker:

```ts
import { restorePrincipal, d1AuthDataStore } from "better-auth-cloudflare";

app.post("/admin/recover/:principalId", async c => {
    const result = await restorePrincipal({
        userDo: c.env.USER_DO,
        authDataStore: d1AuthDataStore(c.env.AUTH_DB),
        principalId: c.req.param("principalId"),
    });
    return c.json(result);
});
```

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

## Session storage caveat

In this v1 of the DO adapter, **sessions live in KV via BA's
`secondaryStorage`**, not in Durable Objects. The `auth/index.ts` config
explicitly sets `storeSessionInDatabase: false` to enforce this and
disables `geolocationTracking` on the session (which would otherwise
force sessions into the adapter path).

Hot-path effect: signature-only validation from the cookie cache (5min
TTL), then a KV read on cache miss — same global perf characteristics
as the upstream library's KV session path.

Moving sessions into DOs is a planned follow-up. The benefit would be
stronger regional residency for session metadata; the trade-off is
implementing token-only session lookup via a KV token→userId mapping
(BA's `findOne('session', { where: [{ field: 'token' }] })` doesn't
carry a userId hint).

## Production notes

This example uses defaults — for production tune:

- `session.cookieCache.maxAge` (5min is reasonable for most apps)
- Rate limit windows and limits
- Email verification flow (BA's `requireEmailVerification`)
- Add OAuth providers via `socialProviders`
