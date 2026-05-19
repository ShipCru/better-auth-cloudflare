import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { ProbeDurableObject, type ProbeOp, type ProbeResult } from "./ProbeDurableObject";
import { REGIONS, locationHintFor, type RegionId } from "./regions";

export { ProbeDurableObject } from "./ProbeDurableObject";

/**
 * Regional probe Worker. Sits between the bench UI and the regional
 * Durable Objects. Exposes one endpoint:
 *
 *   POST /probe { variantId, op, n, regions? } → returns array of
 *      { region, result } across all (or selected) regions in parallel.
 *
 * Each region has its own DO instance pinned via locationHint at
 * creation. The Worker fans out to all of them via Promise.all so the
 * total wall time = max(any region's run) rather than sum.
 *
 * The bench page binds this Worker as PROBE_WORKER and calls /probe.
 *
 * Variant → binding name mapping kept here so the bench picker's
 * variant ids match what the probe DO can dispatch to. Update both
 * when adding a new auth deploy.
 */

interface Env {
    PROBE_DO: DurableObjectNamespace;
}

const VARIANT_TO_BINDING: Record<string, string> = {
    current: "AUTH_BACKEND",
    "thick-identity": "AUTH_BACKEND_THICK_ID",
    "fast-hash": "AUTH_BACKEND_FAST_HASH",
    "pbkdf2-fast": "AUTH_BACKEND_PBKDF2",
    "kv-cache": "AUTH_BACKEND_KV_CACHE",
    stacked: "AUTH_BACKEND_STACKED",
    recommended: "AUTH_BACKEND_RECOMMENDED",
    stateless: "AUTH_BACKEND_STATELESS",
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: o => o ?? "*", credentials: true }));

app.get("/health", c => c.json({ status: "ok", regions: REGIONS.map(r => r.id) }));

app.post("/probe", async c => {
    let body: { variantId?: string; op?: ProbeOp; n?: number; regions?: string[] };
    try {
        body = (await c.req.json()) as never;
    } catch {
        return c.json({ error: "invalid JSON body" }, 400);
    }
    const bindingName = VARIANT_TO_BINDING[body.variantId ?? ""];
    if (!bindingName) {
        return c.json({ error: `unknown variantId: ${body.variantId}` }, 400);
    }
    const op: ProbeOp = (body.op ?? "signin") as ProbeOp;
    const n = Math.max(1, Math.min(20, body.n ?? 5));
    const selected: RegionId[] =
        Array.isArray(body.regions) && body.regions.length > 0
            ? body.regions.filter((r): r is RegionId => REGIONS.some(R => R.id === r))
            : (REGIONS.map(r => r.id) as RegionId[]);

    // Fan out to every selected region. Each iteration creates the DO
    // stub with its locationHint — the DO is placed (or warmed) in that
    // region for this and future calls.
    const tasks = selected.map(async regionId => {
        const hint = locationHintFor(regionId)!;
        const t0 = Date.now();
        try {
            const id = c.env.PROBE_DO.idFromName(`probe:${regionId}`);
            const stub = c.env.PROBE_DO.get(id, { locationHint: hint });
            // @ts-expect-error — DO RPC method
            const result = (await stub.runProbe({ bindingName, op, n })) as ProbeResult;
            return {
                region: regionId,
                hint,
                wallTime: Date.now() - t0,
                result,
                error: null,
            };
        } catch (err) {
            return {
                region: regionId,
                hint,
                wallTime: Date.now() - t0,
                result: null,
                error: (err as Error)?.message ?? "unknown",
            };
        }
    });

    const settled = await Promise.all(tasks);
    return c.json({
        variantId: body.variantId,
        op,
        n,
        regions: settled,
        ts: new Date().toISOString(),
    });
});

export default app;
