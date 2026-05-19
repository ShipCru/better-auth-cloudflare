import { getCloudflareContext } from '@opennextjs/cloudflare';
import { betterAuth } from 'better-auth';
import { withCloudflare } from 'better-auth-cloudflare';
import { anonymous } from 'better-auth/plugins';

/**
 * OpenNext + DO adapter. Drop-in replacement for the D1-based config in
 * `examples/opennextjs/src/auth/index.ts`.
 *
 * Async because OpenNext's Cloudflare context (bindings, request.cf) is
 * fetched per request. Cached as a singleton for the request lifetime by
 * upstream — keep the same pattern here.
 */
let authSingleton: ReturnType<typeof betterAuth> | null = null;

export async function getAuth() {
  if (authSingleton) return authSingleton;
  const { env, cf } = await getCloudflareContext({ async: true });
  authSingleton = betterAuth({
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: true,
        cf,
        do: {
          userDo: env.USER_DO,
          identityDo: env.IDENTITY_DO,
          logLevel: 'info',
        },
        kv: env.KV,
      },
      {
        emailAndPassword: { enabled: true },
        plugins: [anonymous()],
        session: {
          expiresIn: 21 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
      },
    ),
  });
  return authSingleton;
}
