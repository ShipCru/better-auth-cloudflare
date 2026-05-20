# CRDB + Hyperdrive (2-region) — setup checklist

The `crdb_multi` env in `wrangler.toml` routes auth writes through CockroachDB via Cloudflare Hyperdrive. Two CRDB Cloud clusters back it:

| CF region | AWS region     | binding           | purpose                                            |
| --------- | -------------- | ----------------- | -------------------------------------------------- |
| `enam`    | `us-east-2`    | `HYPERDRIVE_ENAM` | NA + SA + AS + OC + AF + default (anything not EU) |
| `weur`    | `eu-central-1` | `HYPERDRIVE_WEUR` | EU residency (cf.continent === "EU")               |

APAC and AF traffic falls through to `enam` — one trans-Pacific or trans-Atlantic hop. Adding a third region is config-only: one more cluster + Hyperdrive, one more `if` in `pickRegion()`.

## One-time setup (operator)

### 1. Create two CRDB Cloud Serverless clusters

Sign in to https://cockroachlabs.cloud → Create cluster → Serverless. Create two:

| name                 | cloud | region         |
| -------------------- | ----- | -------------- |
| `ba-cf-us-east-2`    | AWS   | `us-east-2`    |
| `ba-cf-eu-central-1` | AWS   | `eu-central-1` |

Each cluster gives you a connection string of the form:

```
postgresql://<user>:<password>@<host>.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full
```

### 2. Apply schema to each cluster

```bash
psql "$ENAM_URL" -f src/crdb/migrations/0000_init.sql
psql "$WEUR_URL" -f src/crdb/migrations/0000_init.sql
```

### 3. Create two Hyperdrive configs

```bash
wrangler hyperdrive create ba-crdb-enam --connection-string="$ENAM_URL"
wrangler hyperdrive create ba-crdb-weur --connection-string="$WEUR_URL"
```

Each command prints a Hyperdrive `id`. Paste them into `wrangler.toml` under `[env.crdb_multi]` replacing `YOUR_HYPERDRIVE_ENAM_ID` and `YOUR_HYPERDRIVE_WEUR_ID`.

### 4. Set BA secrets

```bash
wrangler secret put BETTER_AUTH_SECRET --env crdb_multi
wrangler secret put BETTER_AUTH_PEPPER --env crdb_multi
```

### 5. Deploy + wire the bench

```bash
wrangler deploy --env crdb_multi
# Then redeploy probe-worker so the AUTH_BACKEND_CRDB_MULTI binding goes live
cd ../probe-worker && wrangler deploy
```

## Smoke test

```bash
curl https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/geo

curl -X POST https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2","name":"smoke"}'

curl -X POST https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2"}'
```

The user row lands in the cluster matching `cf.continent` of the request's edge: NA edges → us-east-2, EU edges → eu-central-1.

## Bench

```bash
curl -X POST https://better-auth-cloudflare-probe.steve-4b7.workers.dev/probe \
  -H "Content-Type: application/json" \
  -d '{"variantId":"crdb-multi","op":"signup","n":30}'
```

Compare against `d1-unique-stateless`. Expected:

- **Signup, NA edge → ENAM cluster** (same-region): PBKDF2 (~80 ms) + 2 Postgres round-trips over Hyperdrive (~30–80 ms) ≈ **150–300 ms p50 warm**. Should be competitive with `d1-unique-stateless` (438 ms p50 wnam).
- **Signup, EU edge → WEUR cluster** (same-region): similar, ~150–300 ms.
- **Signup, APAC edge → ENAM cluster** (cross-Pacific): ~500–800 ms expected (one ocean hop). For APAC parity with D1's number (916 ms), a third region in `ap-southeast-1` would help.
- **Signin warm**: ~50–150 ms (PBKDF2 + Postgres SELECT). Slightly slower than `d1-unique-stateless` (22–85 ms) because Postgres always crosses an isolate boundary.

## Schema

Minimal — only what BA requires:

- `users`: `id`, `name`, `email` (UNIQUE), `email_verified`, `image`, timestamps
- `accounts`: `id`, `user_id`, `provider_id`, `account_id`, `password` (for email/pw), OAuth tokens, timestamps

No `sessions` (stateless cookies), no `verifications` (forget-password not in scope), none of glass's app-specific columns. Each row in each cluster is local to that cluster — no cross-cluster replication.

## Going further: single multi-region cluster + REGIONAL BY ROW

The 2-cluster design above gives strict per-region data isolation but no cross-region read replication. If you want **one cluster spanning both regions** with each user's row physically stored in their home region (CRDB's `LOCALITY REGIONAL BY ROW` — the pattern glass uses):

1. Create ONE CRDB Cloud cluster, configure it as multi-region with both regions.
2. Apply the schema once, then uncomment the `ALTER TABLE ... SET LOCALITY REGIONAL BY ROW` blocks at the bottom of `0000_init.sql`.
3. Use a SINGLE Hyperdrive binding instead of two.
4. The adapter still picks region from `cf.continent`, but uses it only as a hint passed to the query (the `WHERE crdb_region = $1` predicate) for partition pruning.

The 2-cluster design is what this PR ships because it's the cleanest hard-stop residency boundary; glass's pattern is the single-cluster REGIONAL BY ROW version.
