import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext + Cloudflare config.
 *
 * Note on DO classes: `UserDurableObject` and `IdentityDurableObject` need
 * to be exported from the worker entry that wrangler loads. OpenNext
 * generates `.open-next/worker.js`; depending on the OpenNext version this
 * either accepts custom re-exports via a pre-build hook or needs a tiny
 * wrapper. The simplest working pattern today:
 *
 *   After `opennextjs-cloudflare build`, prepend the generated worker.js with:
 *     export { UserDurableObject, IdentityDurableObject } from "better-auth-cloudflare";
 *
 * For local `pnpm dev`, the DOs are registered via `initOpenNextCloudflareForDev()`
 * in next.config.ts plus the wrangler.toml bindings — Cloudflare's dev binding
 * resolves them from the package's built dist when the demo's node_modules
 * has the workspace link.
 */
export default defineCloudflareConfig({});
