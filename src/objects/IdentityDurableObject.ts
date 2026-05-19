import { DurableObject } from "cloudflare:workers";
import { runSql } from "./sql";
import { createLogger, timed, type Logger, type LogLevel } from "../logging";

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
    private readonly log: Logger;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        const level = ((env as { LOG_LEVEL?: string }).LOG_LEVEL ?? "info") as LogLevel;
        this.log = createLogger({ scope: "identity-do", level }).child("rpc", { doId: state.id.toString() });
        // See UserDurableObject for the blockConcurrencyWhile rationale.
        state.blockConcurrencyWhile(async () => {
            const t0 = Date.now();
            runSql(state.storage.sql, IDENTITY_DO_SCHEMA);
            this.log.info("schema_ready", { durationMs: Date.now() - t0 });
        });
    }

    async reserve(emailHash: string): Promise<ReserveResult> {
        return timed(this.log, "reserve", async () => {
            const sql = this.ctx.storage.sql;
            const existing = runSql(
                sql,
                `SELECT * FROM identity WHERE email_hash = ?`,
                emailHash
            ).toArray()[0] as unknown as RawIdentity | undefined;

            const now = Date.now();
            if (existing) {
                if (existing.state === "disabled") return { ok: false, reason: "disabled" } as ReserveResult;
                if (existing.state === "committed") {
                    return { ok: false, reason: "taken", principalId: existing.principal_id } as ReserveResult;
                }
                if (existing.state === "reserved" && existing.reservation_expires_at) {
                    const until = new Date(existing.reservation_expires_at).getTime();
                    if (until > now) {
                        return { ok: false, reason: "taken", principalId: existing.principal_id } as ReserveResult;
                    }
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
            return { ok: true, reservationId } as ReserveResult;
        });
    }

    async commit(emailHash: string, reservationId: string, principalId: string): Promise<CommitResult> {
        return timed(this.log, "commit", async () => {
            const sql = this.ctx.storage.sql;
            const row = runSql(
                sql,
                `SELECT * FROM identity WHERE email_hash = ?`,
                emailHash
            ).toArray()[0] as unknown as RawIdentity | undefined;
            if (!row || row.state !== "reserved") return { ok: false, reason: "no_reservation" } as CommitResult;
            if (row.reservation_id !== reservationId)
                return { ok: false, reason: "reservation_mismatch" } as CommitResult;
            if (row.reservation_expires_at && new Date(row.reservation_expires_at).getTime() < Date.now()) {
                return { ok: false, reason: "reservation_expired" } as CommitResult;
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
            return { ok: true } as CommitResult;
        });
    }

    async release(emailHash: string, reservationId: string): Promise<void> {
        return timed(this.log, "release", async () => {
            const sql = this.ctx.storage.sql;
            const row = runSql(
                sql,
                `SELECT * FROM identity WHERE email_hash = ?`,
                emailHash
            ).toArray()[0] as unknown as RawIdentity | undefined;
            if (!row || row.state !== "reserved" || row.reservation_id !== reservationId) return;
            runSql(sql, `DELETE FROM identity WHERE email_hash = ?`, emailHash);
        });
    }

    async lookup(emailHash: string): Promise<{ principalId: string } | null> {
        return timed(this.log, "lookup", async () => {
            const sql = this.ctx.storage.sql;
            const row = runSql(
                sql,
                `SELECT * FROM identity WHERE email_hash = ?`,
                emailHash
            ).toArray()[0] as unknown as RawIdentity | undefined;
            if (!row || row.state !== "committed" || !row.principal_id) return null;
            return { principalId: row.principal_id };
        });
    }

    async disable(emailHash: string): Promise<void> {
        return timed(this.log, "disable", async () => {
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
        });
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
