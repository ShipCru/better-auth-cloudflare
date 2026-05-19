import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { withCloudflare, d1AuthDataStore, createIdentityIndexCache } from "better-auth-cloudflare";
import { anonymous } from "better-auth/plugins";
import type { CloudflareBindings } from "../env";
import * as fastHash from "./fast-hash";
import * as pbkdf2Hash from "./pbkdf2-hash";
import { pepperKeysetFromEnv, withPepper } from "./pepper";

/**
 * Pick a password hash strategy based on env vars. Precedence:
 *   USE_PBKDF2=1    → Web Crypto PBKDF2 (100k iters SHA-256, CF cap)
 *   USE_FAST_HASH=1 → scrypt(N=4096) via @noble/hashes
 *   (default)       → BA's built-in scrypt(N=16384)
 *
 * The chosen hash format is encoded in each stored hash's prefix so
 * verify() picks the right algorithm. A user created under one preset
 * can only sign in under that preset.
 *
 * When BETTER_AUTH_PEPPER is configured, all variants get HMAC-peppered
 * before the underlying hash function sees them — defends against
 * offline GPU brute-force when the password DB leaks but the pepper
 * (held in Workers Secrets) doesn't. Hash format gains a `p<v>:` prefix
 * for the pepper version so rotation is possible without re-hashing
 * existing rows immediately.
 */
function pickPasswordConfig(env?: Record<string, string | undefined>) {
    let inner:
        | { hash: (p: string) => Promise<string>; verify: (i: { password: string; hash: string }) => Promise<boolean> }
        | undefined;
    if (env?.USE_PBKDF2 === "1") inner = { hash: pbkdf2Hash.hash, verify: pbkdf2Hash.verify };
    else if (env?.USE_FAST_HASH === "1") inner = { hash: fastHash.hash, verify: fastHash.verify };
    if (!inner) return undefined;
    const keyset = pepperKeysetFromEnv(env ?? {});
    return withPepper(inner, keyset);
}

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
                      // Optional D1 auth data store. When AUTH_DB is bound
                      // (see wrangler.toml), every successful DO write is
                      // one-way mirrored to D1 best-effort. The auth data store is
                      // NEVER queried during auth flows — it exists only for DR.
                      // Use restorePrincipal() to replay a
                      // principal back into a DO that lost storage.
                      authDataStore: env.AUTH_DB ? d1AuthDataStore(env.AUTH_DB) : undefined,
                      // Opt-in identity index cache. USE_KV_CACHE=1 puts a
                      // KV layer (with optional D1 second tier via AUTH_DB)
                      // in front of IdentityDO for email→principal_id
                      // lookups. Writes through on commit/disable. See
                      // src/adapters/identity-cache.ts in the lib.
                      identityIndexCache:
                          env.USE_KV_CACHE === "1" && env.KV
                              ? createIdentityIndexCache({ kv: env.KV, d1: env.AUTH_DB })
                              : undefined,
                      // Opt-in to the "emailHash is the primary lookup"
                      // architecture. When USE_THICK_IDENTITY=1 the adapter
                      // mirrors principal+account data into IdentityDO's
                      // thick_cache so sign-in is one DO RPC instead of three.
                      // Set per-env in wrangler.toml [env.thick.vars] for a
                      // sibling deploy that can be A/B'd against current.
                      thickIdentity: env.USE_THICK_IDENTITY === "1",
                  }
                : undefined,
            kv: env?.KV,
        },
        {
            emailAndPassword: {
                enabled: true,
                // Forgot/reset password flow. In production, replace the
                // console.log with your transactional email service (Resend,
                // SendGrid, etc.) and pass the user a reset URL.
                sendResetPassword: async ({ user, url }) => {
                    console.log(
                        `[forgot-password] reset URL for ${user.email}:`,
                        url,
                        `(in production, email this to the user)`
                    );
                },
                // Password hash strategy selected via env var. See
                // pickPasswordConfig above for the precedence rules
                // (PBKDF2 > fast-scrypt > BA default).
                password: pickPasswordConfig(env),
            },
            // Social providers. Wired conditionally — only enabled if env
            // credentials are present. Set GOOGLE_CLIENT_ID and
            // GOOGLE_CLIENT_SECRET via `wrangler secret put` to enable.
            socialProviders:
                env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET
                    ? {
                          google: {
                              clientId: env.GOOGLE_CLIENT_ID,
                              clientSecret: env.GOOGLE_CLIENT_SECRET,
                          },
                      }
                    : undefined,
            plugins: [anonymous()],
            rateLimit: {
                enabled: true,
                window: 60,
                max: 100,
                customRules: {
                    "/sign-in/email": { window: 60, max: 100 },
                    "/sign-up/email": { window: 60, max: 20 },
                    "/forget-password": { window: 60, max: 10 },
                },
            },
        }
    );

    return betterAuth({
        baseURL,
        // Trust the local Hono port and the Next.js frontend that proxies
        // to it. Production should set these to your actual deployed
        // origins. Wildcards are not supported here — list explicitly.
        trustedOrigins: [
            "http://localhost:8787",
            "http://localhost:3000",
            "https://better-auth-cloudflare-hono-do.steve-4b7.workers.dev",
            "https://better-auth-cloudflare-opennextjs-do.steve-4b7.workers.dev",
        ],
        ...wrapped,
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
