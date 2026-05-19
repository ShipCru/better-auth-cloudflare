import { describe, it, expect, beforeAll } from "vitest";
import { TestClient, waitForServer } from "../helpers";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:8787";

beforeAll(async () => {
    await waitForServer(baseUrl);
});

interface SessionResponse {
    session: { id: string; userId: string; token: string; expiresAt: string };
    user: { id: string; email: string | null; name: string | null; isAnonymous: boolean };
}

interface ErrorResponse {
    code?: string;
    message?: string;
}

describe("Health and metadata endpoints", () => {
    it("GET /health returns 200 and ok status", async () => {
        const r = await fetch(`${baseUrl}/health`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ status: "ok" });
    });

    it("GET /debug/region returns request region with no session", async () => {
        const r = await fetch(`${baseUrl}/debug/region`);
        expect(r.status).toBe(200);
        const data = (await r.json()) as {
            request: { country: string | null; colo: string | null };
            principal: null;
        };
        expect(data.request).toBeDefined();
        expect(data.principal).toBeNull();
    });

    it("GET /debug/region includes principal when authenticated", async () => {
        const client = new TestClient(baseUrl);
        const signIn = await client.post("/api/auth/sign-in/anonymous", {});
        expect(signIn.status).toBe(200);
        const debug = await client.json<{ principal: { id: string; doName: string } | null }>("/debug/region");
        expect(debug.principal).not.toBeNull();
        expect(debug.principal!.doName).toBe(debug.principal!.id);
    });
});

describe("Anonymous authentication flow", () => {
    const client = new TestClient(baseUrl);

    it("POST /api/auth/sign-in/anonymous creates an anonymous user", async () => {
        const r = await client.post("/api/auth/sign-in/anonymous", {});
        expect(r.status).toBe(200);
        const data = (await r.json()) as SessionResponse;
        expect(data.user.isAnonymous).toBe(true);
        expect(data.user.email).toBeNull();
        expect(data.user.id).toMatch(/^[0-9a-f-]+$/i);
    });

    it("GET /api/auth/get-session returns the anonymous session", async () => {
        const data = await client.json<SessionResponse | null>("/api/auth/get-session");
        expect(data).not.toBeNull();
        expect(data!.user.isAnonymous).toBe(true);
    });

    it("GET /protected returns ok for anonymous user", async () => {
        const data = await client.json<{ ok: boolean; storedIn: string; isAnonymous: boolean }>("/protected");
        expect(data.ok).toBe(true);
        expect(data.storedIn).toBe("durable-object");
        expect(data.isAnonymous).toBe(true);
    });

    it("POST /api/auth/sign-out clears the anonymous session", async () => {
        const r = await client.post("/api/auth/sign-out", {});
        expect(r.status).toBe(200);
        const session = await client.json<SessionResponse | null>("/api/auth/get-session");
        expect(session).toBeNull();
    });
});

describe("Email/password signup and signin flow", () => {
    // Per-test-run unique email to avoid IdentityDO conflicts across runs
    const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = "TestPassword123!";
    const client = new TestClient(baseUrl);

    it("POST /api/auth/sign-up/email creates a non-anonymous user", async () => {
        const r = await client.post("/api/auth/sign-up/email", { email, password, name: "E2E User" });
        expect(r.status).toBe(200);
        const data = (await r.json()) as SessionResponse;
        expect(data.user.email).toBe(email);
        expect(data.user.isAnonymous).toBe(false);
        expect(data.user.name).toBe("E2E User");
    });

    it("GET /api/auth/get-session returns the signed-in user", async () => {
        const data = await client.json<SessionResponse | null>("/api/auth/get-session");
        expect(data).not.toBeNull();
        expect(data!.user.email).toBe(email);
    });

    it("GET /protected returns ok for the email user", async () => {
        const data = await client.json<{ ok: boolean; storedIn: string; isAnonymous: boolean }>("/protected");
        expect(data.ok).toBe(true);
        expect(data.isAnonymous).toBe(false);
    });

    it("POST /api/auth/sign-up/email with same email is rejected as duplicate", async () => {
        const fresh = new TestClient(baseUrl);
        const r = await fresh.post("/api/auth/sign-up/email", { email, password, name: "Other" });
        const data = (await r.json()) as ErrorResponse;
        expect(data.code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
    });

    it("POST /api/auth/sign-out clears the email session", async () => {
        const r = await client.post("/api/auth/sign-out", {});
        expect(r.status).toBe(200);
        const session = await client.json<SessionResponse | null>("/api/auth/get-session");
        expect(session).toBeNull();
    });

    it("POST /api/auth/sign-in/email succeeds with correct password", async () => {
        const r = await client.post("/api/auth/sign-in/email", { email, password });
        expect(r.status).toBe(200);
        const data = (await r.json()) as SessionResponse;
        expect(data.user.email).toBe(email);
    });

    it("POST /api/auth/sign-in/email rejects wrong password", async () => {
        const fresh = new TestClient(baseUrl);
        const r = await fresh.post("/api/auth/sign-in/email", { email, password: "NotThePassword123!" });
        const data = (await r.json()) as ErrorResponse;
        expect(data.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    });

    it("POST /api/auth/sign-in/email rejects unknown email", async () => {
        const fresh = new TestClient(baseUrl);
        const r = await fresh.post("/api/auth/sign-in/email", {
            email: `does-not-exist-${Date.now()}@example.com`,
            password: "Whatever123!",
        });
        const data = (await r.json()) as ErrorResponse;
        expect(data.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    });
});

describe("Unauthenticated access", () => {
    it("GET /protected returns 401 without a session", async () => {
        const r = await fetch(`${baseUrl}/protected`);
        expect(r.status).toBe(401);
    });
});

describe("Multiple independent users", () => {
    it("Two signups produce distinct principal ids", async () => {
        const a = new TestClient(baseUrl);
        const b = new TestClient(baseUrl);
        const emailA = `multi-a-${Date.now()}@example.com`;
        const emailB = `multi-b-${Date.now()}@example.com`;
        const rA = (await (
            await a.post("/api/auth/sign-up/email", { email: emailA, password: "PassA123!", name: "A" })
        ).json()) as SessionResponse;
        const rB = (await (
            await b.post("/api/auth/sign-up/email", { email: emailB, password: "PassB123!", name: "B" })
        ).json()) as SessionResponse;
        expect(rA.user.id).not.toBe(rB.user.id);
        expect(rA.user.email).toBe(emailA);
        expect(rB.user.email).toBe(emailB);
    });
});

describe("Cloudflare geolocation endpoint", () => {
    it("GET /api/auth/cloudflare/geolocation returns data when authenticated", async () => {
        const client = new TestClient(baseUrl);
        await client.post("/api/auth/sign-in/anonymous", {});
        const r = await client.fetch("/api/auth/cloudflare/geolocation");
        expect(r.status).toBe(200);
        const data = (await r.json()) as { country?: string | null };
        // In Miniflare local mode, cf data defaults to San Francisco / US
        expect(data).toBeDefined();
    });
});
