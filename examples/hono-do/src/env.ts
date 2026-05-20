import type {
    DurableObjectNamespace,
    KVNamespace,
    AnalyticsEngineDataset,
    D1Database,
    Hyperdrive,
} from "@cloudflare/workers-types";

export interface CloudflareBindings {
    USER_DO: DurableObjectNamespace;
    IDENTITY_DO: DurableObjectNamespace;
    KV: KVNamespace;
    AUTH_ANALYTICS?: AnalyticsEngineDataset;
    AUTH_DB?: D1Database;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /**
     * "1" routes user + account writes through the crdb-multi-region
     * adapter. Backed by ONE multi-region CRDB Cloud cluster with
     * REGIONAL BY ROW locality + TWO Hyperdrive bindings (one per
     * region's SQL gateway). The adapter picks the binding nearest the
     * user via `cf.continent`. Same cluster either way; the row lands
     * in the region of the SQL gateway hit (CRDB `gateway_region()`).
     */
    USE_CRDB_MULTI?: string;
    /** Hyperdrive → aws-us-east-2 SQL gateway of the multi-region CRDB cluster. */
    HYPERDRIVE_AWS_US_EAST_2?: Hyperdrive;
    /** Hyperdrive → aws-eu-central-1 SQL gateway of the same cluster. */
    HYPERDRIVE_AWS_EU_CENTRAL_1?: Hyperdrive;
    /** Hyperdrive → aws-ap-southeast-1 SQL gateway of the same cluster. */
    HYPERDRIVE_AWS_AP_SOUTHEAST_1?: Hyperdrive;
    /** "1" enables the thick IdentityDO sign-in fast path. Set per wrangler env. */
    USE_THICK_IDENTITY?: string;
    /** "1" swaps BA's scrypt default for the faster preset. See auth/fast-hash.ts. */
    USE_FAST_HASH?: string;
    /** "1" swaps BA's scrypt default for native Web Crypto PBKDF2. See auth/pbkdf2-hash.ts. */
    USE_PBKDF2?: string;
    /** "1" enables KV cache for email→principal_id lookups. See auth/identity-cache.ts. */
    USE_KV_CACHE?: string;
    /**
     * Active pepper secret (hex or base64). When set, all custom hash
     * variants HMAC the password with this secret before hashing. See
     * auth/pepper.ts. Set via `wrangler secret put BETTER_AUTH_PEPPER`.
     */
    BETTER_AUTH_PEPPER?: string;
    /**
     * "1" enables the bundle RPC for `findOne(user, email, join.account)`.
     * Replaces the legacy findPrincipal + listAccounts pair with one
     * scalar-returning RPC. Sidesteps the ~200-300ms CF list-RPC overhead.
     */
    USE_BUNDLE_RPC?: string;
    /**
     * "1" drops BA's optional secondaryStorage KV mirror. Sessions still
     * use BA's DEFAULT strategy (HMAC-signed session_data cookie) — this
     * does NOT switch to the `better-auth/plugins/jwt` plugin. What
     * changes: signin skips the ~50-100ms KV PUT (the signed cookie is
     * sufficient), cookieCache.maxAge is extended to session lifetime so
     * the cookie covers the full window, rateLimit storage drops to
     * in-isolate memory. Trade: no remote revocation (sign-out clears
     * the user's cookie only). Targets sub-300ms sign-in p50.
     */
    USE_STATELESS_SESSION?: string;
    /**
     * "1" replaces IdentityDO with a D1 UNIQUE-constraint store for
     * email uniqueness on signup. Requires AUTH_DB binding and the
     * D1_IDENTITY_UNIQUE_SCHEMA applied. Eliminates the per-email DO
     * cold-start tax (~300-1500ms in non-NA regions on signup).
     */
    USE_D1_IDENTITY?: string;
}
