"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side BA client. Hooks like `useSession`, methods like
 * `signIn.email`, `signUp.email`, `signOut`, `forgetPassword`. All
 * requests go to `/api/auth/*` which the Next.js route handler proxies
 * to the server-side BA instance.
 */
export const authClient = createAuthClient({
    baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
});

export const { signIn, signUp, signOut, useSession, forgetPassword } = authClient;
