import type { Metadata } from "next";
import Link from "next/link";
import "../styles/globals.css";
import { TimingProvider, TimingBar } from "@/lib/timing";

export const metadata: Metadata = {
    title: "better-auth-cloudflare DO demo (Next.js + OpenNext)",
    description: "React + Tailwind frontend for Durable-Object-backed Better Auth",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body className="bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 antialiased">
                <TimingProvider>
                    <main className="mx-auto max-w-3xl px-6 py-12 space-y-6">
                        <nav className="flex gap-4 text-sm text-gray-600 dark:text-gray-400">
                            {/*
                             * Single Home link. The / route renders the signin form when
                             * logged-out and redirects to /dashboard when logged-in, so
                             * one link covers both states. Dashboard is reachable via
                             * the post-login redirect from /, not surfaced in nav.
                             */}
                            <Link href="/" className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                                Home
                            </Link>
                            <Link
                                href="/bench"
                                className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                                Bench
                            </Link>
                        </nav>
                        <TimingBar />
                        {children}
                    </main>
                </TimingProvider>
            </body>
        </html>
    );
}
