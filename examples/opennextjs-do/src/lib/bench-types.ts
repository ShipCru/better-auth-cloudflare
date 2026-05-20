/**
 * Types shared between the bench page (React, client) and the bench
 * API route (Next.js route handler, server-side in the CF Worker).
 *
 * Two distinct axes:
 *   - Scenario: what we're measuring (cold burst, warm burst, mix, ...)
 *   - Variant: which backend implementation we're measuring it against
 *     (current = today; future = D1-UNIQUE, KV-cache, faster-hash, ...)
 */

export type Op = "anon" | "get-session" | "signup" | "signin";

/**
 * Backend variants. Add a new entry here AND a [[services]] binding in
 * the OpenNext wrangler.toml when you deploy a sibling auth Worker. The
 * UI's variant picker reflects this list automatically.
 */
export const BACKEND_VARIANTS = [
    {
        id: "current",
        binding: "AUTH_BACKEND",
        label: "Current (IdentityDO → UserDO bounce, scrypt default)",
        description:
            "The default better-auth-cloudflare-hono-do Worker. Sign-in does 3 DO RPCs: IdentityDO.lookup → UserDO.findPrincipal → UserDO.listAccounts.",
    },
    {
        id: "thick-identity",
        binding: "AUTH_BACKEND_THICK_ID",
        label: "Thick IdentityDO (emailHash is primary lookup) — live",
        description:
            "Sibling deploy with thickIdentity=true. Sign-in is ONE DO RPC: IdentityDO.signInLookup returns principal + accounts from its denormalised thick_cache. Writes fan-out to both DOs.",
    },
    {
        id: "kv-cache",
        binding: "AUTH_BACKEND_KV_CACHE",
        label: "KV cache for email→principal_id (with D1 second tier) — live",
        description:
            "Sibling deploy that puts KV (global ~5-30ms reads) and D1 (regional ~30-80ms via Sessions API) in front of IdentityDO for sign-in lookups. Version-stamped for freshness; write-through on commit/disable; falls through to IdentityDO on miss.",
    },
    {
        id: "fast-hash",
        binding: "AUTH_BACKEND_FAST_HASH",
        label: "Faster password hash preset (scrypt N=4096) — live",
        description:
            "Sibling deploy with scrypt(N=4096, r=8) instead of BA's default (N=16384, r=16). Targets the ~150-250ms scrypt slice of warm signin/signup. Hash format is incompatible with the default — users created here can only sign in here.",
    },
    {
        id: "pbkdf2-fast",
        binding: "AUTH_BACKEND_PBKDF2",
        label: "Native Web Crypto PBKDF2 (100k iters — CF cap) — live",
        description:
            "Sibling deploy using crypto.subtle.deriveBits. Cloudflare Workers caps PBKDF2 at 100k iters (below OWASP 2023's 600k), so this is the fastest end of the perf spectrum at reduced cryptographic strength. Tests whether native crypto beats the JS scrypt variants.",
    },
    {
        id: "stacked",
        binding: "AUTH_BACKEND_STACKED",
        label: "Stacked: fast-hash + kv-cache — live",
        description:
            "Sibling deploy that combines scrypt(N=4096) AND the KV (+D1) identity index cache. Tests whether the two optimisations compound — expected ~370ms warm signin p50 (-44% vs current).",
    },
    {
        id: "recommended",
        binding: "AUTH_BACKEND_RECOMMENDED",
        label: "Recommended: pbkdf2 + pepper + kv-cache + bundle-rpc — live",
        description:
            "Production-grade stack. Native PBKDF2 (no JS CPU pressure under burst load) + HMAC pepper (defence vs offline DB-leak attacks) + KV identity cache (skip IdentityDO on warm signin) + bundle RPC (one DO call for user+accounts, sidesteps the ~230ms CF list-RPC overhead).",
    },
    {
        id: "stateless",
        binding: "AUTH_BACKEND_STATELESS",
        label: "Stateless: recommended + drop KV session mirror — live",
        description:
            "Full recommended stack + USE_STATELESS_SESSION=1. Still uses BA's DEFAULT session strategy (HMAC-signed session_data cookie) — NOT the better-auth jwt plugin. What changes: the optional secondaryStorage KV mirror is dropped so signin skips the ~50-100ms KV PUT. cookieCache.maxAge extended to session lifetime. Trade: no remote revocation (sign-out clears cookie only). Rate limit drops to in-isolate memory. Targets sub-300ms p50.",
    },
    {
        id: "d1-unique",
        binding: "AUTH_BACKEND_D1_UNIQUE",
        label: "D1 UNIQUE: replace IdentityDO with D1 INSERT — live",
        description:
            "Replaces IdentityDO's reserve+commit pair with a single D1 INSERT bound by UNIQUE constraint. Eliminates the per-email DO cold-start tax that dominates signup (~300-1500ms in non-NA regions). Also bundles PBKDF2 + bundle-RPC. Sign-in lookups read via D1 Sessions API (nearest replica). Identity-cache and thick-cache writes deferred via waitUntil.",
    },
    {
        id: "d1-unique-stateless",
        binding: "AUTH_BACKEND_D1_UNIQUE_STATELESS",
        label: "D1 UNIQUE + stateless session — live",
        description:
            "d1-unique combo with the stateless session strategy (drops BA's secondaryStorage KV PUT). Targets APAC, where the KV write back to a central region was the dominant cost in n=30 bench (~500-1000ms). Expected APAC p50 ~1900ms (down from 2415 d1-unique alone); EU/NA stay sub-900ms.",
    },
] as const;

export type VariantId = (typeof BACKEND_VARIANTS)[number]["id"];

/**
 * Scenarios. Each describes what the bench runner does and what it
 * proves. The labels surface in the UI dropdown.
 */
export const SCENARIOS = [
    {
        id: "cold-burst-signup",
        label: "Cold burst — N fresh signups",
        op: "signup" as const,
        n: 5,
        concurrency: 1,
        description:
            "N sequential signups each with a unique email. Every signup hits a brand-new IdentityDO + UserDO. Plotting per-iteration duration shows whether the colo's DO host process warms up across cold instantiations.",
    },
    {
        id: "warm-burst-signin",
        label: "Warm burst — N signins, same user",
        op: "signin" as const,
        n: 10,
        concurrency: 1,
        description:
            "N sequential signins for the same already-created user. The IdentityDO and UserDO are warm after the first call. Reveals best-case steady-state latency for the hot path.",
    },
    {
        id: "cold-then-warm",
        label: "Cold→warm — 1 signup then 5 get-session",
        op: "signup" as const,
        n: 1,
        followUp: { op: "get-session" as const, n: 5 },
        concurrency: 1,
        description:
            "Cost curve from the cold birth of a principal to warm steady-state reads of its session. The drop between iteration 1 and iteration 2 quantifies the DO warmup tax.",
    },
    {
        id: "anon-burst",
        label: "Anon burst — N guest signins",
        op: "anon" as const,
        n: 10,
        concurrency: 1,
        description:
            "N sequential anonymous signins. Each one creates a new UserDO (no IdentityDO involvement). Cleaner cold-start signal than the email path.",
    },
    {
        id: "parallel-signup",
        label: "Parallel signup — N concurrent",
        op: "signup" as const,
        n: 5,
        concurrency: 5,
        description:
            "N signups in parallel via Promise.all. Tests whether the DO scheduler queues cold starts or fans them out. Throughput dimension, not latency.",
    },
    {
        id: "mixed-load",
        label: "Mixed load — 1:10:100 signup:signin:get-session",
        op: "signup" as const,
        n: 1,
        mixedRatio: { signup: 1, signin: 10, getSession: 100 } as const,
        concurrency: 1,
        description:
            "Realistic production-shaped ratio: 1 signup for every 10 signins for every 100 session validations. Where does p95 actually live across the mix?",
    },
    {
        id: "geo-spray",
        label: "Geo spray — same call, multiple times (instructions)",
        op: "get-session" as const,
        n: 5,
        concurrency: 1,
        description:
            "This Worker runs in whichever colo the user's request lands on. To measure multi-region, hit /bench from CI runners in EU, APAC, etc. The colo + country fields tag each result. Aggregate externally.",
    },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export interface BenchScenarioResult {
    scenarioId: ScenarioId;
    variantId: VariantId;
    /** Headline op for the scenario; mixed/cold-then-warm have multiple. */
    op: Op;
    n: number;
    ok: number;
    error: number;
    /** Full Cloudflare geo block — see BenchGeo below for the field list. */
    geo: BenchGeo;
    ts: string;
    /** Per-iteration wall-clock millis, in order. Used to plot cold→warm curves. */
    durations: number[];
    /** Optional per-iteration op label for mixed scenarios. */
    durationsLabels?: string[];
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
}

/**
 * Slice of the Cloudflare `request.cf` block we surface in bench
 * results. Captures both where the user hit the edge (colo/country/etc.)
 * and the network-level signals useful for the auth use-cases below.
 */
export interface BenchGeo {
    colo: string | null;
    country: string | null;
    continent: string | null;
    region: string | null;
    regionCode: string | null;
    city: string | null;
    postalCode: string | null;
    timezone: string | null;
    latitude: string | null;
    longitude: string | null;
    /** Autonomous System Number (network operator). */
    asn: number | null;
    asOrganization: string | null;
    /** TLS version + cipher — handy for fingerprinting in auth contexts. */
    tlsVersion: string | null;
    tlsCipher: string | null;
}

export interface BenchRunRequest {
    variantId: VariantId;
    scenarioId: ScenarioId;
    /** Override the scenario's default N. Clamped to [MIN_N, MAX_N]. */
    n?: number;
}

export interface BenchRunResponse {
    result: BenchScenarioResult;
    /** "binding" if env.AUTH_BACKEND was used, "http" if fallback. */
    transport: "binding" | "http";
}

export interface BenchErrorResponse {
    error: string;
}

export const MIN_N = 1;
export const MAX_N = 50;
