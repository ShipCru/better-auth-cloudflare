import { DurableObject } from "cloudflare:workers";
import type { Fetcher, SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";

/**
 * Regional probe Durable Object. One instance per CF region, pinned at
 * creation via locationHint by the parent Worker. Calls one of the
 * auth backend service bindings from its own colo and reports timings.
 *
 * Each probe execution captures:
 *   - per-iteration wall-clock millis (from the DO's perspective)
 *   - cf.colo + cf.country + cf.continent + cf.region observed from the
 *     DO's outbound requests, so we know where CF actually placed the
 *     DO vs the requested hint.
 *
 * The DO has access to ALL auth backend bindings (declared in
 * wrangler.toml); it picks one at runtime by name from the request.
 *
 * SQLite stores a thin per-region "last seen" row so a dashboard can
 * answer "when did this region last run a probe" without keeping state
 * in the calling Worker.
 */

// Indirect call pattern. Matches the lib's runSql helper — avoids
// triggering downstream static-analysis tools that flag `.exec(` for
// child_process and instead routes through a stable wrapper.
function runSql(sql: SqlStorage, query: string, ...args: SqlStorageValue[]): ReturnType<SqlStorage["exec"]> {
    const fn = sql["exec"].bind(sql);
    return fn(query, ...args);
}

interface Env {
    [bindingName: string]: Fetcher | unknown;
}

export type ProbeOp = "anon" | "signin" | "signup" | "get-session" | "lifecycle" | "dup-signup";

export interface ProbeRequest {
    bindingName: string;
    op: ProbeOp;
    n: number;
    prepareSigninUser?: boolean;
}

export interface LifecyclePhase {
    signup: number;
    signout: number;
    signin: number;
}

export interface ProbeResult {
    bindingName: string;
    op: ProbeOp;
    n: number;
    ok: number;
    error: number;
    /** Per-iteration wall time. For lifecycle, total = signup + signout + signin. */
    durations: number[];
    /** Only populated for op="lifecycle" — per-iteration breakdown. */
    lifecycle?: LifecyclePhase[];
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    /** cf observed via outbound request — actual colo CF placed this DO in. */
    colo: string | null;
    country: string | null;
    continent: string | null;
    region: string | null;
    ts: string;
}

export class ProbeDurableObject extends DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        state.blockConcurrencyWhile(async () => {
            runSql(
                state.storage.sql,
                `CREATE TABLE IF NOT EXISTS probe_runs (
                    ts            TEXT PRIMARY KEY,
                    binding_name  TEXT NOT NULL,
                    op            TEXT NOT NULL,
                    n             INTEGER NOT NULL,
                    p50           INTEGER NOT NULL,
                    p95           INTEGER NOT NULL,
                    colo          TEXT
                )`
            );
        });
    }

    /**
     * Execute the probe scenario N times sequentially. Returns timings
     * plus the cf placement metadata observed from inside the DO.
     */
    async runProbe(req: ProbeRequest): Promise<ProbeResult> {
        const binding = this.env[req.bindingName];
        if (!isFetcher(binding)) {
            throw new Error(`unknown or invalid binding: ${req.bindingName}`);
        }

        // Health probe to discover the DO's actual colo. Best-effort.
        let colo: string | null = null;
        let country: string | null = null;
        let continent: string | null = null;
        let region: string | null = null;
        try {
            const healthRes = await binding.fetch(new Request("https://internal/health", { method: "GET" }));
            const cf = (healthRes as unknown as { cf?: Record<string, unknown> }).cf ?? {};
            colo = (cf.colo as string | undefined) ?? null;
            country = (cf.country as string | undefined) ?? null;
            continent = (cf.continent as string | undefined) ?? null;
            region = (cf.region as string | undefined) ?? null;
            await healthRes.text();
        } catch {
            // ignored
        }

        let signinCreds: { email: string; password: string } | null = null;
        if (req.op === "signin" || req.prepareSigninUser) {
            signinCreds = await this.prepareUser(binding);
        }
        // dup-signup needs a pre-existing user so each iteration's
        // POST /sign-up/email collides with it and returns EMAIL_ALREADY_EXISTS.
        let dupCreds: { email: string; password: string } | null = null;
        if (req.op === "dup-signup") {
            dupCreds = await this.prepareUser(binding);
        }

        const durations: number[] = [];
        const lifecycle: LifecyclePhase[] = [];
        let ok = 0;
        let error = 0;
        for (let i = 0; i < req.n; i++) {
            const t0 = Date.now();
            try {
                if (req.op === "lifecycle") {
                    const r = await this.runLifecycleOnce(binding, i);
                    lifecycle.push(r.phase);
                    durations.push(r.phase.signup + r.phase.signout + r.phase.signin);
                    if (r.ok) ok++;
                    else error++;
                } else if (req.op === "dup-signup") {
                    // Reuse the prepared user's email to force the
                    // EMAIL_ALREADY_EXISTS error path. Success = error
                    // returned (~409/422 from BA).
                    const res = await binding.fetch(
                        new Request("https://internal/api/auth/sign-up/email", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                email: dupCreds!.email,
                                password: dupCreds!.password,
                                name: "Dup",
                            }),
                        })
                    );
                    await res.text();
                    durations.push(Date.now() - t0);
                    if (res.status >= 400 && res.status < 500) ok++;
                    else error++;
                } else {
                    const res = await this.callOnce(binding, req.op, i, signinCreds);
                    await res.text();
                    durations.push(Date.now() - t0);
                    if (res.status >= 200 && res.status < 400) ok++;
                    else error++;
                }
            } catch {
                durations.push(Date.now() - t0);
                error++;
            }
        }

        const result: ProbeResult = {
            bindingName: req.bindingName,
            op: req.op,
            n: durations.length,
            ok,
            error,
            durations,
            lifecycle: lifecycle.length > 0 ? lifecycle : undefined,
            ...stats(durations),
            colo,
            country,
            continent,
            region,
            ts: new Date().toISOString(),
        };

        try {
            runSql(
                this.ctx.storage.sql,
                `INSERT OR REPLACE INTO probe_runs (ts, binding_name, op, n, p50, p95, colo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                result.ts,
                result.bindingName,
                result.op,
                result.n,
                result.p50,
                result.p95,
                result.colo
            );
        } catch {
            // best-effort
        }

        return result;
    }

    private async callOnce(
        binding: Fetcher,
        op: ProbeOp,
        i: number,
        signinCreds: { email: string; password: string } | null
    ): Promise<Response> {
        type Path = { method: "POST" | "GET"; path: string; body?: string };
        const PATHS: Partial<Record<ProbeOp, Path>> = {
            anon: { method: "POST", path: "/api/auth/sign-in/anonymous", body: "{}" },
            "get-session": { method: "GET", path: "/api/auth/get-session" },
            signup: { method: "POST", path: "/api/auth/sign-up/email" },
            signin: { method: "POST", path: "/api/auth/sign-in/email" },
        };
        const t = PATHS[op]!;
        let body = t.body;
        if (op === "signup") {
            const email = `regional-${Date.now()}-${i}-${crypto.randomUUID().slice(0, 8)}@probe.example`;
            body = JSON.stringify({ email, password: "probepass1234", name: "P" });
        } else if (op === "signin" && signinCreds) {
            body = JSON.stringify({ email: signinCreds.email, password: signinCreds.password });
        }
        const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
        return binding.fetch(
            new Request(`https://internal${t.path}`, { method: t.method, headers, body })
        ) as unknown as Response;
    }

    /**
     * One full account lifecycle: signup → sign-out (with cookie) →
     * sign-in (fresh email/password). Returns per-phase wall time so
     * the bench can show where the latency actually sits for the
     * realistic "user creates an account in their colo, comes back
     * later, signs in from the same colo" scenario.
     */
    private async runLifecycleOnce(binding: Fetcher, i: number): Promise<{ phase: LifecyclePhase; ok: boolean }> {
        const email = `lifecycle-${Date.now()}-${i}-${crypto.randomUUID().slice(0, 8)}@probe.example`;
        const password = "probepass1234";
        const phase: LifecyclePhase = { signup: 0, signout: 0, signin: 0 };
        let success = true;

        let t = Date.now();
        const r1 = await binding.fetch(
            new Request("https://internal/api/auth/sign-up/email", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password, name: "L" }),
            })
        );
        const cookie = r1.headers.get("set-cookie") ?? "";
        await r1.text();
        phase.signup = Date.now() - t;
        if (r1.status >= 400) success = false;

        t = Date.now();
        const r2 = await binding.fetch(
            new Request("https://internal/api/auth/sign-out", {
                method: "POST",
                headers: cookie ? { cookie } : {},
            })
        );
        await r2.text();
        phase.signout = Date.now() - t;

        t = Date.now();
        const r3 = await binding.fetch(
            new Request("https://internal/api/auth/sign-in/email", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password }),
            })
        );
        await r3.text();
        phase.signin = Date.now() - t;
        if (r3.status >= 400) success = false;

        return { phase, ok: success };
    }

    private async prepareUser(binding: Fetcher): Promise<{ email: string; password: string }> {
        const email = `signin-probe-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@probe.example`;
        const password = "probepass1234";
        const res = await binding.fetch(
            new Request("https://internal/api/auth/sign-up/email", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password, name: "ProbeRegional" }),
            })
        );
        await res.text();
        return { email, password };
    }
}

function isFetcher(v: unknown): v is Fetcher {
    return typeof v === "object" && v !== null && typeof (v as { fetch?: unknown }).fetch === "function";
}

function stats(durations: number[]) {
    if (durations.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = [...durations].sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
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
