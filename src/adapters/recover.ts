import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { RecoveryStore } from "./recovery";

/**
 * Replays a principal from the recovery store back into the
 * UserDurableObject. Use on detected DO storage loss.
 *
 * The recovery store is NEVER queried during normal auth flows — it is
 * write-mirrored only by the adapter. This function is the one place
 * the read direction happens, and it is admin-triggered.
 *
 * Idempotent: re-running on a DO that still has its principal is a
 * no-op (returns `{ restored: false, reason: "principal_already_present" }`).
 *
 * Password hashes are NOT in the recovery store by design. Users
 * restored this way will need to reset their password (or sign in with
 * an alternative provider). This is an intentional security trade-off.
 */
export async function recoverPrincipalFromRecoveryStore(args: {
    userDo: DurableObjectNamespace;
    recoveryStore: RecoveryStore;
    principalId: string;
}): Promise<{ restored: boolean; reason?: string }> {
    const { userDo, recoveryStore, principalId } = args;
    const stub = userDo.get(userDo.idFromName(principalId));

    // @ts-expect-error — DO RPC method
    const existing = await stub.findPrincipal();
    if (existing) return { restored: false, reason: "principal_already_present" };

    const user = await recoveryStore.readUser(principalId);
    if (!user) return { restored: false, reason: "not_in_recovery_store" };

    // @ts-expect-error
    await stub.createPrincipal({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        isAnonymous: user.isAnonymous,
    });

    const accounts = await recoveryStore.readAccountsForUser(principalId);
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
