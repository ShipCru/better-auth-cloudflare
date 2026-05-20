/**
 * Drizzle migrator for the CRDB auth schema. Runs all pending
 * migrations in `src/crdb/migrations/` against the cluster pointed at
 * by `$DATABASE_URL` (or `$BA_CF_DATABASE_URL_AWS_US_EAST_2` for
 * convenience with the glass env file).
 *
 * Run via:
 *
 *   pnpm db:migrate            # uses env URL
 *   pnpm db:migrate -- <URL>   # explicit URL
 *
 * Both regional gateway URLs hit the same multi-region cluster, so any
 * one of them is fine for migrations — writes go to the cluster's
 * coordinator regardless of which gateway opens the session.
 *
 * On first run this creates the `drizzle.__drizzle_migrations` table
 * which tracks applied migrations, then applies 0000_init. Re-runs
 * are idempotent.
 */
import { drizzle } from "drizzle-orm/cockroach";
import { migrate } from "drizzle-orm/cockroach/migrator";
import { Pool } from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || process.env.DATABASE_URL || process.env.BA_CF_DATABASE_URL_AWS_US_EAST_2;

if (!url) {
    console.error("usage: pnpm db:migrate [-- CONNECTION_URL]");
    console.error("       (or set DATABASE_URL / BA_CF_DATABASE_URL_AWS_US_EAST_2 in env)");
    process.exit(1);
}

const host = url.split("@")[1]?.split("?")[0] ?? "<unknown>";
console.log(`connecting to ${host}...`);

const pool = new Pool({
    connectionString: url,
    // Trust CRDB Cloud's cert chain via Node's bundled CA store —
    // avoids the libpq ~/.postgresql/root.crt requirement.
    ssl: { rejectUnauthorized: true },
    max: 1,
});
const db = drizzle({ client: pool });

try {
    await migrate(db, { migrationsFolder: resolve(here, "migrations") });
    console.log("✅ migrations applied\n");

    const regions = await db.execute<{ region: string }>(
        // SHOW REGIONS returns one row per region for the current database
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "SHOW REGIONS FROM DATABASE defaultdb" as unknown as any
    );
    console.log("regions:        " + (regions as unknown as Array<{ region: string }>).map(r => r.region).join(", "));
} catch (err) {
    console.error("❌ migration failed:", (err as Error).message);
    process.exit(1);
} finally {
    await pool.end();
}
