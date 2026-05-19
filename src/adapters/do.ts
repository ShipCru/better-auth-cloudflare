import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createLogger, shortHash, timed, type Logger } from "../logging";
import type { PrincipalRecord, AccountRecord } from "../objects/UserDurableObject";
import type { AuthDataStore } from "./auth-data";

/**
 * Better Auth adapter backed by per-principal Durable Objects.
 *
 * Routing:
 *   - `user` model  → IdentityDurableObject (for email lookup) +
 *                     UserDurableObject (per principal_id)
 *   - `account` model → UserDurableObject (by userId)
 *   - `session` / `verification` → handled by BA `secondaryStorage`
 *     (typically Cloudflare KV). The adapter throws if asked for them.
 *
 * Designed to be passed to BA's `adapter` field via the upstream
 * `withCloudflare({ do: { ... } }, ...)` option. Users can also use it
 * stand-alone:
 *
 * ```ts
 * import { createDoAdapter } from 'better-auth-cloudflare';
 * betterAuth({
 *   database: createDoAdapter({ userDo: env.USER_DO, identityDo: env.IDENTITY_DO }),
 *   ...
 * });
 * ```
 */

export interface DOAdapterConfig {
    userDo: DurableObjectNamespace;
    identityDo: DurableObjectNamespace;
    /** Optional log level; defaults to "info". */
    logLevel?: "debug" | "info" | "warn" | "error";
    /**
     * Optional request region metadata. When supplied, every adapter log line
     * carries `requestColo`, `requestCountry`, `requestContinent` and `requestRegion`,
     * making it possible to correlate user requests with the colo they hit and
     * (via the DO id in the same log line) which DO instance served them.
     *
     * The DO's own physical colo is NOT directly introspectable from inside the
     * DO — Cloudflare doesn't expose `state.colo`. Use the namespace-level
     * Cloudflare dashboard (or per-deployment Analytics Engine queries) to see
     * physical DO placement; the `requestColo` here tells you where the user
     * hit the edge, which is a reasonable proxy when `locationHint` was set.
     */
    region?: RegionContext;
    /**
     * Optional auth data store reference. Pass this if you intend to call
     * `restorePrincipal` from your Worker — it's not used
     * for write-mirroring here.
     *
     * **Sync to the auth data store is owned by the DO**, not the adapter.
     * Bind your D1 database as `AUTH_RECOVERY_DB` in wrangler.toml and the
     * UserDurableObject's outbox + 3s alarm will keep D1 eventually
     * consistent with the DO state (typical lag ~3-6s). See README for
     * details and the schema in `AUTH_DATA_D1_SCHEMA`.
     */
    authDataStore?: AuthDataStore;
    /**
     * Opt-in: write user + account snapshots into IdentityDO's `thick_cache`
     * on every signup/account/profile change, and read sign-in's
     * `findOne(user, email, join.account)` from there in ONE DO RPC instead
     * of bouncing IdentityDO → UserDO.findPrincipal → UserDO.listAccounts.
     *
     * Trade-off: write fan-out (every account write also touches the
     * IdentityDO) and eventual consistency between the two DOs for ~ms-scale
     * windows. The thick cache is a denormalised read cache; the canonical
     * source of truth for principal data remains UserDO.
     *
     * Useful when sign-in is the hot path. For signup-heavy workloads the
     * write amplification may not be worth it.
     */
    thickIdentity?: boolean;
}

export interface RegionContext {
    colo?: string | null;
    country?: string | null;
    continent?: string | null;
    region?: string | null;
}

export interface WhereClause {
    field: string;
    value: unknown;
    operator?: string;
    connector?: "AND" | "OR";
}

export interface Adapter {
    id: string;
    create<T = Record<string, unknown>>(args: { model: string; data: Record<string, unknown> }): Promise<T>;
    findOne<T = Record<string, unknown>>(args: {
        model: string;
        where: WhereClause[];
        join?: Record<string, boolean>;
    }): Promise<T | null>;
    findMany<T = Record<string, unknown>>(args: {
        model: string;
        where?: WhereClause[];
        limit?: number;
        offset?: number;
    }): Promise<T[]>;
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

const encoder = new TextEncoder();

async function hashEmail(email: string): Promise<string> {
    const normalised = email.trim().toLowerCase();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalised));
    const bytes = new Uint8Array(digest);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
}

/**
 * Thick mode write helper. Pulls the canonical principal + account list
 * from UserDO and writes a JSON snapshot into IdentityDO's thick_cache so
 * the next sign-in resolves in one DO RPC. Best-effort: if anything fails
 * we log and continue; the legacy three-RPC path remains correct.
 */
async function updateThickCache(config: DOAdapterConfig, log: Logger, principalId: string): Promise<void> {
    try {
        const userStub = config.userDo.get(config.userDo.idFromName(principalId));
        // @ts-expect-error — DO RPC
        const principal = (await userStub.findPrincipal()) as { email?: string | null; isAnonymous?: boolean } | null;
        if (!principal?.email || principal.isAnonymous) return;
        // @ts-expect-error — DO RPC
        const accounts = (await userStub.listAccounts(principalId)) as unknown[];
        const emailHash = await hashEmail(principal.email);
        const idStub = config.identityDo.get(config.identityDo.idFromName(`identity:${emailHash}`));
        // @ts-expect-error — DO RPC
        await idStub.upsertCachedData(emailHash, JSON.stringify(principal), JSON.stringify(accounts));
    } catch (err) {
        log.warn("thick cache update failed", { principalId, err: (err as Error)?.message });
    }
}

function pickWhere(where: WhereClause[], field: string): unknown {
    return where.find(w => w.field === field)?.value;
}

function unsupported(method: string, model: string, detail: string): never {
    throw new Error(`do-adapter: ${method} on model '${model}' not supported (${detail})`);
}

/**
 * Better Auth expects `database` to be either a Kysely Dialect/D1Database OR
 * an "adapter instance" — a factory function `(BetterAuthOptions) => Adapter`.
 * `createDoAdapter` returns the factory, matching the shape returned by
 * `drizzleAdapter(...)`. The BetterAuthOptions argument is unused today
 * (BA passes its full options for the adapter to introspect — none of our
 * paths need them) but is accepted to satisfy the contract.
 */
export type DoAdapterFactory = (options: unknown) => Adapter;

export function createDoAdapter(config: DOAdapterConfig): DoAdapterFactory {
    const baseLog: Logger = createLogger({ scope: "do-adapter", level: config.logLevel ?? "info" });
    const regionMeta: Record<string, string | null> = config.region
        ? {
              requestColo: config.region.colo ?? null,
              requestCountry: config.region.country ?? null,
              requestContinent: config.region.continent ?? null,
              requestRegion: config.region.region ?? null,
          }
        : {};
    const log: Logger = baseLog.child("ops", regionMeta);
    const userStub = (principalId: string) => config.userDo.get(config.userDo.idFromName(principalId));
    const identityStub = (emailHash: string) =>
        config.identityDo.get(config.identityDo.idFromName(`identity:${emailHash}`));

    /**
     * Short-lived per-isolate cache of records just written by adapter.create().
     * Better Auth's signup flow calls adapter.create(user) and immediately
     * after calls adapter.findOne({ model: "user", where: { id } }) to
     * re-fetch the row it just inserted. That round-trips back to the DO
     * for ~6ms warm / ~400-700ms cold. Serving the same record from this
     * map saves a full DO RPC per signup. TTL is intentionally short
     * (FRESH_WRITE_TTL_MS) — anything older falls back to the DO so
     * adapter never serves stale state.
     */
    const freshWrites = new Map<string, { record: Record<string, unknown>; expiresAt: number }>();
    const FRESH_WRITE_TTL_MS = 5_000;
    function rememberFresh(kind: "user" | "account", id: string, record: Record<string, unknown>): void {
        freshWrites.set(`${kind}:${id}`, { record, expiresAt: Date.now() + FRESH_WRITE_TTL_MS });
    }
    function takeFresh(kind: "user" | "account", id: string): Record<string, unknown> | null {
        const key = `${kind}:${id}`;
        const hit = freshWrites.get(key);
        if (!hit) return null;
        if (hit.expiresAt < Date.now()) {
            freshWrites.delete(key);
            return null;
        }
        // One-shot: consume on read. BA's post-create refetch is a single
        // call; subsequent reads (different request) should go through the
        // DO so we never serve stale data even within the 5s window.
        freshWrites.delete(key);
        return hit.record;
    }

    const buildAdapter = (): Adapter =>
        ({
            id: "durable-object",

            async create({ model, data }) {
                return timed(
                    log,
                    "adapter.create",
                    async () => {
                        log.debug("create", { model, fields: Object.keys(data) });

                        if (model === "user") {
                            const created = (await createUser(config, data, log)) as Record<string, unknown>;
                            if (typeof created.id === "string") rememberFresh("user", created.id, created);
                            return created as never;
                        }
                        if (model === "account") {
                            const userId = data.userId as string;
                            if (!userId) unsupported("create", model, "missing userId");
                            const stub = userStub(userId);
                            const id = (data.id as string) ?? crypto.randomUUID();
                            // @ts-expect-error — DO RPC method
                            const account = await stub.createAccount({
                                id,
                                userId,
                                providerId: data.providerId as string,
                                accountId: (data.accountId as string) ?? id,
                                password: (data.password as string | undefined) ?? null,
                                accessToken: (data.accessToken as string | undefined) ?? null,
                                refreshToken: (data.refreshToken as string | undefined) ?? null,
                                idToken: (data.idToken as string | undefined) ?? null,
                                accessTokenExpiresAt: serialiseDate(data.accessTokenExpiresAt),
                                refreshTokenExpiresAt: serialiseDate(data.refreshTokenExpiresAt),
                                scope: (data.scope as string | undefined) ?? null,
                            });
                            const mapped = mapAccountToBA(account);
                            rememberFresh("account", account.id, mapped);
                            // Thick mode: keep IdentityDO's thick_cache in sync with
                            // the account write. This lets sign-in resolve in one DO
                            // RPC instead of three. Fetches the principal + full
                            // account list from UserDO once so the snapshot includes
                            // everything BA's signin path needs.
                            if (config.thickIdentity) {
                                await updateThickCache(config, log, userId);
                            }
                            return mapped as never;
                        }
                        unsupported("create", model, "use BA secondaryStorage for session/verification");
                    },
                    { model }
                );
            },

            async findOne({ model, where, join }) {
                return timed(
                    log,
                    "adapter.findOne",
                    async () => {
                        log.debug("findOne", { model, fields: where.map(w => w.field), join });

                        if (model === "user") {
                            const id = pickWhere(where, "id");
                            const includeAccounts = join?.account === true;
                            if (typeof id === "string") {
                                // Fast path: BA's post-create refetch. Only skip
                                // the DO RPC when no join is needed — joined reads
                                // still have to talk to the DO for the account list.
                                if (!includeAccounts) {
                                    const fresh = takeFresh("user", id);
                                    if (fresh) {
                                        log.debug("findOne.fresh_hit", { model });
                                        return fresh as never;
                                    }
                                }
                                const stub = userStub(id);
                                // @ts-expect-error
                                const p = (await stub.findPrincipal()) as PrincipalRecord | null;
                                if (!p) return null;
                                const baUser = mapPrincipalToBA(p);
                                if (includeAccounts) {
                                    // @ts-expect-error
                                    const accounts = (await stub.listAccounts(p.id)) as AccountRecord[];
                                    (baUser as Record<string, unknown>).account = accounts.map(mapAccountToBA);
                                }
                                return baUser as never;
                            }
                            const email = pickWhere(where, "email");
                            if (typeof email === "string") {
                                // PERF: BA calls findOne({email}) as a pre-existence
                                // check before signup. Hitting IdentityDO here for a
                                // brand-new email triggers a fresh DO cold start
                                // (~1-4s p95). The reserve() inside create() is
                                // already the authoritative uniqueness gate — it
                                // returns "taken" with the principal_id, which BA
                                // surfaces as EMAIL_ALREADY_EXISTS. So we can answer
                                // null here and let create do the real check.
                                //
                                // For the sign-IN path (where BA looks up an existing
                                // user by email), this would break — but that path
                                // actually uses findOne({email}) with join.account:
                                // true, so the includeAccounts branch is what
                                // matters. We still need to go to the DO for that.
                                if (!includeAccounts) {
                                    log.info("findOne.email.skipped_idDO", {});
                                    return null;
                                }
                                const emailHash = await hashEmail(email);
                                const idStub = identityStub(emailHash);

                                // Thick mode fast path. ONE DO RPC returns
                                // principal_id + user + accounts. Falls back to
                                // the legacy three-RPC path if the thick cache
                                // wasn't populated (e.g., user predates the
                                // thickIdentity flag being turned on).
                                if (config.thickIdentity) {
                                    // @ts-expect-error
                                    const thick = (await idStub.signInLookup(emailHash)) as {
                                        principalId: string;
                                        principal: string | null;
                                        accounts: string | null;
                                    } | null;
                                    if (!thick) return null;
                                    if (thick.principal && thick.accounts) {
                                        log.info("findOne.email.thick_hit", {});
                                        const principal = JSON.parse(thick.principal) as PrincipalRecord;
                                        const accounts = JSON.parse(thick.accounts) as AccountRecord[];
                                        const baUser = mapPrincipalToBA(principal);
                                        (baUser as Record<string, unknown>).account = accounts.map(mapAccountToBA);
                                        return baUser as never;
                                    }
                                    log.info("findOne.email.thick_miss", { principalId: thick.principalId });
                                    // Fall through to legacy fetch from UserDO.
                                    const stub = userStub(thick.principalId);
                                    // @ts-expect-error
                                    const p = (await stub.findPrincipal()) as PrincipalRecord | null;
                                    if (!p) return null;
                                    const baUser = mapPrincipalToBA(p);
                                    // @ts-expect-error
                                    const accounts = (await stub.listAccounts(p.id)) as AccountRecord[];
                                    (baUser as Record<string, unknown>).account = accounts.map(mapAccountToBA);
                                    return baUser as never;
                                }

                                // @ts-expect-error
                                const lookup = (await idStub.lookup(emailHash)) as { principalId: string } | null;
                                if (!lookup) return null;
                                const stub = userStub(lookup.principalId);
                                // @ts-expect-error
                                const p = (await stub.findPrincipal()) as PrincipalRecord | null;
                                if (!p) return null;
                                const baUser = mapPrincipalToBA(p);
                                // @ts-expect-error
                                const accounts = (await stub.listAccounts(p.id)) as AccountRecord[];
                                (baUser as Record<string, unknown>).account = accounts.map(mapAccountToBA);
                                return baUser as never;
                            }
                            unsupported("findOne", model, "only `id` or `email` where-clauses supported");
                        }

                        if (model === "account") {
                            const userId = pickWhere(where, "userId");
                            if (typeof userId !== "string")
                                unsupported("findOne", model, "userId required to route to UserDO");
                            const stub = userStub(userId);
                            const id = pickWhere(where, "id");
                            const providerId = pickWhere(where, "providerId");
                            const accountId = pickWhere(where, "accountId");
                            if (typeof id === "string") {
                                // BA's post-create refetch fast path (see user above).
                                const fresh = takeFresh("account", id);
                                if (fresh) {
                                    log.debug("findOne.fresh_hit", { model });
                                    return fresh as never;
                                }
                                // @ts-expect-error
                                const a = (await stub.findAccountById(id, userId)) as AccountRecord | null;
                                return a ? (mapAccountToBA(a) as never) : null;
                            }
                            if (typeof providerId === "string" && typeof accountId === "string") {
                                // @ts-expect-error
                                const a = (await stub.findAccountByProvider(
                                    providerId,
                                    accountId,
                                    userId
                                )) as AccountRecord | null;
                                return a ? (mapAccountToBA(a) as never) : null;
                            }
                            if (typeof providerId === "string") {
                                // Provider-only lookup (BA's email/password signin path):
                                // walk the user's accounts and return the first match.
                                // @ts-expect-error
                                const list = (await stub.listAccounts(userId)) as AccountRecord[];
                                const match = list.find(a => a.providerId === providerId);
                                return match ? (mapAccountToBA(match) as never) : null;
                            }
                            // Fallback for queries with just userId: return first account.
                            // @ts-expect-error
                            const list = (await stub.listAccounts(userId)) as AccountRecord[];
                            return list[0] ? (mapAccountToBA(list[0]) as never) : null;
                        }

                        unsupported("findOne", model, "unsupported model");
                    },
                    { model }
                );
            },

            async findMany({ model, where }) {
                return timed(
                    log,
                    "adapter.findMany",
                    async () => {
                        log.debug("findMany", { model, fields: (where ?? []).map(w => w.field) });

                        if (model === "account") {
                            const userId = pickWhere(where ?? [], "userId");
                            if (typeof userId !== "string") unsupported("findMany", model, "userId required");
                            const stub = userStub(userId);
                            // @ts-expect-error
                            const accounts = (await stub.listAccounts(userId)) as AccountRecord[];
                            return accounts.map(mapAccountToBA) as never;
                        }
                        unsupported("findMany", model, "unsupported model");
                    },
                    { model }
                );
            },

            async update({ model, where, update }) {
                return timed(
                    log,
                    "adapter.update",
                    async () => {
                        log.debug("update", { model, fields: Object.keys(update) });

                        if (model === "user") {
                            const id = pickWhere(where, "id");
                            if (typeof id !== "string") unsupported("update", model, "id required");
                            const stub = userStub(id);
                            // @ts-expect-error
                            const p = (await stub.updatePrincipal({
                                name: update.name as string | undefined,
                                email: update.email as string | undefined,
                                emailVerified: update.emailVerified as boolean | undefined,
                                image: update.image as string | undefined,
                            })) as PrincipalRecord;
                            if (config.thickIdentity) await updateThickCache(config, log, id);
                            return mapPrincipalToBA(p) as never;
                        }

                        if (model === "account") {
                            const id = pickWhere(where, "id");
                            const userId = pickWhere(where, "userId") ?? update.userId;
                            if (typeof id !== "string" || typeof userId !== "string") {
                                unsupported("update", model, "id and userId required");
                            }
                            const stub = userStub(userId);
                            // @ts-expect-error
                            const a = (await stub.updateAccount(
                                id,
                                update as Partial<AccountRecord>,
                                userId
                            )) as AccountRecord | null;
                            if (config.thickIdentity) await updateThickCache(config, log, userId);
                            return a ? (mapAccountToBA(a) as never) : null;
                        }

                        unsupported("update", model, "unsupported model");
                    },
                    { model }
                );
            },

            async updateMany(_args) {
                throw new Error("do-adapter: updateMany not supported");
            },

            async delete({ model, where }) {
                return timed(
                    log,
                    "adapter.delete",
                    async () => {
                        log.debug("delete", { model });

                        if (model === "user") {
                            const id = pickWhere(where, "id");
                            if (typeof id !== "string") unsupported("delete", model, "id required");
                            const stub = userStub(id);
                            // @ts-expect-error
                            const principal = (await stub.findPrincipal()) as PrincipalRecord | null;
                            if (principal?.email) {
                                const emailHash = await hashEmail(principal.email);
                                const idStub = identityStub(emailHash);
                                // @ts-expect-error
                                await idStub.disable(emailHash);
                                log.info("identity disabled on user delete", { emailHash: await shortHash(emailHash) });
                            }
                            // @ts-expect-error
                            await stub.deletePrincipal();
                            return;
                        }

                        if (model === "account") {
                            const id = pickWhere(where, "id");
                            const userId = pickWhere(where, "userId");
                            if (typeof id !== "string" || typeof userId !== "string") {
                                unsupported("delete", model, "id and userId required");
                            }
                            const stub = userStub(userId);
                            // @ts-expect-error
                            await stub.deleteAccount(id);
                            return;
                        }

                        unsupported("delete", model, "unsupported model");
                    },
                    { model }
                );
            },

            async deleteMany(_args) {
                throw new Error("do-adapter: deleteMany not supported");
            },

            async count(_args) {
                throw new Error(
                    "do-adapter: count not supported (DOs are not indexed by aggregate; use the projection store)"
                );
            },

            /**
             * DOs serialise per-object so a real BEGIN/COMMIT is unnecessary for
             * single-DO operations. For cross-DO atomicity (e.g. multi-step signup
             * with both IdentityDO and UserDO) the adapter does its own
             * reserve/commit/release dance. This no-op satisfies BA's transaction
             * contract.
             */
            async transaction(cb: (tx: Adapter) => Promise<unknown>) {
                return cb(buildAdapter());
            },
        }) as Adapter;

    return (_betterAuthOptions: unknown): Adapter => buildAdapter();
}

// ───── helpers: signup + mapping ───────────────────────────────────────

async function createUser(
    config: DOAdapterConfig,
    data: Record<string, unknown>,
    log: Logger
): Promise<Record<string, unknown>> {
    const isAnonymous = data.isAnonymous === true || !data.email;
    const principalId = (data.id as string) ?? crypto.randomUUID();
    const userStub = config.userDo.get(config.userDo.idFromName(principalId));

    if (isAnonymous) {
        log.info("createUser anonymous", { principalIdShort: await shortHash(principalId) });
        // @ts-expect-error
        const p = (await userStub.createPrincipal({
            id: principalId,
            name: (data.name as string) ?? null,
            email: null,
            isAnonymous: true,
        })) as PrincipalRecord;
        // Anonymous users are intentionally NOT mirrored to the fallback.
        // They are ephemeral; replicating them inflates the fallback store
        // with users that mostly never convert. If you need them in your
        // auth data store, mirror explicitly downstream.
        return mapPrincipalToBA(p);
    }

    const email = data.email as string;
    const emailHash = await hashEmail(email);
    const idStub = config.identityDo.get(config.identityDo.idFromName(`identity:${emailHash}`));

    log.info("createUser email", { emailHashShort: await shortHash(emailHash) });

    // @ts-expect-error
    const reserveResult = (await idStub.reserve(emailHash)) as
        | { ok: true; reservationId: string }
        | { ok: false; reason: string; principalId?: string | null };

    if (!reserveResult.ok) {
        log.warn("createUser email_taken_or_disabled", {
            reason: reserveResult.reason,
            emailHashShort: await shortHash(emailHash),
        });
        throw new Error(reserveResult.reason === "disabled" ? "EMAIL_DISABLED" : "EMAIL_ALREADY_EXISTS");
    }

    try {
        // @ts-expect-error
        const p = (await userStub.createPrincipal({
            id: principalId,
            name: (data.name as string) ?? null,
            email,
            emailVerified: (data.emailVerified as boolean) ?? false,
            image: (data.image as string) ?? null,
        })) as PrincipalRecord;
        // @ts-expect-error
        const commit = (await idStub.commit(emailHash, reserveResult.reservationId, principalId)) as
            | { ok: true }
            | { ok: false; reason: string };
        if (!commit.ok) {
            // @ts-expect-error
            await userStub.deletePrincipal();
            // fall through to throw below — no fallback write if commit failed
            throw new Error(`do-adapter: identity commit failed (${commit.reason})`);
        }
        return mapPrincipalToBA(p);
    } catch (err) {
        // @ts-expect-error
        await idStub.release(emailHash, reserveResult.reservationId).catch(() => {});
        throw err;
    }
}

function mapPrincipalToBA(p: PrincipalRecord): Record<string, unknown> {
    return {
        id: p.id,
        name: p.name,
        email: p.email,
        emailVerified: p.emailVerified,
        image: p.image,
        isAnonymous: p.isAnonymous,
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
    };
}

function mapAccountToBA(a: AccountRecord): Record<string, unknown> {
    return {
        id: a.id,
        userId: a.userId,
        providerId: a.providerId,
        accountId: a.accountId,
        password: a.password,
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        idToken: a.idToken,
        accessTokenExpiresAt: a.accessTokenExpiresAt ? new Date(a.accessTokenExpiresAt) : null,
        refreshTokenExpiresAt: a.refreshTokenExpiresAt ? new Date(a.refreshTokenExpiresAt) : null,
        scope: a.scope,
        createdAt: new Date(a.createdAt),
        updatedAt: new Date(a.updatedAt),
    };
}

function serialiseDate(d: unknown): string | null {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString();
    if (typeof d === "string") return d;
    return null;
}
