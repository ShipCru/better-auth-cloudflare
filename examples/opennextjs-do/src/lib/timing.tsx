"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Per-operation timing UI for the demo. Renders a *stack* of recent
 * results at the top of the page; each entry auto-dismisses after 10s
 * or on click. Replaces the old single-bar UI so users can see the
 * timing history (e.g. a sequence of bench runs, signin → dashboard
 * navigation, etc.) without losing earlier numbers.
 *
 *   const { timed } = useTiming();
 *   await timed("sign-in.email", () => signIn.email({ email, password }));
 *
 * Production-safe — this is a demo app. We deliberately measure wall-clock
 * from inside the browser (not server-side) so users see what they feel.
 */
export interface TimingEntry {
    /** Unique within the running session, monotonically increasing. */
    id: number;
    label: string;
    state: "running" | "ok" | "error";
    elapsedMs?: number;
    error?: string;
    /** epoch ms; used to drive auto-dismiss timers. */
    startedAt: number;
}

interface TimingContextValue {
    entries: TimingEntry[];
    timed: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    dismiss: (id: number) => void;
}

const TimingContext = createContext<TimingContextValue | null>(null);

const AUTO_DISMISS_MS = 10_000;
const MAX_ENTRIES = 5;

export function TimingProvider({ children }: { children: ReactNode }) {
    const [entries, setEntries] = useState<TimingEntry[]>([]);
    const nextId = useRef(0);

    const dismiss = useCallback((id: number) => {
        setEntries(prev => prev.filter(e => e.id !== id));
    }, []);

    // useCallback with empty deps gives a stable identity across renders.
    // Consumers put `timed` in useEffect deps; an unstable identity here
    // would trigger an infinite loop. See git history for the bug we
    // hit pre-useCallback.
    const timed = useCallback(async function timedImpl<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const id = nextId.current++;
        const startedAt = performance.now();
        setEntries(prev => trim([...prev, { id, label, state: "running", startedAt }]));
        try {
            const result = await fn();
            const elapsedMs = Math.round(performance.now() - startedAt);
            setEntries(prev => prev.map(e => (e.id === id ? { ...e, state: "ok" as const, elapsedMs } : e)));
            return result;
        } catch (err) {
            const elapsedMs = Math.round(performance.now() - startedAt);
            setEntries(prev =>
                prev.map(e =>
                    e.id === id
                        ? {
                              ...e,
                              state: "error" as const,
                              elapsedMs,
                              error: (err as Error)?.message?.slice(0, 120) ?? "unknown",
                          }
                        : e
                )
            );
            throw err;
        }
    }, []);

    const value = useMemo(() => ({ entries, timed, dismiss }), [entries, timed, dismiss]);
    return <TimingContext.Provider value={value}>{children}</TimingContext.Provider>;
}

function trim(arr: TimingEntry[]): TimingEntry[] {
    return arr.length > MAX_ENTRIES ? arr.slice(-MAX_ENTRIES) : arr;
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

/**
 * Renders the active timing stack as a sticky strip above the page.
 * Entries auto-dismiss 10s after they reach a terminal state (`ok` /
 * `error`); running entries stay visible until they complete. Click any
 * entry to dismiss immediately.
 */
export function TimingStack() {
    const { entries, dismiss } = useTiming();
    if (entries.length === 0) return null;
    return (
        <div className="sticky top-2 z-50 space-y-1.5" role="status" aria-live="polite">
            {entries.map(entry => (
                <TimingPill key={entry.id} entry={entry} onDismiss={() => dismiss(entry.id)} />
            ))}
        </div>
    );
}

function TimingPill({ entry, onDismiss }: { entry: TimingEntry; onDismiss: () => void }) {
    useEffect(() => {
        if (entry.state === "running") return;
        const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
        return () => window.clearTimeout(timer);
    }, [entry.state, onDismiss]);

    const cls = STATE_STYLES[entry.state];
    return (
        <button
            type="button"
            onClick={onDismiss}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-sm text-left transition-colors shadow-sm hover:opacity-80 ${cls}`}
            aria-label={`Dismiss timing for ${entry.label}`}
        >
            <span className="font-mono">{entry.label}</span>
            {entry.state === "running" && (
                <span
                    aria-hidden
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
            )}
            {entry.state === "ok" && <span aria-hidden>✓</span>}
            {entry.state === "error" && <span aria-hidden>✗</span>}
            {entry.elapsedMs != null && (
                <span className="ml-auto font-mono text-xs opacity-80">{entry.elapsedMs} ms</span>
            )}
            {entry.error && <span className="text-xs opacity-80 truncate">{entry.error}</span>}
        </button>
    );
}

/**
 * @deprecated kept for source-compat with imports made before the stack
 * migration; aliases to TimingStack so anyone importing the old name
 * still gets the new behaviour.
 */
export const TimingBar = TimingStack;
