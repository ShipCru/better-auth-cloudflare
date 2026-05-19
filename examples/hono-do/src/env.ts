import type {
    DurableObjectNamespace,
    KVNamespace,
    AnalyticsEngineDataset,
    D1Database,
} from "@cloudflare/workers-types";

export interface CloudflareBindings {
    USER_DO: DurableObjectNamespace;
    IDENTITY_DO: DurableObjectNamespace;
    KV: KVNamespace;
    AUTH_ANALYTICS?: AnalyticsEngineDataset;
    AUTH_DB?: D1Database;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
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
}
