import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { withCloudflare } from 'better-auth-cloudflare';
import { anonymous } from 'better-auth/plugins';
import type { CloudflareBindings } from '../env';

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
function createAuth(
  env?: CloudflareBindings,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  return betterAuth({
    baseURL,
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: true,
        cf: cf ?? {},
        do: env
          ? {
              userDo: env.USER_DO,
              identityDo: env.IDENTITY_DO,
              logLevel: 'info',
            }
          : undefined,
        kv: env?.KV,
      },
      {
        emailAndPassword: { enabled: true },
        plugins: [anonymous()],
        session: {
          expiresIn: 21 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
        rateLimit: {
          enabled: true,
          window: 60,
          max: 100,
          customRules: {
            '/sign-in/email': { window: 60, max: 100 },
            '/sign-up/email': { window: 60, max: 20 },
          },
        },
      },
    ),
  });
}

export const auth = createAuth();
export { createAuth };
