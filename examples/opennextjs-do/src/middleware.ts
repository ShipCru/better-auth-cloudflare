import { NextResponse, type NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Proxy /api/auth/* and /admin/* to the Hono auth Worker via the
 * AUTH_BACKEND service binding (see wrangler.toml).
 *
 * Bindings are the only supported wire between this Worker and the Hono
 * Worker. Outbound HTTP fetch to another *.workers.dev URL on the same
 * account is unreliable (Cloudflare returns its generic 404 placeholder),
 * and a dual-codepath would hide bugs behind a "works locally" fallback.
 *
 * Same-origin keeps cookies working with no CORS dance.
 */
export async function middleware(request: NextRequest) {
    const incoming = new URL(request.url);

    // The matcher already restricts to these prefixes, but be explicit so
    // a misconfigured matcher can't accidentally drop other routes.
    if (!incoming.pathname.startsWith("/api/auth/") && !incoming.pathname.startsWith("/admin/")) {
        return NextResponse.next();
    }

    const backend = getCloudflareContext().env.AUTH_BACKEND;
    if (!backend) {
        // No silent HTTP fallback. If the binding is missing, surface it.
        // Local dev: run `pnpm preview` (wrangler) so the binding is wired,
        // not plain `next dev`.
        return new NextResponse(
            JSON.stringify({
                error: "AUTH_BACKEND service binding is not configured",
                hint: "Set [[services]] binding=AUTH_BACKEND in wrangler.toml and run via wrangler.",
            }),
            { status: 503, headers: { "content-type": "application/json" } }
        );
    }

    // Service binding: pass the original Request straight through.
    // env.AUTH_BACKEND.fetch() preserves method, headers, and body and
    // dispatches in-process to the Hono Worker (no network hop).
    return backend.fetch(request);
}

export const config = {
    matcher: ["/api/auth/:path*", "/admin/:path*"],
};
