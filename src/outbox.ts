import type { SqlStorage } from "@cloudflare/workers-types";

/**
 * Generic outbox + alarm helper for SQLite-backed Durable Objects that
 * need to sync writes to an async store (D1, R2, an HTTP webhook, etc.)
 * with bounded eventual consistency.
 *
 * Usage pattern in a consumer DO:
 *
 * ```ts
 * import { createOutboxFlush } from "better-auth-cloudflare";
 *
 * export class UserDataDurableObject extends DurableObject<Env> {
 *   private outbox = createOutboxFlush({
 *     sql: this.ctx.storage.sql,
 *     storage: this.ctx.storage,
 *     waitUntil: (p) => this.ctx.waitUntil(p),
 *     intervalMs: 3000,
 *     apply: async (op) => {
 *       const db = this.env.USER_DATA_DB;
 *       if (op.model === "profile" && op.op === "upsert") {
 *         await db.prepare(`INSERT INTO profiles (...) VALUES (...) ON CONFLICT ...`)
 *           .bind(...).run();
 *       }
 *     },
 *   });
 *
 *   async updateProfile(input: {...}) {
 *     // ... local SQLite write ...
 *     this.outbox.enqueue("profile", "upsert", { id, ...fields });
 *     await this.outbox.flushNow();  // schedules waitUntil + alarm
 *     return result;
 *   }
 *
 *   async alarm() { await this.outbox.drain(); }
 * }
 * ```
 *
 * Properties:
 *   - Mandatory: every `enqueue` is durable in local SQLite.
 *   - Eventually consistent: typical lag ~50-200ms via waitUntil; bounded
 *     by `intervalMs` (default 3s) via alarm as fallback.
 *   - Resilient: failures stay in outbox, retry with exponential backoff
 *     capped at 30s.
 *   - GC: rows older than 1h after successful sync are deleted.
 *
 * Three modes for `apply`:
 *   - "snapshot" — your `apply` does UPSERT (overwrite current state)
 *   - "history" — your `apply` does INSERT (every version preserved)
 *   - "both"   — your `apply` does both writes (current + versioned)
 *
 * The mode isn't enforced by the helper — it's a property of YOUR `apply`
 * callback. The helper just delivers (model, op, payload) events; what
 * you do with them is yours.
 */

export interface OutboxEvent {
    eventId: string;
    model: string;
    op: string;
    payload: unknown;
    attempts: number;
}

export interface OutboxFlushConfig {
    /** The DO's SQL storage handle. */
    sql: SqlStorage;
    /** The DO's storage interface (for alarms). */
    storage: { getAlarm(): Promise<number | null>; setAlarm(scheduledTime: number): Promise<void> };
    /**
     * The DO's `ctx.waitUntil` — used for immediate post-response drain
     * attempts. Optional but strongly recommended for sub-second lag.
     */
    waitUntil?: (promise: Promise<unknown>) => void;
    /** Alarm interval in ms. @default 3000 */
    intervalMs?: number;
    /** Max events drained per alarm tick. @default 25 */
    batchSize?: number;
    /** Apply a single outbox event to the downstream store. Throws on failure → retry. */
    apply: (event: OutboxEvent) => Promise<void>;
    /** Optional name to disambiguate multiple outbox tables in one DO. @default "outbox" */
    tableName?: string;
}

export interface OutboxFlush {
    /** Enqueue an event. Synchronous (writes to local SQLite). */
    enqueue(model: string, op: string, payload: unknown): void;
    /** Schedule immediate (waitUntil) and fallback (alarm) drain attempts. */
    flushNow(): Promise<void>;
    /** Drain pending events. Call from your DO's `alarm()`. */
    drain(): Promise<number>;
    /** Pending event count (sent_at IS NULL). */
    pendingCount(): number;
}

export function createOutboxFlush(config: OutboxFlushConfig): OutboxFlush {
    const sql = config.sql;
    const table = config.tableName ?? "outbox";
    const intervalMs = config.intervalMs ?? 3_000;
    const batchSize = config.batchSize ?? 25;
    const runSqlQuery = sql["exec"].bind(sql);

    // Ensure the table exists. CREATE IF NOT EXISTS is cheap and idempotent.
    runSqlQuery(`
    CREATE TABLE IF NOT EXISTS ${table} (
      event_id          TEXT PRIMARY KEY,
      model             TEXT NOT NULL,
      op                TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      next_attempt_at   TEXT,
      sent_at           TEXT
    );
  `);

    function enqueue(model: string, op: string, payload: unknown): void {
        runSqlQuery(
            `INSERT INTO ${table} (event_id, model, op, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            model,
            op,
            JSON.stringify(payload),
            new Date().toISOString()
        );
    }

    async function drain(): Promise<number> {
        const now = new Date().toISOString();
        const rows = runSqlQuery(
            `SELECT event_id, model, op, payload_json, attempts
         FROM ${table}
         WHERE sent_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at LIMIT ?`,
            now,
            batchSize
        ).toArray() as unknown as Array<{
            event_id: string;
            model: string;
            op: string;
            payload_json: string;
            attempts: number;
        }>;

        for (const row of rows) {
            try {
                await config.apply({
                    eventId: row.event_id,
                    model: row.model,
                    op: row.op,
                    payload: JSON.parse(row.payload_json),
                    attempts: row.attempts,
                });
                runSqlQuery(`UPDATE ${table} SET sent_at = ? WHERE event_id = ?`, now, row.event_id);
            } catch (err) {
                const backoffS = Math.min(30, 2 ** Math.min(row.attempts, 6));
                const next = new Date(Date.now() + backoffS * 1000).toISOString();
                runSqlQuery(
                    `UPDATE ${table} SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?`,
                    next,
                    row.event_id
                );
                console.error("outbox drain failed", { eventId: row.event_id, model: row.model, op: row.op, err });
            }
        }

        // GC sent rows older than 1h.
        const gcCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        runSqlQuery(`DELETE FROM ${table} WHERE sent_at IS NOT NULL AND sent_at < ?`, gcCutoff);

        return pendingCount();
    }

    function pendingCount(): number {
        const row = runSqlQuery(`SELECT COUNT(*) AS c FROM ${table} WHERE sent_at IS NULL`).one() as { c: number };
        return row.c;
    }

    async function flushNow(): Promise<void> {
        if (config.waitUntil) {
            config.waitUntil(drain().catch(() => 0));
        }
        const current = await config.storage.getAlarm();
        if (current === null) {
            await config.storage.setAlarm(Date.now() + intervalMs);
        }
    }

    return { enqueue, flushNow, drain, pendingCount };
}
