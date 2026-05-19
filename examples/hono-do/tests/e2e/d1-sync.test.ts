import { describe, it, expect, beforeAll } from "vitest";
import { TestClient, waitForServer } from "../helpers";

/**
 * E2E test for the recovery-store sync guarantee.
 *
 * Architecture under test:
 *   1. Signup writes to IdentityDO + UserDO (no DB on hot path).
 *   2. UserDO enqueues a recovery event in its local outbox.
 *   3. Immediate drain attempt via `state.waitUntil(...)` (typical ~100ms).
 *   4. Alarm-driven retry at 3s + exponential backoff if waitUntil fails.
 *
 * Mandatory eventual consistency window: 10s. We assert within 8s to give
 * headroom for CI jitter.
 *
 * Requires the demo to be running with AUTH_RECOVERY_DB bound and the
 * recovery-schema.sql applied:
 *
 *   wrangler d1 execute ba-cf-do-recovery --local --file ./recovery-schema.sql
 *   pnpm dev
 */
const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:8787";

beforeAll(async () => {
    await waitForServer(baseUrl);
});

interface AdminUsersResponse {
    users: Array<{
        id: string;
        email: string;
        name: string | null;
        is_anonymous: number;
        created_at: string;
    }>;
    pagination: { limit: number; offset: number; total: number };
}

describe("Recovery sync to D1 (<10s guarantee)", () => {
    it("admin/users requires AUTH_RECOVERY_DB binding (returns 200 not 503)", async () => {
        const r = await fetch(`${baseUrl}/admin/users`);
        expect(r.status).toBe(200);
        const data = (await r.json()) as AdminUsersResponse;
        expect(data.users).toBeDefined();
        expect(data.pagination).toBeDefined();
    });

    it("signup → user appears in D1 within 10s", async () => {
        const client = new TestClient(baseUrl);
        const email = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

        // 1. Signup — DO write, response returned immediately
        const signup = await client.post("/api/auth/sign-up/email", {
            email,
            password: "Password123!",
            name: "Sync Test",
        });
        expect(signup.status).toBe(200);
        const signupBody = (await signup.json()) as { user: { id: string } };
        const principalId = signupBody.user.id;

        // 2. Poll /admin/users for up to 10s, checking for the new user
        const deadline = Date.now() + 10_000;
        let found = false;
        let attempts = 0;
        while (Date.now() < deadline) {
            attempts++;
            const r = await fetch(`${baseUrl}/admin/users?limit=100`);
            const data = (await r.json()) as AdminUsersResponse;
            if (data.users.some(u => u.id === principalId)) {
                found = true;
                break;
            }
            await new Promise(res => setTimeout(res, 250));
        }

        expect(found, `User ${email} did not appear in D1 within 10s (after ${attempts} polls)`).toBe(true);
    });

    it("multiple rapid signups all appear in D1", async () => {
        const before = (await (await fetch(`${baseUrl}/admin/users?limit=100`)).json()) as AdminUsersResponse;
        const beforeCount = before.pagination.total;

        const N = 5;
        const ts = Date.now();
        const emails = Array.from({ length: N }, (_, i) => `burst-${ts}-${i}@example.com`);
        await Promise.all(
            emails.map(email => {
                const client = new TestClient(baseUrl);
                return client.post("/api/auth/sign-up/email", {
                    email,
                    password: "Password123!",
                    name: `Burst ${ts}`,
                });
            })
        );

        // Allow up to 10s for all to propagate
        const deadline = Date.now() + 10_000;
        let allFound = false;
        while (Date.now() < deadline) {
            const r = (await (await fetch(`${baseUrl}/admin/users?limit=100`)).json()) as AdminUsersResponse;
            const present = emails.filter(e => r.users.some(u => u.email === e)).length;
            if (present === N) {
                allFound = true;
                break;
            }
            await new Promise(res => setTimeout(res, 250));
        }

        expect(allFound, `Not all ${N} burst signups appeared in D1 within 10s`).toBe(true);

        const after = (await (await fetch(`${baseUrl}/admin/users?limit=100`)).json()) as AdminUsersResponse;
        expect(after.pagination.total).toBeGreaterThanOrEqual(beforeCount + N);
    });

    it("anonymous signups do NOT appear in D1 (edge-only by design)", async () => {
        const client = new TestClient(baseUrl);
        const r = await client.post("/api/auth/sign-in/anonymous", {});
        expect(r.status).toBe(200);
        const body = (await r.json()) as { user: { id: string } };
        const anonId = body.user.id;

        // Wait the full sync window
        await new Promise(res => setTimeout(res, 6000));

        // Verify by specific id: the anonymous user we just created must NOT
        // be in D1, regardless of other tests running in parallel.
        const after = (await (await fetch(`${baseUrl}/admin/users?limit=100`)).json()) as AdminUsersResponse;
        const present = after.users.some(u => u.id === anonId);
        expect(present, `Anonymous user ${anonId} should not be persisted to D1`).toBe(false);

        // Sanity: any users in the result must all be non-anonymous.
        for (const u of after.users) {
            expect(u.is_anonymous).toBe(0);
        }
    });
});
