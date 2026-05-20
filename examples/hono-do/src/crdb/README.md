# CRDB + Hyperdrive — single multi-region cluster

The `crdb_multi` env in `wrangler.toml` routes auth writes through ONE multi-region CockroachDB Cloud cluster via TWO Hyperdrive bindings (one per region's SQL gateway). Same cluster, same data — different ingress paths so each region's workers hit a local SQL gateway.

| CF region | CRDB region           | Hyperdrive binding | routed traffic          |
| --------- | --------------------- | ------------------ | ----------------------- |
| `enam`    | `us-east-2` (primary) | `HYPERDRIVE_ENAM`  | NA, SA, AS, OC, default |
| `weur`    | `eu-central-1`        | `HYPERDRIVE_WEUR`  | EU, AF                  |

`REGIONAL BY ROW` locality means each row's `crdb_region` column determines where it physically lives. The column defaults to `default_to_database_primary_region(gateway_region())` so the row lands in the region of whichever SQL gateway accepts the insert. Cross-region reads transparently fetch from the row's home region.

This is the glass-proven pattern.

## One-time setup (operator)

### 1. Create the multi-region cluster in CRDB Cloud

Sign in to https://cockroachlabs.cloud → **Create cluster** → **Serverless (Multi-region)**.

Configure:

- **Cluster name:** `ba-cf-multi`
- **Cloud:** AWS
- **Regions:** check both `us-east-2` and `eu-central-1`
- **Primary region:** `us-east-2`

The cluster gives you **two regional SQL gateway URLs**, one per region:

```
postgresql://USER:PASS@host.us-east-2.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full
postgresql://USER:PASS@host.eu-central-1.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full
```

Both URLs point at the same cluster; the difference is which SQL gateway the connection lands on. Each gateway is local to its region's nodes, so writes coming through it use that region as their default `crdb_region`.

### 2. Apply schema (once, against either URL)

Both URLs hit the same cluster — pick either and run:

```bash
psql "$ENAM_URL" -f src/crdb/migrations/0000_init.sql
```

The migration creates `users` + `accounts` and sets `LOCALITY REGIONAL BY ROW` on both, including the composite `(user_id, crdb_region)` FK that keeps account joins region-local.

### 3. Create two Hyperdrive configs (one per regional gateway)

```bash
wrangler hyperdrive create ba-crdb-enam --connection-string="$ENAM_URL"
wrangler hyperdrive create ba-crdb-weur --connection-string="$WEUR_URL"
```

Paste the two Hyperdrive ids into `wrangler.toml` under `[env.crdb_multi]` replacing `YOUR_HYPERDRIVE_ENAM_ID` and `YOUR_HYPERDRIVE_WEUR_ID`.

### 4. Set BA secrets + deploy

```bash
wrangler secret put BETTER_AUTH_SECRET --env crdb_multi
wrangler secret put BETTER_AUTH_PEPPER --env crdb_multi
wrangler deploy --env crdb_multi
cd ../probe-worker && wrangler deploy   # picks up the AUTH_BACKEND_CRDB_MULTI binding
```

## Smoke test

```bash
URL=https://ba-cf-do-crdb-multi.steve-4b7.workers.dev
curl $URL/api/geo

curl -X POST $URL/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2","name":"smoke"}'

curl -X POST $URL/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"crdb-smoke@example.com","password":"hunter2hunter2"}'
```

Verify the row landed in the right region:

```sql
SELECT id, email, crdb_region FROM users WHERE email = 'crdb-smoke@example.com';
```

## Bench

```bash
curl -X POST https://better-auth-cloudflare-probe.steve-4b7.workers.dev/probe \
  -H "Content-Type: application/json" \
  -d '{"variantId":"crdb-multi","op":"signup","n":30}'
```

Expected p50, compared with `d1-unique-stateless`:

- **Signup, NA edge → us-east-2 gateway**: PBKDF2 (~80 ms) + 2 Postgres round-trips (~30–80 ms) ≈ **150–300 ms**. Competitive with D1's 438 ms wnam.
- **Signup, EU edge → eu-central-1 gateway**: similar, ~150–300 ms.
- **Signup, APAC edge → us-east-2 gateway (fallback)**: ~500–800 ms (one trans-Pacific hop). For native APAC perf, add `ap-southeast-1` to the cluster's regions + a third Hyperdrive.
- **Signin warm**: ~50–150 ms (PBKDF2 + Postgres SELECT). D1 with replicas is faster (22–85 ms) because CRDB always crosses the SQL boundary.

## Schema

Minimal — only what BA requires + the REGIONAL BY ROW partition column:

- `users`: `id`, `crdb_region`, `name`, `email` (UNIQUE), `email_verified`, `image`, timestamps
- `accounts`: `id`, `crdb_region`, `user_id`, `provider_id`, `account_id`, `password`, OAuth tokens, timestamps

The composite `(user_id, crdb_region)` FK keeps `accounts → users` joins region-local. No `sessions` (stateless), no `verifications` (forget-password not in scope).

## Adding a third region later

1. CRDB Cloud → cluster → Add region (e.g., `ap-southeast-1`).
2. Add a third Hyperdrive: `wrangler hyperdrive create ba-crdb-apac --connection-string="$APAC_URL"`.
3. In `wrangler.toml` add a third `[[env.crdb_multi.hyperdrive]]` block.
4. In `examples/hono-do/src/crdb/adapter.ts` extend `CrdbRegion` and `pickRegion()` to map AS/OC continents to `ap-southeast-1`.
5. Update `crdbInternalRegion` in `schema.ts` to include the new region value.

The cluster auto-migrates existing rows on `ADD REGION`; new signups in APAC will land in the new region from then on.
