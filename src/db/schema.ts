/**
 * Drizzle schema for the D1 auth data store.
 *
 * Mirrors what the UserDurableObject syncs downstream via the outbox.
 * Consumers can import these tables to compose with their own Drizzle
 * setup or generate migrations:
 *
 * ```ts
 * import { users, accounts } from "better-auth-cloudflare/db/schema";
 *
 * // Use in your own Drizzle queries:
 * const recentUsers = await db.select().from(users)
 *   .where(isNull(users.deletedAt))
 *   .orderBy(desc(users.createdAt))
 *   .limit(50);
 * ```
 *
 * For migrations: point drizzle-kit at this file, generate the SQL, apply
 * via `wrangler d1 execute`. The plain-SQL form is also exported as
 * `AUTH_DATA_D1_SCHEMA` for one-shot setup without drizzle-kit.
 *
 * Password hash deliberately not included — see auth-data.ts for why.
 */
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
    "users",
    {
        id: text("id").primaryKey(),
        name: text("name"),
        email: text("email"),
        emailVerified: integer("email_verified").notNull().default(0),
        image: text("image"),
        isAnonymous: integer("is_anonymous").notNull().default(0),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
        deletedAt: text("deleted_at"),
    },
    table => ({
        emailUnique: uniqueIndex("users_email_unique").on(table.email),
    })
);

export const accounts = sqliteTable(
    "accounts",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull(),
        providerId: text("provider_id").notNull(),
        accountId: text("account_id"),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    table => ({
        providerAccountUnique: uniqueIndex("accounts_provider_account_unique").on(table.providerId, table.accountId),
        userIdx: index("accounts_user_idx").on(table.userId),
    })
);

export const schema = { users, accounts };
