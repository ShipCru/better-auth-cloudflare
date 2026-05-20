import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for the CRDB schema.
 *
 * One CRDB Cloud cluster with three regions (us-east-2, eu-central-1,
 * ap-southeast-1). drizzle-kit operates against a single connection,
 * but all three regional URLs hit the same cluster — pick whichever
 * is closest for your dev machine via:
 *
 *   pnpm db:generate                    # generate a new migration from schema diff
 *   pnpm db:migrate                     # run pending migrations against $BA_CF_DATABASE_URL_AWS_US_EAST_2
 *   pnpm db:push                        # push schema directly (dev only, no migration files)
 *   pnpm db:studio                      # open the web UI
 *   pnpm db:check                       # validate that migrations are consistent
 *
 * The connection URL is sourced from env. Set it before running any
 * drizzle-kit command:
 *
 *   set -a; source ../../../../../glass/packages/rock/.env.development-ref; set +a
 *
 * Or pass it inline:
 *
 *   DATABASE_URL='postgresql://...' pnpm db:migrate
 *
 * Custom CRDB DDL (REGIONAL BY ROW locality, composite region FKs)
 * lives at the END of migrations/0000_init.sql — handwritten, not
 * generated. Drizzle-kit's diff engine can't model `LOCALITY` or the
 * region-aware FK pattern. Future `pnpm db:generate` will produce
 * diffs for the regular columns/indexes only; append any new locality
 * tweaks to the generated migration by hand.
 */
export default defineConfig({
    dialect: "cockroachdb",
    schema: "./src/crdb/schema.ts",
    out: "./src/crdb/migrations",
    dbCredentials: {
        url: process.env.DATABASE_URL || process.env.BA_CF_DATABASE_URL_AWS_US_EAST_2 || "",
    },
    // Verbose so the generated SQL is reviewable before applying
    verbose: true,
    strict: true,
});
