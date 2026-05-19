import { getAuth } from "@/lib/auth";

/**
 * Catch-all BA handler. Next.js App Router routes /api/auth/* here;
 * the handler delegates to BA's HTTP machinery.
 */
async function handler(req: Request): Promise<Response> {
    const auth = await getAuth();
    return auth.handler(req);
}

export const GET = handler;
export const POST = handler;
