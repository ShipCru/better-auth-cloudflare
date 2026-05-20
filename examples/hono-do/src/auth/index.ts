import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import {
    withCloudflare,
    d1AuthDataStore,
    createIdentityIndexCache,
    createD1IdentityStore,
} from "better-auth-cloudflare";
import { anonymous } from "better-auth/plugins";
import type { CloudflareBindings } from "../env";
import { pickPasswordConfig } from "./password-config";
import { createCrdbAdapter } from "../crdb/adapter";

/**
 * Single auth factory wired to the Durable Object adapter.
 *
 *   - `do.userDo`     → per-principal SQLite DO (BA user + account models)
 *   - `do.identityDo` → per-email-hash DO (global uniqueness)
 *   - `kv`            → BA secondaryStorage (sessions, verification, rate limits)
 *
 * No D1/Hyperdrive needed. Hot path is signature verify + zero-to-two DO
 * RPCs depending on the flow.
 */
function createAuth(
    env?: CloudflareBindings,
    cf?: IncomingRequestCfProperties,
    baseURL?: string,
    /**
     * Per-request ExecutionContext. When provided, the adapter dispatches
     * non-critical writes (identity-cache upsert, thick-cache fan-out) via
     * `ctx.waitUntil` so they don't block the user response. The Hono
     * middleware passes this in.
     */
    deferredWritesCtx?: { waitUntil(p: Promise<unknown>): void }
) {
    // Sessions in this v1 of the DO adapter go to BA's secondaryStorage (KV),
    // not to the DO. We disable `geolocationTracking` here (which would force
    // sessions into the DB-backed path) — the `cloudflare/geolocation`
    // endpoint still works because the plugin is enabled and `cf` is set.
    // Adding session persistence to the DO adapter is a planned follow-up
    // (see the fork's roadmap).
    const wrapped = withCloudflare(
        {
            autoDetectIpAddress: true,
            geolocationTracking: false,
            cf: cf ?? {},
            do: env
                ? {
                      userDo: env.USER_DO,
                      identityDo: env.IDENTITY_DO,
                      logLevel: "info",
                      // Optional D1 auth data store. When AUTH_DB is bound
                      // (see wrangler.toml), every successful DO write is
                      // one-way mirrored to D1 best-effort. The auth data store is
                      // NEVER queried during auth flows — it exists only for DR.
                      // Use restorePrincipal() to replay a
                      // principal back into a DO that lost storage.
                      authDataStore: env.AUTH_DB ? d1AuthDataStore(env.AUTH_DB) : undefined,
                      // Opt-in identity index cache. USE_KV_CACHE=1 puts a
                      // KV layer (with optional D1 second tier via AUTH_DB)
                      // in front of IdentityDO for email→principal_id
                      // lookups. Writes through on commit/disable. See
                      // src/adapters/identity-cache.ts in the lib.
                      identityIndexCache:
                          env.USE_KV_CACHE === "1" && env.KV
                              ? createIdentityIndexCache({ kv: env.KV, d1: env.AUTH_DB })
                              : undefined,
                      // Opt-in to the "emailHash is the primary lookup"
                      // architecture. When USE_THICK_IDENTITY=1 the adapter
                      // mirrors principal+account data into IdentityDO's
                      // thick_cache so sign-in is one DO RPC instead of three.
                      // Set per-env in wrangler.toml [env.thick.vars] for a
                      // sibling deploy that can be A/B'd against current.
                      thickIdentity: env.USE_THICK_IDENTITY === "1",
                      // Opt-in bundle RPC. USE_BUNDLE_RPC=1 collapses the
                      // legacy findPrincipal + listAccounts two-call
                      // sequence into one findPrincipal({include:['accountsJson']})
                      // call. Sidesteps CF's list-RPC wallTime penalty
                      // (~200-300ms even for 1-row results). Compatible with
                      // thickIdentity — the thick path wins when both set.
                      bundleUserAccounts: env.USE_BUNDLE_RPC === "1",
                      // Per-request waitUntil sink so non-critical writes
                      // (identity cache, thick cache) don't block the
                      // signup response. Saves ~50-200ms p50.
                      deferredWritesCtx,
                      // D1 UNIQUE store replaces IdentityDO for email
                      // uniqueness. One D1 INSERT vs reserve+commit on a
                      // cold DO. Required: AUTH_DB binding + schema applied.
                      d1IdentityStore:
                          env.USE_D1_IDENTITY === "1" && env.AUTH_DB ? createD1IdentityStore(env.AUTH_DB) : undefined,
                  }
                : undefined,
            // When USE_STATELESS_SESSION=1 we don't pass KV to
            // withCloudflare. BA then has no secondaryStorage — sign-in
            // skips the ~50-100ms KV PUT entirely. The signed session_data
            // cookie becomes the authoritative session blob; get-session
            // reads it via cookieCache only. Trade: no remote revocation
            // (sign-out only clears the user's local cookie).
            kv: env?.USE_STATELESS_SESSION === "1" ? undefined : env?.KV,
        },
        {
            emailAndPassword: {
                enabled: true,
                // Forgot/reset password flow. In production, replace the
                // console.log with your transactional email service (Resend,
                // SendGrid, etc.) and pass the user a reset URL.
                sendResetPassword: async ({ user, url }) => {
                    console.log(
                        `[forgot-password] reset URL for ${user.email}:`,
                        url,
                        `(in production, email this to the user)`
                    );
                },
                // Password hash strategy selected via env var. See
                // pickPasswordConfig above for the precedence rules
                // (PBKDF2 > fast-scrypt > BA default).
                password: pickPasswordConfig(env),
            },
            // Social providers. Wired conditionally — only enabled if env
            // credentials are present. Set GOOGLE_CLIENT_ID and
            // GOOGLE_CLIENT_SECRET via `wrangler secret put` to enable.
            socialProviders:
                env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET
                    ? {
                          google: {
                              clientId: env.GOOGLE_CLIENT_ID,
                              clientSecret: env.GOOGLE_CLIENT_SECRET,
                          },
                      }
                    : undefined,
            plugins: [anonymous()],
            rateLimit: {
                enabled: true,
                window: 60,
                max: 100,
                customRules: {
                    "/sign-in/email": { window: 60, max: 100 },
                    "/sign-up/email": { window: 60, max: 20 },
                    "/forget-password": { window: 60, max: 10 },
                },
                // Stateless mode has no KV; rate limit must use the
                // in-isolate memory store. Per-isolate counters are
                // weaker than KV (attacker spreading across isolates
                // can bypass), but better than nothing for demos.
                storage: env?.USE_STATELESS_SESSION === "1" ? "memory" : undefined,
            },
        }
    );

    const stateless = env?.USE_STATELESS_SESSION === "1";
    const expiresIn = 21 * 24 * 60 * 60; // 21 days

    // CRDB multi-region path: when USE_CRDB_MULTI=1 AND all three
    // Hyperdrive bindings are present, route user + account writes to
    // CockroachDB via the per-region Hyperdrive matching `cf.continent`.
    // Falls back to the DO adapter from `wrapped` when any of the
    // bindings is missing (so the variant can be deployed in stages).
    const crdbAdapter =
        env?.USE_CRDB_MULTI === "1" && env.HYPERDRIVE_ENAM && env.HYPERDRIVE_WEUR
            ? createCrdbAdapter({
                  hyperdrives: {
                      "us-east-2": env.HYPERDRIVE_ENAM,
                      "eu-central-1": env.HYPERDRIVE_WEUR,
                  },
                  cf,
                  identityIndexCache:
                      env.USE_KV_CACHE === "1" && env.KV ? createIdentityIndexCache({ kv: env.KV }) : undefined,
                  deferredWritesCtx,
              })
            : undefined;

    return betterAuth({
        baseURL,
        // Trust the local Hono port and the Next.js frontend that proxies
        // to it. Production should set these to your actual deployed
        // origins. Wildcards are not supported here — list explicitly.
        trustedOrigins: [
            "http://localhost:8787",
            "http://localhost:3000",
            "https://better-auth-cloudflare-hono-do.steve-4b7.workers.dev",
            "https://better-auth-cloudflare-opennextjs-do.steve-4b7.workers.dev",
        ],
        ...wrapped,
        // CRDB adapter overrides BA's `database` field when present. BA
        // accepts an Adapter object directly; we cast because BA's
        // public Adapter type is loosely typed (`any`-ish) and our
        // typed adapter shape isn't reachable from the BA types.
        ...(crdbAdapter ? { database: crdbAdapter as never } : {}),
        // In stateless mode replace BA's secondaryStorage with a no-op.
        // Without it, BA falls back to the database adapter for sessions
        // and our DO adapter throws on `create({model: 'session'})`. The
        // no-op makes BA's session writes a fire-and-forget — the signed
        // session_data cookie carries the actual session state, and
        // get-session reads cookieCache only.
        //
        // For stateful variants: wrap secondaryStorage so `set` and
        // `delete` defer via waitUntil when an execution ctx is provided.
        // Reads stay sync (BA depends on them returning the value). Saves
        // ~50–100 ms on signin (the KV PUT for the new session) and on
        // sign-out (the KV DELETE for the old session) by moving those
        // writes off the response critical path.
        secondaryStorage: stateless
            ? noopSecondaryStorage
            : wrapWithIsolateL1(
                  deferredWritesCtx
                      ? wrapDeferredKv(wrapped.secondaryStorage, deferredWritesCtx)
                      : wrapped.secondaryStorage
              ),
        session: {
            ...wrapped.session,
            storeSessionInDatabase: false,
            expiresIn,
            updateAge: 24 * 60 * 60,
            // In stateless mode the cookieCache IS the session — it has
            // to live as long as the session itself, otherwise get-session
            // misses fall through to a non-existent KV. In stateful mode
            // we keep the short 5-minute window so revocation propagates
            // within that window after KV invalidation.
            cookieCache: { enabled: true, maxAge: stateless ? expiresIn : 5 * 60 },
        },
    });
}

/**
 * Drop-on-the-floor secondaryStorage. Satisfies BA's interface so it
 * doesn't fall back to the database adapter for session writes, while
 * actually persisting nothing — the signed session_data cookie is the
 * only state. Used only when USE_STATELESS_SESSION=1.
 */
const noopSecondaryStorage = {
    get: async (_key: string) => null,
    set: async (_key: string, _value: string, _ttl?: number) => undefined as void,
    delete: async (_key: string) => undefined as void,
};

/**
 * Wraps BA's secondaryStorage so writes (`set`, `delete`) dispatch via
 * `ctx.waitUntil` and return immediately. Reads stay synchronous because
 * BA's get-session and verification flows need the value back.
 *
 * Safe trade-off:
 *  - signup/signin response returns ~50–100 ms faster (no KV PUT in
 *    the critical path).
 *  - sign-out response returns ~50–100 ms faster (no KV DELETE).
 *  - For ~5–30 ms after the response, a different colo's get-session
 *    that hits the just-written key may briefly see stale data — KV
 *    propagation is eventually consistent regardless.
 *  - Edge case: if the same colo immediately re-reads the key within
 *    the same isolate (rare), it will hit the in-flight PUT; CF
 *    serializes per-key writes per region.
 *  - In stateless mode we don't use secondaryStorage at all, so this
 *    wrapper only applies to KV-backed deploys.
 */
/**
 * In-isolate L1 cache in front of KV `secondaryStorage.get`. Stores
 * each value with a short TTL (30 s by default — short enough that a
 * stale session is bounded to 30 s after revocation, long enough that
 * same-isolate repeat reads on a page-load burst skip KV entirely).
 *
 * Cloudflare Workers reuses the same V8 isolate across many requests
 * (Fluid Compute keeps isolates warm for minutes), so a Map declared at
 * the module scope persists across requests within the same colo's
 * isolate. The cache is per-isolate; cross-isolate misses still hit KV.
 *
 * Invalidation: `set` and `delete` evict the local entry first, so the
 * same-isolate next read sees the new value (or null) immediately. KV's
 * own cross-region eventual consistency is unchanged.
 *
 * Saves ~5–15 ms per repeat `get-session` call (KV warm reads are ~5–30 ms
 * within a region; the L1 hit is sub-millisecond).
 */
const L1_TTL_MS = 30 * 1000;
const l1Cache = new Map<string, { value: string | null; expiresAt: number }>();
function l1Get(key: string): string | null | undefined {
    const hit = l1Cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
        l1Cache.delete(key);
        return undefined;
    }
    return hit.value;
}
function l1Set(key: string, value: string | null): void {
    l1Cache.set(key, { value, expiresAt: Date.now() + L1_TTL_MS });
}
function l1Delete(key: string): void {
    l1Cache.delete(key);
}
function wrapWithIsolateL1<T extends { get: unknown; set: unknown; delete: unknown }>(
    base: T | undefined
): T | undefined {
    if (!base) return base;
    const getFn = (base as unknown as { get: (k: string) => Promise<string | null> }).get;
    const setFn = (base as unknown as { set: (k: string, v: string, t?: number) => Promise<void> }).set;
    const delFn = (base as unknown as { delete: (k: string) => Promise<void> }).delete;
    return {
        ...base,
        get: (async (key: string) => {
            const cached = l1Get(key);
            if (cached !== undefined) return cached;
            const value = await getFn.call(base, key);
            l1Set(key, value);
            return value;
        }) as unknown as T["get"],
        set: ((key: string, value: string, ttl?: number) => {
            // Update L1 first so same-isolate reads see the new value
            // immediately, even though the underlying KV PUT may be deferred.
            l1Set(key, value);
            return setFn.call(base, key, value, ttl);
        }) as unknown as T["set"],
        delete: ((key: string) => {
            l1Delete(key);
            return delFn.call(base, key);
        }) as unknown as T["delete"],
    };
}

function wrapDeferredKv<T extends { get: unknown; set: unknown; delete: unknown }>(
    base: T,
    ctx: { waitUntil(p: Promise<unknown>): void }
): T {
    const setFn = (base as unknown as { set: (k: string, v: string, t?: number) => Promise<void> }).set;
    const delFn = (base as unknown as { delete: (k: string) => Promise<void> }).delete;
    return {
        ...base,
        set: ((key: string, value: string, ttl?: number) => {
            ctx.waitUntil(setFn.call(base, key, value, ttl));
            return Promise.resolve();
        }) as unknown as T["set"],
        delete: ((key: string) => {
            ctx.waitUntil(delFn.call(base, key));
            return Promise.resolve();
        }) as unknown as T["delete"],
    };
}

export const auth = createAuth();
export { createAuth };
