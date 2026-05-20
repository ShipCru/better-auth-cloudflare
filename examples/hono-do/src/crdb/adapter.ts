/**
 * Better Auth adapter backed by CockroachDB via Hyperdrive.
 *
 * Routing: 3 Hyperdrive bindings (one per region — us-east-2,
 * eu-central-1, ap-southeast-1) plus 3 separate CRDB clusters (one
 * per region). At request time, the adapter picks the binding that
 * matches `cf.continent`:
 *
 *   NA  → HYPERDRIVE_NA (us-east-2)
 *   EU  → HYPERDRIVE_EU (eu-central-1)
 *   AS/OC → HYPERDRIVE_APAC (ap-southeast-1)
 *   else → HYPERDRIVE_NA (default)
 *
 * Same-region writes are local-Postgres-fast (~5–20 ms). Hyperdrive
 * pools connections at the edge so cold-start TLS handshake is amortised.
 *
 * Perf patterns ported from the D1/DO adapters in this PR:
 *
 *   - KV identity_index pre-check on the dup-email signup path
 *     (`Promise.race` against a 50 ms ceiling; cache hit → stub user
 *     so BA short-circuits without hashing)
 *   - Write-through to KV identity_index on successful signup
 *   - `Promise.allSettled([INSERT user, INSERT account])` not yet —
 *     these are sequential here because the account row references
 *     user.id and we want the FK invariant honoured at the SQL layer.
 *     The user-insert is one round-trip; the account-insert is the
 *     second. Total signup: 2 cross-isolate Hyperdrive calls.
 *   - `waitUntil` for the KV write-through so it doesn't block the
 *     signup response.
 */
import type { Hyperdrive } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/cockroach";
import { eq, and } from "drizzle-orm";
import { Pool } from "pg";
import type { IdentityIndexCache } from "better-auth-cloudflare";
import { users, accounts } from "./schema";

/**
 * Cloudflare region codes — matched against `cf.continent` to pick
 * the right Hyperdrive. Aligns with the lib's `examples/probe-worker`
 * region scheme.
 *
 *   enam  → AWS us-east-2 (cf.continent === "NA")
 *   weur  → AWS eu-central-1 (cf.continent === "EU")
 *   apac  → AWS ap-southeast-1 (cf.continent === "AS" or "OC")
 */
export type CrdbRegion = "enam" | "weur" | "apac";

export interface CrdbAdapterConfig {
    /** One Hyperdrive binding per region. Region keys match CF region codes. */
    hyperdrives: { enam: Hyperdrive; weur: Hyperdrive; apac: Hyperdrive };
    /** Cloudflare `cf` block from the request — used to pick the region. */
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

function pickRegion(continent: string | null | undefined): CrdbRegion {
    if (continent === "EU") return "weur";
    if (continent === "AS" || continent === "OC") return "apac";
    return "enam";
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
 * `binding.connectionString`. We open a `pg.Pool` once per
 * (isolate, region) — `pg.Pool` keeps connections warm across requests
 * in the same isolate (CF Fluid Compute reuses isolates).
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
    if (!hyperdrive) {
        throw new Error(`crdb-adapter: no Hyperdrive binding for region "${region}"`);
    }
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
                const [row] = await db
                    .insert(accounts)
                    .values({
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
                // KV pre-check on dup-email signup path (same pattern as
                // do.ts findOne in the D1 adapter). When findOne is called
                // with `email` and no `join`, BA is checking existence —
                // a KV cache hit means the email is taken; return a stub
                // user so BA short-circuits to EMAIL_ALREADY_EXISTS without
                // ever hashing the password.
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
                    const rows = await db.select().from(users).where(eq(users.email, w.email)).limit(1);
                    if (rows.length === 0) return null;
                    const user = rows[0];
                    if (join?.account) {
                        const accountRows = await db.select().from(accounts).where(eq(accounts.userId, user.id));
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
