/**
 * SAMPLE: how to build a domain DurableObject that uses the
 * better-auth-cloudflare outbox helper for D1 sync.
 *
 * This file is illustrative — it isn't wired into the demo's wrangler.toml
 * or Worker entry. Copy it as a starting point when you build your own
 * domain DOs (UserDataDO, ResumeDataDO, CommentsDO, etc.).
 *
 * The pattern: every state-changing method writes to local SQLite, then
 * enqueues an event and calls `outbox.flushNow()`. Sync to D1 happens
 * within ~50-200ms via waitUntil, with the 3s alarm as a safety net.
 *
 * Two modes shown:
 *   - profile  → "snapshot" (D1 has current state only, via UPSERT)
 *   - resumes  → "history"  (D1 has every version, via INSERT)
 *
 * For resumes specifically, you store ALL versions so the dashboard can
 * show evolution + lets users restore prior versions.
 */
import { DurableObject } from "cloudflare:workers";
import { createOutboxFlush, type OutboxFlush } from "better-auth-cloudflare";
import type { D1Database } from "@cloudflare/workers-types";

interface UserDataEnv {
    USER_DATA_DB: D1Database;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  principal_id        TEXT PRIMARY KEY,
  display_name        TEXT,
  avatar_url          TEXT,
  locale              TEXT,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  resume_id           TEXT PRIMARY KEY,
  version             INTEGER NOT NULL,
  content_json        TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`;

/** Required matching D1 schema for the dashboard:
 *
 * CREATE TABLE profiles (
 *   principal_id TEXT PRIMARY KEY,
 *   display_name TEXT,
 *   avatar_url   TEXT,
 *   locale       TEXT,
 *   updated_at   TEXT NOT NULL
 * );
 *
 * CREATE TABLE resume_versions (
 *   resume_id    TEXT NOT NULL,
 *   version      INTEGER NOT NULL,
 *   content_json TEXT NOT NULL,
 *   created_at   TEXT NOT NULL,
 *   PRIMARY KEY (resume_id, version)
 * );
 */

export class UserDataDurableObject extends DurableObject<UserDataEnv> {
    private outbox: OutboxFlush;

    constructor(state: DurableObjectState, env: UserDataEnv) {
        super(state, env);
        const runSqlQuery = state.storage.sql["exec"].bind(state.storage.sql);
        runSqlQuery(SCHEMA);

        this.outbox = createOutboxFlush({
            sql: state.storage.sql,
            storage: state.storage,
            waitUntil: p => state.waitUntil(p),
            intervalMs: 3000,
            apply: async ({ model, op, payload }) => {
                const db = env.USER_DATA_DB;
                const p = payload as Record<string, unknown>;

                if (model === "profile" && op === "upsert") {
                    // SNAPSHOT mode — upsert current state.
                    await db
                        .prepare(
                            `INSERT INTO profiles (principal_id, display_name, avatar_url, locale, updated_at)
                                 VALUES (?, ?, ?, ?, ?)
                                 ON CONFLICT(principal_id) DO UPDATE SET
                                   display_name = excluded.display_name,
                                   avatar_url   = excluded.avatar_url,
                                   locale       = excluded.locale,
                                   updated_at   = excluded.updated_at`
                        )
                        .bind(p.principal_id, p.display_name, p.avatar_url, p.locale, p.updated_at)
                        .run();
                    return;
                }

                if (model === "resume" && op === "version") {
                    // HISTORY mode — insert every version as a new row.
                    // Dashboard query: `SELECT * FROM resume_versions WHERE resume_id=? ORDER BY version DESC`
                    await db
                        .prepare(
                            `INSERT INTO resume_versions (resume_id, version, content_json, created_at)
                                 VALUES (?, ?, ?, ?)`
                        )
                        .bind(p.resume_id, p.version, JSON.stringify(p.content), p.updated_at)
                        .run();
                    return;
                }
            },
        });
    }

    // ───── Profile (snapshot mode) ──────────────────────────────────────

    async updateProfile(input: {
        principalId: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        locale?: string | null;
    }): Promise<void> {
        const runSqlQuery = this.ctx.storage.sql["exec"].bind(this.ctx.storage.sql);
        const now = new Date().toISOString();
        runSqlQuery(
            `INSERT INTO profile (principal_id, display_name, avatar_url, locale, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(principal_id) DO UPDATE SET
               display_name = excluded.display_name,
               avatar_url   = excluded.avatar_url,
               locale       = excluded.locale,
               updated_at   = excluded.updated_at`,
            input.principalId,
            input.displayName ?? null,
            input.avatarUrl ?? null,
            input.locale ?? null,
            now
        );
        this.outbox.enqueue("profile", "upsert", {
            principal_id: input.principalId,
            display_name: input.displayName ?? null,
            avatar_url: input.avatarUrl ?? null,
            locale: input.locale ?? null,
            updated_at: now,
        });
        await this.outbox.flushNow();
    }

    // ───── Resume (history mode) ────────────────────────────────────────

    async saveResume(input: { resumeId: string; content: unknown }): Promise<{ version: number }> {
        const runSqlQuery = this.ctx.storage.sql["exec"].bind(this.ctx.storage.sql);
        const now = new Date().toISOString();

        // Get the current version (or 0 if new) and increment.
        const existing = runSqlQuery(
            `SELECT version FROM resumes WHERE resume_id = ?`,
            input.resumeId
        ).toArray() as unknown as Array<{ version: number }> | [];
        const nextVersion = (existing[0]?.version ?? 0) + 1;

        runSqlQuery(
            `INSERT INTO resumes (resume_id, version, content_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(resume_id) DO UPDATE SET
               version      = excluded.version,
               content_json = excluded.content_json,
               updated_at   = excluded.updated_at`,
            input.resumeId,
            nextVersion,
            JSON.stringify(input.content),
            now
        );

        // Enqueue the new version as a HISTORY event — every save creates
        // a row in the D1 dashboard `resume_versions` table.
        this.outbox.enqueue("resume", "version", {
            resume_id: input.resumeId,
            version: nextVersion,
            content: input.content,
            updated_at: now,
        });
        await this.outbox.flushNow();

        return { version: nextVersion };
    }

    // ───── Alarm ────────────────────────────────────────────────────────

    async alarm(): Promise<void> {
        const remaining = await this.outbox.drain();
        if (remaining > 0) {
            await this.ctx.storage.setAlarm(Date.now() + 3000);
        }
    }
}
