import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { AuthDataStore } from "./auth-data";

/**
 * Replays a principal from the auth data store back into the
 * UserDurableObject. Use on detected DO storage loss.
 *
 * The auth data store is NEVER queried during normal auth flows — it is
 * write-mirrored only via the DO outbox + alarm. This function is the
 * one place the read direction happens, and it is admin-triggered.
 *
 * Idempotent: re-running on a DO that still has its principal is a
 * no-op (returns `{ restored: false, reason: "principal_already_present" }`).
 *
 * Password hashes are NOT in the store by design. Users restored this
 * way will need to reset their password (or sign in via OAuth).
 */
export async function restorePrincipal(args: {
    userDo: DurableObjectNamespace;
    authData: AuthDataStore;
    principalId: string;
}): Promise<{ restored: boolean; reason?: string }> {
    const { userDo, authData, principalId } = args;
    const stub = userDo.get(userDo.idFromName(principalId));

    // @ts-expect-error — DO RPC method
    const existing = await stub.findPrincipal();
    if (existing) return { restored: false, reason: "principal_already_present" };

    const user = await authData.readUser(principalId);
    if (!user) return { restored: false, reason: "not_in_auth_data" };

    // @ts-expect-error
    await stub.createPrincipal({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        isAnonymous: user.isAnonymous,
    });

    const accounts = await authData.readAccountsForUser(principalId);
    for (const account of accounts) {
        // @ts-expect-error
        await stub.createAccount({
            id: account.id,
            userId: account.userId,
            providerId: account.providerId,
            accountId: account.accountId,
            password: null, // by design — user must reset
        });
    }

    return { restored: true };
}
