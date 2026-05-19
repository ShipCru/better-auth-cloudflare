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
        id: "d1-unique",
        binding: "AUTH_BACKEND_D1",
        label: "D1 UNIQUE replaces IdentityDO (not yet deployed)",
        description:
            "Sibling deploy that drops IdentityDO and uses a D1 table with UNIQUE(email_hash) for uniqueness. Expected: -1 to -4s on signup p95.",
    },
    {
        id: "kv-cache",
        binding: "AUTH_BACKEND_KV",
        label: "KV write-through cache (not yet deployed)",
        description:
            "Current architecture + KV cache for email→principal_id. Expected: signin reads drop to ~5-30ms globally for cached entries.",
    },
    {
        id: "fast-hash",
        binding: "AUTH_BACKEND_FAST_HASH",
        label: "Faster password hash preset (not yet deployed)",
        description:
            "Current architecture + scrypt(N=4096) instead of N=16384. Expected: -1 to -3s of CPU on signup/signin.",
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
    colo: string | null;
    country: string | null;
    continent: string | null;
    region: string | null;
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
