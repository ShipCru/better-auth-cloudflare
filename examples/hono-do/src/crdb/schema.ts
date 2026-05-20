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
 * Single multi-region cluster: each table includes `crdb_region` and is
 * set to `LOCALITY REGIONAL BY ROW` via the migration SQL. The default
 * for `crdb_region` is `default_to_database_primary_region(gateway_region())`
 * cast to `crdb_internal_region` — at insert time, the row lands in the
 * region of the SQL gateway it hit, which (because Hyperdrive is also
 * region-aware) matches the user's edge.
 *
 * REGIONAL BY ROW means same-region reads + writes are local Postgres
 * latency (~5-20 ms). Cross-region reads transparently fetch from the
 * row's home region (slower, ~80-200 ms).
 *
 * Drizzle 1.0.0-rc.3 cockroach-core preserved column names exactly as
 * in glass so future migrations don't need a rename pass.
 */
import { sql } from "drizzle-orm";
import {
    cockroachTable,
    cockroachEnum,
    varchar,
    text,
    boolean,
    uuid,
    index,
    uniqueIndex,
    timestamp,
} from "drizzle-orm/cockroach-core";

/**
 * `crdb_internal_region` is a system-managed enum — CRDB creates it
 * automatically when you `ALTER DATABASE ... ADD REGION 'X'`. We
 * declare it here only so Drizzle has a TS type for the column;
 * drizzle-kit shouldn't generate a CREATE TYPE for it (the enum is
 * owned by the database, not the application). Glass uses the same
 * pattern in `packages/database/modules/drizzle/crdbRegion.ts`.
 *
 * Values must match the regions configured on the live cluster.
 */
export const crdbInternalRegion = cockroachEnum("crdb_internal_region", [
    "aws-us-east-2",
    "aws-eu-central-1",
    "aws-ap-southeast-1",
]);

/**
 * `default_to_database_primary_region(gateway_region())` — the
 * CockroachDB-native expression that picks the SQL gateway's home
 * region (or falls back to the database's primary region if the
 * gateway region isn't a configured database region). Cast through
 * the system-managed enum so Drizzle generates the right DDL.
 *
 * Glass uses the same expression in
 * `packages/database/modules/drizzle/gatewayRegionHome.ts`.
 */
const closestCrdbRegionFromGatewaySql = sql`default_to_database_primary_region(gateway_region())::crdb_internal_region`;

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

        // REGIONAL BY ROW partition column. Default = SQL gateway's region.
        // Each row physically lives in this region's nodes; cross-region
        // reads are transparent but slower.
        crdbRegion: crdbInternalRegion("crdb_region").notNull().default(closestCrdbRegionFromGatewaySql),

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

        // Inherits from the parent user's region — set explicitly in
        // the adapter at insert time, NOT defaulted from gateway_region
        // (an account row must live in the same region as its parent
        // user, even if the OAuth callback hits a different SQL gateway).
        crdbRegion: crdbInternalRegion("crdb_region").notNull(),

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
