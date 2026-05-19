import type { NextConfig } from "next";

const config: NextConfig = {
    experimental: {
        // OpenNext recommends turning these off to minimize the worker bundle.
        serverComponentsHmrCache: false,
    },
};

export default config;

// OpenNext-Cloudflare dev binding initialization. Lets the Next.js dev
// server access the wrangler bindings (D1, KV, DOs) without a separate
// wrangler dev process. See https://opennext.js.org/cloudflare
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
