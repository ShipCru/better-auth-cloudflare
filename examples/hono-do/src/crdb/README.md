# CRDB + Hyperdrive (3-region) — setup checklist

The `crdb_multi` env in `wrangler.toml` routes auth writes through CockroachDB via Cloudflare Hyperdrive. Three CRDB Cloud clusters back it, one per region:

| CF region | AWS region       | binding           | purpose                              |
| --------- | ---------------- | ----------------- | ------------------------------------ |
| `enam`    | `us-east-2`      | `HYPERDRIVE_ENAM` | default for NA / unrouted continents |
| `weur`    | `eu-central-1`   | `HYPERDRIVE_WEUR` | EU residency                         |
| `apac`    | `ap-southeast-1` | `HYPERDRIVE_APAC` | AS + OC                              |

At request time the adapter picks the binding by `cf.continent`. Writes go to that region's primary; the other two clusters are independent (no cross-cluster replication in this design).

## One-time setup (operator)

1. **Create three CRDB Cloud Serverless clusters.** Sign in to https://cockroachlabs.cloud, create three clusters:
    - `ba-cf-us-east-2` in `aws-us-east-2`
    - `ba-cf-eu-central-1` in `aws-eu-central-1`
    - `ba-cf-ap-southeast-1` in `aws-ap-southeast-1`

    Note each cluster's connection string (looks like `postgresql://user:pass@host.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full`).

2. **Apply schema** to each cluster:

    ```bash
    psql "$ENAM_URL" -f src/crdb/migrations/0000_init.sql
    psql "$WEUR_URL" -f src/crdb/migrations/0000_init.sql
    psql "$APAC_URL" -f src/crdb/migrations/0000_init.sql
    ```

3. **Create three Hyperdrive configs** (one per region):

    ```bash
    wrangler hyperdrive create ba-crdb-enam --connection-string="$ENAM_URL"
    wrangler hyperdrive create ba-crdb-weur --connection-string="$WEUR_URL"
    wrangler hyperdrive create ba-crdb-apac --connection-string="$APAC_URL"
    ```

    Each command prints a Hyperdrive `id`. Paste those three ids into `wrangler.toml` under `[env.crdb_multi]` replacing `YOUR_HYPERDRIVE_*_ID`.

4. **Set BA secrets** on the variant:

    ```bash
    wrangler secret put BETTER_AUTH_SECRET --env crdb_multi
    wrangler secret put BETTER_AUTH_PEPPER --env crdb_multi
    ```

5. **Deploy:**

    ```bash
    wrangler deploy --env crdb_multi
    ```

6. **Wire the bench:** the variant is already declared in `examples/probe-worker/wrangler.toml` as `AUTH_BACKEND_CRDB_MULTI`. After deploy, redeploy the probe-worker so the binding picks up the new service.

## Smoke test

```bash
curl https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/geo
# Should return { colo, country, continent, ... }

curl -X POST https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2","name":"smoke"}'
# Should return a session cookie. The user row lands in the cluster
# matching cf.continent of the request's edge.

curl -X POST https://ba-cf-do-crdb-multi.steve-4b7.workers.dev/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2"}'
```

## Bench

The probe-worker exposes the variant as `crdb-multi`:

```bash
curl -X POST https://better-auth-cloudflare-probe.steve-4b7.workers.dev/probe \
  -H "Content-Type: application/json" \
  -d '{"variantId":"crdb-multi","op":"signup","n":30}'
```

Compare against `d1-unique-stateless`. Expected:

- **Signup** in the home region (NA→ENAM, EU→WEUR, APAC→APAC): ~250–500 ms (PBKDF2 hash + 2 Postgres round-trips). Should be **faster than D1** because Hyperdrive keeps the connection warm at the edge and CRDB's local-region writes are a single round-trip.
- **Signup across regions** (user in NA writing to EU cluster): still routed to NA (the adapter picks by `cf.continent`, not by user's home region). Per-cluster data sovereignty.
- **Signin warm**: ~50–150 ms (PBKDF2 + Postgres SELECT). Slightly slower than `d1-unique-stateless` (which is 22-85 ms) because Postgres always crosses an isolate boundary; D1 reads can serve from a CF replica.

## Schema

Minimal — only what BA requires:

- `users`: `id`, `name`, `email` (UNIQUE), `email_verified`, `image`, timestamps
- `accounts`: `id`, `user_id`, `provider_id`, `account_id`, `password` (for email/pw), OAuth tokens, timestamps

No `sessions` table (the variant runs `USE_STATELESS_SESSION=1` — the cookie is the session).  
No `verifications` table (forget-password flow not yet in this PR).  
No glass-specific columns (`stripe_customer_id`, `zendesk_id`, `legacy_id`, `permissions`, ...) — strip them in if your app needs them.

## Going further: single multi-region cluster + REGIONAL BY ROW

The 3-cluster design above gives strict per-region data isolation but no cross-region read replication. If you want **one cluster spanning three regions** with each user's row physically stored in their home region (CRDB's `LOCALITY REGIONAL BY ROW`):

1. Create ONE CRDB Cloud cluster, configure it as multi-region with all three regions.
2. Apply the schema once, then uncomment the `ALTER TABLE ... SET LOCALITY REGIONAL BY ROW` blocks at the bottom of `0000_init.sql`.
3. Use a SINGLE Hyperdrive binding instead of three.
4. The adapter still picks region from `cf.continent`, but uses it only as a hint passed to the query (the `WHERE crdb_region = $1` predicate) for partition pruning.

The 3-cluster design is what this PR ships because it's the cleanest hard-stop residency boundary; glass's pattern is the single-cluster REGIONAL BY ROW version.
