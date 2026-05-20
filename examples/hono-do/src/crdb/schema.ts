/**
 * Minimal CockroachDB auth schema. Adapted from
 * packages/database/modules/drizzle/auth/schema.ts in the glass repo
 * but stripped down to ONLY what Better Auth requires:
 *
 *   - users     (BA required fields only — no Stripe/Zendesk/legacy IDs)
 *   - accounts  (password hash + OAuth tokens)
 *
 * No `verifications` (forget-password flow not in the bench scope yet).
 * No `sessions` (we run stateless — the signed cookie IS the session).
 *
 * Multi-region: the `crdb_region` column + `REGIONAL BY ROW` locality
 * is added by SQL migration *after* the table is created. Drizzle
 * doesn't model `LOCALITY` directly — that's a CRDB DDL extension
 * applied via raw SQL in `migrations/0001_regional_by_row.sql`.
 *
 * Drizzle 1.0.0-rc.3 cockroach-core preserved column names exactly as
 * in glass so a future migration from one to the other doesn't require
 * a rename pass.
 */
import {
    cockroachTable,
    varchar,
    text,
    boolean,
    uuid,
    index,
    uniqueIndex,
    timestamp,
} from "drizzle-orm/cockroach-core";

/**
 * Users table. The bench's signup writes here.
 *
 * REGIONAL BY ROW: each row is physically stored in the home region of
 * the user (set by the `crdb_region` column at insert via a CRDB
 * `default_to_database_primary_region(gateway_region())` cast). Cross-
 * region queries are transparent; same-region queries are local and
 * fast (no inter-region RTT).
 */
export const users = cockroachTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        // BA-required fields
        name: text("name").notNull(),
        email: varchar("email", { length: 255 }).notNull().unique(),
        emailVerified: boolean("email_verified").notNull().default(false),
        image: text("image"),

        // Timestamps (BA reads these for sorting / token validity calcs)
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    table => [
        // BA-required: email lookup on signin. CRDB's REGIONAL BY ROW
        // auto-partitions the index by `crdb_region`, so same-region
        // lookups don't cross regions. Cross-region lookups are still
        // correct; just slower. UNIQUE is enforced globally.
        uniqueIndex("user_email_uniq").on(table.email),
    ]
);

/**
 * Accounts table. Holds the password hash (email/password auth) or
 * OAuth tokens (Google etc.). One user can have multiple accounts
 * (e.g., email + Google linked to the same user).
 */
export const accounts = cockroachTable(
    "accounts",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        userId: uuid("user_id").notNull(),

        providerId: text("provider_id").notNull(),
        accountId: text("account_id").notNull(),

        // Email/password auth — BA stores the PBKDF2/scrypt hash here.
        password: text("password"),

        // OAuth providers — null for email/password accounts.
        accessToken: text("access_token"),
        refreshToken: text("refresh_token"),
        accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
        refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
        scope: text("scope"),
        idToken: text("id_token"),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    table => [
        // BA signin loads accounts by user. With REGIONAL BY ROW, this
        // is a single-region index scan.
        index("account_user_id_idx").on(table.userId),
        // BA upsert path for OAuth: find by (provider, accountId).
        // UNIQUE is global so the same Google sub can't link to two users.
        uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
    ]
);

export type UserRow = typeof users.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
