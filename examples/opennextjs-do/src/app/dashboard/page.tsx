"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "@/lib/auth-client";
import { useTiming } from "@/lib/timing";

interface AdminUser {
    id: string;
    name: string | null;
    email: string;
    is_anonymous: number;
    created_at: string;
}

export default function DashboardPage() {
    const { data: session, isPending } = useSession();
    const router = useRouter();
    const { timed } = useTiming();
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);

    // useSession() may return a fresh object reference on every render even
    // when nothing changed. Depend on the stable user id (or its absence) so
    // this effect doesn't refetch /admin/users in an infinite loop.
    const userId = session?.user?.id ?? null;

    useEffect(() => {
        if (!isPending && !userId) router.push("/");
    }, [isPending, userId, router]);

    useEffect(() => {
        if (!userId) return;
        setLoadingUsers(true);
        timed("GET /admin/users", () => fetch("/admin/users?limit=20").then(r => r.json()))
            .then((data: { users?: AdminUser[] }) => setUsers(data.users ?? []))
            .finally(() => setLoadingUsers(false));
    }, [userId, timed]);

    if (isPending || !session) return <div className="text-sm text-gray-500">Loading…</div>;

    const isAnonymous = (session.user as { isAnonymous?: boolean }).isAnonymous ?? false;

    return (
        <div className="space-y-8">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        Signed in as{" "}
                        <span className="font-medium">{session.user.email ?? session.user.name ?? "guest"}</span>
                        {isAnonymous && (
                            <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                                anonymous
                            </span>
                        )}
                    </p>
                </div>
                <button
                    onClick={async () => {
                        await timed("sign-out", () => signOut());
                        router.push("/");
                    }}
                    className="rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 px-4 py-2 text-sm font-medium transition-colors"
                >
                    Sign out
                </button>
            </div>

            <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm">
                <h2 className="text-lg font-semibold mb-4">Session</h2>
                <dl className="grid grid-cols-3 gap-4 text-sm">
                    <dt className="text-gray-500">User ID</dt>
                    <dd className="col-span-2 font-mono text-xs">{session.user.id}</dd>
                    <dt className="text-gray-500">Session ID</dt>
                    <dd className="col-span-2 font-mono text-xs">{session.session.id}</dd>
                    <dt className="text-gray-500">Expires</dt>
                    <dd className="col-span-2">{new Date(session.session.expiresAt).toLocaleString()}</dd>
                    <dt className="text-gray-500">Stored in</dt>
                    <dd className="col-span-2">
                        <span className="inline-flex rounded bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-200 px-2 py-0.5 text-xs font-medium">
                            Durable Object
                        </span>
                    </dd>
                </dl>
            </section>

            <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm">
                <div className="flex items-baseline justify-between mb-4">
                    <h2 className="text-lg font-semibold">Recent users (from D1)</h2>
                    <p className="text-xs text-gray-500">via /admin/users — synced from DOs via outbox</p>
                </div>
                {loadingUsers && <p className="text-sm text-gray-500">Loading…</p>}
                {!loadingUsers && users.length === 0 && (
                    <p className="text-sm text-gray-500">No users in D1 yet. Sync window: ~10s after signup.</p>
                )}
                {users.length > 0 && (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs uppercase text-gray-500 border-b border-gray-200 dark:border-gray-800">
                                <th className="pb-2 pr-4">Email</th>
                                <th className="pb-2 pr-4">Name</th>
                                <th className="pb-2">Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map(u => (
                                <tr key={u.id} className="border-b border-gray-100 dark:border-gray-900 last:border-0">
                                    <td className="py-2 pr-4 font-mono text-xs">{u.email}</td>
                                    <td className="py-2 pr-4">{u.name ?? "—"}</td>
                                    <td className="py-2 text-xs text-gray-500">
                                        {new Date(u.created_at).toLocaleString()}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}
