import type { NextConfig } from "next";

// /api/auth/* and /admin/* are proxied to the Hono auth Worker in
// src/middleware.ts via the AUTH_BACKEND service binding (wrangler.toml).
// No Next.js `rewrites()` here — external rewrites across same-account
// *.workers.dev Workers return Cloudflare's 404 placeholder.
const config: NextConfig = {
    experimental: {
        serverComponentsHmrCache: false,
    },
};

export default config;
