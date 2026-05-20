-- Minimal CockroachDB auth schema for the bench. Run ONCE per cluster
-- per region before deploying the crdb-multi variant.
--
-- Apply via the CRDB Cloud SQL shell or:
--   psql "$DATABASE_URL_US_EAST_2" -f 0000_init.sql
--   psql "$DATABASE_URL_EU_CENTRAL_1" -f 0000_init.sql
--   psql "$DATABASE_URL_AP_SOUTHEAST_1" -f 0000_init.sql
--
-- Each cluster is a SEPARATE multi-region database; the worker picks
-- the right Hyperdrive binding by cf.continent and writes go to that
-- cluster's primary region only. Sharding by jurisdiction, not by
-- replication.
--
-- For a single multi-region cluster (one cluster, 3 region replicas),
-- run this against just that one cluster and use REGIONAL BY ROW with
-- the cluster's primary-region default. Comments at the bottom show
-- how to convert.

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

-- REGIONAL BY ROW conversion (single multi-region cluster only).
-- Uncomment AFTER the database has at least one region configured.
-- The default reads gateway_region() so each row lands in the SQL
-- gateway's primary region at insert time. Cast through the
-- system-managed crdb_internal_region enum.
--
-- ALTER DATABASE defaultdb SET PRIMARY REGION 'us-east-2';
-- ALTER DATABASE defaultdb ADD REGION 'eu-central-1';
-- ALTER DATABASE defaultdb ADD REGION 'ap-southeast-1';
--
-- ALTER TABLE users  ADD COLUMN crdb_region crdb_internal_region
--   NOT NULL
--   DEFAULT default_to_database_primary_region(gateway_region())::crdb_internal_region;
-- ALTER TABLE users  SET LOCALITY REGIONAL BY ROW;
--
-- ALTER TABLE accounts ADD COLUMN crdb_region crdb_internal_region
--   NOT NULL
--   DEFAULT default_to_database_primary_region(gateway_region())::crdb_internal_region;
-- ALTER TABLE accounts SET LOCALITY REGIONAL BY ROW;
