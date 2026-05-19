"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signUp, useSession } from "@/lib/auth-client";

type Mode = "signin" | "signup" | "anonymous";

export default function HomePage() {
    const { data: session, isPending } = useSession();
    const router = useRouter();
    const [mode, setMode] = useState<Mode>("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    if (isPending) {
        return <div className="text-sm text-gray-500">Loading…</div>;
    }
    if (session) {
        router.push("/dashboard");
        return null;
    }

    async function handleSubmit(ev: React.FormEvent) {
        ev.preventDefault();
        setError(null);
        setLoading(true);
        try {
            if (mode === "signup") {
                const r = await signUp.email({ email, password, name: name || email.split("@")[0] });
                if (r.error) throw new Error(r.error.message);
            } else if (mode === "signin") {
                const r = await signIn.email({ email, password });
                if (r.error) throw new Error(r.error.message);
            }
            router.push("/dashboard");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    async function handleAnonymous() {
        setLoading(true);
        try {
            await signIn.anonymous();
            router.push("/dashboard");
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    async function handleGoogle() {
        setLoading(true);
        try {
            await signIn.social({ provider: "google", callbackURL: "/dashboard" });
        } catch (err) {
            setError((err as Error).message);
            setLoading(false);
        }
    }

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">better-auth-cloudflare</h1>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    React + Next.js (OpenNext) demo with Durable Object-backed auth.
                    Storage: per-principal DOs. No DB on the hot path.
                </p>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm">
                <div className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-800">
                    {(["signin", "signup"] as const).map((m) => (
                        <button
                            key={m}
                            onClick={() => setMode(m)}
                            className={`px-3 py-2 text-sm font-medium transition-colors ${
                                mode === m
                                    ? "border-b-2 border-blue-600 text-blue-600"
                                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                            }`}
                        >
                            {m === "signin" ? "Sign in" : "Sign up"}
                        </button>
                    ))}
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {mode === "signup" && (
                        <div>
                            <label className="block text-sm font-medium mb-1">Name (optional)</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                            />
                        </div>
                    )}
                    <div>
                        <label className="block text-sm font-medium mb-1">Email</label>
                        <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Password</label>
                        <input
                            type="password"
                            required
                            minLength={8}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        />
                    </div>
                    {error && (
                        <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 px-3 py-2 text-sm">
                            {error}
                        </div>
                    )}
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium transition-colors"
                    >
                        {loading ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
                    </button>
                </form>

                <div className="relative my-6">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-200 dark:border-gray-800"></div>
                    </div>
                    <div className="relative flex justify-center text-xs">
                        <span className="bg-white dark:bg-gray-900 px-2 text-gray-500">or</span>
                    </div>
                </div>

                <div className="space-y-2">
                    <button
                        onClick={handleAnonymous}
                        disabled={loading}
                        className="w-full rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
                    >
                        Continue as guest
                    </button>
                    <button
                        onClick={handleGoogle}
                        disabled={loading}
                        className="w-full rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
                    >
                        Continue with Google
                    </button>
                </div>
            </div>

            <p className="text-xs text-gray-500 text-center">
                Storage: <code className="text-gray-700 dark:text-gray-300">UserDurableObject</code> (per principal) +{" "}
                <code className="text-gray-700 dark:text-gray-300">IdentityDurableObject</code> (per email hash). Sync
                to D1 happens via outbox + waitUntil within ~10s.
            </p>
        </div>
    );
}
