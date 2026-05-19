import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
    // Re-export the DO classes from the generated worker so Cloudflare can
    // register them. This is the OpenNext convention; see the docs for
    // details: https://opennext.js.org/cloudflare/durable-objects
    extra: {
        durableObjects: {
            UserDurableObject: "better-auth-cloudflare",
            IdentityDurableObject: "better-auth-cloudflare",
        },
    },
});
