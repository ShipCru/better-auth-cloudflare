import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runScenario } from "@/lib/bench-runner";
import type { BenchRunRequest, BenchRunResponse, BenchErrorResponse } from "@/lib/bench-types";

/**
 * POST /api/bench
 *
 * Body: { variantId, scenarioId, n? }
 * Runs the named scenario against the named variant's backend binding and
 * returns the timing result.
 *
 * Runs server-side inside the OpenNext Worker — same isolate that hosts
 * the rest of the app — so the service binding to the auth Worker is
 * available via getCloudflareContext().env.
 *
 * This is intentionally a route handler (not middleware) so the bench
 * page can call it from the browser via plain fetch and get JSON back.
 */
export async function POST(req: NextRequest): Promise<NextResponse<BenchRunResponse | BenchErrorResponse>> {
    let body: BenchRunRequest;
    try {
        body = (await req.json()) as BenchRunRequest;
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    if (!body?.variantId || !body?.scenarioId) {
        return NextResponse.json({ error: "body requires { variantId, scenarioId, n? }" }, { status: 400 });
    }

    const ctx = getCloudflareContext();
    const cf = (ctx.cf as unknown as Record<string, unknown> | undefined) ?? {};

    try {
        const out = await runScenario({
            env: ctx.env as unknown as Record<string, unknown>,
            scenarioId: body.scenarioId,
            variantId: body.variantId,
            n: body.n,
            cf,
        });
        return NextResponse.json(out, {
            headers: { "cache-control": "private, no-store" },
        });
    } catch (err) {
        return NextResponse.json({ error: (err as Error)?.message ?? "bench run failed" }, { status: 500 });
    }
}

export const runtime = "nodejs";
