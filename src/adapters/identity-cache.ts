import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { type Logger } from "../logging";

/**
 * Multi-tier identity index cache: KV (global, eventually consistent)
 * sitting in front of D1 (regional, Sessions-API strongly consistent
 * within a replica group), with the IdentityDurableObject as the
 * authoritative source of truth.
 *
 *   sign-in lookup chain:
 *     1. KV.get(emailHash)             ~5-30ms global
 *     2. D1.first(emailHash)           ~30-80ms regional via Sessions API
 *     3. IdentityDO.lookup(emailHash)  fallback, authoritative
 *
 * Each layer is populated lazily on miss (read-through), and updated
 * eagerly on every authoritative write (write-through).
 *
 * Freshness model: every entry carries a monotonic `version` (assigned
 * by IdentityDO). Readers can detect stale entries by comparing against
 * the DO's current version in a `waitUntil` audit; if drift is detected
 * the cache entry is overwritten on the next access. The user's sign-in
 * still proceeds with the cached value because the UserDO data behind
 * the principal_id is independently fresh.
 *
 * NOTE: this cache is for the email→principal_id mapping ONLY. Never
 * cache password hashes here — those stay in the UserDO and are fetched
 * fresh on every signin to support immediate password rotation.
 */

export const IDENTITY_INDEX_D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_index (
  email_hash    TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

export interface IdentityIndexEntry {
    principalId: string;
    version: number;
}

export interface IdentityIndexCache {
    /** Read in cache-chain order. Returns null if not present in any layer. */
    get(emailHash: string): Promise<IdentityIndexEntry | null>;
    /** Write-through to KV + D1 (when bound). */
    upsert(emailHash: string, entry: IdentityIndexEntry): Promise<void>;
    /** Invalidate (on identity disable / email change). */
    invalidate(emailHash: string): Promise<void>;
}

/**
 * Build a cache instance bound to a Worker invocation. KV is required;
 * D1 is optional (when absent, the chain is just KV → IdentityDO).
 */
export function createIdentityIndexCache(opts: { kv: KVNamespace; d1?: D1Database; log?: Logger }): IdentityIndexCache {
    const KV_PREFIX = "identity:";
    const KV_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days; immutable mappings can live forever

    return {
        async get(emailHash) {
            const kvKey = KV_PREFIX + emailHash;
            try {
                const cached = await opts.kv.get(kvKey, "json");
                if (cached && typeof cached === "object" && "principalId" in (cached as object)) {
                    return cached as IdentityIndexEntry;
                }
            } catch (err) {
                opts.log?.warn("identity-cache.kv.get failed", { err: (err as Error)?.message });
            }

            if (opts.d1) {
                try {
                    // D1 Sessions API: db.withSession({constraint}) opts into
                    // global read replicas with bookmark-based consistency.
                    // "first-unconstrained" picks the nearest replica without
                    // requiring sequential consistency vs a prior write — best
                    // for identity-index reads since the data is effectively
                    // immutable per binding.
                    const sess =
                        typeof (opts.d1 as { withSession?: unknown }).withSession === "function"
                            ? (opts.d1 as { withSession: (c?: string) => D1Database }).withSession(
                                  "first-unconstrained"
                              )
                            : opts.d1;
                    const row = (await sess
                        .prepare(`SELECT principal_id, version FROM identity_index WHERE email_hash = ?`)
                        .bind(emailHash)
                        .first()) as { principal_id: string; version: number } | null;
                    if (row) {
                        const entry = { principalId: String(row.principal_id), version: Number(row.version) };
                        // Backfill KV. Non-blocking — caller continues with the value we already have.
                        opts.kv
                            .put(kvKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS })
                            .catch(err =>
                                opts.log?.warn("identity-cache.kv.backfill failed", { err: (err as Error)?.message })
                            );
                        return entry;
                    }
                } catch (err) {
                    opts.log?.warn("identity-cache.d1.get failed", { err: (err as Error)?.message });
                }
            }

            return null;
        },

        async upsert(emailHash, entry) {
            const kvKey = KV_PREFIX + emailHash;
            const payload = JSON.stringify(entry);
            // Fire writes in parallel — both layers are independent and we
            // accept that the second can lag the first under partial failure.
            const writes: Promise<unknown>[] = [
                opts.kv.put(kvKey, payload, { expirationTtl: KV_TTL_SECONDS }).catch(err => {
                    opts.log?.warn("identity-cache.kv.put failed", { err: (err as Error)?.message });
                }),
            ];
            if (opts.d1) {
                writes.push(
                    opts.d1
                        .prepare(
                            `INSERT INTO identity_index (email_hash, principal_id, version, updated_at)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(email_hash) DO UPDATE SET
                               principal_id = excluded.principal_id,
                               version = excluded.version,
                               updated_at = excluded.updated_at`
                        )
                        .bind(emailHash, entry.principalId, entry.version, new Date().toISOString())
                        .run()
                        .catch(err => opts.log?.warn("identity-cache.d1.put failed", { err: (err as Error)?.message }))
                );
            }
            await Promise.all(writes);
        },

        async invalidate(emailHash) {
            const kvKey = KV_PREFIX + emailHash;
            const writes: Promise<unknown>[] = [
                opts.kv.delete(kvKey).catch(err => {
                    opts.log?.warn("identity-cache.kv.delete failed", { err: (err as Error)?.message });
                }),
            ];
            if (opts.d1) {
                writes.push(
                    opts.d1
                        .prepare(`DELETE FROM identity_index WHERE email_hash = ?`)
                        .bind(emailHash)
                        .run()
                        .catch(err =>
                            opts.log?.warn("identity-cache.d1.delete failed", { err: (err as Error)?.message })
                        )
                );
            }
            await Promise.all(writes);
        },
    };
}
