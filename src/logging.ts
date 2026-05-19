/**
 * Minimal structured logger for the Cloudflare Workers runtime.
 *
 * Outputs single-line JSON to stdout, which Cloudflare Workers Logs
 * captures and indexes natively. Levels honour `BETTER_AUTH_CF_LOG_LEVEL`
 * (defaults to `info`). PII-bearing values should be hashed by the caller
 * before passing in — this logger does not sanitise.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerConfig {
  level?: LogLevel;
  scope: string;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string, meta?: Record<string, unknown>): Logger;
}

export function createLogger(config: LoggerConfig): Logger {
  const minLevel = LEVEL_ORDER[config.level ?? 'info'];

  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minLevel) return;
    const line = {
      level,
      scope: config.scope,
      msg,
      ts: new Date().toISOString(),
      ...(meta ?? {}),
    };
    const out = JSON.stringify(line);
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child(scope, meta) {
      const childLogger = createLogger({ ...config, scope: `${config.scope}.${scope}` });
      if (!meta) return childLogger;
      return {
        debug: (m, x) => childLogger.debug(m, { ...meta, ...(x ?? {}) }),
        info: (m, x) => childLogger.info(m, { ...meta, ...(x ?? {}) }),
        warn: (m, x) => childLogger.warn(m, { ...meta, ...(x ?? {}) }),
        error: (m, x) => childLogger.error(m, { ...meta, ...(x ?? {}) }),
        child: (s, m) => childLogger.child(s, { ...meta, ...(m ?? {}) }),
      };
    },
  };
}

const encoder = new TextEncoder();

/** Stable SHA-256 hex digest. Use to log identifiers without leaking the raw value. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Compact 12-char prefix of the SHA-256 hex — short enough for logs, long enough to be unique in practice. */
export async function shortHash(input: string): Promise<string> {
  return (await sha256Hex(input)).slice(0, 12);
}
