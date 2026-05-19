import { DurableObject } from 'cloudflare:workers';
import { runSql } from './sql';

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
`;

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
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    runSql(this.ctx.storage.sql, USER_DO_SCHEMA);
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
      input.extra ? JSON.stringify(input.extra) : null,
    );
    return this.findPrincipalOrThrow();
  }

  async findPrincipal(): Promise<PrincipalRecord | null> {
    const row = runSql(this.ctx.storage.sql, `SELECT * FROM principal LIMIT 1`).toArray()[0] as RawPrincipal | undefined;
    return row ? toPrincipal(row) : null;
  }

  async updatePrincipal(patch: Partial<Omit<PrincipalRecord, 'id' | 'createdAt'>>): Promise<PrincipalRecord> {
    const now = new Date().toISOString();
    const set: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [now];

    if ('name' in patch) { set.push('name = ?'); args.push(patch.name ?? null); }
    if ('email' in patch) { set.push('email = ?'); args.push(patch.email ?? null); }
    if ('emailVerified' in patch) { set.push('email_verified = ?'); args.push(patch.emailVerified ? 1 : 0); }
    if ('image' in patch) { set.push('image = ?'); args.push(patch.image ?? null); }
    if ('isAnonymous' in patch) { set.push('is_anonymous = ?'); args.push(patch.isAnonymous ? 1 : 0); }
    if ('extra' in patch) { set.push('extra_json = ?'); args.push(patch.extra ? JSON.stringify(patch.extra) : null); }

    runSql(this.ctx.storage.sql, `UPDATE principal SET ${set.join(', ')}`, ...args);
    return this.findPrincipalOrThrow();
  }

  async deletePrincipal(): Promise<void> {
    runSql(this.ctx.storage.sql, `DELETE FROM accounts`);
    runSql(this.ctx.storage.sql, `DELETE FROM principal`);
  }

  // ───── Accounts ──────────────────────────────────────────────────────

  async createAccount(input: Omit<AccountRecord, 'userId' | 'createdAt' | 'updatedAt'> & { userId: string }): Promise<AccountRecord> {
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
      now,
    );
    return this.findAccountByIdOrThrow(input.id, input.userId);
  }

  async findAccountById(id: string, userId: string): Promise<AccountRecord | null> {
    const row = runSql(this.ctx.storage.sql, `SELECT * FROM accounts WHERE id = ? LIMIT 1`, id).toArray()[0] as
      | RawAccount
      | undefined;
    return row ? toAccount(row, userId) : null;
  }

  async findAccountByProvider(providerId: string, accountId: string, userId: string): Promise<AccountRecord | null> {
    const row = runSql(
      this.ctx.storage.sql,
      `SELECT * FROM accounts WHERE provider_id = ? AND account_id = ? LIMIT 1`,
      providerId,
      accountId,
    ).toArray()[0] as RawAccount | undefined;
    return row ? toAccount(row, userId) : null;
  }

  async listAccounts(userId: string): Promise<AccountRecord[]> {
    const rows = runSql(this.ctx.storage.sql, `SELECT * FROM accounts ORDER BY created_at`).toArray() as RawAccount[];
    return rows.map((r) => toAccount(r, userId));
  }

  async updateAccount(id: string, patch: Partial<AccountRecord>, userId: string): Promise<AccountRecord | null> {
    const now = new Date().toISOString();
    const set: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [now];

    const allowed: Array<keyof AccountRecord> = [
      'password',
      'accessToken',
      'refreshToken',
      'idToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
      'scope',
    ];
    for (const k of allowed) {
      if (k in patch) {
        set.push(`${camelToSnake(k)} = ?`);
        args.push((patch[k] as string | null | undefined) ?? null);
      }
    }
    if (set.length === 1) return this.findAccountById(id, userId);

    args.push(id);
    runSql(this.ctx.storage.sql, `UPDATE accounts SET ${set.join(', ')} WHERE id = ?`, ...args);
    return this.findAccountById(id, userId);
  }

  async deleteAccount(id: string): Promise<void> {
    runSql(this.ctx.storage.sql, `DELETE FROM accounts WHERE id = ?`, id);
  }

  // ───── Internal ──────────────────────────────────────────────────────

  private findPrincipalOrThrow(): PrincipalRecord {
    const row = runSql(this.ctx.storage.sql, `SELECT * FROM principal LIMIT 1`).toArray()[0] as RawPrincipal | undefined;
    if (!row) throw new Error('UserDurableObject: principal row missing');
    return toPrincipal(row);
  }

  private findAccountByIdOrThrow(id: string, userId: string): AccountRecord {
    const row = runSql(this.ctx.storage.sql, `SELECT * FROM accounts WHERE id = ?`, id).toArray()[0] as
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
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}
