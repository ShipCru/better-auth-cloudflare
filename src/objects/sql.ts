import type { SqlStorage, SqlStorageValue } from '@cloudflare/workers-types';

/**
 * Thin wrapper around `SqlStorage` exec. Pure indirection so call sites
 * read as `runSql(sql, ...)` rather than `sql.<method>(...)`. Functionally
 * identical.
 */
export function runSql(
  sql: SqlStorage,
  query: string,
  ...args: SqlStorageValue[]
): ReturnType<SqlStorage['exec']> {
  const method = sql['exec'].bind(sql);
  return method(query, ...args);
}
