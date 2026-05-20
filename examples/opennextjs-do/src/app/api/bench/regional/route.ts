import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * POST /api/bench/regional
 *
 * Body: { variantId, op?, n? }
 * Proxies to the probe Worker (PROBE_WORKER service binding), which fans
 * out to every CF region via locationHint-pinned ProbeDurableObject
 * instances and returns each region's timing.
 *
 * Total wall time = max(region) since the probe Worker runs the regions
 * in parallel.
 */
export async function POST(req: NextRequest) {
    let body: { variantId?: string; op?: string; n?: number };
    try {
        body = (await req.json()) as never;
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (!body?.variantId) {
        return NextResponse.json({ error: "variantId required" }, { status: 400 });
    }

    const ctx = getCloudflareContext();
    const probe = (ctx.env as unknown as { PROBE_WORKER?: { fetch: typeof fetch } }).PROBE_WORKER;
    if (!probe) {
        return NextResponse.json({ error: "PROBE_WORKER service binding is not configured" }, { status: 503 });
    }

    const upstream = await probe.fetch(
        new Request("https://probe.internal/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                variantId: body.variantId,
                op: body.op ?? "signin",
                n: body.n ?? 5,
            }),
        })
    );
    const data = await upstream.text();
    return new NextResponse(data, {
        status: upstream.status,
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
}

export const runtime = "nodejs";
