/**
 * Better Auth adapter backed by CockroachDB via Cloudflare Hyperdrive.
 * Single multi-region cluster (REGIONAL BY ROW) — same pattern glass
 * uses in production.
 *
 * One Hyperdrive binding talks to the cluster. CRDB itself handles
 * region routing: each row's `crdb_region` column determines which
 * region's nodes physically hold it. Same-region queries are local
 * Postgres latency; cross-region queries transparently fetch from the
 * home region.
 *
 * Region selection on signup:
 *   - The `users.crdb_region` column defaults to
 *     `default_to_database_primary_region(gateway_region())` at INSERT,
 *     i.e., wherever the SQL gateway lives. With Hyperdrive picking the
 *     nearest gateway to the worker, the user's row lands near them.
 *   - The `accounts.crdb_region` column is set explicitly to match the
 *     parent user's region (sent by the adapter on the second INSERT).
 *
 * Perf patterns ported from the D1/DO adapters in earlier PRs:
 *
 *   - KV identity_index pre-check on the dup-email signup path
 *     (Promise.race against a 50 ms ceiling; cache hit → stub user
 *     so BA short-circuits without hashing)
 *   - Write-through to KV identity_index on successful signup
 *   - All region-aware reads include `WHERE crdb_region = $hint` so
 *     CRDB can prune partitions and serve from the local replica.
 *   - waitUntil for the KV write-through so it doesn't block signup.
 */
import type { Hyperdrive } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/cockroach";
import { eq, and } from "drizzle-orm";
import { Pool } from "pg";
import type { IdentityIndexCache } from "better-auth-cloudflare";
import { users, accounts } from "./schema";

/**
 * Cluster region codes — matched against `cf.continent` to pick the
 * `crdb_region` hint we pass on inserts. Add a new region here AND on
 * the CRDB cluster (`ALTER DATABASE ... ADD REGION ...`) to extend.
 */
/**
 * Cluster region codes — match CRDB Cloud's naming, including the
 * `aws-` prefix the cluster uses on AWS (CRDB on GCP would use `gcp-`).
 * These are the values stored in the `crdb_region` column.
 */
export type CrdbRegion = "aws-us-east-2" | "aws-eu-central-1" | "aws-ap-southeast-1";

export interface CrdbAdapterConfig {
    /**
     * One Hyperdrive per region's SQL gateway. All Hyperdrives point at
     * the SAME multi-region CRDB cluster — they differ only in which
     * SQL gateway hostname they connect to. Picking the nearest gateway
     * means the SQL session lands in that region, the row's
     * `gateway_region()` default places it locally, and reads/writes
     * stay in-region.
     */
    hyperdrives: {
        "aws-us-east-2": Hyperdrive;
        "aws-eu-central-1": Hyperdrive;
        "aws-ap-southeast-1": Hyperdrive;
    };
    /** Cloudflare `cf` block — used to pick the Hyperdrive. */
    cf?: { continent?: string | null };
    /** Optional KV identity_index for the dup-email pre-check. */
    identityIndexCache?: IdentityIndexCache;
    /** Optional ExecutionContext.waitUntil for deferring KV write-through. */
    deferredWritesCtx?: { waitUntil(p: Promise<unknown>): void };
}

interface WhereClause {
    field: string;
    value: unknown;
    operator?: string;
}

export interface Adapter {
    id: string;
    create<T = Record<string, unknown>>(args: { model: string; data: Record<string, unknown> }): Promise<T>;
    findOne<T = Record<string, unknown>>(args: {
        model: string;
        where: WhereClause[];
        join?: Record<string, boolean>;
    }): Promise<T | null>;
    findMany<T = Record<string, unknown>>(args: { model: string; where?: WhereClause[]; limit?: number }): Promise<T[]>;
    update<T = Record<string, unknown>>(args: {
        model: string;
        where: WhereClause[];
        update: Record<string, unknown>;
    }): Promise<T | null>;
    updateMany(args: { model: string; where: WhereClause[]; update: Record<string, unknown> }): Promise<number>;
    delete(args: { model: string; where: WhereClause[] }): Promise<void>;
    deleteMany(args: { model: string; where: WhereClause[] }): Promise<number>;
    count(args: { model: string; where?: WhereClause[] }): Promise<number>;
}

/**
 * Map `cf.continent` → CRDB region name. The names match what was passed
 * to `ALTER DATABASE ... ADD REGION` on the cluster.
 *
 * EU + AF go to eu-central-1 (data-residency boundary + AF colos closer
 * to EU than US). Everything else (NA, SA, AS, OC, AN, unknown) goes to
 * us-east-2 — the primary region.
 */
function pickRegion(continent: string | null | undefined): CrdbRegion {
    if (continent === "EU" || continent === "AF") return "aws-eu-central-1";
    if (continent === "AS" || continent === "OC") return "aws-ap-southeast-1";
    return "aws-us-east-2";
}

async function hashEmail(email: string): Promise<string> {
    const data = new TextEncoder().encode(email.toLowerCase().trim());
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Pool factory. Hyperdrive presents a Postgres connection string via
 * `binding.connectionString`. We open a `pg.Pool` once per isolate —
 * `pg.Pool` keeps connections warm across requests in the same isolate
 * (CF Fluid Compute reuses isolates).
 *
 * Bounded to max=1 because Hyperdrive itself does the connection
 * pooling at the edge — local pool is just for the in-flight call.
 */
const poolByRegion: Partial<Record<CrdbRegion, Pool>> = {};
function getPool(region: CrdbRegion, hyperdrive: Hyperdrive): Pool {
    let pool = poolByRegion[region];
    if (!pool) {
        pool = new Pool({
            connectionString: hyperdrive.connectionString,
            max: 1,
            ssl: false, // Hyperdrive handles TLS; the in-isolate hop is plaintext.
        });
        poolByRegion[region] = pool;
    }
    return pool;
}

export function createCrdbAdapter(config: CrdbAdapterConfig): Adapter {
    const region = pickRegion(config.cf?.continent);
    const hyperdrive = config.hyperdrives[region];
    const db = drizzle({ client: getPool(region, hyperdrive) });

    function whereToObj(where: WhereClause[]): Record<string, unknown> {
        const obj: Record<string, unknown> = {};
        for (const w of where) obj[w.field] = w.value;
        return obj;
    }

    return {
        id: "crdb-multi-region",

        async create({ model, data }) {
            if (model === "user") {
                const email = data.email as string;
                const emailHash = await hashEmail(email);
                const [row] = await db
                    .insert(users)
                    .values({
                        // Don't set crdbRegion explicitly — let the SQL
                        // default (default_to_database_primary_region(gateway_region()))
                        // pick the SQL gateway's region. Hyperdrive routes
                        // to the nearest gateway, so this is the right place
                        // for the user's row.
                        name: (data.name as string) ?? "",
                        email,
                        emailVerified: (data.emailVerified as boolean) ?? false,
                        image: (data.image as string) ?? null,
                    })
                    .returning();
                // Write-through to KV identity_index. Deferred so the
                // INSERT round-trip is the only thing on the signup
                // response critical path.
                if (config.identityIndexCache) {
                    const p = config.identityIndexCache
                        .upsert(emailHash, { principalId: row.id, version: 1 })
                        .catch(() => {});
                    config.deferredWritesCtx ? config.deferredWritesCtx.waitUntil(p) : await p;
                }
                return row as never;
            }
            if (model === "account") {
                // The account's region MUST match the parent user's region.
                // We use the hint from cf.continent for new signups (the
                // user was just inserted into the same region). For
                // OAuth-account-add against an existing user, the caller
                // should pass `data.crdbRegion` explicitly.
                const accountRegion = typeof data.crdbRegion === "string" ? (data.crdbRegion as CrdbRegion) : region;
                const [row] = await db
                    .insert(accounts)
                    .values({
                        crdbRegion: accountRegion,
                        userId: data.userId as string,
                        providerId: data.providerId as string,
                        accountId: (data.accountId as string) ?? (data.userId as string),
                        password: (data.password as string | undefined) ?? null,
                        accessToken: (data.accessToken as string | undefined) ?? null,
                        refreshToken: (data.refreshToken as string | undefined) ?? null,
                        scope: (data.scope as string | undefined) ?? null,
                        idToken: (data.idToken as string | undefined) ?? null,
                    })
                    .returning();
                return row as never;
            }
            throw new Error(`crdb-adapter.create: unsupported model "${model}"`);
        },

        async findOne({ model, where, join }) {
            const w = whereToObj(where);
            if (model === "user") {
                // KV pre-check on dup-email signup path. Cache hit means
                // the email is taken; return a stub user so BA short-
                // circuits to EMAIL_ALREADY_EXISTS without ever hashing.
                if (typeof w.email === "string" && !join?.account && config.identityIndexCache) {
                    const emailHash = await hashEmail(w.email);
                    const ceiling = new Promise<null>(r => setTimeout(() => r(null), 50));
                    const hit = await Promise.race([
                        config.identityIndexCache.get(emailHash).catch(() => null),
                        ceiling,
                    ]);
                    if (hit) {
                        return {
                            id: hit.principalId,
                            email: w.email,
                            name: null,
                            emailVerified: false,
                            image: null,
                            createdAt: new Date(0),
                            updatedAt: new Date(0),
                        } as never;
                    }
                }

                if (typeof w.email === "string") {
                    // No `crdb_region` filter here — email is a globally-
                    // unique secondary index, and we don't know the user's
                    // home region without looking it up. UNIQUE is enforced
                    // globally by CRDB's cross-partition check.
                    const rows = await db.select().from(users).where(eq(users.email, w.email)).limit(1);
                    if (rows.length === 0) return null;
                    const user = rows[0];
                    if (join?.account) {
                        // Region-aware join: the parent user's region tells
                        // us where the account rows live, so we prune.
                        const accountRows = await db
                            .select()
                            .from(accounts)
                            .where(and(eq(accounts.userId, user.id), eq(accounts.crdbRegion, user.crdbRegion)));
                        return { ...user, account: accountRows } as never;
                    }
                    return user as never;
                }
                if (typeof w.id === "string") {
                    const rows = await db.select().from(users).where(eq(users.id, w.id)).limit(1);
                    return (rows[0] ?? null) as never;
                }
                return null;
            }
            if (model === "account") {
                if (typeof w.userId === "string") {
                    const rows = await db.select().from(accounts).where(eq(accounts.userId, w.userId)).limit(1);
                    return (rows[0] ?? null) as never;
                }
                if (typeof w.providerId === "string" && typeof w.accountId === "string") {
                    const rows = await db
                        .select()
                        .from(accounts)
                        .where(and(eq(accounts.providerId, w.providerId), eq(accounts.accountId, w.accountId)))
                        .limit(1);
                    return (rows[0] ?? null) as never;
                }
                return null;
            }
            throw new Error(`crdb-adapter.findOne: unsupported model "${model}"`);
        },

        async findMany({ model, where }) {
            const w = whereToObj(where ?? []);
            if (model === "account" && typeof w.userId === "string") {
                const rows = await db.select().from(accounts).where(eq(accounts.userId, w.userId));
                return rows as never;
            }
            return [];
        },

        async update({ model, where, update }) {
            const w = whereToObj(where);
            if (model === "user" && typeof w.id === "string") {
                const [row] = await db
                    .update(users)
                    .set(update as never)
                    .where(eq(users.id, w.id))
                    .returning();
                return (row ?? null) as never;
            }
            if (model === "account" && typeof w.id === "string") {
                const [row] = await db
                    .update(accounts)
                    .set(update as never)
                    .where(eq(accounts.id, w.id))
                    .returning();
                return (row ?? null) as never;
            }
            return null;
        },

        async updateMany() {
            return 0;
        },

        async delete({ model, where }) {
            const w = whereToObj(where);
            if (model === "user" && typeof w.id === "string") {
                await db.delete(users).where(eq(users.id, w.id));
            }
        },

        async deleteMany() {
            return 0;
        },

        async count() {
            return 0;
        },
    };
}
