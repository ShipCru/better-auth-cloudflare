import { DurableObject } from "cloudflare:workers";
import { runSql } from "./sql";

/**
 * Global uniqueness primitive for the `do` adapter.
 *
 * One DO per identity key (sha256-hashed email, OAuth subject hash, or
 * handle hash). Stores only the principal_id pointer; the principal data
 * itself lives in UserDurableObject.
 *
 * The DO's single-threaded execution serialises racing signup attempts —
 * only one caller sees `state IS NULL` and proceeds.
 *
 * Owners must re-export this class:
 *
 * ```ts
 * export { IdentityDurableObject } from 'better-auth-cloudflare';
 * ```
 */
export const IDENTITY_DO_SCHEMA = `
CREATE TABLE IF NOT EXISTS identity (
  email_hash              TEXT PRIMARY KEY,
  state                   TEXT NOT NULL CHECK (state IN ('reserved','committed','disabled')),
  principal_id            TEXT,
  reservation_id          TEXT,
  reservation_expires_at  TEXT,
  committed_at            TEXT,
  disabled_at             TEXT
);
`;

const RESERVATION_TTL_MS = 30_000;

export type ReserveResult =
    | { ok: true; reservationId: string }
    | { ok: false; reason: "taken"; principalId: string | null }
    | { ok: false; reason: "disabled" };

export type CommitResult =
    | { ok: true }
    | { ok: false; reason: "no_reservation" | "reservation_expired" | "reservation_mismatch" };

export interface IdentityDurableObjectEnv {
    [key: string]: unknown;
}

export class IdentityDurableObject<
    Env extends IdentityDurableObjectEnv = IdentityDurableObjectEnv,
> extends DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        runSql(this.ctx.storage.sql, IDENTITY_DO_SCHEMA);
    }

    async reserve(emailHash: string): Promise<ReserveResult> {
        const sql = this.ctx.storage.sql;
        const existing = runSql(
            sql,
            `SELECT * FROM identity WHERE email_hash = ?`,
            emailHash
        ).toArray()[0] as unknown as RawIdentity | undefined;

        const now = Date.now();
        if (existing) {
            if (existing.state === "disabled") return { ok: false, reason: "disabled" };
            if (existing.state === "committed") {
                return { ok: false, reason: "taken", principalId: existing.principal_id };
            }
            if (existing.state === "reserved" && existing.reservation_expires_at) {
                const until = new Date(existing.reservation_expires_at).getTime();
                if (until > now) return { ok: false, reason: "taken", principalId: existing.principal_id };
            }
        }

        const reservationId = crypto.randomUUID();
        const expiresAt = new Date(now + RESERVATION_TTL_MS).toISOString();
        runSql(
            sql,
            `INSERT INTO identity (email_hash, state, reservation_id, reservation_expires_at)
       VALUES (?, 'reserved', ?, ?)
       ON CONFLICT(email_hash) DO UPDATE
         SET state = 'reserved',
             reservation_id = excluded.reservation_id,
             reservation_expires_at = excluded.reservation_expires_at`,
            emailHash,
            reservationId,
            expiresAt
        );
        return { ok: true, reservationId };
    }

    async commit(emailHash: string, reservationId: string, principalId: string): Promise<CommitResult> {
        const sql = this.ctx.storage.sql;
        const row = runSql(sql, `SELECT * FROM identity WHERE email_hash = ?`, emailHash).toArray()[0] as unknown as
            | RawIdentity
            | undefined;
        if (!row || row.state !== "reserved") return { ok: false, reason: "no_reservation" };
        if (row.reservation_id !== reservationId) return { ok: false, reason: "reservation_mismatch" };
        if (row.reservation_expires_at && new Date(row.reservation_expires_at).getTime() < Date.now()) {
            return { ok: false, reason: "reservation_expired" };
        }
        runSql(
            sql,
            `UPDATE identity
         SET state = 'committed',
             principal_id = ?,
             committed_at = ?,
             reservation_id = NULL,
             reservation_expires_at = NULL
       WHERE email_hash = ?`,
            principalId,
            new Date().toISOString(),
            emailHash
        );
        return { ok: true };
    }

    async release(emailHash: string, reservationId: string): Promise<void> {
        const sql = this.ctx.storage.sql;
        const row = runSql(sql, `SELECT * FROM identity WHERE email_hash = ?`, emailHash).toArray()[0] as unknown as
            | RawIdentity
            | undefined;
        if (!row || row.state !== "reserved" || row.reservation_id !== reservationId) return;
        runSql(sql, `DELETE FROM identity WHERE email_hash = ?`, emailHash);
    }

    async lookup(emailHash: string): Promise<{ principalId: string } | null> {
        const sql = this.ctx.storage.sql;
        const row = runSql(sql, `SELECT * FROM identity WHERE email_hash = ?`, emailHash).toArray()[0] as unknown as
            | RawIdentity
            | undefined;
        if (!row || row.state !== "committed" || !row.principal_id) return null;
        return { principalId: row.principal_id };
    }

    async disable(emailHash: string): Promise<void> {
        runSql(
            this.ctx.storage.sql,
            `INSERT INTO identity (email_hash, state, disabled_at)
       VALUES (?, 'disabled', ?)
       ON CONFLICT(email_hash) DO UPDATE
         SET state = 'disabled', disabled_at = excluded.disabled_at,
             principal_id = NULL, reservation_id = NULL, reservation_expires_at = NULL`,
            emailHash,
            new Date().toISOString()
        );
    }
}

interface RawIdentity {
    email_hash: string;
    state: "reserved" | "committed" | "disabled";
    principal_id: string | null;
    reservation_id: string | null;
    reservation_expires_at: string | null;
    committed_at: string | null;
    disabled_at: string | null;
}
