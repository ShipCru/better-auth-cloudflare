import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { withCloudflare, d1AuthDataStore } from "better-auth-cloudflare";
import { anonymous } from "better-auth/plugins";

/**
 * BA factory wired to the DO adapter. Per-request because OpenNext fetches
 * its Cloudflare context (bindings, request.cf) per request. Cached as a
 * singleton for the lifetime of one request only.
 *
 * Mirror of `examples/hono-do/src/auth/index.ts` — same DO + KV + AUTH_DB
 * wiring, same forgot-password + Google OAuth config. Stays Next.js-aware
 * (App Router route handler) where the Hono variant is Hono-aware.
 */
let authInstance: ReturnType<typeof betterAuth> | null = null;

export async function getAuth() {
    if (authInstance) return authInstance;
    const { env, cf } = await getCloudflareContext({ async: true });

    const wrapped = withCloudflare(
        {
            autoDetectIpAddress: true,
            geolocationTracking: false,
            cf,
            do: {
                userDo: env.USER_DO,
                identityDo: env.IDENTITY_DO,
                logLevel: "info",
                authDataStore: env.AUTH_DB ? d1AuthDataStore(env.AUTH_DB) : undefined,
            },
            kv: env.KV,
        },
        {
            emailAndPassword: {
                enabled: true,
                sendResetPassword: async ({ user, url }) => {
                    console.log(`[forgot-password] ${user.email}: ${url}`);
                },
            },
            socialProviders:
                env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
                    ? {
                          google: {
                              clientId: env.GOOGLE_CLIENT_ID,
                              clientSecret: env.GOOGLE_CLIENT_SECRET,
                          },
                      }
                    : undefined,
            plugins: [anonymous()],
        }
    );

    authInstance = betterAuth({
        ...wrapped,
        session: {
            ...wrapped.session,
            storeSessionInDatabase: false,
            expiresIn: 21 * 24 * 60 * 60,
            updateAge: 24 * 60 * 60,
            cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
    });
    return authInstance;
}
