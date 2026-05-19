import type { Metadata } from "next";
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
                    <main className="mx-auto max-w-2xl px-6 py-12 space-y-6">
                        <TimingBar />
                        {children}
                    </main>
                </TimingProvider>
            </body>
        </html>
    );
}
