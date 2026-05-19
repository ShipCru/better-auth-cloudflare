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

n=30 per region per op, 2026-05-19, D1 primary in `enam` with read-replication off. All times in ms (p50). Lower is better.

**Signup p50 (ms)**

| variant                                     |    wnam |    enam |     sam |    weur |    eeur |    apac |       oc |      me |     afr |
| ------------------------------------------- | ------: | ------: | ------: | ------: | ------: | ------: | -------: | ------: | ------: |
| current (baseline)                          |    2145 |    1857 |    1771 |    1398 |    1728 |    3154 |     3506 |    1680 |    1476 |
| thick-identity                              |    2142 |    1939 |    1873 |    1377 |    1840 |    3212 |     3446 |    1826 |    1466 |
| fast-hash (scrypt N=4096)                   |    1849 |    1743 |    1603 |    1179 |    1640 |    3092 |     3325 |    1677 |    1221 |
| pbkdf2-fast                                 |    1956 |    1788 |    1620 |    1207 |    1668 |    3086 |     3370 |    1676 |    1185 |
| kv-cache                                    |    2145 |    1993 |    1911 |    1379 |    1849 |    3169 |     3418 |    1684 |    1454 |
| stacked (fast-hash + kv-cache)              |    1877 |    1723 |    1600 |    1204 |    1578 |    3094 |     3315 |    1621 |    1243 |
| recommended (pbkdf2 + pepper + kv + bundle) |    1876 |    1767 |    1601 |    1146 |    1575 |    3113 |     3347 |    1525 |    1203 |
| stateless (recommended − KV session)        |    1319 |    1284 |    1173 |    1125 |    1429 |    1608 |     1715 |    1452 |    1114 |
| d1-unique                                   |    1350 |    1219 |    1156 |     801 |    1101 |    2466 |     2747 |    1054 |     847 |
| **d1-unique-stateless**                     | **733** | **762** | **636** | **733** | **945** | **983** | **1054** | **868** | **744** |

**Signin p50 (ms)**, warm same-user

| variant                 |   wnam |    enam |     sam |    weur |    eeur |    apac |      oc |      me |     afr |
| ----------------------- | -----: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: |
| current (baseline)      |    734 |     590 |     612 |     326 |     378 |    1377 |    1580 |     429 |     214 |
| thick-identity          |    706 |     582 |     559 |     151 |     282 |    1334 |    1547 |     293 |     191 |
| fast-hash               |    510 |     423 |     430 |     137 |     203 |    1237 |    1421 |     275 |     138 |
| pbkdf2-fast             |    502 |     423 |     416 |     117 |     225 |    1224 |    1416 |     387 |     139 |
| kv-cache                |    750 |     611 |     587 |     148 |     351 |    1372 |    1490 |     359 |     194 |
| stacked                 |    521 |     493 |     458 |      95 |     195 |    1226 |    1339 |     191 |     148 |
| recommended             |    513 |     440 |     411 |      83 |     170 |    1220 |    1387 |     152 |      86 |
| stateless               |     24 |      33 |      21 |      19 |      26 |      21 |      12 |      35 |      22 |
| d1-unique               |    589 |     472 |     407 |     188 |     314 |    1396 |    1537 |     348 |     233 |
| **d1-unique-stateless** | **60** | **136** | **109** | **185** | **212** | **148** | **227** | **214** | **202** |

**Winner across both ops: `d1-unique-stateless`.** Signup sub-1s p50 in 6/9 regions (worst: 1054 ms OC, −70% vs current); signin sub-230 ms global (−84% vs current). `stateless` is faster on signin alone (sub-40 ms — pure cookie verify) because it skips the email-lookup; if you don't need new signups going through D1, `stateless` is the pick.

The `d1-unique-stateless` combo wins because the only cross-region cost on its signup path is the D1 `INSERT` to the `enam` primary, and signin reads the same primary via Sessions API. Dropping BA's `secondaryStorage` KV PUT removes the second cross-region hop that hurt the `d1-unique` baseline in APAC.

Source JSONs in `/tmp/bench-signup-n30.json`, `/tmp/bench-signin-n30.json`, `/tmp/bench-signup-enam-*.json`, `/tmp/bench-signin-fixed-*.json`. Re-run with `examples/probe-worker` `POST /probe { variantId, op, n }`.

## Multi-region D1 + jurisdiction routing plan

**Current state.** A single D1 (`ba-cf-do-recovery`) holds three tables:

| table                | role                                                                             | source-of-truth?                                         |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `identity_unique`    | `email_hash → principal_id`, UNIQUE constraint backs the `d1-unique` signup path | **yes** (when `USE_D1_IDENTITY=1`)                       |
| `identity_index`     | KV+D1 cache for `email → principal_id`; version-stamped                          | no (cache; `identity_unique` or IdentityDO is the floor) |
| `users` + `accounts` | DR mirror written one-way from UserDO via the outbox                             | no (DOs are the source of truth)                         |

Two of those three (`identity_unique`, `users`) hold per-principal PII (email, name, image). That's what makes residency a hard requirement — putting EU users' rows in a US D1 violates GDPR.

**Phase 1 — move primary to enam (this PR).** A single D1 primary in `enam`. NA traffic is fast (same continent), EU traffic is fast-ish (one ocean hop). Replaces today's `wnam`-ish placement. No app changes — just `wrangler d1 create --location enam` and rebind. Validated by bench delta on `weur` and `enam` rows.

**Phase 2 — EU primary + per-principal `home_region`.** Add a second D1 (`ba-cf-do-recovery-eu`) with the same schema, primary in `weur`. Introduce:

- A jurisdiction config: `{ enam: { d1: AUTH_DB_NA }, weur: { d1: AUTH_DB_EU } }`.
- A `home_region` field on each principal, decided at signup from `cf.continent` (with an explicit user override for legal residency). Stored in the UserDO's principal record + mirrored to D1.
- A routing layer that, given an email, has to find `principal_id` _and_ `home_region` together. Two options:
    1. **Replicated identity index in KV** — single KV namespace (KV is global anyway) keyed by `email_hash` holds `{principalId, homeRegion, version}`. Lookup is one KV GET. PII is just the email hash. Falls back to fan-out (parallel `lookup` against every regional D1) on KV miss.
    2. **Identity lookup in a tiny global D1** — only `identity_unique` lives in a global D1 (primary anywhere — wnam is fine); the heavy PII tables (`users`, `accounts`) live in the regional D1 picked by `home_region`. Heavier than KV but gives a strict-consistent uniqueness check.
- A new `multiRegionAdapter(config)` factory that wraps the existing `createDoAdapter` and dispatches reads/writes to the correct regional `d1IdentityStore` + downstream `authDataStore`.

**Phase 3 — APAC primary if traffic justifies it.** Same pattern, `ba-cf-do-recovery-apac` in `apac`. The bench shows APAC's signup tax against an enam primary is ~250 ms — only worth a third primary if APAC becomes a top-3 traffic region.

**Phase 4 — sharding inside a region.** When any one regional D1 nears the 10 GB ceiling, shard on `hash(principal_id) % N` across N sibling DBs in the same jurisdiction. The routing layer composes naturally — `(homeRegion, shardId)` becomes the routing key.

**Open questions deliberately deferred:**

- Cross-jurisdiction account move (EU user moves to US). Probably "create new principal, link old via account merge, deprecate old". No data crosses borders.
- Replication for read-locality within a jurisdiction. D1 Sessions API already gives us nearest-replica reads inside a primary's region; the multi-region pattern above is about _write_ primary placement, not replicas.
- Hyperdrive (Postgres) variant of the same pattern, for users who want a real DB.

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
