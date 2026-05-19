import { DurableObject } from "cloudflare:workers";
import { runSql } from "./sql";
import { createLogger, timed, type Logger, type LogLevel } from "../logging";

/**
 * Per-principal Durable Object owning the BA `user` and `account` models.
 *
 * One DO per principal_id. The DO is keyed by principal_id (stable, opaque)
 * and addressed via the `USER_DO` namespace binding configured in
 * `wrangler.toml`. The owning Worker must re-export this class:
 *
 * ```ts
 * export { UserDurableObject } from 'better-auth-cloudflare';
 * ```
 *
 * Sessions are handled by Better Auth's `secondaryStorage` (typically
 * KV), not by this DO. That choice keeps the adapter narrow and lets
 * BA's standard session machinery work unchanged.
 */
export const USER_DO_SCHEMA = `
CREATE TABLE IF NOT EXISTS principal (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  email               TEXT,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  image               TEXT,
  is_anonymous        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  extra_json          TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id                       TEXT PRIMARY KEY,
  provider_id              TEXT NOT NULL,
  account_id               TEXT NOT NULL,
  password                 TEXT,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  TEXT,
  refresh_token_expires_at TEXT,
  scope                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
);

-- Recovery outbox. Every write to principal/accounts enqueues an event.
-- The DO's alarm (every ~3s) drains pending events to the configured
-- D1 auth data binding (env.AUTH_DB by convention). Eventually
-- consistent with a bounded lag (~3-6s under healthy D1, more on retry).
CREATE TABLE IF NOT EXISTS auth_outbox (
  event_id            TEXT PRIMARY KEY,
  model               TEXT NOT NULL,
  op                  TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  payload_json        TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  next_attempt_at     TEXT,
  sent_at             TEXT
);
`;

const AUTH_FLUSH_INTERVAL_MS = 3_000;
const AUTH_FLUSH_BATCH_SIZE = 25;
const AUTH_FLUSH_BACKOFF_CAP_S = 30;

export interface PrincipalRecord {
    id: string;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    image: string | null;
    isAnonymous: boolean;
    createdAt: string;
    updatedAt: string;
    extra?: Record<string, unknown>;
}

export interface AccountRecord {
    id: string;
    userId: string;
    providerId: string;
    accountId: string;
    password: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    scope: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface UserDurableObjectEnv {
    [key: string]: unknown;
}

export class UserDurableObject<Env extends UserDurableObjectEnv = UserDurableObjectEnv> extends DurableObject<Env> {
    private readonly log: Logger;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        // Log level is read from LOG_LEVEL on the DO's env (set in
        // wrangler.toml [vars]). Defaults to "info" — emit per-method
        // timing so we can see what dominates on the hot path.
        const level = ((env as { LOG_LEVEL?: string }).LOG_LEVEL ?? "info") as LogLevel;
        this.log = createLogger({ scope: "user-do", level }).child("rpc", { doId: state.id.toString() });
        // Schema setup must serialise across concurrent first-requests so
        // two RPCs hitting a cold DO don't race on CREATE TABLE / IF NOT
        // EXISTS. blockConcurrencyWhile is the documented pattern.
        // See https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
        state.blockConcurrencyWhile(async () => {
            const t0 = Date.now();
            runSql(state.storage.sql, USER_DO_SCHEMA);
            this.log.info("schema_ready", { durationMs: Date.now() - t0 });
        });
    }

    // ───── Principal ─────────────────────────────────────────────────────

    async createPrincipal(input: {
        id: string;
        name?: string | null;
        email?: string | null;
        emailVerified?: boolean;
        image?: string | null;
        isAnonymous?: boolean;
        extra?: Record<string, unknown>;
    }): Promise<PrincipalRecord> {
        return timed(
            this.log,
            "createPrincipal",
            async () => {
                const now = new Date().toISOString();
                runSql(
                    this.ctx.storage.sql,
                    `INSERT INTO principal (id, name, email, email_verified, image, is_anonymous, created_at, updated_at, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    input.id,
                    input.name ?? null,
                    input.email ?? null,
                    input.emailVerified ? 1 : 0,
                    input.image ?? null,
                    input.isAnonymous ? 1 : 0,
                    now,
                    now,
                    input.extra ? JSON.stringify(input.extra) : null
                );
                const principal = this.findPrincipalOrThrow();
                if (!principal.isAnonymous) {
                    this.enqueueAuthEvent("user", "upsert", principal);
                    await this.scheduleAuthFlush();
                }
                return principal;
            },
            { isAnonymous: input.isAnonymous === true }
        );
    }

    async findPrincipal(): Promise<PrincipalRecord | null> {
        return timed(this.log, "findPrincipal", async () => {
            const row = runSql(this.ctx.storage.sql, `SELECT * FROM principal LIMIT 1`).toArray()[0] as unknown as
                | RawPrincipal
                | undefined;
            return row ? toPrincipal(row) : null;
        });
    }

    async updatePrincipal(patch: Partial<Omit<PrincipalRecord, "id" | "createdAt">>): Promise<PrincipalRecord> {
        return timed(this.log, "updatePrincipal", async () => {
            const now = new Date().toISOString();
            const set: string[] = ["updated_at = ?"];
            const args: (string | number | null)[] = [now];

            if ("name" in patch) {
                set.push("name = ?");
                args.push(patch.name ?? null);
            }
            if ("email" in patch) {
                set.push("email = ?");
                args.push(patch.email ?? null);
            }
            if ("emailVerified" in patch) {
                set.push("email_verified = ?");
                args.push(patch.emailVerified ? 1 : 0);
            }
            if ("image" in patch) {
                set.push("image = ?");
                args.push(patch.image ?? null);
            }
            if ("isAnonymous" in patch) {
                set.push("is_anonymous = ?");
                args.push(patch.isAnonymous ? 1 : 0);
            }
            if ("extra" in patch) {
                set.push("extra_json = ?");
                args.push(patch.extra ? JSON.stringify(patch.extra) : null);
            }

            runSql(this.ctx.storage.sql, `UPDATE principal SET ${set.join(", ")}`, ...args);
            const principal = this.findPrincipalOrThrow();
            if (!principal.isAnonymous) {
                this.enqueueAuthEvent("user", "upsert", principal);
                await this.scheduleAuthFlush();
            }
            return principal;
        });
    }

    async deletePrincipal(): Promise<void> {
        return timed(this.log, "deletePrincipal", async () => {
            const before = await this.findPrincipal();
            runSql(this.ctx.storage.sql, `DELETE FROM accounts`);
            runSql(this.ctx.storage.sql, `DELETE FROM principal`);
            if (before && !before.isAnonymous) {
                this.enqueueAuthEvent("user", "delete", { id: before.id });
                await this.scheduleAuthFlush();
            }
        });
    }

    // ───── Accounts ──────────────────────────────────────────────────────

    async createAccount(
        input: Omit<AccountRecord, "userId" | "createdAt" | "updatedAt"> & { userId: string }
    ): Promise<AccountRecord> {
        return timed(
            this.log,
            "createAccount",
            async () => {
                const now = new Date().toISOString();
                runSql(
                    this.ctx.storage.sql,
                    `INSERT INTO accounts
         (id, provider_id, account_id, password, access_token, refresh_token, id_token,
          access_token_expires_at, refresh_token_expires_at, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    input.id,
                    input.providerId,
                    input.accountId,
                    input.password ?? null,
                    input.accessToken ?? null,
                    input.refreshToken ?? null,
                    input.idToken ?? null,
                    input.accessTokenExpiresAt ?? null,
                    input.refreshTokenExpiresAt ?? null,
                    input.scope ?? null,
                    now,
                    now
                );
                const account = this.findAccountByIdOrThrow(input.id, input.userId);
                this.enqueueAuthEvent("account", "upsert", account);
                await this.scheduleAuthFlush();
                return account;
            },
            { providerId: input.providerId, hasPassword: input.password != null }
        );
    }

    async findAccountById(id: string, userId: string): Promise<AccountRecord | null> {
        return timed(this.log, "findAccountById", async () => {
            const row = runSql(
                this.ctx.storage.sql,
                `SELECT * FROM accounts WHERE id = ? LIMIT 1`,
                id
            ).toArray()[0] as unknown as RawAccount | undefined;
            return row ? toAccount(row, userId) : null;
        });
    }

    async findAccountByProvider(providerId: string, accountId: string, userId: string): Promise<AccountRecord | null> {
        return timed(
            this.log,
            "findAccountByProvider",
            async () => {
                const row = runSql(
                    this.ctx.storage.sql,
                    `SELECT * FROM accounts WHERE provider_id = ? AND account_id = ? LIMIT 1`,
                    providerId,
                    accountId
                ).toArray()[0] as unknown as RawAccount | undefined;
                return row ? toAccount(row, userId) : null;
            },
            { providerId }
        );
    }

    async listAccounts(userId: string): Promise<AccountRecord[]> {
        return timed(this.log, "listAccounts", async () => {
            const rows = runSql(
                this.ctx.storage.sql,
                `SELECT * FROM accounts ORDER BY created_at`
            ).toArray() as unknown as RawAccount[];
            return rows.map(r => toAccount(r, userId));
        });
    }

    async updateAccount(id: string, patch: Partial<AccountRecord>, userId: string): Promise<AccountRecord | null> {
        return timed(this.log, "updateAccount", async () => {
            const now = new Date().toISOString();
            const set: string[] = ["updated_at = ?"];
            const args: (string | null)[] = [now];

            const allowed: Array<keyof AccountRecord> = [
                "password",
                "accessToken",
                "refreshToken",
                "idToken",
                "accessTokenExpiresAt",
                "refreshTokenExpiresAt",
                "scope",
            ];
            for (const k of allowed) {
                if (k in patch) {
                    set.push(`${camelToSnake(k)} = ?`);
                    args.push((patch[k] as string | null | undefined) ?? null);
                }
            }
            if (set.length === 1) return this.findAccountById(id, userId);

            args.push(id);
            runSql(this.ctx.storage.sql, `UPDATE accounts SET ${set.join(", ")} WHERE id = ?`, ...args);
            const account = await this.findAccountById(id, userId);
            if (account) {
                this.enqueueAuthEvent("account", "upsert", account);
                await this.scheduleAuthFlush();
            }
            return account;
        });
    }

    async deleteAccount(id: string): Promise<void> {
        return timed(this.log, "deleteAccount", async () => {
            runSql(this.ctx.storage.sql, `DELETE FROM accounts WHERE id = ?`, id);
            this.enqueueAuthEvent("account", "delete", { id });
            await this.scheduleAuthFlush();
        });
    }

    // ───── Recovery outbox + alarm ───────────────────────────────────────
    //
    // Every state-changing operation enqueues a recovery event. A 3s alarm
    // drains the outbox to env.AUTH_DB (if bound) so the recovery
    // store stays eventually consistent within ~3-6s under healthy D1.
    // The auth hot path NEVER waits on the recovery flush — these methods
    // return as soon as the local DO write succeeds.

    private enqueueAuthEvent(model: "user" | "account", op: "upsert" | "delete", payload: unknown): void {
        runSql(
            this.ctx.storage.sql,
            `INSERT INTO auth_outbox (event_id, model, op, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            model,
            op,
            JSON.stringify(payload),
            new Date().toISOString()
        );
    }

    /**
     * After each enqueue, this method:
     *   1. Immediately attempts to drain via `ctx.waitUntil(drain())` so the
     *      DB sync happens in the ~50-200ms after the response is returned
     *      (not 3s later via alarm).
     *   2. Also schedules the alarm as a safety net — if waitUntil fails
     *      (DO restarted, D1 outage, etc.), the alarm catches it and retries.
     */
    private async scheduleAuthFlush(): Promise<void> {
        // Immediate attempt — runs after the response is sent.
        this.ctx.waitUntil(this.drainAuthOutbox().catch(() => 0));
        // Alarm fallback — only set if not already scheduled.
        const current = await this.ctx.storage.getAlarm();
        if (current === null) {
            await this.ctx.storage.setAlarm(Date.now() + AUTH_FLUSH_INTERVAL_MS);
        }
    }

    async alarm(): Promise<void> {
        // CF docs: alarms that throw block reschedule logic — wrap the
        // drain so a transient D1 outage doesn't lose the alarm. The drain
        // itself catches per-event failures and re-queues with backoff;
        // this is the second layer of defense for catastrophic failures.
        let remaining = 0;
        const t0 = Date.now();
        try {
            remaining = await this.drainAuthOutbox();
            this.log.info("alarm_drain", { durationMs: Date.now() - t0, remaining, status: "ok" });
        } catch (err) {
            this.log.error("alarm_drain", {
                durationMs: Date.now() - t0,
                status: "error",
                error: (err as Error)?.message?.slice(0, 200) ?? "unknown",
            });
            // Still reschedule so the next alarm retries.
            remaining = 1;
        }
        if (remaining > 0) {
            await this.ctx.storage.setAlarm(Date.now() + AUTH_FLUSH_INTERVAL_MS);
        }
    }

    /**
     * Drains pending auth_outbox rows to env.AUTH_DB. Returns
     * the number of rows still pending after the drain (so caller can
     * decide whether to reschedule the alarm).
     */
    private async drainAuthOutbox(): Promise<number> {
        const db = (this.env as { AUTH_DB?: import("@cloudflare/workers-types").D1Database }).AUTH_DB;
        if (!db) {
            // No auth data binding — clear pending rows so they don't accumulate.
            runSql(this.ctx.storage.sql, `DELETE FROM auth_outbox WHERE sent_at IS NULL`);
            return 0;
        }

        const now = new Date().toISOString();
        const pending = runSql(
            this.ctx.storage.sql,
            `SELECT event_id, model, op, payload_json, attempts
         FROM auth_outbox
         WHERE sent_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at
         LIMIT ?`,
            now,
            AUTH_FLUSH_BATCH_SIZE
        ).toArray() as unknown as Array<{
            event_id: string;
            model: string;
            op: "upsert" | "delete";
            payload_json: string;
            attempts: number;
        }>;

        for (const row of pending) {
            try {
                await this.applyRecoveryEvent(db, row.model, row.op, JSON.parse(row.payload_json));
                runSql(
                    this.ctx.storage.sql,
                    `UPDATE auth_outbox SET sent_at = ? WHERE event_id = ?`,
                    now,
                    row.event_id
                );
            } catch (err) {
                const backoff = Math.min(AUTH_FLUSH_BACKOFF_CAP_S, 2 ** Math.min(row.attempts, 6));
                const next = new Date(Date.now() + backoff * 1000).toISOString();
                runSql(
                    this.ctx.storage.sql,
                    `UPDATE auth_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?`,
                    next,
                    row.event_id
                );
                console.error("recovery drain failed", { eventId: row.event_id, model: row.model, op: row.op, err });
            }
        }

        // GC sent rows older than 1 hour so the outbox doesn't grow unbounded.
        const gcCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        runSql(this.ctx.storage.sql, `DELETE FROM auth_outbox WHERE sent_at IS NOT NULL AND sent_at < ?`, gcCutoff);

        const remaining = runSql(
            this.ctx.storage.sql,
            `SELECT COUNT(*) AS c FROM auth_outbox WHERE sent_at IS NULL`
        ).one() as { c: number };
        return remaining.c;
    }

    private async applyRecoveryEvent(
        db: import("@cloudflare/workers-types").D1Database,
        model: string,
        op: "upsert" | "delete",
        payload: Record<string, unknown>
    ): Promise<void> {
        if (model === "user") {
            if (op === "upsert") {
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
                        payload.id,
                        payload.name ?? null,
                        payload.email ?? null,
                        payload.emailVerified ? 1 : 0,
                        payload.image ?? null,
                        payload.isAnonymous ? 1 : 0,
                        payload.createdAt,
                        payload.updatedAt
                    )
                    .run();
                return;
            }
            if (op === "delete") {
                const now = new Date().toISOString();
                await db
                    .prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`)
                    .bind(now, now, payload.id)
                    .run();
                return;
            }
        }
        if (model === "account") {
            if (op === "upsert") {
                await db
                    .prepare(
                        `INSERT INTO accounts (id, user_id, provider_id, account_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
                    )
                    .bind(
                        payload.id,
                        payload.userId,
                        payload.providerId,
                        payload.accountId ?? null,
                        payload.createdAt,
                        payload.updatedAt
                    )
                    .run();
                return;
            }
            if (op === "delete") {
                await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(payload.id).run();
                return;
            }
        }
        throw new Error(`UserDurableObject.applyRecoveryEvent: unhandled (${model}, ${op})`);
    }

    // ───── Internal ──────────────────────────────────────────────────────

    private findPrincipalOrThrow(): PrincipalRecord {
        const row = runSql(this.ctx.storage.sql, `SELECT * FROM principal LIMIT 1`).toArray()[0] as unknown as
            | RawPrincipal
            | undefined;
        if (!row) throw new Error("UserDurableObject: principal row missing");
        return toPrincipal(row);
    }

    private findAccountByIdOrThrow(id: string, userId: string): AccountRecord {
        const row = runSql(this.ctx.storage.sql, `SELECT * FROM accounts WHERE id = ?`, id).toArray()[0] as unknown as
            | RawAccount
            | undefined;
        if (!row) throw new Error(`UserDurableObject: account ${id} missing`);
        return toAccount(row, userId);
    }
}

// ───── helpers ─────────────────────────────────────────────────────────

interface RawPrincipal {
    id: string;
    name: string | null;
    email: string | null;
    email_verified: number;
    image: string | null;
    is_anonymous: number;
    created_at: string;
    updated_at: string;
    extra_json: string | null;
}

interface RawAccount {
    id: string;
    provider_id: string;
    account_id: string;
    password: string | null;
    access_token: string | null;
    refresh_token: string | null;
    id_token: string | null;
    access_token_expires_at: string | null;
    refresh_token_expires_at: string | null;
    scope: string | null;
    created_at: string;
    updated_at: string;
}

function toPrincipal(r: RawPrincipal): PrincipalRecord {
    return {
        id: r.id,
        name: r.name,
        email: r.email,
        emailVerified: r.email_verified === 1,
        image: r.image,
        isAnonymous: r.is_anonymous === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        extra: r.extra_json ? (JSON.parse(r.extra_json) as Record<string, unknown>) : undefined,
    };
}

function toAccount(r: RawAccount, userId: string): AccountRecord {
    return {
        id: r.id,
        userId,
        providerId: r.provider_id,
        accountId: r.account_id,
        password: r.password,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        idToken: r.id_token,
        accessTokenExpiresAt: r.access_token_expires_at,
        refreshTokenExpiresAt: r.refresh_token_expires_at,
        scope: r.scope,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function camelToSnake(s: string): string {
    return s.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
}
