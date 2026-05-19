import type { Fetcher } from "@cloudflare/workers-types";
import {
    type Op,
    type ScenarioId,
    type VariantId,
    type BenchScenarioResult,
    SCENARIOS,
    BACKEND_VARIANTS,
    MIN_N,
    MAX_N,
} from "./bench-types";

/**
 * Runs a single bench scenario server-side inside the OpenNext Worker.
 *
 * The variant binding (env.AUTH_BACKEND, env.AUTH_BACKEND_D1, etc.) is
 * accessed by name so the runner is variant-agnostic. Unbound variants
 * fall back to fetch() against AUTH_BACKEND_URL — useful for variants
 * deployed on a different account or for local dev.
 */

/**
 * Permissive env shape — Cloudflare bindings + vars are accessed by name
 * and may be any type (Fetcher, string, KVNamespace, etc.). The
 * `dispatch()` helper narrows to Fetcher via runtime check.
 */
type Env = Record<string, unknown>;

interface BackendCall {
    method: "GET" | "POST";
    path: string;
    body?: string;
}

const TARGET: Record<Op, BackendCall> = {
    anon: { method: "POST", path: "/api/auth/sign-in/anonymous", body: "{}" },
    "get-session": { method: "GET", path: "/api/auth/get-session" },
    signup: { method: "POST", path: "/api/auth/sign-up/email" },
    signin: { method: "POST", path: "/api/auth/sign-in/email" },
};

export interface RunScenarioInput {
    env: Env;
    scenarioId: ScenarioId;
    variantId: VariantId;
    n?: number;
    cf: Record<string, unknown>;
}

export interface RunScenarioOutput {
    result: BenchScenarioResult;
    transport: "binding" | "http";
}

export async function runScenario({ env, scenarioId, variantId, n, cf }: RunScenarioInput): Promise<RunScenarioOutput> {
    const scenario = SCENARIOS.find(s => s.id === scenarioId);
    const variant = BACKEND_VARIANTS.find(v => v.id === variantId);
    if (!scenario) throw new Error(`unknown scenario: ${scenarioId}`);
    if (!variant) throw new Error(`unknown variant: ${variantId}`);

    const effectiveN = clamp(n ?? scenario.n, MIN_N, MAX_N);
    const transport: "binding" | "http" = env[variant.binding] instanceof Object ? "binding" : "http";

    // Pre-create signin user if needed (for warm-burst-signin, mixed-load).
    let signinCreds: { email: string; password: string } | null = null;
    const needsSigninUser =
        scenario.op === "signin" || ("mixedRatio" in scenario && scenario.mixedRatio && scenario.mixedRatio.signin > 0);
    if (needsSigninUser) {
        signinCreds = await ensureSigninUser(env, variant.binding);
    }

    const durations: number[] = [];
    const durationsLabels: string[] = [];
    let ok = 0;
    let error = 0;

    if ("mixedRatio" in scenario && scenario.mixedRatio) {
        // Build interleaved sequence respecting the ratio.
        const seq: Op[] = [];
        for (let i = 0; i < scenario.mixedRatio.signup; i++) seq.push("signup");
        for (let i = 0; i < scenario.mixedRatio.signin; i++) seq.push("signin");
        for (let i = 0; i < scenario.mixedRatio.getSession; i++) seq.push("get-session");
        for (let i = 0; i < seq.length; i++) {
            const op = seq[i];
            const r = await callOnce(env, variant.binding, op, i, signinCreds);
            durations.push(r.duration);
            durationsLabels.push(op);
            if (r.ok) ok++;
            else error++;
        }
    } else if ("followUp" in scenario && scenario.followUp) {
        // Special: cold-then-warm. One create followed by N reads of the same principal.
        // We don't have a way to capture the session cookie out of the binding response
        // easily across calls, so we approximate by doing a signup then N get-session
        // calls without cookies — the get-session still exercises the worker path even
        // if the session is unauthenticated (returns null). The interesting signal is
        // the latency curve, not the session payload.
        const first = await callOnce(env, variant.binding, scenario.op, 0, signinCreds);
        durations.push(first.duration);
        durationsLabels.push(scenario.op);
        if (first.ok) ok++;
        else error++;
        for (let i = 0; i < scenario.followUp.n; i++) {
            const r = await callOnce(env, variant.binding, scenario.followUp.op, i, signinCreds);
            durations.push(r.duration);
            durationsLabels.push(scenario.followUp.op);
            if (r.ok) ok++;
            else error++;
        }
    } else if (scenario.concurrency > 1) {
        // Parallel fan-out. Promise.all over the N calls; we lose order-of-completion
        // but capture each duration independently.
        const tasks = Array.from({ length: effectiveN }, (_, i) =>
            callOnce(env, variant.binding, scenario.op, i, signinCreds)
        );
        const settled = await Promise.all(tasks);
        for (const r of settled) {
            durations.push(r.duration);
            durationsLabels.push(scenario.op);
            if (r.ok) ok++;
            else error++;
        }
    } else {
        for (let i = 0; i < effectiveN; i++) {
            const r = await callOnce(env, variant.binding, scenario.op, i, signinCreds);
            durations.push(r.duration);
            durationsLabels.push(scenario.op);
            if (r.ok) ok++;
            else error++;
        }
    }

    return {
        transport,
        result: {
            scenarioId,
            variantId,
            op: scenario.op,
            n: durations.length,
            ok,
            error,
            geo: extractGeo(cf),
            ts: new Date().toISOString(),
            durations,
            durationsLabels,
            ...stats(durations),
        },
    };
}

function extractGeo(cf: Record<string, unknown>) {
    const s = (k: string): string | null => (typeof cf[k] === "string" ? (cf[k] as string) : null);
    const n = (k: string): number | null => (typeof cf[k] === "number" ? (cf[k] as number) : null);
    return {
        colo: s("colo"),
        country: s("country"),
        continent: s("continent"),
        region: s("region"),
        regionCode: s("regionCode"),
        city: s("city"),
        postalCode: s("postalCode"),
        timezone: s("timezone"),
        latitude: s("latitude"),
        longitude: s("longitude"),
        asn: n("asn"),
        asOrganization: s("asOrganization"),
        tlsVersion: s("tlsVersion"),
        tlsCipher: s("tlsCipher"),
    };
}

interface CallResult {
    ok: boolean;
    status: number;
    duration: number;
}

async function callOnce(
    env: Env,
    bindingName: string,
    op: Op,
    i: number,
    signinCreds: { email: string; password: string } | null
): Promise<CallResult> {
    const { method, path, body: defaultBody } = TARGET[op];
    let body = defaultBody;
    if (op === "signup") {
        const email = `bench-${Date.now()}-${i}-${crypto.randomUUID().slice(0, 8)}@bench.example`;
        body = JSON.stringify({ email, password: "benchpass1234", name: "Bench" });
    } else if (op === "signin" && signinCreds) {
        body = JSON.stringify({ email: signinCreds.email, password: signinCreds.password });
    }

    const headers: Record<string, string> = {};
    if (body) headers["content-type"] = "application/json";

    const t0 = Date.now();
    try {
        const res = await dispatch(env, bindingName, path, { method, headers, body });
        // Consume the body so the connection completes and the timing is honest.
        await res.text();
        return { ok: res.status >= 200 && res.status < 400, status: res.status, duration: Date.now() - t0 };
    } catch {
        return { ok: false, status: 0, duration: Date.now() - t0 };
    }
}

async function ensureSigninUser(env: Env, bindingName: string): Promise<{ email: string; password: string }> {
    const email = `signin-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@bench.example`;
    const password = "benchpass1234";
    const res = await dispatch(env, bindingName, "/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: "SigninBench" }),
    });
    await res.text();
    return { email, password };
}

async function dispatch(
    env: Env,
    bindingName: string,
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string }
): Promise<Response> {
    const binding = env[bindingName];
    const url = isFetcher(binding) ? `https://${bindingName}.internal${path}` : urlFromFallback(env, path);
    const req = new Request(url, init);
    if (isFetcher(binding)) {
        return binding.fetch(req as unknown as Parameters<typeof binding.fetch>[0]) as unknown as Response;
    }
    return fetch(req);
}

function isFetcher(v: unknown): v is Fetcher {
    return typeof v === "object" && v !== null && "fetch" in (v as object);
}

function urlFromFallback(env: Env, path: string): string {
    const base = (env.AUTH_BACKEND_URL as string | undefined) ?? "http://localhost:8787";
    return base.replace(/\/$/, "") + path;
}

function stats(durations: number[]) {
    if (durations.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = [...durations].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
    const sum = sorted.reduce((s, v) => s + v, 0);
    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: Math.round(sum / sorted.length),
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
    };
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.floor(n)));
}
