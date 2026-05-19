"use client";

import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";

/**
 * Browser-side BA client. Hooks like `useSession`, methods like
 * `signIn.email`, `signUp.email`, `signOut`. All requests go to
 * `/api/auth/*` which the Next.js route handler proxies to the
 * server-side BA instance.
 *
 * The `anonymousClient()` plugin is required to expose `signIn.anonymous()`
 * on the client — the server-only `anonymous()` plugin doesn't add the
 * client method by itself.
 */
export const authClient = createAuthClient({
    baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
    plugins: [anonymousClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
