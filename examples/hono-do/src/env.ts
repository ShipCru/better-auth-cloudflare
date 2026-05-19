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
}
