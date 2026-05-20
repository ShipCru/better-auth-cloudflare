/**
 * Migrator for the CRDB auth schema.
 *
 * Reads every NNNN_*.sql file in src/crdb/migrations/, applies the
 * ones not yet recorded in the `_app_migrations` tracking table, in
 * filename order. Idempotent: re-running is safe.
 *
 * Why a custom runner instead of `drizzle-orm/cockroach/migrator`?
 * The Drizzle migrator at 1.0.0-rc.3 enforces a strict folder shape
 * (per-migration snapshot.json + journal v7) and complains when it
 * sees hand-written SQL. Our 0000_init.sql carries CRDB DDL the
 * drizzle-kit diff engine can't model (LOCALITY REGIONAL BY ROW,
 * composite region FKs), so we'd be fighting the tool. This runner
 * gives the same idempotent contract with 30 lines.
 *
 * Run via:
 *
 *   pnpm db:migrate                     # uses env URL
 *   pnpm db:migrate -- '<URL>'          # explicit URL
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

async function main(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(here, "migrations");
    const url = process.argv[2] || process.env.DATABASE_URL || process.env.BA_CF_DATABASE_URL_AWS_US_EAST_2;

    if (!url) {
        console.error("usage: pnpm db:migrate [-- CONNECTION_URL]");
        console.error("       (or set DATABASE_URL / BA_CF_DATABASE_URL_AWS_US_EAST_2 in env)");
        process.exit(1);
    }

    const host = url.split("@")[1]?.split("?")[0] ?? "<unknown>";
    console.log(`connecting to ${host}...`);

    const client = new pg.Client({
        connectionString: url,
        // Trust CRDB Cloud's cert chain via Node's bundled CA store —
        // avoids the libpq ~/.postgresql/root.crt requirement.
        ssl: { rejectUnauthorized: true },
    });
    await client.connect();

    try {
        // Tracking table for applied migrations. CRDB-friendly (no
        // PostgreSQL-specific features), with `applied_at` for audit.
        await client.query(`
            CREATE TABLE IF NOT EXISTS _app_migrations (
                tag         TEXT PRIMARY KEY,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows: applied } = await client.query<{ tag: string }>("SELECT tag FROM _app_migrations ORDER BY tag");
        const appliedSet = new Set(applied.map(r => r.tag));

        const files = readdirSync(migrationsDir)
            .filter(f => /^\d+_.*\.sql$/.test(f))
            .sort();

        let ranAny = false;
        for (const file of files) {
            if (appliedSet.has(file)) {
                console.log(`  ✓ ${file} (already applied)`);
                continue;
            }
            console.log(`  → applying ${file}...`);
            const sql = readFileSync(join(migrationsDir, file), "utf8");
            await client.query(sql);
            await client.query("INSERT INTO _app_migrations (tag) VALUES ($1)", [file]);
            console.log(`  ✓ applied ${file}`);
            ranAny = true;
        }

        if (!ranAny) console.log("\nno pending migrations");
        else console.log("\n✅ migrations applied");

        const { rows: regions } = await client.query<{ region: string; primary: boolean }>(
            "SHOW REGIONS FROM DATABASE defaultdb"
        );
        console.log("regions:        " + regions.map(r => `${r.region}${r.primary ? " (primary)" : ""}`).join(", "));
        // SHOW LOCALITY isn't a top-level statement in CRDB — extract from
        // SHOW CREATE TABLE which always includes the LOCALITY clause.
        for (const t of ['"user"', '"account"', '"session"']) {
            const { rows } = await client.query<{ create_statement: string }>(
                `SELECT create_statement FROM [SHOW CREATE TABLE ${t}]`
            );
            const loc = rows[0]?.create_statement.match(/LOCALITY\s+([^;]+)/)?.[1].trim() ?? "(unknown)";
            console.log(`${t} locality: ${loc}`);
        }
    } catch (err) {
        console.error("❌ migration failed:", (err as Error).message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error("❌ unexpected:", err);
    process.exit(1);
});
