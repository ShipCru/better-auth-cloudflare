import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

// Config used ONLY by the BA CLI generator. Tells BA "we'll be on
// Postgres-flavoured Drizzle" so it can emit the canonical schema.
// At runtime we use our crdb adapter; the schema shape is identical.
export const auth = betterAuth({
    database: drizzleAdapter({} as never, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    plugins: [anonymous()],
});
