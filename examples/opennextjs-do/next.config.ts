import type { NextConfig } from "next";

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? "http://localhost:8787";

const config: NextConfig = {
    experimental: {
        serverComponentsHmrCache: false,
    },
    // Proxy /api/auth/* and /admin/* to the Hono auth Worker so the browser
    // sees them as same-origin (cookies just work). Override the upstream
    // URL with AUTH_BACKEND_URL.
    async rewrites() {
        return [
            { source: "/api/auth/:path*", destination: `${AUTH_BACKEND_URL}/api/auth/:path*` },
            { source: "/admin/:path*", destination: `${AUTH_BACKEND_URL}/admin/:path*` },
        ];
    },
};

export default config;
