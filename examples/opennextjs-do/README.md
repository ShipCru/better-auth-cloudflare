# DO adapter — Next.js (OpenNext) example

Same shape as [`examples/opennextjs`](../opennextjs/) but uses the `do`
adapter option. No D1, no Hyperdrive. All auth state in Durable
Objects on the hot path; sessions in KV via BA's `secondaryStorage`.

## Status

**Scaffold only.** The auth + DB wiring (`src/auth/index.ts`, `src/db/index.ts`)
is the working core — drop-in replacement for the equivalent files in
`examples/opennextjs`. The UI, layout, dashboard, and protected pages
are not duplicated here; **copy them verbatim from `examples/opennextjs`**.
The auth flow doesn't change shape — only the storage layer underneath.

## Migration recipe from `examples/opennextjs`

```bash
# 1. Start from the existing OpenNext example
cp -R examples/opennextjs examples/opennextjs-do
cd examples/opennextjs-do

# 2. Replace auth + db config with the files in this directory
cp ../opennextjs-do/src/auth/index.ts src/auth/index.ts
cp ../opennextjs-do/src/db/index.ts src/db/index.ts
rm -rf src/db/auth.schema.ts drizzle/  # no migrations needed for DO

# 3. Update wrangler.jsonc / wrangler.toml to add DO bindings (see this directory's wrangler.toml)

# 4. Add the DO export to the Worker entry — see "OpenNext gotcha" below
```

## OpenNext gotcha: re-exporting DO classes

OpenNext generates the Worker entry file at build time. To register
Durable Object classes, you must extend the generated entry:

```ts
// .open-next/worker.ts (or your wrapper, see OpenNext docs)
import { default as handler } from './worker.generated';
export { UserDurableObject, IdentityDurableObject } from 'better-auth-cloudflare';
export default handler;
```

Or, if your wrangler.toml's `main` points at your own wrapper:

```ts
// src/worker.ts
import baseHandler from '@opennextjs/cloudflare/handler';
export { UserDurableObject, IdentityDurableObject } from 'better-auth-cloudflare';
export default baseHandler;
```

See the OpenNext-Cloudflare docs for the current recommended pattern:
<https://opennext.js.org/cloudflare>.

## What's in this directory

- `src/auth/index.ts` — DO-backed BA config (drop-in for the upstream version)
- `src/db/index.ts` — no-op (the DO adapter doesn't need a DB client)
- `wrangler.toml` — DO + KV bindings, no D1
- `package.json` — same deps as upstream minus D1/Drizzle
- (UI files — see Migration recipe above to copy from `examples/opennextjs`)

## Why this is scaffold-only

OpenNext's build pipeline + DO class registration is non-trivial to
demonstrate without committing 30+ UI files that aren't materially
different from the upstream example. Once the upstream OpenNext example
is stable and the DO-export pattern is documented, this can become a
full standalone demo.
