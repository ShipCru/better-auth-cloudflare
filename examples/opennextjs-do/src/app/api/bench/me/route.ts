import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * GET /api/bench/me — returns the visitor's Cloudflare-derived geo
 * + network metadata. The bench page renders this at the top so the
 * tester can see which colo their browser is hitting before
 * interpreting any latency numbers.
 *
 * Edge-only (no caching). Each request reflects the current request's
 * `cf` block.
 */
export interface MeResponse {
    colo: string | null;
    country: string | null;
    continent: string | null;
    region: string | null;
    regionCode: string | null;
    city: string | null;
    timezone: string | null;
    asn: number | null;
    asOrganization: string | null;
    latitude: string | null;
    longitude: string | null;
}

export async function GET(): Promise<NextResponse<MeResponse>> {
    const ctx = getCloudflareContext();
    const cf = (ctx.cf as unknown as Record<string, unknown> | undefined) ?? {};
    const s = (k: string): string | null => {
        const v = cf[k];
        return typeof v === "string" ? v : null;
    };
    const n = (k: string): number | null => {
        const v = cf[k];
        return typeof v === "number" ? v : null;
    };
    return NextResponse.json(
        {
            colo: s("colo"),
            country: s("country"),
            continent: s("continent"),
            region: s("region"),
            regionCode: s("regionCode"),
            city: s("city"),
            timezone: s("timezone"),
            asn: n("asn"),
            asOrganization: s("asOrganization"),
            latitude: s("latitude"),
            longitude: s("longitude"),
        },
        { headers: { "cache-control": "private, no-store" } }
    );
}

export const runtime = "nodejs";
