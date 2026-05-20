import { sha256Hex } from "../logging";

/**
 * Per-request observability helpers.
 *
 * Standard shape for all auth/admin request logs so dashboards can index
 * by `op`, slice by `principalIdHash`, alert on `errorCode`, and chart
 * `durationMs` percentiles. Hash anything that might be PII (principalId,
 * email, IP, token).
 *
 * The helpers are framework-agnostic — wire them into Hono middleware,
 * Next.js route handlers, or anywhere else.
 */

export interface RequestLogFields {
    requestId: string;
    op: string;
    /** sha256 hex prefix. Logged at most. Never the raw principal id. */
    principalIdHash?: string;
    durationMs: number;
    status: number;
    errorCode?: string;
    /** request region (Cloudflare colo) when available */
    colo?: string;
    country?: string;
    /** payload size in bytes when available */
    bytesIn?: number;
    bytesOut?: number;
}

/** Stable per-request id. Reads `cf-ray` (set by Cloudflare's edge) if available, otherwise generates. */
export function getRequestId(req: Request): string {
    const cfRay = req.headers.get("cf-ray");
    if (cfRay) return cfRay;
    return crypto.randomUUID();
}

/** Hash a principal id for logging. 12 hex chars is enough to uniquely identify
 *  within a working set while being privacy-safe in aggregated logs. */
export async function shortPrincipalHash(principalId: string): Promise<string> {
    return (await sha256Hex(principalId)).slice(0, 12);
}

/** Emit a single structured log line. Cloudflare Workers Logs indexes JSON. */
export function logRequest(fields: RequestLogFields): void {
    const line = JSON.stringify({
        ...fields,
        ts: new Date().toISOString(),
        kind: "request",
    });
    if (fields.status >= 500) console.error(line);
    else if (fields.status >= 400) console.warn(line);
    else console.log(line);
}

/**
 * Times an async operation and emits a request log when it resolves or rejects.
 * Returns the operation's result; rethrows on failure after logging.
 */
export async function withRequestLog<T>(
    base: Omit<RequestLogFields, "durationMs" | "status">,
    fn: () => Promise<{ result: T; status: number }>
): Promise<T> {
    const t0 = Date.now();
    try {
        const { result, status } = await fn();
        logRequest({ ...base, durationMs: Date.now() - t0, status });
        return result;
    } catch (err) {
        logRequest({
            ...base,
            durationMs: Date.now() - t0,
            status: 500,
            errorCode: (err as Error)?.message?.slice(0, 80) ?? "unknown",
        });
        throw err;
    }
}
