import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Admin/dashboard read endpoint — paginates users from the D1 auth data
 * store. Same pattern as Hono /admin/users in `examples/hono-do/`.
 *
 * NOT auth-protected here — wrap in your own admin auth for production.
 */
export async function GET(req: Request): Promise<Response> {
    const { env } = await getCloudflareContext({ async: true });
    const db = env.AUTH_DB;
    if (!db) {
        return Response.json({ error: "AUTH_DB not bound" }, { status: 503 });
    }
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const result = await db
        .prepare(
            `SELECT id, name, email, email_verified, is_anonymous, created_at, updated_at
                 FROM users
                 WHERE deleted_at IS NULL
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?`
        )
        .bind(limit, offset)
        .all();
    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL`).first()) as {
        c: number;
    } | null;
    return Response.json({
        users: result.results,
        pagination: { limit, offset, total: total?.c ?? 0 },
    });
}
