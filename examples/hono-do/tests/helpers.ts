/**
 * Tiny cookie-jar test client. Holds Set-Cookie values across requests so
 * tests can simulate a real browser session against a running wrangler
 * dev instance.
 *
 * Intentionally minimal: no expiry checking, no domain matching, no
 * SameSite enforcement. Tests run against a local Worker so none of that
 * matters.
 */
export class TestClient {
    private cookies = new Map<string, string>();

    constructor(public readonly baseUrl: string) {}

    cookie(name: string): string | undefined {
        return this.cookies.get(name);
    }

    clearCookies(): void {
        this.cookies.clear();
    }

    async fetch(path: string, init?: RequestInit): Promise<Response> {
        const headers = new Headers(init?.headers);
        if (this.cookies.size > 0) {
            const cookieHeader = Array.from(this.cookies.entries())
                .map(([k, v]) => `${k}=${v}`)
                .join("; ");
            headers.set("Cookie", cookieHeader);
        }
        // BA rejects auth-route POSTs without Origin (CSRF defense). Node's
        // fetch doesn't set Origin like a browser does. Set it explicitly to
        // the test base URL so BA accepts the request.
        if (!headers.has("Origin")) headers.set("Origin", this.baseUrl);
        const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
        const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        for (const sc of setCookies) {
            const [pair] = sc.split(";");
            if (!pair) continue;
            const idx = pair.indexOf("=");
            if (idx < 0) continue;
            const name = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            // Expiry / clearing is represented as empty value with Max-Age=0 — drop it.
            if (value === "" || /max-age=0/i.test(sc)) {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
        return res;
    }

    async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
        const r = await this.fetch(path, init);
        return (await r.json()) as T;
    }

    async post(path: string, body: unknown): Promise<Response> {
        return this.fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
        });
    }
}

export async function waitForServer(baseUrl: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${baseUrl}/health`);
            if (r.ok) return;
        } catch (err) {
            lastErr = err;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(
        `waitForServer: ${baseUrl} did not become ready within ${timeoutMs}ms. ` +
            `Start with \`pnpm dev\` from examples/hono-do. ` +
            `Last error: ${lastErr ? (lastErr as Error).message : "none"}`
    );
}
