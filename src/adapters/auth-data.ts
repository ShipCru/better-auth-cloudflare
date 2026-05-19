import type { D1Database } from "@cloudflare/workers-types";
import type { PrincipalRecord, AccountRecord } from "../objects/UserDurableObject";
import { createLogger, timed, type Logger, type LogLevel } from "../logging";

/**
 * Auth data store for the DO adapter.
 *
 * The Durable Objects are the source of truth on the hot path. This store
 * is a one-way downstream sync target: every DO write is mirrored here
 * via the outbox + alarm + waitUntil pipeline. It is **never** queried
 * during auth flows. Two use cases:
 *
 *   1. **Dashboard / admin queries** — list users, search by email,
 *      paginate, report. Reads go directly against this store via your
 *      own admin endpoints.
 *   2. **DR / restore** — if a DO loses its SQLite, replay state from
 *      here via `restorePrincipal`.
 *
 * `d1AuthDataStore` is the only implementation shipped today. The
 * interface is small enough to back with Postgres via Hyperdrive or any
 * other store later.
 */
export interface AuthDataStore {
    writeUser(user: PrincipalRecord): Promise<void>;
    writeAccount(account: AccountRecord): Promise<void>;
    deleteUser(principalId: string): Promise<void>;
    deleteAccount(accountId: string): Promise<void>;
    readUser(principalId: string): Promise<PrincipalRecord | null>;
    readAccountsForUser(principalId: string): Promise<AccountRecord[]>;
}

/**
 * SQL schema for the D1 auth data store. Password hash deliberately NOT
 * mirrored — stays in the DO only. Restored users must reset their
 * password (acceptable trade-off for the rare DO storage-loss event).
 *
 * Also exported as Drizzle definitions from `better-auth-cloudflare/db/schema`.
 */
export const AUTH_DATA_D1_SCHEMA = `
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

/**
 * @param logLevel - Optional log level for D1 timing logs. Defaults to "info".
 *                   Each D1 query emits a single info line: {op, durationMs, status}.
 */
export function d1AuthDataStore(db: D1Database, logLevel: LogLevel = "info"): AuthDataStore {
    const log = createLogger({ scope: "d1-auth-data", level: logLevel });
    return {
        async writeUser(user) {
            return timed(
                log,
                "d1.writeUser",
                async () => {
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
                { isAnonymous: user.isAnonymous }
            );
        },

        async writeAccount(account) {
            return timed(
                log,
                "d1.writeAccount",
                async () => {
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
                { providerId: account.providerId }
            );
        },

        async deleteUser(principalId) {
            return timed(log, "d1.deleteUser", async () => {
                const now = new Date().toISOString();
                await db
                    .prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`)
                    .bind(now, now, principalId)
                    .run();
            });
        },

        async deleteAccount(accountId) {
            return timed(log, "d1.deleteAccount", async () => {
                await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(accountId).run();
            });
        },

        async readUser(principalId) {
            return timed(log, "d1.readUser", async () => {
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
            });
        },

        async readAccountsForUser(principalId) {
            return timed(log, "d1.readAccountsForUser", async () => {
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
            });
        },
    };
}

/**
 * Wraps an auth-data-store write so failures log and resolve rather than
 * throwing. The auth hot path must never block on this store.
 */
export async function bestEffortAuthDataWrite(log: Logger, label: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        log.warn("auth data write failed", { op: label, err: (err as Error)?.message });
    }
}
