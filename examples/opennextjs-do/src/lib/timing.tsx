"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";

/**
 * Per-operation timing UI for the demo.
 *
 *   const { timed, current } = useTiming();
 *   await timed("sign-in.email", () => signIn.email({ email, password }));
 *   // <TimingBar /> shows "sign-in.email…", then "sign-in.email ✓ 247 ms"
 *
 * Production-safe — this is a demo app. We deliberately measure wall-clock
 * from inside the browser (not server-side) so users see what they feel.
 */
export interface TimingEntry {
    label: string;
    state: "running" | "ok" | "error";
    elapsedMs?: number;
    error?: string;
}

interface TimingContextValue {
    current: TimingEntry | null;
    timed: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
}

const TimingContext = createContext<TimingContextValue | null>(null);

export function TimingProvider({ children }: { children: ReactNode }) {
    const [current, setCurrent] = useState<TimingEntry | null>(null);
    // Use a ref so concurrent timed() calls (rare here) don't clobber each
    // other's elapsed times — we only keep the *last* one in the bar.
    const lastLabel = useRef<string | null>(null);

    async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
        lastLabel.current = label;
        setCurrent({ label, state: "running" });
        const t0 = performance.now();
        try {
            const result = await fn();
            const elapsedMs = Math.round(performance.now() - t0);
            if (lastLabel.current === label) setCurrent({ label, state: "ok", elapsedMs });
            return result;
        } catch (err) {
            const elapsedMs = Math.round(performance.now() - t0);
            if (lastLabel.current === label) {
                setCurrent({
                    label,
                    state: "error",
                    elapsedMs,
                    error: (err as Error)?.message?.slice(0, 120) ?? "unknown",
                });
            }
            throw err;
        }
    }

    return <TimingContext.Provider value={{ current, timed }}>{children}</TimingContext.Provider>;
}

export function useTiming(): TimingContextValue {
    const ctx = useContext(TimingContext);
    if (!ctx) throw new Error("useTiming must be used inside <TimingProvider>");
    return ctx;
}

const STATE_STYLES: Record<TimingEntry["state"], string> = {
    running: "bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-200 border-amber-200 dark:border-amber-900",
    ok: "bg-emerald-100 dark:bg-emerald-950 text-emerald-900 dark:text-emerald-200 border-emerald-200 dark:border-emerald-900",
    error: "bg-red-100 dark:bg-red-950 text-red-900 dark:text-red-200 border-red-200 dark:border-red-900",
};

export function TimingBar() {
    const { current } = useTiming();
    if (!current) return null;
    const cls = STATE_STYLES[current.state];
    return (
        <div
            className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${cls}`}
            role="status"
            aria-live="polite"
        >
            <span className="font-mono">{current.label}</span>
            {current.state === "running" && (
                <span
                    aria-hidden
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
            )}
            {current.state === "ok" && <span aria-hidden>✓</span>}
            {current.state === "error" && <span aria-hidden>✗</span>}
            {current.elapsedMs != null && (
                <span className="ml-auto font-mono text-xs opacity-80">{current.elapsedMs} ms</span>
            )}
            {current.error && <span className="text-xs opacity-80">{current.error}</span>}
        </div>
    );
}
