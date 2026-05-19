import type { D1Database } from "@cloudflare/workers-types";
import type { PrincipalRecord, AccountRecord } from "../objects/UserDurableObject";
import type { Logger } from "../logging";

/**
 * Recovery store for the DO adapter.
 *
 * **The recovery store is one-way: DOs sync to it on writes; it is NEVER
 * queried during auth flows.** Auth lookups (sign-in, session validate,
 * find-user-by-email) always go through the Durable Objects — they are
 * the sole source of truth.
 *
 * Use: when a DO loses its SQLite storage (rare but possible),
 * `recoverPrincipalFromRecoveryStore` replays users + accounts back into
 * the DO from this store. Recovery is admin-triggered, never automatic.
 *
 * `d1RecoveryStore` is the only implementation shipped today.
 */
export interface RecoveryStore {
    writeUser(user: PrincipalRecord): Promise<void>;
    writeAccount(account: AccountRecord): Promise<void>;
    deleteUser(principalId: string): Promise<void>;
    deleteAccount(accountId: string): Promise<void>;
    readUser(principalId: string): Promise<PrincipalRecord | null>;
    readAccountsForUser(principalId: string): Promise<AccountRecord[]>;
}

/**
 * SQL schema for the D1 recovery store. Password hash deliberately NOT
 * mirrored — stays in the DO only. Restored users must reset their
 * password (acceptable trade-off for the rare DO storage-loss event).
 */
export const RECOVERY_D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  email               TEXT UNIQUE,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  image               TEXT,
  is_anonymous        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider_id         TEXT NOT NULL,
  account_id          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
);

CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts(user_id);
`;

export function d1RecoveryStore(db: D1Database): RecoveryStore {
    return {
        async writeUser(user) {
            await db
                .prepare(
                    `INSERT INTO users (id, name, email, email_verified, image, is_anonymous, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             email = excluded.email,
             email_verified = excluded.email_verified,
             image = excluded.image,
             is_anonymous = excluded.is_anonymous,
             updated_at = excluded.updated_at`
                )
                .bind(
                    user.id,
                    user.name,
                    user.email,
                    user.emailVerified ? 1 : 0,
                    user.image,
                    user.isAnonymous ? 1 : 0,
                    user.createdAt,
                    user.updatedAt
                )
                .run();
        },

        async writeAccount(account) {
            await db
                .prepare(
                    `INSERT INTO accounts (id, user_id, provider_id, account_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
                )
                .bind(
                    account.id,
                    account.userId,
                    account.providerId,
                    account.accountId,
                    account.createdAt,
                    account.updatedAt
                )
                .run();
        },

        async deleteUser(principalId) {
            const now = new Date().toISOString();
            await db
                .prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`)
                .bind(now, now, principalId)
                .run();
        },

        async deleteAccount(accountId) {
            await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(accountId).run();
        },

        async readUser(principalId) {
            const row = (await db
                .prepare(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`)
                .bind(principalId)
                .first()) as Record<string, unknown> | null;
            if (!row) return null;
            return {
                id: String(row.id),
                name: row.name as string | null,
                email: row.email as string | null,
                emailVerified: Number(row.email_verified) === 1,
                image: row.image as string | null,
                isAnonymous: Number(row.is_anonymous) === 1,
                createdAt: String(row.created_at),
                updatedAt: String(row.updated_at),
            };
        },

        async readAccountsForUser(principalId) {
            const result = await db.prepare(`SELECT * FROM accounts WHERE user_id = ?`).bind(principalId).all();
            const rows = (result.results ?? []) as Array<Record<string, unknown>>;
            return rows.map(r => ({
                id: String(r.id),
                userId: String(r.user_id),
                providerId: String(r.provider_id),
                accountId: r.account_id as string,
                password: null,
                accessToken: null,
                refreshToken: null,
                idToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
                scope: null,
                createdAt: String(r.created_at),
                updatedAt: String(r.updated_at),
            }));
        },
    };
}

/**
 * Wraps a recovery-store write so failures log and resolve rather than
 * throwing. The auth hot path must never block on the recovery store.
 */
export async function bestEffortRecoveryWrite(log: Logger, label: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        log.warn("recovery store write failed", { op: label, err: (err as Error)?.message });
    }
}
