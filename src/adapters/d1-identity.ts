import type { D1Database } from "@cloudflare/workers-types";
import { type Logger } from "../logging";

/**
 * D1-backed identity uniqueness store. Drop-in replacement for
 * IdentityDurableObject when the goal is to **eliminate the per-email
 * DO cold-start tax on signup**.
 *
 * The trade in one line: D1's UNIQUE constraint gives us the same
 * "first-write-wins" guarantee that IdentityDO's blockConcurrencyWhile
 * gives us, but at D1 latency (~30-80ms regional, 100-300ms cross) vs
 * IdentityDO's 300-1500ms cold-start tax for a brand-new email.
 *
 * For sign-IN reads, D1 Sessions API (db.withSession("first-unconstrained"))
 * lets the lookup hit the nearest read replica — comparable to KV
 * latency for warm rows.
 *
 *   sign-up uniqueness path:    INSERT INTO identity_unique ... → ON UNIQUE → 'taken'
 *   sign-in lookup path:        SELECT principal_id FROM identity_unique WHERE email_hash = ?
 *   delete / email change:      UPDATE identity_unique SET disabled_at = ?
 *
 * Designed to be passed via DOAdapterConfig.d1IdentityStore. When set,
 * the adapter's createUser bypasses IdentityDO.reserve/commit entirely
 * and findOne(user, email) reads from here instead.
 */

export const D1_IDENTITY_UNIQUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_unique (
  email_hash    TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_identity_unique_principal ON identity_unique(principal_id);
`;

export interface D1IdentityResult {
    principalId: string;
    version: number;
}

export interface D1IdentityStore {
    /**
     * Atomic insert. Returns ok=true on success, ok=false reason='taken'
     * when the email_hash already exists. Other failures throw.
     */
    insertOrFail(emailHash: string, principalId: string): Promise<{ ok: true } | { ok: false; reason: "taken" }>;
    lookup(emailHash: string): Promise<D1IdentityResult | null>;
    /** Soft-disable (sets disabled_at). lookup returns null for disabled rows. */
    disable(emailHash: string): Promise<void>;
}

interface MaybeSessionedD1 {
    withSession?: (constraint?: string) => D1Database;
}

export function createD1IdentityStore(db: D1Database, log?: Logger): D1IdentityStore {
    return {
        async insertOrFail(emailHash, principalId) {
            try {
                await db
                    .prepare(
                        `INSERT INTO identity_unique (email_hash, principal_id, version, created_at)
                         VALUES (?, ?, 1, ?)`
                    )
                    .bind(emailHash, principalId, new Date().toISOString())
                    .run();
                return { ok: true };
            } catch (err) {
                const msg = String((err as Error)?.message ?? err);
                // D1 surfaces UNIQUE violations as "UNIQUE constraint failed".
                // Both branches end up rolling back; treat anything UNIQUE-y
                // as "taken" so the caller can return EMAIL_ALREADY_EXISTS.
                if (/UNIQUE|constraint/i.test(msg)) {
                    return { ok: false, reason: "taken" };
                }
                log?.warn("d1-identity.insertOrFail unknown error", { err: msg });
                throw err;
            }
        },
        async lookup(emailHash) {
            try {
                const maybeSessioned = db as MaybeSessionedD1 & D1Database;
                const sess =
                    typeof maybeSessioned.withSession === "function"
                        ? maybeSessioned.withSession("first-unconstrained")
                        : db;
                const row = (await sess
                    .prepare(
                        `SELECT principal_id, version FROM identity_unique
                         WHERE email_hash = ? AND disabled_at IS NULL`
                    )
                    .bind(emailHash)
                    .first()) as { principal_id: string; version: number } | null;
                return row ? { principalId: String(row.principal_id), version: Number(row.version) } : null;
            } catch (err) {
                log?.warn("d1-identity.lookup failed", { err: (err as Error)?.message });
                return null;
            }
        },
        async disable(emailHash) {
            try {
                await db
                    .prepare(`UPDATE identity_unique SET disabled_at = ? WHERE email_hash = ?`)
                    .bind(new Date().toISOString(), emailHash)
                    .run();
            } catch (err) {
                log?.warn("d1-identity.disable failed", { err: (err as Error)?.message });
            }
        },
    };
}
