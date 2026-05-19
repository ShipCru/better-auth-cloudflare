/**
 * Helpers for safely consuming optional Cloudflare bindings.
 *
 * Production safety rule: a worker should boot even when optional bindings
 * (AUTH_DB, AUTH_ANALYTICS, GOOGLE_CLIENT_ID, …) are unset. Missing-binding
 * errors at runtime are far worse than a warning log at boot.
 *
 * Pattern:
 *
 * ```ts
 * import { optionalBinding } from "better-auth-cloudflare";
 *
 * const db = optionalBinding(env.AUTH_DB, "AUTH_DB", "auth data sync");
 * if (db) { ... }
 * ```
 *
 * The first time `optionalBinding` is called for a given name with a missing
 * value, it logs a single warning. Subsequent calls are silent — this keeps
 * the logs clean while still telling operators what feature degraded.
 */

const warned = new Set<string>();

export function optionalBinding<T>(value: T | undefined | null, name: string, purpose: string): T | null {
    if (value !== undefined && value !== null) return value;
    if (!warned.has(name)) {
        warned.add(name);
        console.warn(
            `[better-auth-cloudflare] optional binding "${name}" is not configured. ` +
                `Feature "${purpose}" is disabled. Bind it in wrangler.toml to enable.`
        );
    }
    return null;
}

/**
 * Hard requirement — throw a clear error if a required binding is missing
 * at boot. Use sparingly; prefer optionalBinding for graceful degradation.
 */
export function requireBinding<T>(value: T | undefined | null, name: string): T {
    if (value === undefined || value === null) {
        throw new Error(
            `[better-auth-cloudflare] required binding "${name}" is not configured. ` + `Add it to wrangler.toml.`
        );
    }
    return value;
}

/** Reset warning state — testing only. */
export function resetOptionalBindingWarnings(): void {
    warned.clear();
}
