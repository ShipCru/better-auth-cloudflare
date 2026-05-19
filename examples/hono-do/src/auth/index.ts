import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { withCloudflare, d1RecoveryStore } from "better-auth-cloudflare";
import { anonymous } from "better-auth/plugins";
import type { CloudflareBindings } from "../env";

/**
 * Single auth factory wired to the Durable Object adapter.
 *
 *   - `do.userDo`     → per-principal SQLite DO (BA user + account models)
 *   - `do.identityDo` → per-email-hash DO (global uniqueness)
 *   - `kv`            → BA secondaryStorage (sessions, verification, rate limits)
 *
 * No D1/Hyperdrive needed. Hot path is signature verify + zero-to-two DO
 * RPCs depending on the flow.
 */
function createAuth(env?: CloudflareBindings, cf?: IncomingRequestCfProperties, baseURL?: string) {
    // Sessions in this v1 of the DO adapter go to BA's secondaryStorage (KV),
    // not to the DO. We disable `geolocationTracking` here (which would force
    // sessions into the DB-backed path) — the `cloudflare/geolocation`
    // endpoint still works because the plugin is enabled and `cf` is set.
    // Adding session persistence to the DO adapter is a planned follow-up
    // (see the fork's roadmap).
    const wrapped = withCloudflare(
        {
            autoDetectIpAddress: true,
            geolocationTracking: false,
            cf: cf ?? {},
            do: env
                ? {
                      userDo: env.USER_DO,
                      identityDo: env.IDENTITY_DO,
                      logLevel: "info",
                      // Optional D1 recovery store. When AUTH_RECOVERY_DB is bound
                      // (see wrangler.toml), every successful DO write is
                      // one-way mirrored to D1 best-effort. The recovery store is
                      // NEVER queried during auth flows — it exists only for DR.
                      // Use recoverPrincipalFromRecoveryStore() to replay a
                      // principal back into a DO that lost storage.
                      recoveryStore: env.AUTH_RECOVERY_DB ? d1RecoveryStore(env.AUTH_RECOVERY_DB) : undefined,
                  }
                : undefined,
            kv: env?.KV,
        },
        {
            emailAndPassword: { enabled: true },
            plugins: [anonymous()],
            rateLimit: {
                enabled: true,
                window: 60,
                max: 100,
                customRules: {
                    "/sign-in/email": { window: 60, max: 100 },
                    "/sign-up/email": { window: 60, max: 20 },
                },
            },
        }
    );

    return betterAuth({
        baseURL,
        ...wrapped,
        // Force sessions into KV via secondaryStorage instead of the adapter.
        session: {
            ...wrapped.session,
            storeSessionInDatabase: false,
            expiresIn: 21 * 24 * 60 * 60,
            updateAge: 24 * 60 * 60,
            cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
    });
}

export const auth = createAuth();
export { createAuth };
