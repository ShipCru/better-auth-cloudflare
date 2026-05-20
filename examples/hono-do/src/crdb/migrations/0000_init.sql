-- Minimal CockroachDB auth schema for the bench. ONE multi-region cluster
-- with three regions (us-east-2, eu-central-1, ap-southeast-1).
--
-- Apply via `pnpm db:migrate` from examples/hono-do.
--
-- The cluster itself must exist + have the three regions provisioned at
-- the cluster level (CockroachDB Cloud → Cluster Settings → Regions).
-- THIS migration handles the database-level region setup + the schema.

-- ───── 1. Database-level region setup ──────────────────────────────
-- These ALTERs add each region to the `defaultdb` database and create
-- the system-managed `crdb_internal_region` enum. Each statement is
-- guarded by IF NOT EXISTS so re-runs are safe. The first ADD REGION
-- on a fresh database also sets it as primary; subsequent regions are
-- secondary unless promoted.

ALTER DATABASE defaultdb PRIMARY REGION "aws-us-east-2";
ALTER DATABASE defaultdb ADD REGION IF NOT EXISTS "aws-eu-central-1";
ALTER DATABASE defaultdb ADD REGION IF NOT EXISTS "aws-ap-southeast-1";

-- ───── 2. Tables (plain Postgres-flavoured DDL) ────────────────────

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crdb_region     crdb_internal_region NOT NULL
                    DEFAULT default_to_database_primary_region(gateway_region())::crdb_internal_region,
    name            TEXT NOT NULL,
    email           VARCHAR(255) NOT NULL,
    email_verified  BOOL NOT NULL DEFAULT false,
    image           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_email_uniq UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS accounts (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- accounts inherit their parent user's region; set explicitly at INSERT
    -- time. No default — the adapter must provide it.
    crdb_region                 crdb_internal_region NOT NULL,
    user_id                     UUID NOT NULL,
    provider_id                 TEXT NOT NULL,
    account_id                  TEXT NOT NULL,
    password                    TEXT,
    access_token                TEXT,
    refresh_token               TEXT,
    access_token_expires_at     TIMESTAMPTZ,
    refresh_token_expires_at    TIMESTAMPTZ,
    scope                       TEXT,
    id_token                    TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT account_provider_account_idx UNIQUE (provider_id, account_id)
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON accounts(user_id);

-- ───── 2. REGIONAL BY ROW locality ─────────────────────────────────
-- Each row physically lives on the nodes in its `crdb_region`. Same-
-- region reads/writes are local Postgres latency. Cross-region reads
-- transparently fetch from the row's home region.

ALTER TABLE users    SET LOCALITY REGIONAL BY ROW;
ALTER TABLE accounts SET LOCALITY REGIONAL BY ROW;

-- ───── 3. Composite foreign key (region-aware) ─────────────────────
-- REGIONAL BY ROW tables don't auto-add the region to FKs. We add it
-- explicitly so accounts join to their parent user IN THE SAME REGION
-- (no cross-region scatter on the join). ON UPDATE CASCADE lets a
-- region move on the user cascade to the account rows.
--
-- Glass uses the same pattern, see
-- packages/database/AGENTS.md "REGIONAL BY ROW Shape".

ALTER TABLE accounts
    ADD CONSTRAINT accounts_user_id_region_fk
    FOREIGN KEY (user_id, crdb_region)
    REFERENCES users (id, crdb_region)
    ON UPDATE CASCADE
    ON DELETE CASCADE;
