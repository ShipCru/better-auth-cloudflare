# better-auth-cloudflare (ShipCru fork)

> **Scope**: this fork adds Durable Object support, outbox + recovery helpers,
> and Drizzle schema exports to upstream `better-auth-cloudflare`. It is
> still focused on Better Auth. Domain DOs (UserDataDO, ResumeDataDO, etc.)
> belong in your application — but you can use the exported
> `createOutboxFlush()` helper to give them the same DO → D1 eventual-
> consistency sync pattern UserDurableObject uses.

Seamlessly integrate [Better Auth](https://github.com/better-auth/better-auth) with Cloudflare Workers, **Durable Objects**, D1, Hyperdrive, KV, R2, and geolocation services.

[![License: MIT](https://img.shields.io/npm/l/better-auth-cloudflare)](https://opensource.org/licenses/MIT)

> **Fork notice.** This is the [ShipCru fork](https://github.com/ShipCru/better-auth-cloudflare)
> of [`zpg6/better-auth-cloudflare`](https://github.com/zpg6/better-auth-cloudflare)
> (MIT, Copyright (c) 2025 Zach Grimaldi). Fork additions:
>
> - `do` adapter option — store BA `user` and `account` models in
>   per-principal SQLite-backed Durable Objects. No database call on
>   any user-facing hot path.
> - Two-DO model: `UserDurableObject` (per principal) +
>   `IdentityDurableObject` (per `sha256(email)`, global uniqueness).
> - `examples/hono-do/` and `examples/opennextjs-do/` — drop-in DO
>   equivalents of the upstream examples.
> - Structured logging + Analytics Engine telemetry helpers.
> - Skeleton types for multi-jurisdiction routing (Phase 2 — see Roadmap).
>
> Upstream features (D1, Hyperdrive, KV, R2, geolocation, IP detection,
> CLI) work unchanged. The fork is additive.

**LIVE DEMOS** (upstream, D1-backed):

- **OpenNextJS**: [https://better-auth-cloudflare.zpg6.workers.dev](https://better-auth-cloudflare.zpg6.workers.dev/)
- **Hono**: [https://better-auth-cloudflare-hono.zpg6.workers.dev](https://better-auth-cloudflare-hono.zpg6.workers.dev/)

Demo implementations are available in the [`examples/`](./examples/) directory for **OpenNextJS ◆**, **Hono 🔥**, and the new DO-backed variants (`hono-do`, `opennextjs-do`).

## Features

- 🗄️ **Database Integration**: Support for D1 (SQLite), Postgres, and MySQL databases via Drizzle ORM, or native D1 without Drizzle.
- 🚀 **Hyperdrive Support**: Connect to Postgres and MySQL databases through Cloudflare Hyperdrive.
- 🔌 **KV Storage Integration**: Optionally use Cloudflare KV for secondary storage (e.g., session caching).
- 📁 **R2 File Storage**: Upload, download, and manage user files with Cloudflare R2 object storage and database tracking.
- 📍 **Automatic Geolocation Tracking**: Enrich user sessions with location data derived from Cloudflare.
- 🌐 **Cloudflare IP Detection**: Utilize Cloudflare's IP detection headers out-of-the-box.
- 🔍 **Rich Client-Side Context**: Access timezone, city, country, region, and more via the client plugin.
- 📦 **CLI**: Tools for getting started quickly with Hono or Next.js, managing database schema, and more.

## Roadmap

**Storage adapters:**

- [x] IP Detection
- [x] Geolocation
- [x] D1
- [x] Hyperdrive (Postgres/MySQL)
- [x] KV
- [x] R2
- [x] **Durable Objects** _(ShipCru fork)_ — DOs as source of truth on the hot path, D1 auth-data store as one-way downstream sync target. See `examples/hono-do`.
- [x] **Outbox helper** _(ShipCru fork)_ — `createOutboxFlush()` reusable across any DO that needs eventually-consistent sync to a downstream store. See `src/outbox.ts`.
- [x] **Drizzle schema export** _(ShipCru fork)_ — `import { users, accounts } from "better-auth-cloudflare/db/schema"` for type-safe migrations and queries.
- [x] **D1 auth data store** _(ShipCru fork)_ — `d1AuthDataStore` + `restorePrincipal` for DR + admin dashboards.
- [x] **Recovery sync within 10s** _(ShipCru fork)_ — waitUntil-based immediate drain + 3s alarm fallback. Mandatory eventual consistency.
- [x] **KV-backed sessions** — BA secondaryStorage pattern, unchanged from upstream.
- [ ] Cloudflare Email
- [ ] Cloudflare Images
- [x] **KV write-through cache in front of IdentityDO** _(ShipCru fork — `kv-cache`, `stacked`, `recommended` variants)_ — adapter writes `kv.put('identity:'+emailHash, {principalId, version})` in the same `waitUntil` as every IdentityDO commit/disable. Sign-in's `email→principal_id` lookup reads KV first (5-30ms globally) and falls back to IdentityDO on miss. **Freshness model:** IdentityDO stays the consistency floor for the `reserve()` uniqueness check; writes are write-through with monotonic `version` so the rare KV propagation race is detectable.
- [x] **Replace IdentityDO with D1 UNIQUE index** _(ShipCru fork — `d1-unique`, `d1-unique-stateless` variants)_ — D1 table with `UNIQUE (email_hash)` gives identical uniqueness guarantees with ~30-80ms reads. **Measured:** signup p50 ~2.1s → ~0.8s in WEUR, ~3.2s → ~1.0s in APAC. See [Benchmark results](#benchmark-results-multi-region-signup-p50) below. IdentityDO remains the default; opt-in via `USE_D1_IDENTITY=1`.
- [x] **D1 Sessions API for read replicas** _(ShipCru fork)_ — `db.withSession("first-unconstrained")` is wired on every read path through the `identity_index` cache and `d1IdentityStore.lookup`. Writes still go to the primary; eventual consistency is bounded and survivable for auth metadata.
- [ ] **Multi-region D1 deployments + jurisdiction routing** — see [Multi-region D1 plan](#multi-region-d1--jurisdiction-routing-plan) below for the full design. **Phase 1:** single D1 primary moved to `enam` (closest to NA + EU). **Phase 2:** add a second D1 primary in `weur` for EU-resident principals, with a per-principal `home_region` claim recorded at signup and a Worker-level router that picks the right database. **Phase 3:** APAC primary if traffic justifies it.
- [ ] **Multi-database sharding within a region** — hash principal_id mod N across DB shards inside a jurisdiction. Supports growth beyond a single DB (~10GB D1 ceiling per database). Compose with the jurisdiction layer above.
- [ ] **Active DO dashboard** — read-only admin view of active principal DOs with location, region, and storage size
- [ ] **Hash-sharded UserDOs** — opt-in mode where principal_id → `userDo.idFromName("shard:" + hash(id) % N)` so cold starts amortize across many users. Trade-off: lose 1:1 principal:DO isolation; cap of ~256MB SQLite per shard.

**Performance / observability:**

> **Workload assumption.** Optimise for the typical pattern: a user signs up _once_, then returns days/weeks later — possibly from a different region. That puts **sign-in, `get-session`, and session-validation reads** on the hot path, not signup. Signup latency matters but a 1-3s signup is acceptable when sign-in and reads are sub-100ms globally. The roadmap below is ordered for that profile.
>
> **Bench-validated baseline** (measured in `examples/opennextjs-do/bench`, SJC colo, against the deployed Worker as of PR #5):
>
> - `warm-burst-signin` × 8 → 662-748 ms (p50 668, p95 721). Steady-state is dominated by scrypt CPU + 1 warm DO RPC.
> - `cold-burst-signup` × 4 → 2240-2735 ms (p50 2251, p95 2618). DO instances do **not** meaningfully warm up across fresh cold starts in the same colo.
> - `anon-burst` × 5 → 1267-2253 ms. Anon signin has no IdentityDO involvement so it's mostly UserDO cold-start cost.
>
> The two highest-ROI next changes (per the bench): **KV cache in front of IdentityDO** (sign-in hot path) and **D1 UNIQUE replacement for IdentityDO** (signup tail). Both are scaffolded as variants in the bench picker.

- [x] **Structured per-method timing** _(ShipCru fork)_ — every DO RPC and adapter method emits `{op, durationMs, status}` via `timed(logger, op, fn)`. Visible in `wrangler tail --format=json` and Cloudflare Workers Logs.
- [x] **Per-request log middleware** _(ShipCru fork)_ — one info line per Hono request with `{requestId, op, durationMs, status, colo, country}`. Indexable for p50/p95/p99 dashboards.
- [x] **D1 query timing** _(ShipCru fork)_ — `d1AuthDataStore` wraps every prepare/run/all/first in `timed()`.
- [x] **In-process freshness cache for create→findOne** _(ShipCru fork)_ — eliminates BA's post-create refetch DO RPC. Per-isolate map, 5s TTL, one-shot consume.
- [x] **Skip IdentityDO pre-existence check on signup** _(ShipCru fork)_ — `findOne(user, email)` without `join.account` short-circuits; `reserve()` in create remains the authoritative uniqueness gate. Drops signup p95 from ~6s to ~3.5s.
- [ ] **Extensive global benchmarking suite** — k6 / autocannon scenarios for anon-signin, email-signup, email-signin, get-session. Runners pinned to multiple Cloudflare colos (SJC, LHR, FRA, NRT, SYD) so we measure real geo latency, not local. Output: per-op p50/p95/p99 across regions, weekly-tracked.
- [ ] **Global performance monitoring dashboard** — Cloudflare Analytics Engine + Grafana. Per-op SLO panels, error-budget burn rate, DO cold-start frequency, KV/D1 read tail latency by colo. Alerts wired to Cloudflare Notifications when p95 exceeds budget.
- [ ] **Per-endpoint perf budgets** — declared in code (e.g., `sign-up/email: p95 < 1500ms`), enforced by the benchmark suite in CI. PRs blocked when a perf regression is detected.
- [ ] **Configurable password-hash cost** — BA defaults to scrypt(N=16384, r=16, p=1), which costs ~1.5-3.5s of CPU on a Worker isolate. Expose `emailAndPassword.password.hash` overrides in the demo with documented presets (`secure` = BA default, `balanced` = N=4096, `fast` = bcrypt cost 10). Currently the single largest sub-second contributor on the warm signup path.
- [ ] **Smart placement / `locationHint` on DO creation** — when `cf.continent` is available, pass `locationHint: "wnam" | "enam" | "weur" | …` to `idFromName()` so the DO is placed near the user on first write. Should reduce cold-start RTT for non-NA traffic.

**KV performance optimizations** _(hot path = sign-in + get-session)_:

- [ ] **KV write-through cache for sessions** — BA already uses KV via secondaryStorage. Audit the read path so a warm session lookup is one KV GET (no DO RPC). Profile `get-session` end-to-end to find any code that double-reads.
- [ ] **In-isolate L1 cache in front of KV** — short-TTL (~30s) Map cache per Worker isolate for session blobs. Same-isolate repeat reads (very common during a multi-request page load) skip KV entirely. Watch out for session invalidation propagation — clear local entry on sign-out.
- [ ] **KV cache for email → principal_id index** — write-through on signup, read-first on sign-in. KV is globally replicated (~5-30ms anywhere), so this turns the cross-region IdentityDO/D1 read into a fast local read for the 99% case. D1 UNIQUE stays as the consistency floor for the eventual-consistency window.
- [ ] **KV cache for `findUserById`** — same pattern for the `findOne(user, id)` path BA uses inside session validation. Invalidate on `updatePrincipal`.
- [ ] **KV cache priming on signup** — when `create(user)` lands, write KV entries for `email_hash` and `principal_id` in the same `waitUntil` that drains the outbox. First post-signup sign-in is then already-cached.
- [ ] **Bulk KV reads in session validation** — combine session + user + account lookups into a single `Promise.all` with all three KV GETs in parallel.
- [ ] **Document KV consistency model + TTL choices** — README section explaining when stale reads are acceptable (sessions, profile data) vs when they are not (email uniqueness — backed by D1 UNIQUE; password verification — bypasses cache).

**Deployment + CI/CD:**

- [ ] **Automatic git deployment** — GitHub Actions workflow that on push to `main` runs `pnpm build` then `wrangler deploy` for each Worker in `examples/*` whose source changed (path filter). Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) live in GitHub Actions secrets; per-Worker secrets like `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_*` injected via `wrangler secret put` from CI. No manual `wrangler deploy` from a laptop.
- [ ] **Per-PR preview deployments** — each PR gets a `*-pr-<n>.workers.dev` preview environment built from the PR head. Drops the manual "deploy then ask user to verify" loop. Bench page becomes a per-PR demo, and reviewers can A/B against prod in real time.
- [ ] **Drift detection** — daily job that diffs `wrangler.toml` declared bindings vs `wrangler deployments list` actual state. Surfaces "production has secrets/bindings that no longer match the repo" before it becomes an incident.
- [ ] **Database schema sync in CI** — for D1, on push run `wrangler d1 execute --remote --file auth-data-schema.sql` against the recovery DB. Detects schema drift, fails the build if migrations would be data-destructive.

**Geo + abuse / rate-limiting hardening:**

> Cloudflare gives us a lot of geo + network signal for free on every request (`cf.colo`, `cf.country`, `cf.city`, `cf.asn`, `cf.tlsVersion`, etc.). The bench API and UI now surface all of it. Below are the concrete auth uses we want to wire.

- [x] **Surface full geo + network metadata in bench results** _(ShipCru fork)_ — `colo`, `country`, `continent`, `region`, `regionCode`, `city`, `postalCode`, `timezone`, `lat/lng`, `asn`, `asOrganization`, `tlsVersion`, `tlsCipher`. Visible in the `/bench` UI under "geo + network metadata".
- [x] **IP rate limiting** _(via BA core)_ — `rateLimit.enabled = true` with `customRules` for `/sign-in/email`, `/sign-up/email`, `/forget-password`. BA keys by IP using the configured `ipAddressHeaders` (we set `cf-connecting-ip` first). See `examples/hono-do/src/auth/index.ts`.
- [ ] **Per-account rate limit** — N failed signin attempts within a window → temporary account lockout. Currently only per-IP, so an attacker can rotate IPs. Lock the account itself (UserDO state) after 5 failures in 15 min, surface a meaningful error.
- [ ] **Captcha after N failures** — turnstile or hcaptcha challenge after the per-IP or per-account rate-limit window expires. Don't block signin entirely; force a humanity check.
- [ ] **Anomalous geo email** — on first signin from a "new" country (country not seen in `session.country` history), send a "new sign-in from $city, $country" email. Stores per-principal country set in the UserDO; new-country event triggers the email.
- [ ] **Country / ASN allow/deny list** — `auth.config.allowedCountries` / `deniedAsns` config. Reject sign-in / sign-up requests from disallowed regions or known-bad ASNs (datacenter ranges if you don't want bot signups). Pulls from `cf.country` and `cf.asn`.
- [ ] **TLS fingerprint anomaly detection** — log `cf.tlsClientCiphersSha1` + `cf.tlsClientExtensionsSha1` per session. Surface in admin dashboard. Sudden cipher-suite change for an established session is a strong account-takeover signal.
- [ ] **Geo-aware UX** — return `cf.country` to the client at signup so the form can default to local language / currency / TOS jurisdiction.
- [ ] **Residency routing by geo** — pair with the multi-region D1 work above. `cf.continent` picks which regional D1 to write to so EU users' principals live in EU D1. Hard-stop residency boundary.

**Collaborative editing primitives (Glass / ShipCru-specific):**

- [ ] **ResumeDurableObject** with WebSocket Hibernation API (`ctx.acceptWebSocket`). One DO per resume, holds canonical document, broadcasts edits to all connected sessions, hibernates when idle. Auth-gated via session cookie verification before `acceptWebSocket`. Op-log + periodic snapshot; CRDT-friendly (LWW or Yjs-compatible binary deltas).
- [ ] **Presence / cursor sync** — extension of ResumeDO; broadcasts ephemeral cursor positions and user color via separate WS message kind, never written to storage.
- [ ] **Multi-doc bulk-edit DO** — when one principal opens N resumes at once (typical for batch operations), share a single DO connection instead of N WebSockets.

**CLI:**

- [x] `generate` - Create new projects from Hono/Next.js templates with automatic Cloudflare resource setup
- [ ] `integrate` - Add `better-auth-cloudflare` to existing projects, creating/updating auth and schema files
- [x] `migrate` - Update auth schema and run database migrations when configuration changes
- [ ] `provision` - Read `shipcru-auth.config.ts` (or equivalent) and create per-jurisdiction Cloudflare resources (D1/KV/Hyperdrive/DO namespaces) idempotently
- [ ] `plugin` - Generate empty Better Auth plugin for quickly adding typesafe endpoints and schema fields
- [x] `version` - Check the version of the CLI
- [x] `help` - Show all commands and their usage

**Examples:**

- [x] Hono (D1)
- [x] OpenNextJS (D1)
- [x] **Hono with DO** (`examples/hono-do/`) — full working demo
- [x] **OpenNextJS with DO** (`examples/opennextjs-do/`) — scaffold + migration recipe
- [ ] **vinext** — Next.js on Cloudflare via [vinext](https://www.npmjs.com/package/vinext), DO-backed
- [ ] SvelteKit (+ Hyperdrive)
- [ ] TanStack Start (+ Durable Objects)

**Observability & testing:**

- [x] Structured logging (`createLogger`)
- [x] Analytics Engine telemetry helpers (`createAnalyticsRecorder`)
- [x] **Multi-region bench harness** _(ShipCru fork)_ — `examples/probe-worker` exposes `POST /probe` and fans out to `locationHint`-pinned `ProbeDurableObject`s in nine CF regions. The `/bench` UI in `examples/opennextjs-do` consumes it. See [Benchmark results](#benchmark-results-multi-region-signup-p50).
- [ ] Active-DO dashboard endpoint (`GET /api/auth/admin/active-objects`)
- [ ] Benchmark suite with geo-distributed runners on a cron (currently invoked manually)

## Architecture (ShipCru fork)

```
                 ┌───────────────────────────────────────────┐
                 │           CF edge (any colo)              │
                 │                                           │
   user ───────► │  Hono Worker (better-auth-cloudflare)     │
                 │   │                                       │
                 │   │   1. PBKDF2/scrypt + HMAC pepper      │
                 │   │   2. session = signed cookie          │
                 │   │      (no KV PUT in stateless mode)    │
                 │   ▼                                       │
                 │  do-adapter (createDoAdapter)             │
                 │   │  ┌────────────┐ ┌──────────────────┐  │
                 │   │  │identityIndex│ │ d1IdentityStore  │  │
                 │   │  │ cache (KV+D1)│ │ (UNIQUE INSERT) │  │
                 │   │  │ — read path │ │ — source of truth│  │
                 │   │  │              │ │  when enabled    │  │
                 │   │  └─────┬───────┘ └────┬─────────────┘  │
                 │   ▼        ▼              ▼                │
                 │  ┌─────────────────────────────────────┐   │
                 │  │ Cloudflare bindings                 │   │
                 │  │  USER_DO  : per-principal DO (SQLite)│  │
                 │  │  IDENTITY_DO: per-email-hash DO     │   │
                 │  │  KV       : session mirror (optional)│  │
                 │  │  AUTH_DB  : D1 in enam              │   │
                 │  │             ├─ identity_unique      │   │
                 │  │             ├─ identity_index (cache)│   │
                 │  │             └─ users + accounts (DR)│   │
                 │  └─────────────────────────────────────┘   │
                 └───────────────────────────────────────────┘
```

**Two DO classes, one D1, one KV.** `UserDurableObject` is the per-principal source of truth (BA's `user` + `account` models in SQLite). `IdentityDurableObject` holds the `sha256(email) → principal_id` uniqueness map and is the consistency floor for the default path. In the `d1-unique` path the IdentityDO is bypassed entirely; D1's `UNIQUE` constraint is the consistency floor instead.

**Sibling deploys for A/B.** `examples/hono-do/wrangler.toml` defines ten sibling environments (`current`, `thick`, `fast_hash`, `pbkdf2`, `kv_cache`, `stacked`, `recommended`, `stateless`, `d1_unique`, `d1_unique_stateless`). Each gets its own DO namespace + KV + D1 binding so bench comparisons are clean. Same source code; behaviour switched by env vars (`USE_PBKDF2`, `USE_KV_CACHE`, `USE_BUNDLE_RPC`, `USE_STATELESS_SESSION`, `USE_D1_IDENTITY`, `USE_FAST_HASH`, `USE_THICK_IDENTITY`).

**Bench harness.** `examples/probe-worker` exposes `POST /probe { variantId, op, n, regions? }`. It owns nine `ProbeDurableObject`s — one per CF region, pinned via `locationHint`. Each probe holds service bindings to all ten variants and invokes them by `bindingName`. Fan-out is `Promise.all` across regions, sequential `n` calls per region. `examples/opennextjs-do/src/app/bench` is the user-facing UI.

**Hot-path cost model.** Signup latency = `cross-region D1 INSERT (200–500 ms)` + `PBKDF2/scrypt CPU (250–600 ms)` + `local UserDO create (5–30 ms)`. Signin latency = `D1 lookup via Sessions API (50–250 ms)` + `cookie decrypt (1–5 ms)`. The biggest knob is whether the password hash is JS scrypt (slow) or native PBKDF2 (fast) — see `src/auth/*.ts`.

## Benchmark results (multi-region)

n=30 per region per op, 2026-05-19, D1 primary in `enam` with **read replication = `auto`**. All times in ms (p50). Lower is better.

### Signup p50 (ms) — cold path, fresh email each iteration

| variant                                     |    wnam |    enam |     sam |    weur |    eeur |    apac |      oc |      me |     afr |
| ------------------------------------------- | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: |
| current (baseline)                          |    2003 |    1776 |    1768 |    1192 |    1636 |    3230 |    3570 |    1523 |    1278 |
| thick-identity                              |    2022 |    1880 |    1881 |    1221 |    1670 |    3235 |    3596 |    1467 |    1273 |
| fast-hash (scrypt N=4096)                   |    1805 |    1725 |    1644 |    1122 |    1528 |    3181 |    3358 |    1361 |    1126 |
| pbkdf2-fast                                 |    1807 |    1631 |    1517 |    1096 |    1596 |    3075 |    3365 |    1354 |    1103 |
| kv-cache                                    |    2018 |    1841 |    1811 |    1218 |    1722 |    3167 |    3582 |    1480 |    1282 |
| stacked (fast-hash + kv-cache)              |    1821 |    1682 |    1561 |    1121 |    1509 |    3064 |    3303 |    1409 |    1123 |
| recommended (pbkdf2 + pepper + kv + bundle) |    1775 |    1646 |    1582 |    1060 |    1469 |    3126 |    3352 |    1341 |    1102 |
| stateless (recommended − KV session)        |    1216 |    1200 |    1098 |    1024 |    1355 |    1624 |    1727 |    1166 |    1033 |
| d1-unique                                   |    1176 |    1108 |     982 |     629 |     871 |    2290 |    2546 |     781 |     647 |
| **d1-unique-stateless**                     | **655** | **602** | **532** | **523** | **691** | **870** | **901** | **653** | **549** |

### Signin p50 (ms) — warm path, same user repeated. Stateful variants now defer KV session-write via `waitUntil`.

| variant                 |   wnam |   enam | sam | weur | eeur | apac |   oc |  me | afr |
| ----------------------- | -----: | -----: | --: | ---: | ---: | ---: | ---: | --: | --: |
| current (baseline)      |     46 |     76 |  96 |   42 |   58 |   86 |  107 | 119 |  51 |
| thick-identity          |     43 |     46 |  33 |   36 |   21 |   33 |   53 |  46 |  39 |
| fast-hash               |     47 |     18 |  52 |   52 |   40 |   47 |   63 |  74 |  54 |
| pbkdf2-fast             |     57 |     77 |  62 |   45 |   51 |   19 |   65 |  21 |  46 |
| kv-cache                |     60 |     28 |  55 |   58 |  107 |   31 |  109 |  23 |  55 |
| stacked                 |     32 |     54 |  43 |   27 |   37 |   49 |  124 |  16 |  35 |
| recommended             | **27** | **14** |  32 |   29 |   26 |   32 |   60 |  31 |  33 |
| **stateless**           | **15** | **32** |  19 |   14 |   66 |   13 |   39 |  25 |  17 |
| d1-unique               |    463 |    469 | 422 |  103 |  187 | 1231 | 1454 | 171 | 111 |
| **d1-unique-stateless** |     22 |     62 |  24 |   25 |   46 |   40 |   85 |  29 |  43 |

### Signout p50 (ms, n=30) — fresh signin then immediate signout

| variant                 |  wnam |  enam |    sam |  weur |  eeur |  apac |    oc |    me |   afr |
| ----------------------- | ----: | ----: | -----: | ----: | ----: | ----: | ----: | ----: | ----: |
| current                 |   175 |    74 |    136 |    87 |    84 |   204 |   369 |    86 |   236 |
| thick-identity          |   205 |    67 |    196 |     0 |   104 |   184 |   444 |    92 |   222 |
| fast-hash               |   282 |    56 |    186 |    85 |    99 |   162 |   298 |    78 |   174 |
| pbkdf2-fast             |   205 |    59 |    196 |    85 |   105 |   144 |   348 |   135 |   222 |
| kv-cache                |   282 |    62 |    153 |    82 |   103 |   185 |   369 |    92 |   235 |
| stacked                 |   263 |    69 |    145 |    72 |   104 |   205 |   328 |    84 |   222 |
| recommended             |   167 |    72 |    240 |   112 |   111 |   226 |   376 |   100 |   222 |
| **stateless**           | **0** | **0** |  **5** | **0** | **0** | **0** | **0** | **0** | **0** |
| d1-unique               |   262 |    65 |    196 |    93 |   102 |   205 |   363 |    88 |   214 |
| **d1-unique-stateless** | **0** | **0** | **17** | **0** | **0** | **0** | **0** | **0** | **0** |

Stateful variants spend 60-440 ms on signout despite KV DELETE being deferred via `waitUntil`. Most of that is BA's session-lookup GET (which can't be deferred — needs to confirm the session exists before deleting). The remaining latency is the BA handler itself + cookie unset. Stateless paths skip this entirely because there's no server-side session to look up — the cookie clear is enough.

### Dup-signup p50 (ms, n=30) — EMAIL_ALREADY_EXISTS error path

| variant             | wnam | enam |  sam | weur | eeur | apac |   oc |  me |  afr |
| ------------------- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --: | ---: |
| current             | 1004 |   65 |  793 |  125 |   40 |   81 | 1305 | 103 | 1127 |
| thick-identity      | 1041 |   88 | 1139 |  534 |   77 |   81 | 1201 |  69 | 1127 |
| fast-hash           | 1041 |   34 |  932 |  534 |  103 |   95 | 1201 |  56 | 1100 |
| pbkdf2-fast         | 1041 |   34 |   66 |   80 |   77 |   30 | 1201 |  54 |  207 |
| kv-cache            | 1004 |   68 | 1139 |  534 |  103 |   69 | 1042 |  56 |  697 |
| stacked             | 1041 |   65 |  753 |  125 |   77 |   86 |  963 |  69 |  697 |
| recommended         |  936 |   68 |  793 |  456 |   74 |   79 | 1201 |  64 |  697 |
| stateless           |  936 |   68 |  793 |  534 |  103 |   77 |  963 |  61 | 1127 |
| d1-unique           |  693 |  656 |  676 |  639 |  728 |  935 |  913 | 701 |  602 |
| d1-unique-stateless |  758 |  684 |  691 |  587 |  747 |  996 |  944 | 728 |  677 |

The bimodal IdentityDO numbers (cheap in enam/eeur/apac/me, expensive in wnam/sam/oc/afr) come from BA's early `findOne(user, email, join.account=true)` hitting the warm IdentityDO and short-circuiting — except in regions where the bench-run's prepareUser created the IdentityDO in a different colo from where the dup-signups land. D1-unique stays consistent (~600-1000 ms) because its `findOne` skip-path doesn't catch dup-email; the recommended `Promise.race` against the KV `identity_index` pre-check in the roadmap below would flatten this.

### Top 3 implementations — side-by-side across every op

Picking the three production-viable picks and showing every op's p50 (ms, n=30) head-to-head. Lower is better.

#### 1. `d1-unique-stateless` — best overall, recommended default

Sub-1 s signup globally, sub-100 ms signin globally, instant signout. Stateless cookie (no remote revocation), slow dup-email path. Best for high-volume apps where you'd rather rotate the signing secret than revoke individual sessions.

| op                   | wnam | enam | sam | weur | eeur | apac |   oc |  me | afr |
| -------------------- | ---: | ---: | --: | ---: | ---: | ---: | ---: | --: | --: |
| signup               |  438 |  657 | 689 |  430 |  793 |  916 |  788 | 666 | 501 |
| signin (warm)        |   22 |   62 |  24 |   25 |   46 |   40 |   85 |  29 |  43 |
| signout              |    0 |    0 |  17 |    0 |    0 |    0 |    0 |   0 |   0 |
| dup-signup           |  758 |  684 | 691 |  587 |  747 |  996 |  944 | 728 | 677 |
| lifecycle (su+so+si) |  701 |  717 | 631 |  606 |  765 | 1010 | 1004 | 686 | 624 |

#### 2. `recommended` — best stateful (revocable, full security stack)

PBKDF2 + HMAC pepper + KV identity cache + bundle RPC + KV-backed sessions, with `waitUntil`-deferred KV writes. Sub-30 ms warm signin, revocable sessions (sign-out invalidates server-side), defense against offline DB-leak attacks via the server-side pepper. Slow signup. Best for enterprise apps with security/revocation requirements.

| op                   | wnam | enam |  sam | weur | eeur | apac |   oc |   me |  afr |
| -------------------- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| signup               | 1721 | 1526 | 1759 | 1200 | 1687 | 2268 | 2388 | 1413 | 1446 |
| signin (warm)        |   27 |   14 |   32 |   29 |   26 |   32 |   60 |   31 |   33 |
| signout              |  167 |   72 |  240 |  112 |  111 |  226 |  376 |  100 |  222 |
| dup-signup           |  936 |   68 |  793 |  456 |   74 |   79 | 1201 |   64 |  697 |
| lifecycle (su+so+si) | 2273 | 2226 | 2017 | 1212 | 1983 | 4409 | 4792 | 1573 | 1257 |

#### 3. `stateless` — fastest signin, simplest model

Same DO architecture as `recommended` but drops BA's KV `secondaryStorage` entirely — the signed cookie _is_ the session. Sub-40 ms signin global, instant signout, but no remote revocation and moderate signup cost. Best for read-heavy apps where signin is the only hot op and rotation > revocation.

| op                   | wnam | enam |  sam | weur | eeur | apac |   oc |   me |  afr |
| -------------------- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| signup               | 1469 | 1358 | 1593 | 1215 | 1537 | 1861 | 1986 | 1367 | 1440 |
| signin (warm)        |   15 |   32 |   19 |   14 |   66 |   13 |   39 |   25 |   17 |
| signout              |    0 |    0 |    5 |    0 |    0 |    0 |    0 |    0 |    0 |
| dup-signup           |  936 |   68 |  793 |  534 |  103 |   77 |  963 |   61 | 1127 |
| lifecycle (su+so+si) | 1400 | 1374 | 1250 | 1062 | 1432 | 2047 | 2113 | 1294 | 1116 |

**My pick:** `d1-unique-stateless` for the default; fall back to `recommended` if you need server-side session revocation. `stateless` is a niche choice (you only care about signin and accept signup at the recommended floor).

### D1 primary location — what if the database is far from the user?

The default `d1-unique` family points at `ba-cf-do-recovery-enam` (primary in `enam`, read replicas auto). To answer "what if the database is on the other side of the planet," there's now a sibling deploy `d1-unique-stateless-apac` backed by `ba-cf-do-recovery-apac` (primary in `apac`, replicas auto). Same code, only the primary changes.

Head-to-head p50 (ms, n=30), `d1-unique-stateless`:

**Signup** (one D1 INSERT to primary per request):

| region | D1 primary in enam (default) | D1 primary in apac (far away) | delta |
| ------ | ---------------------------: | ----------------------------: | ----: |
| wnam   |                          662 |                           655 |    −7 |
| enam   |                          603 |                           595 |    −8 |
| weur   |                          529 |                           539 |   +10 |
| eeur   |                          682 |                           700 |   +18 |
| apac   |                          875 |                           908 |   +33 |
| oc     |                          889 |                           905 |   +16 |
| me     |                          621 |                           621 |     0 |
| afr    |                          574 |                           561 |   −13 |

Signup latency moves by ≤33 ms regardless of where the D1 primary sits. The PBKDF2 hash + UserDO RPC dominate; the cross-region INSERT is a small slice of the total because CF's internal network is fast.

**Signin** (one D1 SELECT via Sessions API → reads from nearest replica):

| region   | D1 primary in enam (default) | D1 primary in apac (far away) |    delta |
| -------- | ---------------------------: | ----------------------------: | -------: |
| wnam     |                           30 |                            72 |      +42 |
| enam     |                           54 |                            72 |      +18 |
| weur     |                           29 |                            42 |      +13 |
| eeur     |                           64 |                            52 |      −12 |
| **apac** |                      **134** |                        **21** | **−113** |
| **oc**   |                       **85** |                        **44** |  **−41** |
| me       |                           31 |                            52 |      +21 |
| afr      |                           36 |                            39 |       +3 |

**Headline finding:** with read replication enabled, the primary's physical location barely matters for signin reads — D1 serves them from the nearest replica. Moving the primary to APAC makes APAC signin **−84% faster** (replica AND primary are local now), penalising NA users by only +18–42 ms (their reads come from an NA replica that fetches + caches from the APAC primary on first miss; warm reads are fast).

**Practical conclusion:** put the D1 primary wherever your _writes_ (signups) come from most, then let Sessions API + replicas handle reads everywhere. For a mostly-NA user base, `enam` is right. For an APAC-first product, `apac` is right. For a balanced global product, either works within ~50 ms of the other and the delta is dominated by which region you optimize signin latency for.

### Get-session p50 (ms, n=30)

The probe-worker calls `GET /api/auth/get-session` with **no cookie** — all variants return `{session:null,user:null}` in ≤30 ms p95 globally (often ≤1 ms). For warm authenticated `get-session`, see the lifecycle bench above where the second-iteration signin within the same probe DO benefits from cookieCache (sub-100 ms p50 stateless / d1-unique-stateless).

### DB vs DO for the typical hot path

In one paragraph: **DO is fractionally faster on warm signin (15-66 ms vs 22-85 ms for the stateless pair, ~20-50 ms gap); D1 is dramatically faster on signup (-40% to -68% everywhere)**. Both stateless variants beat every legacy variant on signin by an order of magnitude because they skip the KV session write. The difference between them on signin is the lookup: `stateless` reads from IdentityDO; `d1-unique-stateless` reads from D1 via Sessions API.

Direct head-to-head, signup (cold path):

| region | `recommended` (IdentityDO) | `d1-unique-stateless` (D1) |   DO − D1 |
| ------ | -------------------------: | -------------------------: | --------: |
| wnam   |                       1775 |                        655 | **+1120** |
| enam   |                       1646 |                        602 | **+1044** |
| sam    |                       1582 |                        532 | **+1050** |
| weur   |                       1060 |                        523 |  **+537** |
| eeur   |                       1469 |                        691 |  **+778** |
| apac   |                       3126 |                        870 | **+2256** |
| oc     |                       3352 |                        901 | **+2451** |
| me     |                       1341 |                        653 |  **+688** |
| afr    |                       1102 |                        549 |  **+553** |

Direct head-to-head, signin (warm hot path):

| region | `stateless` (IdentityDO) | `d1-unique-stateless` (D1 + replicas) | DO − D1 |
| ------ | -----------------------: | ------------------------------------: | ------: |
| wnam   |                       15 |                                    22 |      −7 |
| enam   |                       32 |                                    62 |     −30 |
| sam    |                       19 |                                    24 |      −5 |
| weur   |                       14 |                                    25 |     −11 |
| eeur   |                       66 |                                    46 | **+20** |
| apac   |                       13 |                                    40 |     −27 |
| oc     |                       39 |                                    85 |     −46 |
| me     |                       25 |                                    29 |      −4 |
| afr    |                       17 |                                    43 |     −26 |

**Recommendation.** The 20-50 ms DO advantage on signin is below most human-perception thresholds. The 400-2000 ms D1 advantage on signup is very perceptible (an instant signup vs a hesitation). For a typical 1:10:100 (signup:signin:get-session) workload `get-session` skips both subsystems entirely (pure cookie verify), so the choice doesn't affect that path. Net: **D1-unique + stateless is the right default**, especially under the multi-region jurisdiction plan, where regional D1 replicas keep signin sub-100 ms anywhere.

The single counter-argument for IdentityDO: it survives the D1 primary region failing (each DO is independently placed). For DR scenarios that's real value. The current setup already keeps `users` + `accounts` in UserDOs, so the worst case for the d1-unique path on D1 outage is "identity lookups fail fast" — no data loss, signup is unavailable until D1 recovers.

### How the bench was run

`POST /probe { variantId, op, n }` against `examples/probe-worker`, which fans out to `ProbeDurableObject`s pinned via `locationHint` in nine CF regions. Each region runs `n` sequential calls against the variant's service binding. Sources: `/tmp/bench-h2h-*-{signup,signin}.json`. Re-run via `/tmp/bench-headtohead.sh`.

## Signup request path — full inventory

End-to-end trace of `POST /api/auth/sign-up/email` for the `d1-unique-stateless` variant (the production target). All times are measured in the n=30 bench unless noted.

| #   | step                                                                                         | who                                                                           | typical cost                                                                                                                                                    | parallelizable?                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Edge → Hono Worker isolate boot, request middleware, geo enrichment                          | CF + our request middleware                                                   | 1–5 ms                                                                                                                                                          | n/a                                                                                                                                  |
| 2   | BA `adapter.findOne(user, where: {email})` — _pre-existence check_                           | adapter `findOne`                                                             | **0 ms** (we short-circuit and return `null`; the authoritative check is the D1 INSERT in step 5)                                                               | already optimized                                                                                                                    |
| 3   | BA generates `principalId = randomUUID()`                                                    | BA core                                                                       | <1 ms                                                                                                                                                           | n/a                                                                                                                                  |
| 4   | BA `password.hash(plain)` — PBKDF2/scrypt                                                    | BA + our `pbkdf2-hash.ts` (with HMAC pepper)                                  | 50–150 ms PBKDF2 native; 150–600 ms scrypt JS                                                                                                                   | CPU-bound, can't parallelize with itself but can run in parallel with step 5 (not yet wired — see "What still isn't parallel" below) |
| 5   | BA `adapter.create({ model: "user", data })` → `createUser()`                                | adapter; now uses `Promise.allSettled([d1.INSERT, userStub.createPrincipal])` | INSERT 100–300 ms cross-region to enam primary; createPrincipal 5–30 ms warm DO RPC. With `allSettled` parallel, wall = `max(INSERT, createPrincipal)` ≈ INSERT | **yes, NEW** — `Promise.allSettled` in `do.ts` `createUser` (d1-unique path)                                                         |
| 6   | BA `adapter.create({ model: "account", data })` → `userStub.createAccount`                   | UserDO RPC                                                                    | 5–30 ms warm                                                                                                                                                    | sequential (account row links to user.id from step 5)                                                                                |
| 7   | BA writes session via secondaryStorage (KV PUT) — **skipped** when `USE_STATELESS_SESSION=1` | KV                                                                            | 50–200 ms cross-region (default); **0 ms** (stateless)                                                                                                          | already optimized — stateless skips it                                                                                               |
| 8   | BA signs session_data cookie (HMAC-SHA-256)                                                  | BA core                                                                       | <2 ms                                                                                                                                                           | n/a                                                                                                                                  |
| 9   | Hono response middleware logs request timing                                                 | our `requestTimingMiddleware`                                                 | <1 ms                                                                                                                                                           | n/a                                                                                                                                  |
| 10  | (deferred via `waitUntil`) identity_index KV+D1 upsert                                       | adapter                                                                       | runs after response returns                                                                                                                                     | already optimized                                                                                                                    |
| 11  | (deferred via `waitUntil`) thick_cache fan-out to IdentityDO                                 | adapter                                                                       | runs after response returns; only when `USE_THICK_IDENTITY=1`                                                                                                   | already optimized                                                                                                                    |
| 12  | (deferred via UserDO outbox + alarm) `users`+`accounts` mirror to D1                         | UserDO outbox                                                                 | runs in DO background, target <10 s lag                                                                                                                         | already async                                                                                                                        |

**Critical-path total for `d1-unique-stateless` warm:** `~10 ms boot` + `~80 ms hash` + `max(150 ms INSERT, 15 ms createPrincipal)` + `~10 ms createAccount` + `~5 ms cookie` ≈ **250–300 ms** local-primary, **600–900 ms** when the D1 primary is across an ocean. Bench p50 sits around 550–800 ms warm, matching.

### What is now parallel (this PR)

- **Step 5 — `Promise.allSettled([d1.INSERT, userStub.createPrincipal])`**: independent operations (the principalId is locally generated), run in parallel. Failure of either rolls back the other. Saves ~one D1 cross-region round-trip (100–300 ms) of wall time.
- **Steps 10, 11, 12** — non-critical writes are dispatched via `ctx.waitUntil` so the client response doesn't wait.

### `waitUntil` audit — every deferred write

The full inventory of writes that don't affect response correctness, per auth path:

| flow                           | write                                           | status                                        | notes                                                                     |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| sign-up                        | `identityIndexCache.upsert` (KV + optional D1)  | deferred                                      | `ctx.waitUntil` in `do.ts`                                                |
| sign-up                        | `IdentityDO.thick_cache` fan-out                | deferred (thick mode)                         | `ctx.waitUntil` in `do.ts`                                                |
| sign-up                        | UserDO outbox → D1 mirror (`users`, `accounts`) | async (alarm)                                 | runs in DO background, ~3–6 s lag                                         |
| sign-up + sign-in              | `secondaryStorage.set` (session KV PUT)         | **deferred (this PR)**                        | `wrapDeferredKv` in `examples/hono-do/src/auth/index.ts`; reads stay sync |
| sign-out                       | `secondaryStorage.delete` (session KV DELETE)   | **deferred (this PR)**                        | safe — cookie is cleared client-side regardless                           |
| forget-password / verification | `secondaryStorage.set` (one-time-token PUT)     | **deferred (this PR)**                        | safe — user clicks email link seconds later                               |
| sign-up                        | `D1.INSERT identity_unique`                     | critical-path (must complete before response) | runs in parallel with `createPrincipal` via `Promise.allSettled`          |
| sign-up                        | `UserDO.createPrincipal`                        | critical-path                                 | parallel with D1.INSERT                                                   |
| sign-up                        | `UserDO.createAccount`                          | critical-path                                 | sequential after createPrincipal                                          |
| sign-in / get-session          | `secondaryStorage.get` (session KV GET)         | **must stay sync**                            | BA needs the value back for the response                                  |
| sign-up / sign-in              | password hash (PBKDF2/scrypt)                   | critical-path, CPU-bound                      | output is needed for verify/store; not deferrable                         |

The wrapper is two lines at the BA config call site. Reads still go through to KV synchronously.

**Safe-because:** Cloudflare KV is already eventually consistent across regions, and same-region same-key writes are serialized. Moving `set`/`delete` off the response critical path means at worst a different colo's read sees stale data for ~5–30 ms (KV's normal propagation window) — exactly the window that existed before the deferral.

**Not safe to defer:** the password hash (response carries the verification result), `secondaryStorage.get` (read needed for the response), the D1.INSERT in the d1-unique path (would surface UNIQUE conflicts as silent later-failures and break duplicate-account safety).

### Roadmap — performance items recommended from this PR

Ordered by expected wall-time win × ease of implementation.

1. ✅ **KV pre-check on the dup-email path** — _shipped_. `Promise.race([identityIndexCache.get(emailHash), 50ms ceiling])` in `do.ts` `findOne` skip-path. Cache hit → return stub user → BA short-circuits to EMAIL_ALREADY_EXISTS without hashing. Write-through in `createUser` keeps the cache populated. **Measured win on `d1-unique-stateless` dup-signup: 593→5 ms enam (-99%), 705→4 ms weur (-99%), 892→4 ms apac (-99.5%).**
2. **UserDO pre-warm pool** (already designed in [UserDO pre-warm pool (planned)](#userdo-pre-warm-pool-planned)). Wins **~50–300 ms** on signup in non-NA regions by claiming a warm DO instead of creating one. Bigger lift — needs a `PoolDirectoryDO` (per-region, locationHint-pinned) + cron top-up + claim/release semantics + opt-in env flag. Trade: `principal_id` becomes a structured `pool:<n>` name instead of a fresh UUID.
3. **Pre-fire D1 INSERT during password hash** (Step 4 ‖ Step 5). Wins **~50–150 ms** on signup. Risk: orphan identity rows on rare BA validation rejection between hash start and create. Mitigate with a TTL sweep of unclaimed `identity_unique` rows older than 60 s.
4. **Multi-jurisdiction Phase 2** with the safe pattern (global `identity_unique` D1 + per-jurisdiction PII shards). Cost ~50–250 ms cross-region for EU signups; unlocks GDPR-grade residency.
5. **Bulk adapter join** for BA `findOne(user, email, join.account)`. Single SQL/DO call instead of the current `lookup` + `findPrincipal` + `listAccounts` chain. Wins **~50–100 ms** on signin warm path.
6. ✅ **In-isolate L1 cache for KV session reads** — _shipped_. Per-isolate `Map<key, {value, expiresAt}>` with 30 s TTL, evicted on `set`/`delete`. Wraps `secondaryStorage.get` so same-isolate repeat reads skip KV entirely. **Measured win on `recommended` signin: `oc` 60→41 ms (-32%); other regions in noise on the warm path (the first signin already had KV warm).** The L1 cache shines on burst `get-session` calls — every page load sees the same session token referenced by N parallel API calls, and only one of them pays the KV GET.
7. **Per-account rate limit + captcha after N failures** (security, not perf). Already wired at the IP layer via BA core; account-level rate limit is the natural next step before captcha.

### Duplicate-account safety — every eventual-consistency path audited

Two principals owning the same email is the single failure mode that justifies the whole identity-uniqueness layer. Walking each path that touches that invariant:

| scenario                                                                         | path                                                                                           | strongly consistent?                                                                                                                                          | duplicate possible?                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Two concurrent signups, same email, different colos                              | D1 `INSERT identity_unique` (UNIQUE constraint)                                                | yes — D1 serializes through the single primary                                                                                                                | no                                                                                                                          |
| Two concurrent signups, same email, different colos (DO variant)                 | `IdentityDO.reserve` then `commit`                                                             | yes — one DO per email-hash, `blockConcurrencyWhile` serializes                                                                                               | no                                                                                                                          |
| Two concurrent signups, same email, same colo same isolate                       | both above                                                                                     | yes — same serializer, just lower-latency                                                                                                                     | no                                                                                                                          |
| Concurrent signin while a signup is mid-`Promise.allSettled`                     | INSERT lands, principal create lands a few ms later                                            | window of partial state (~5–20 ms) where D1 says "exists" but UserDO returns null                                                                             | no duplicate — signin returns 401, retry succeeds. Mitigated further by `rollback-on-failure` paths in `do.ts` `createUser` |
| Signup region A → signin region B before KV `identity_index` propagates          | KV cache may briefly return "not present"                                                      | safe by design — `identity_index` is a _cache_. Miss falls through to `identity_unique` (D1, primary-consistent) or `IdentityDO.lookup` (DO, single-instance) | no                                                                                                                          |
| KV `identity_index` returns stale `{principalId, version}` for a deleted account | reader receives the stale principalId, then tries UserDO                                       | UserDO returns 404 (principal disabled) → signin fails closed; cache is version-stamped so it'll repopulate on the next miss                                  | no — fails closed                                                                                                           |
| Multi-jurisdiction (Phase 2): EU and NA simultaneously signup `alice@x.com`      | KV `identity_directory` returns "not present" in both regions before either's write propagates | **possible duplicate** if each jurisdiction has its OWN `identity_unique` D1 with no global coordination                                                      | **yes** — see mitigation below                                                                                              |
| `restorePrincipal` runs concurrently with a live signup for the same email       | `UserDO.blockConcurrencyWhile` serializes at the DO; D1 INSERT is independent                  | restore reads from D1 mirror and rewrites UserDO state. If a parallel signup INSERTs a new principalId for the same email, restore reads the OLD principalId  | no duplicate, but old data may be temporarily restored — administrative path, docs say "freeze writes during restore"       |
| Outbox flush to D1 mirror lags                                                   | UserDO source-of-truth is unchanged; D1 mirror lags ~3–6 s                                     | auth flows never read the mirror; admin dashboards may see stale data                                                                                         | no                                                                                                                          |

**Multi-jurisdiction mitigation (Phase 2 decision):** the only path that allows duplicates is two jurisdictions racing for the same email. Two options:

1. Per-jurisdiction `identity_unique` + global KV `identity_directory` as coordination layer. KV doesn't have CAS, so two regions can both insert into their own D1 and then both write to KV; one KV write wins and overwrites the other. Result: two principals exist, KV index points to only one. **Bad.**
2. Global `identity_unique` D1 (one for the world) + per-jurisdiction `users`+`accounts` D1s. All signups race for the same UNIQUE constraint at one primary. Loser gets EMAIL_ALREADY_EXISTS. Then per-jurisdiction routing decides which regional D1 to write the heavy `users`/`accounts` to. **This is the safe pattern** — strong consistency at the email-uniqueness layer, weak consistency tolerated only for PII placement.

Decision: when Phase 2 ships, use **option 2** — single global `identity_unique` D1 (primary in `enam`, replicas everywhere) shared by all jurisdictions. INSERTs from EU pay 50–250 ms cross-region; this is well under the existing ~600 ms signup floor and the safety guarantee is worth it.

### What still isn't parallel (worth measuring next)

- **Step 4 (hash) ‖ step 5 (INSERT + createPrincipal).** BA hashes BEFORE calling `adapter.create`, so we can't see the INSERT coming when the hash starts. Could be unlocked by monkey-patching `password.hash` to kick off a pre-INSERT for a deterministic principalId before the hash returns. Risk: the INSERT runs even if BA later rejects (rare validation failure path) → orphaned identity rows. Mitigated by a TTL-based sweep, but adds complexity. Expected win: 50–150 ms.
- **Step 5 INSERT ‖ step 6 createAccount.** account creation depends on the user row existing in the DO (step 5's createPrincipal). If we relaxed that (the DO accepts an account write keyed by principalId even before createPrincipal lands), step 5's INSERT and step 6 could run together. Expected win: 5–30 ms warm, more cold.
- **`Promise.race` for D1 INSERT against a KV optimistic-uniqueness pre-check**: if KV `identity_index` has the email cached as "taken," fail fast at ~5–30 ms global without ever calling D1. Real uniqueness still enforced by the D1 INSERT in the not-cached case. Win on the dup-email path: ~500 ms → ~30 ms (see `dup-signup` bench numbers below). Win on the unique-email path: 0 (still has to wait for INSERT).

### Lifecycle (`signup → signout → signin` same-colo) p50, ms

The most realistic per-user workload: a user signs up, signs out, then comes back later and signs in — typically from the same colo. n=30, fresh email per iteration, all three calls execute against the same ProbeDurableObject (same colo).

| variant                 |    wnam |    enam |     sam |    weur |    eeur |     apac |       oc |      me |     afr |
| ----------------------- | ------: | ------: | ------: | ------: | ------: | -------: | -------: | ------: | ------: |
| current                 |    2681 |    2416 |    2380 |    1513 |    1990 |     4750 |     5293 |    1851 |    1662 |
| thick-identity          |       ~ |    2418 |    2319 |    1505 |    1962 |     4629 |     5258 |    1804 |    1652 |
| fast-hash               |    2273 |    2176 |    2015 |    1279 |    2006 |     4480 |     4851 |    1613 |    1309 |
| pbkdf2-fast             |    2386 |    2167 |    2130 |    1444 |    1964 |     4424 |     4834 |    1683 |    1530 |
| kv-cache                |    2828 |    2425 |    2490 |    1533 |    2044 |     4716 |     5296 |    1768 |    1667 |
| stacked                 |    2288 |    2154 |    2005 |    1290 |    1947 |     4401 |     4776 |    1596 |    1341 |
| recommended             |    2273 |    2226 |    2017 |    1212 |    1983 |     4409 |     4792 |    1573 |    1257 |
| stateless               |    1400 |    1374 |    1250 |    1062 |    1432 |     2047 |     2113 |    1294 |    1116 |
| d1-unique               |    1713 |    1576 |    1456 |     753 |    1095 |     3754 |     4001 |     957 |     802 |
| **d1-unique-stateless** | **701** | **717** | **631** | **606** | **765** | **1010** | **1004** | **686** | **624** |

d1-unique-stateless beats every other variant in every region. The signout phase is ~0 ms across all variants (BA's sign-out is just cookie expiry). Signin median for d1-unique-stateless is **14–125 ms** in lifecycle — the same-iteration sign-in benefits from warm DOs + warm KV cache populated by the matching signup.

### EMAIL_ALREADY_EXISTS path (`dup-signup` bench)

n=30 per region, 2026-05-19, pre-created user then dup-signup repeats.

| variant                 |    wnam |    enam |     sam |    weur |    eeur |    apac |      oc |      me |     afr |
| ----------------------- | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: |
| current                 |      21 |      13 |      26 |      26 |      10 |      82 |      44 |      32 |      30 |
| thick-identity          |      17 |      42 |      29 |      13 |      10 |      30 |      50 |       9 |      32 |
| fast-hash               |       9 |      30 |      27 |      12 |      19 |      11 |      35 |      26 |      15 |
| pbkdf2-fast             |      17 |      29 |      23 |       9 |       5 |       7 |      13 |      24 |      11 |
| kv-cache                |      18 |      42 |      20 |      14 |      38 |      31 |      53 |      36 |      15 |
| stacked                 |      11 |       9 |      27 |      15 |      16 |       6 |      38 |      25 |      13 |
| recommended             |      16 |       8 |      23 |       7 |       6 |      21 |      33 |      22 |      13 |
| stateless               |      14 |      27 |      13 |       7 |      33 |       7 |      14 |      25 |       9 |
| **d1-unique**           | **670** | **622** | **552** | **538** | **661** | **875** | **892** | **610** | **532** |
| **d1-unique-stateless** | **646** | **614** | **519** | **511** | **669** | **873** | **894** | **613** | **537** |

**Surprise finding.** All IdentityDO-based variants fail-fast on dup-email (5–82 ms p50 global) because BA's signup flow does an early `findOne(user, {email}, join.account)` that hits IdentityDO/KV cache and finds the existing user — BA short-circuits _before_ hashing the password. The D1-unique variants pay the full hash + INSERT-fail cost (510–894 ms) because the corresponding D1 short-circuit isn't wired into the no-join-account skip path.

**Fix (recommended for the next PR).** Wire a `Promise.race` style early-out in the `findOne(email, no-join)` skip path when `d1IdentityStore` is set: race the D1 lookup (cached in KV identity_index when warm) against `null`-after-`50 ms`. Cache hit → return the existing user → BA short-circuits without hashing. Cost on the happy path: ~5–30 ms per signup (KV GET). Saved on dup-email: ~500 ms. Net win once dup rate × saving > happy rate × cost, i.e. dup rate ≳ 6 % (or always if you care about the dup UX more than the absolute warm signup floor).

Worth noting: this is the kind of place `Promise.allSettled` and `Promise.race` actually pay off. The "race the cheap-fast check against the expensive-slow path" pattern is a clean fit: don't _wait_ for D1 if KV says "definitely taken"; don't _wait_ for KV if D1 says "definitely missing"; the slower of the two becomes inactive once a winner is known.

## Multi-region D1 + jurisdiction routing plan

**Updated scope (simplified).** Jurisdiction routing is **optional and EU-opt-in only**. Phase 2 ships a second D1 in `weur` for EU-resident principals; everyone else stays on the single default D1 (currently `enam`, can be anywhere). Sharded NA and full multi-region matrix are deferred until traffic demands it.

**Priority order.** `enam` first (done — D1 primary moved, read replication on `auto`), then `weur` as an opt-in EU jurisdiction, then sharding inside `weur` only if data volume warrants it.

**Current state.** A single D1 (`ba-cf-do-recovery-enam`, primary in `enam`, **read replication enabled — `mode: auto`**) holds three tables:

| table                | role                                                                             | source-of-truth?                                         | contains PII?                |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| `identity_unique`    | `email_hash → principal_id`, UNIQUE constraint backs the `d1-unique` signup path | **yes** (when `USE_D1_IDENTITY=1`)                       | only the email hash          |
| `identity_index`     | KV+D1 cache for `email → principal_id`; version-stamped                          | no (cache; `identity_unique` or IdentityDO is the floor) | only the email hash          |
| `users` + `accounts` | DR mirror written one-way from UserDO via the outbox                             | no (DOs are the source of truth)                         | **yes** (email, name, image) |

Of those three, `users` + `accounts` carry the PII that matters for GDPR-style residency.

### Phase 1 — enam primary + replicas (this PR)

Single D1 in `enam`, read replication `auto`. Sessions API (`db.withSession("first-unconstrained")`) is wired on every read path through `d1-identity` and `identity-cache`, so signin lookups serve from the nearest replica without code changes.

### Phase 2 — EU primary + per-principal `home_jurisdiction`

Add a second D1 (`ba-cf-do-recovery-weur`) with the same schema, primary in `weur`. Plus:

- **Jurisdiction config.** `{ na: { d1: AUTH_DB_NA, kv: KV_NA }, eu: { d1: AUTH_DB_EU, kv: KV_EU } }`. Each jurisdiction gets its own DO namespace, KV, and D1 — bindings declared per env block in `wrangler.toml`.
- **`home_jurisdiction` on every principal.** Decided at signup from `cf.continent` (EU/NA), with an explicit user override for legal residency (a user in Tokyo who is legally EU-resident picks `eu`). Stored on the UserDO + mirrored to D1.
- **Global identity directory in KV (replicated).** A single KV namespace (KV is global anyway) keyed by `sha256(email)` holds `{ principalId, homeJurisdiction, homeShard, version }`. Lookup is one KV GET (~5-30 ms anywhere); per-principal value is small (~80 B). Falls back to fan-out (parallel `identity_unique` lookup against every jurisdictional D1) on KV miss. This is the routing oracle — given an email, anyone anywhere can find which jurisdiction owns that principal.

### Phase 3 — sharding inside a jurisdiction, one shard per region

Once a jurisdiction's D1 hits the ~10 GB ceiling (or write QPS limits), shard. The ask is "one shard per region" — so EU jurisdiction could shard into `eu-weur`, `eu-eeur`, `eu-me` (each shard is its own D1 primary in that physical region).

- **Shard key.** `home_shard = pickShard(jurisdiction, cf.continent, cf.country)` at signup. Stored on the principal alongside `home_jurisdiction`.
- **Composite routing key.** `(jurisdiction, shard) → D1 binding`. Worker bindings declared per shard.
- **Identity uniqueness stays per-jurisdiction.** Each jurisdiction has ONE small `identity_unique` D1 (the directory above) that all shards in that jurisdiction share. Shards only carry the heavy `users`+`accounts` tables. Avoids the cross-shard uniqueness coordination problem entirely.

### Client propagation — how every API call routes correctly

The hard part of multi-region isn't the data layout — it's making sure every subsequent client request lands on the right backend without the client knowing the topology.

**Pattern: edge router worker + signed cookie**

```
            ┌──────────────────────────────────────────────────────┐
            │ auth.example.com  (single domain, one CNAME)         │
            │                                                      │
            │   ┌────────────────────────────────────┐             │
            │   │  Router Worker (the only public-   │             │
            │   │   facing entry point)              │             │
            │   │                                    │             │
   ┌──── 1. │   │  Parse cookie 'session_data':      │             │
   │ signed │   │    { principalId, jurisdiction,    │             │
   │ cookie │   │      shard, ... }                  │             │
   ├──── 2. │   │                                    │             │
   │ no     │   │  No cookie? Pre-auth path:         │             │
   │ cookie │   │   - signup → cf.continent → juris  │             │
   │        │   │   - signin → KV identity directory │             │
   │        │   │     by email_hash → juris+shard    │             │
   │        │   │                                    │             │
   │        │   │  fetch(env.AUTH[juris][shard], req)│  ← service  │
   │        │   └────────────────────────────────────┘    bindings │
   │                  │                                            │
   │                  ├──► auth-na-shard-enam                      │
   │                  ├──► auth-eu-shard-weur                      │
   │                  └──► auth-eu-shard-eeur                      │
            └──────────────────────────────────────────────────────┘
```

**Three propagation surfaces:**

1. **Cookie (primary).** BA's signed `session_data` cookie is the natural carrier. Extend the principal payload to include `homeJurisdiction` and `homeShard`. Every authenticated request already sends this cookie. The router HMAC-verifies it (same secret BA uses) and routes without a network lookup. **This is how the client "propagates" the region without ever knowing about regions.**
2. **KV identity directory (signin fallback).** When there's no cookie (first signin on a new device, post-signout signin, email-based recovery), the router needs to find the jurisdiction by email. One KV GET. Result is then baked into the response cookie so subsequent requests stay on the fast path.
3. **`cf.continent` (last-resort signup).** Brand-new user with no cookie and no email→jurisdiction record. Best-guess from request geo. Override pathway available via an explicit `X-Auth-Jurisdiction` header from the client (e.g., a settings page where the user picks legal residency before signup).

**Why edge-router over DNS geo-steering.** DNS-based routing (Cloudflare Load Balancer with geo rules) handles request-IP geography but can't enforce "this principal belongs to EU regardless of where they're signing in from today." A returning EU user on a Tokyo coffee-shop wifi must still land on the EU backend. The cookie is the authoritative carrier; geo is only a default for first-touch.

**Why service bindings over public-domain hops.** Worker-to-Worker service bindings are in-isolate (no DNS, no TLS, no HTTP overhead) and stay inside Cloudflare's network. A router fanning out to 3–5 shards over service bindings adds ~1–2 ms; fanning out over public HTTPS would add ~20–50 ms. Strict residency: service bindings between Workers in the same Cloudflare account; no data crosses the public internet.

**SDK story.** The client SDK doesn't need to know about jurisdictions or shards. The router is the only thing the SDK talks to (single CNAME, single base URL). All routing is server-side. The single side-effect the SDK must handle is a 308-redirect if the router decides to short-circuit cross-region (e.g., if an `na`-resident's session somehow lands on the EU edge, the router _could_ 308 to `na.auth.example.com` to avoid every NA-resident's session bouncing through the EU edge — but v1 just pays the in-network proxy cost and keeps one public domain).

### Setting cookie's `homeJurisdiction` + `homeShard` on the initial request

CF gives us three relevant signals on every request: `cf.continent` (NA/EU/AS/…), `cf.country` (ISO-2), `cf.colo` (airport code, ~300 values). The mapping for "one shard per region" reuses the same 9-region scheme as `examples/probe-worker/src/regions.ts` (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `me`, `afr`).

Initial-request flow on signup (no cookie yet):

```ts
// Router worker — pseudocode
const continent = c.req.raw.cf?.continent; // "NA" | "EU" | ...
const colo = c.req.raw.cf?.colo; // "LHR" | "SJC" | ...

// 1) jurisdiction = law-grade boundary; never derived from colo, only continent
const jurisdiction: "na" | "eu" = continent === "EU" ? "eu" : "na";

// 2) shard within jurisdiction = perf boundary; derived from colo
const shard = pickShardFromColo(colo, jurisdiction); // → "weur" | "enam" | ...

// 3) forward to the matching backend Worker via service binding
const backend = env[`AUTH_${jurisdiction.toUpperCase()}_${shard.toUpperCase()}`];

// 4) The backend creates the principal, includes home claims in the
//    signed session_data cookie BA already issues:
//    session_data = HMAC-signed JSON({ principalId, homeJurisdiction, homeShard, ... })
```

`cf.continent` is what we map jurisdictions from — it's a continent, not a colo, so a Tokyo coffee-shop wifi for a German user _does not_ incorrectly route them to EU based on geo: that user picked `homeJurisdiction = "eu"` at signup, the cookie carries it, the router honours the cookie. `cf.colo` is only used to pick a SHARD when _creating_ the principal (i.e., where to physically put their data inside the EU jurisdiction).

For users who need explicit residency control (legal residency ≠ where they happened to sign up), expose `X-Auth-Jurisdiction: eu` as a header the SDK can set. The router prefers the header over `cf.continent` for first-touch routing.

### Why not KV for uniqueness (KV is unsafe as a source of truth)

KV is fast: 5–30 ms per GET globally, write-anywhere. But KV is **eventually consistent across regions**, and the inter-region propagation window is ~10–60 s. That breaks uniqueness:

```
t=0   user A in LHR signs up alice@x.com
       LHR worker: kv.get('email:alice@x.com') → null
       LHR worker: kv.put('email:alice@x.com', { principalId: 'A' })
t=1   user B in NRT signs up alice@x.com (KV write hasn't propagated yet)
       NRT worker: kv.get('email:alice@x.com') → null
       NRT worker: kv.put('email:alice@x.com', { principalId: 'B' })
t=30  both writes settle; one wins, the other is silently lost.
       Two principals now both think they own alice@x.com.
```

D1's `UNIQUE` constraint and IdentityDO's `blockConcurrencyWhile()` both serialize through a single point (the D1 primary or the per-emailHash DO instance), so the second writer sees the first one's write and fails fast.

**The right hybrid: KV in front of D1 (or DO), never on its own.**

| layer                                               | role                                                           | consistency                                                         | latency                |
| --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| KV `identity_index`                                 | cache for read-side `email → principal_id` lookups             | eventual; tolerates drift because the underlying D1/DO is the floor | 5–30 ms global         |
| D1 `identity_unique` _or_ IdentityDO                | authoritative uniqueness check at signup INSERT/reserve time   | strong (serialized at primary)                                      | 80–300 ms cross-region |
| KV `identity_directory` _(multi-jurisdiction only)_ | routing oracle: `email → { jurisdiction, shard, principalId }` | eventual; safe because miss falls back to per-jurisdiction fan-out  | 5–30 ms global         |

Combining these is exactly what `recommended`, `stacked`, and the `d1-unique` family already do: KV is a read accelerator; D1/DO is the consistency floor. We're already running the safe hybrid.

If you want to bench "what if uniqueness was just KV?" — the bench would show ~5–30 ms uniqueness checks (excellent), but a small percentage of concurrent dup-email signups would silently both succeed. Correctness loss for ~50 ms saved. Not worth it.

### Scaling — how many principals fit in a single deployment

Per-component ceilings on the current default config:

| component                                  | per-instance ceiling                               | unit cost                                       | bottleneck                                                              |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| UserDO (1 per principal)                   | 10 GB SQLite per DO, billions of DOs per namespace | a typical principal record + accounts ≈ 1–10 KB | unbounded for practical purposes; account-level billing is the real cap |
| IdentityDO (1 per emailHash)               | 10 GB SQLite per DO, billions per namespace        | a few hundred bytes per entry                   | same                                                                    |
| D1 `identity_unique`                       | 10 GB per database (D1 hard cap)                   | ~60 B per row                                   | ≈ **170 M emails per D1**                                               |
| D1 `users` + `accounts` (DR mirror)        | 10 GB per database                                 | ~250 B per principal across both tables         | ≈ **40 M principals per D1**                                            |
| D1 write QPS                               | ~1 000 sustained per primary                       | one signup ≈ 2–3 writes                         | ≈ **300–500 sustained signups/sec per shard**                           |
| KV `identity_index` / `identity_directory` | no documented row limit                            | ~80 B per key+value                             | billions of keys per namespace                                          |
| KV ops                                     | 1 000 reads/sec free, much higher paid             | one signin ≈ 1 KV GET                           | tens of thousands of sustained signins/sec per namespace                |

**Single-shard ceiling:** the `users`+`accounts` D1 caps first, at ~40 M principals. Once a shard nears that:

1. Add a new shard. New signups in that region land on the new shard.
2. Old principals stay on their original shard forever — no migration. Router knows from the cookie which shard each principal lives on.
3. With 9 region-shards per jurisdiction and 2 jurisdictions, that's 18 × 40 M ≈ **720 M principals** before we'd need a _second_ shard per region.

**Identity index ceiling:** ~170 M emails per identity D1. When approached, shard the identity table by `hash(email_hash) % N` — each jurisdiction can have N identity shards. Lookups fan out (parallel `Promise.all`) but the directory cache in KV makes the hot path one KV GET regardless.

**Per-UserDO ceiling:** 10 GB SQLite. A pathologically active principal (lots of OAuth accounts, large session history if stored in the DO) is still <100 MB realistically. Cap is irrelevant for typical users.

**Practical guidance.** A single-jurisdiction deployment with one D1 primary handles ~40 M users comfortably; the multi-region plan above scales linearly with shards (~720 M users at 18 shards) before structural work is needed. Beyond that, shard the identity table.

### Phase 4 — open questions deliberately deferred

- **Cross-jurisdiction account move** (EU resident relocates to US). Cleanest answer: create new principal in NA, link old via account merge, deprecate old. No data crosses borders.
- **Cross-shard rebalancing** (one shard fills faster than others). Add a new shard, gate new signups to it, never move old principals.
- **Hyperdrive (Postgres) variant of the same pattern.** Same router; replace D1 bindings with Hyperdrive configs. Sharding becomes Postgres logical-replication territory.

## UserDO pre-warm pool (planned)

Today every new signup creates a fresh `UserDO` via `idFromName(principalId)`. The first RPC into a brand-new DO eats a cold-start tax (50-300 ms typical, more in distant regions) that the bench attributes to "DO cold-start" but the user sees as "slow signup."

Pre-warm pool design:

- **Pool size.** Maintain `M` (e.g., 50) ready-to-use DOs per region, keyed `pool:<region>:<n>` for n in 0..M.
- **Cron** — every minute, a Worker scheduled job iterates regions, checks the pool depth via a `PoolManagerDO` (one per region, locationHint-pinned), and tops up via concurrent `userStub.warm()` calls. `warm()` initialises storage, ensures the SQLite table exists, sets `claimed_at = null`.
- **Claim at signup.** When `createUser` runs, instead of `idFromName(principalId)`, the adapter calls `PoolManagerDO.claim(region)` → returns a `pooled_<uuid>` DO. That DO transactionally sets `principal_id = …, claimed_at = now()` and is no longer in the pool. The created principal record uses the pooled DO's name as its id.
- **Where the win is.** First user-facing RPC into the DO is now warm (already initialised + storage cached). Saves the per-DO cold-start tax. Biggest impact in APAC/OC where cold starts are ~300 ms.
- **Trade-offs.** (1) ID is no longer derivable from the principal — needs the claim step. (2) Stale principals in the pool cost storage (mitigate: cron drops any pooled DO with `claimed_at = null && created_at < 24h` and re-warms). (3) Adds one DO RPC (claim) to signup — but it's local + tiny, so net negative latency.

Deferred to a follow-up PR because it requires the cron + PoolManagerDO + claim semantics + thorough testing — non-trivial scope.

## Table of Contents

- [Quick Start with CLI](#quick-start-with-cli)
- [Configuration Options](#configuration-options)
- [Manual Installation](#manual-installation)
- [Manual Setup](#manual-setup)
    - [1. Define Your Database Schema (`src/db/schema.ts`)](#1-define-your-database-schema-srcdbschemats)
    - [2. Initialize Drizzle ORM (`src/db/index.ts`)](#2-initialize-drizzle-orm-srcdbindexts)
    - [3. Configure Better Auth (`src/auth/index.ts`)](#3-configure-better-auth-srcauthindexts)
    - [4. Generate and Manage Auth Schema](#4-generate-and-manage-auth-schema)
    - [5. Configure KV as Secondary Storage (Optional)](#5-configure-kv-as-secondary-storage-optional)
    - [6. Set Up API Routes](#6-set-up-api-routes)
    - [7. Initialize the Client](#7-initialize-the-client)
- [Usage Examples](#usage-examples)
    - [Accessing Geolocation Data](#accessing-geolocation-data)
- [Architecture (ShipCru fork)](#architecture-shipcru-fork)
- [Benchmark results (multi-region)](#benchmark-results-multi-region)
- [Multi-region D1 + jurisdiction routing plan](#multi-region-d1--jurisdiction-routing-plan)
- [UserDO pre-warm pool (planned)](#userdo-pre-warm-pool-planned)
- [R2 File Storage Guide](./docs/r2.md)
- [Configuration Reference](./docs/configuration.md)
- [License](#license)
- [Contributing](#contributing)

## Quick Start with CLI

⚡️ For the fastest setup, use the CLI to generate a complete project (including the resources on Cloudflare):

**Interactive mode** (asks questions and provides helpful defaults):

```bash
npx @better-auth-cloudflare/cli@latest generate
```

**Non-interactive mode** (use arguments):

```bash
# Simple D1 app with KV (fully deployed to Cloudflare)
npx @better-auth-cloudflare/cli@latest generate \
  --app-name=my-auth-app \
  --template=hono \
  --database=d1 \
  --kv=true \
  --r2=false \
  --apply-migrations=prod
```

**Migration workflow**:

```bash
npx @better-auth-cloudflare/cli@latest migrate                         # Interactive
npx @better-auth-cloudflare/cli@latest migrate --migrate-target=prod   # Non-interactive
```

The CLI creates projects from Hono or Next.js templates and can automatically set up D1, KV, R2, and Hyperdrive resources. See [CLI Documentation](./cli/README.md) for full documentation and all available arguments.

**Troubleshooting**:

If you encounter this error when using the CLI: `...Error [ERR_REQUIRE_ESM]: require() of ES Module...`, make sure your node version is at least `v23.0.0`, `v22.12.0`, or `v20.19.0`, depending on the major version you use. Read more [here](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require)

## Manual Installation

```bash
npm install better-auth-cloudflare
# or
yarn add better-auth-cloudflare
# or
pnpm add better-auth-cloudflare
# or
bun add better-auth-cloudflare
```

## Configuration Options

| Option                | Type    | Default     | Description                                    |
| --------------------- | ------- | ----------- | ---------------------------------------------- |
| `autoDetectIpAddress` | boolean | `true`      | Auto-detect IP address from Cloudflare headers |
| `geolocationTracking` | boolean | `true`      | Track geolocation data in the session table    |
| `cf`                  | object  | `{}`        | Cloudflare geolocation context                 |
| `r2`                  | object  | `undefined` | R2 bucket configuration for file storage       |

For the full `WithCloudflareOptions` interface (including database, KV, and Drizzle adapter options), see the [Configuration Reference](./docs/configuration.md).

## Setup

Integrating `better-auth-cloudflare` into your project involves a few key steps to configure your database, authentication logic, and API routes. Follow these instructions to get started:

<br>

### 1. Define Your Database Schema (`src/db/schema.ts`)

You'll need to merge the Better Auth schema with any other Drizzle schemas your application uses. This ensures that Drizzle can manage your entire database structure, including the tables required by Better Auth.

```typescript
import * as authSchema from "./auth.schema"; // This will be generated in a later step

// Combine all schemas here for migrations
export const schema = {
    ...authSchema,
    // ... your other application schemas
} as const;
```

_Note: The `auth.schema.ts` file will be generated by the Better Auth CLI in a subsequent step._

<br>

### 2. Initialize Drizzle ORM (`src/db/index.ts`)

Properly initialize Drizzle with your database. This function will provide a database client instance to your application. For D1, you'll use Cloudflare D1 bindings, while Postgres/MySQL will use Hyperdrive connection strings.

```typescript
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "./schema";

export async function getDb() {
    // Retrieves Cloudflare-specific context, including environment variables and bindings
    const { env } = await getCloudflareContext({ async: true });

    // Initialize Drizzle with your D1 binding (e.g., "DB" or "DATABASE" from wrangler.toml)
    return drizzle(env.DATABASE, {
        // Ensure "DATABASE" matches your D1 binding name in wrangler.toml
        schema,
        logger: true, // Optional
    });
}
```

<br>

### 3. Configure Better Auth (`src/auth/index.ts`)

Set up your Better Auth configuration, wrapping it with `withCloudflare` to enable Cloudflare-specific features. The exact configuration depends on your framework:

**For most frameworks (Hono, etc.):**

```typescript
import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";

// Single auth configuration that handles both CLI and runtime scenarios
function createAuth(env?: CloudflareBindings, cf?: IncomingRequestCfProperties, baseURL?: string) {
    // Use actual DB for runtime, empty object for CLI
    const db = env ? drizzle(env.DATABASE, { schema, logger: true }) : ({} as any);

    return betterAuth({
        baseURL,
        ...withCloudflare(
            {
                autoDetectIpAddress: true,
                geolocationTracking: true,
                cf: cf || {},
                d1: env
                    ? {
                          db,
                          options: {
                              usePlural: true,
                              debugLogs: true,
                          },
                      }
                    : undefined,
                kv: env?.KV,
                // Optional: Enable R2 file storage
                r2: {
                    bucket: env.R2_BUCKET,
                    maxFileSize: 10 * 1024 * 1024, // 10MB
                    allowedTypes: [".jpg", ".jpeg", ".png", ".gif", ".pdf", ".doc", ".docx"],
                    additionalFields: {
                        category: { type: "string", required: false },
                        isPublic: { type: "boolean", required: false },
                        description: { type: "string", required: false },
                    },
                },
            },
            {
                emailAndPassword: {
                    enabled: true,
                },
                rateLimit: {
                    enabled: true,
                    window: 60, // Minimum KV TTL is 60s
                    max: 100, // reqs/window
                    customRules: {
                        // https://github.com/better-auth/better-auth/issues/5452
                        "/sign-in/email": {
                            window: 60,
                            max: 100,
                        },
                        "/sign-in/social": {
                            window: 60,
                            max: 100,
                        },
                    },
                },
            }
        ),
        // Only add database adapter for CLI schema generation
        ...(env
            ? {}
            : {
                  database: drizzleAdapter({} as D1Database, {
                      provider: "sqlite",
                      usePlural: true,
                      debugLogs: true,
                  }),
              }),
    });
}

// Export for CLI schema generation
export const auth = createAuth();

// Export for runtime usage
export { createAuth };
```

The `baseURL` is derived per-request in Hono middleware via `new URL(c.req.url).origin`. On Cloudflare Workers, `request.url` reflects the actual URL the client connected to — Cloudflare's edge routes requests to your worker based on DNS and [route configuration](https://developers.cloudflare.com/workers/configuration/routing/routes/), not the HTTP `Host` header alone. Alternatively, you can set the `BETTER_AUTH_URL` environment variable and omit the `baseURL` parameter.

**For OpenNext.js with complex async requirements:**
See the [OpenNext.js example](./examples/opennextjs/README.md) for a more complex configuration that handles async database initialization and singleton patterns.

**Using Hyperdrive (MySQL):**

```typescript
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

async function getDb() {
    const { env } = await getCloudflareContext({ async: true });
    const connection = mysql.createPool(env.HYPERDRIVE_URL);
    return drizzle(connection, { schema });
}

const auth = betterAuth({
    ...withCloudflare(
        {
            mysql: {
                db: await getDb(),
            },
            // other cloudflare options...
        },
        {
            // your auth options...
        }
    ),
});
```

**Using Hyperdrive (Postgres):**

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function getDb() {
    const { env } = await getCloudflareContext({ async: true });
    const sql = postgres(env.HYPERDRIVE_URL);
    return drizzle(sql, { schema });
}

const auth = betterAuth({
    ...withCloudflare(
        {
            postgres: {
                db: await getDb(),
            },
            // other cloudflare options...
        },
        {
            // your auth options...
        }
    ),
});
```

**Using Native D1 (no Drizzle required):**

If you don't need Drizzle ORM's type-safe schema and migration tooling, you can pass a D1 binding directly. better-auth uses its built-in Kysely D1 dialect under the hood:

```typescript
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";

const auth = betterAuth({
    ...withCloudflare(
        {
            d1Native: env.DATABASE, // D1Database binding from wrangler.toml
            kv: env.KV,
            // other cloudflare options...
        },
        {
            // your auth options...
        }
    ),
});
```

This path does **not** require `@better-auth/drizzle-adapter` at all. Trade-offs vs. the Drizzle D1 option:

|                   | `d1Native`                   | `d1` (Drizzle)            |
| ----------------- | ---------------------------- | ------------------------- |
| Bundle size       | Smaller                      | Larger (includes Drizzle) |
| Schema management | Manual SQL / better-auth CLI | Drizzle Kit migrations    |
| Type-safe queries | No                           | Yes                       |
| Setup complexity  | Simpler                      | More boilerplate          |

**Using `better-auth/minimal` for smaller bundles:**

better-auth v1.5+ provides a `better-auth/minimal` entry point that tree-shakes unused features for smaller Worker bundles:

```typescript
import { betterAuth } from "better-auth/minimal";
import { withCloudflare } from "better-auth-cloudflare";
```

This works as a drop-in replacement for `betterAuth` from `"better-auth"` but excludes features you haven't explicitly imported (e.g., social providers, admin endpoints).

### 4. Generate and Manage Auth Schema

Better Auth uses Drizzle ORM for database interactions, allowing for automatic schema management for your database (D1/SQLite, Postgres, or MySQL).

To generate or update your authentication-related database schema, run the Better Auth CLI:

```bash
npx @better-auth/cli@latest generate
```

This command inspects your `src/auth/index.ts` (specifically the `auth` export) and creates/updates `src/db/auth.schema.ts` with the necessary Drizzle schema definitions for tables like users, sessions, accounts, etc.

**Recommended Usage:**

Specify your configuration file and output path for more precise control:

```bash
npx @better-auth/cli@latest generate --config src/auth/index.ts --output src/db/auth.schema.ts -y
```

This command will:

- Read the `export const auth` configuration from `src/auth/index.ts`.
- Output the generated Drizzle schema to `src/db/auth.schema.ts`.
- Automatically confirm prompts (`-y`).

After generation, you can use Drizzle Kit to create and apply migrations to your database. Refer to the [Drizzle ORM documentation](https://orm.drizzle.team/kit/overview) for managing migrations.

For integrating the generated `auth.schema.ts` with your existing Drizzle schema, see [managing schema across multiple files](https://orm.drizzle.team/docs/sql-schema-declaration#schema-in-multiple-files). More details on schema generation are available in the [Better Auth docs](https://www.better-auth.com/docs/adapters/drizzle#schema-generation--migration).

### 5. Configure KV as Secondary Storage (Optional)

If you provide a KV namespace in the `withCloudflare` configuration (as shown in `src/auth/index.ts`), it will be used as [Secondary Storage](https://www.better-auth.com/docs/concepts/database#secondary-storage) by Better Auth. This is typically used for caching or storing session data that doesn't need to reside in your primary database.

Ensure your KV namespace (e.g., `USER_SESSIONS`) is correctly bound in your `wrangler.toml` file.

#### Important: KV TTL Limitation

Cloudflare KV has a minimum TTL (Time To Live) requirement of **60 seconds**. If you're using KV for secondary storage with rate limiting enabled, you **must** configure your rate limit windows to be at least 60 seconds to prevent crashes:

```typescript
rateLimit: {
    enabled: true,
    window: 60, // Minimum KV TTL is 60s
    max: 100, // reqs/window
    customRules: {
        // https://github.com/better-auth/better-auth/issues/5452
        "/sign-in/email": {
            window: 60,
            max: 100,
        },
        "/sign-in/social": {
            window: 60,
            max: 100,
        },
    },
},
```

The library automatically enforces this minimum and will log a warning if a TTL less than 60 seconds is attempted, but it's better to configure your rate limits correctly from the start.

### 6. Set Up API Routes

Create API routes to handle authentication requests. Better Auth provides a handler that can be used for various HTTP methods.

```typescript
// Example: src/app/api/auth/[...all]/route.ts
// Adjust the path based on your project structure (e.g., Next.js App Router)

import { initAuth } from "@/auth"; // Adjust path to your auth/index.ts

export async function POST(req: Request) {
    const auth = await initAuth();
    return auth.handler(req);
}

export async function GET(req: Request) {
    const auth = await initAuth();
    return auth.handler(req);
}

// You can also add handlers for PUT, DELETE, PATCH if needed by your auth flows
```

### 7. Initialize the Client

Set up the Better Auth client, including the Cloudflare plugin, to interact with authentication features on the front-end.

```typescript
// Example: src/lib/authClient.ts or similar client-side setup file

import { createAuthClient } from "better-auth/client";
import { cloudflareClient } from "better-auth-cloudflare/client";

const authClient = createAuthClient({
    plugins: [cloudflareClient()], // includes geolocation and R2 file features (if configured)
});

export default authClient;
```

## Usage Examples

### Accessing Geolocation Data

This library enables access to Cloudflare's geolocation data both on the client and server-side.

**Client-side API:**
Use the `authClient` to fetch geolocation information.

```typescript
import authClient from "@/lib/authClient"; // Adjust path to your client setup

const displayLocationInfo = async () => {
    try {
        const result = await authClient.cloudflare.geolocation();
        if (result.error) {
            console.error("Error fetching geolocation:", result.error);
        } else if (result.data && !("error" in result.data)) {
            console.log("📍 Geolocation data:", {
                timezone: result.data.timezone,
                city: result.data.city,
                country: result.data.country,
                region: result.data.region,
                regionCode: result.data.regionCode,
                colo: result.data.colo,
                latitude: result.data.latitude,
                longitude: result.data.longitude,
            });
        }
    } catch (err) {
        console.error("Failed to get geolocation data:", err);
    }
};

displayLocationInfo();
```

### R2 File Storage

If you've configured R2 in your server setup, you can upload and manage files:

```typescript
import authClient from "@/lib/authClient";

// Upload a file with metadata
const uploadFile = async (file: File) => {
    const result = await authClient.uploadFile(file, {
        category: "documents",
        isPublic: false,
        description: "Important document",
    });

    if (result.error) {
        console.error("Upload failed:", result.error.message || "Failed to upload file. Please try again.");
    } else {
        console.log("File uploaded:", result.data);
    }
};

// List user's files
const listFiles = async () => {
    const result = await authClient.files.list();
    if (result.data) {
        console.log("User files:", result.data);
    }
};

// Download a file
const downloadFile = async (fileId: string, filename: string) => {
    const result = await authClient.files.download({ fileId });
    if (result.error) {
        console.error("Download failed:", result.error);
        return;
    }

    // Extract blob and create download
    const response = result.data;
    const blob = response instanceof Response ? await response.blob() : response;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
};
```

For complete R2 file storage documentation, see the [R2 File Storage Guide](./docs/r2.md).

## License

[MIT](./LICENSE)

## Contributing

Contributions are welcome! Whether it's bug fixes, feature additions, or documentation improvements, we appreciate your help in making this project better. For major changes or new features, please open an issue first to discuss what you would like to change.
