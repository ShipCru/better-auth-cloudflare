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
- [ ] **KV read-cache layer for IdentityDO** — globally-cached email→principalId lookups (eliminates cross-region signin RPC). DO stays as the write oracle.
- [ ] **Replace IdentityDO with D1 UNIQUE index** — current per-email-hash DO eats ~1-4s cold-start on every new signup. A D1 table with `UNIQUE (email_hash)` gives identical uniqueness guarantees with ~30-80ms cold reads and ~5ms warm. Make IdentityDO opt-in for users who prefer the no-DB-on-hot-path purity.
- [ ] **Multi-database routing for residency** — pluggable per-region database bindings (EU / US / APAC), so EU auth data stays in EU D1 (or Postgres via Hyperdrive). Hard-stop residency boundary.
- [ ] **Multi-database sharding within a region** — hash principal_id mod N across DB shards inside a jurisdiction. Supports growth beyond a single DB.
- [ ] **Active DO dashboard** — read-only admin view of active principal DOs with location, region, and storage size
- [ ] **Hash-sharded UserDOs** — opt-in mode where principal_id → `userDo.idFromName("shard:" + hash(id) % N)` so cold starts amortize across many users. Trade-off: lose 1:1 principal:DO isolation; cap of ~256MB SQLite per shard.

**Performance / observability:**

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
- [ ] Active-DO dashboard endpoint (`GET /api/auth/admin/active-objects`)
- [ ] Benchmark suite with geo-distributed runners

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
