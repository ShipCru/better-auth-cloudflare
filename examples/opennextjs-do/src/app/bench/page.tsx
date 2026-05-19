"use client";

import { useState } from "react";
import {
    BACKEND_VARIANTS,
    SCENARIOS,
    type BenchRunResponse,
    type BenchScenarioResult,
    type ScenarioId,
    type VariantId,
} from "@/lib/bench-types";

interface RunRow extends BenchScenarioResult {
    transport: "binding" | "http";
    scenarioLabel: string;
    variantLabel: string;
}

export default function BenchPage() {
    const [variantId, setVariantId] = useState<VariantId>("current");
    const [scenarioId, setScenarioId] = useState<ScenarioId>("cold-burst-signup");
    const [n, setN] = useState<number>(5);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rows, setRows] = useState<RunRow[]>([]);

    const scenario = SCENARIOS.find(s => s.id === scenarioId)!;
    const variant = BACKEND_VARIANTS.find(v => v.id === variantId)!;

    async function runOne() {
        setRunning(true);
        setError(null);
        try {
            const res = await fetch("/api/bench", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ variantId, scenarioId, n }),
            });
            const data = (await res.json()) as BenchRunResponse | { error: string };
            if ("error" in data) {
                setError(data.error);
                return;
            }
            setRows(prev => [
                {
                    ...data.result,
                    transport: data.transport,
                    scenarioLabel: scenario.label,
                    variantLabel: variant.label,
                },
                ...prev,
            ]);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRunning(false);
        }
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Benchmark</h1>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Runs auth flows server-side against the chosen backend variant via Cloudflare service binding
                    (in-isolate, no network hop). Reveals per-iteration cold→warm latency curves so you can see DO
                    warmup behavior directly. Hit this page from different regions to capture geo latency in{" "}
                    <code>colo</code>/<code>country</code>.
                </p>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-sm space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <label className="block text-sm font-medium mb-1">Variant (backend implementation)</label>
                        <select
                            value={variantId}
                            onChange={e => setVariantId(e.target.value as VariantId)}
                            className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        >
                            {BACKEND_VARIANTS.map(v => (
                                <option key={v.id} value={v.id}>
                                    {v.label}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">{variant.description}</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Scenario</label>
                        <select
                            value={scenarioId}
                            onChange={e => setScenarioId(e.target.value as ScenarioId)}
                            className="w-full rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        >
                            {SCENARIOS.map(s => (
                                <option key={s.id} value={s.id}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">{scenario.description}</p>
                    </div>
                </div>

                <div className="flex items-end gap-3">
                    <div>
                        <label className="block text-sm font-medium mb-1">N per scenario</label>
                        <input
                            type="number"
                            min={1}
                            max={50}
                            value={n}
                            onChange={e => setN(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
                            className="w-24 rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        />
                    </div>
                    <button
                        onClick={runOne}
                        disabled={running}
                        className="rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium transition-colors"
                    >
                        {running ? "Running…" : "Run"}
                    </button>
                </div>

                {error && (
                    <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 px-3 py-2 text-sm">
                        {error}
                    </div>
                )}
            </div>

            {rows.length > 0 && (
                <div className="space-y-4">
                    {rows.map((r, idx) => (
                        <ResultCard key={`${r.ts}-${idx}`} row={r} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ResultCard({ row }: { row: RunRow }) {
    const max = Math.max(1, ...row.durations);
    return (
        <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 shadow-sm">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold">{row.scenarioLabel}</h2>
                    <p className="text-xs text-gray-500">{row.variantLabel}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Pill>{row.transport}</Pill>
                    {row.colo && <Pill>colo {row.colo}</Pill>}
                    {row.country && <Pill>{row.country}</Pill>}
                    <span>{new Date(row.ts).toLocaleTimeString()}</span>
                </div>
            </header>

            <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-3 text-sm">
                <Stat label="n" value={row.n} />
                <Stat label="ok" value={row.ok} />
                <Stat label="err" value={row.error} className={row.error > 0 ? "text-red-600 dark:text-red-400" : ""} />
                <Stat label="p50" value={`${row.p50} ms`} />
                <Stat label="p95" value={`${row.p95} ms`} />
                <Stat label="p99" value={`${row.p99} ms`} />
            </div>

            <div className="mt-5">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Per-iteration durations (ms)</p>
                <div className="space-y-1">
                    {row.durations.map((d, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs font-mono">
                            <span className="w-6 text-right text-gray-500">{i + 1}</span>
                            {row.durationsLabels?.[i] && (
                                <span className="w-24 truncate text-gray-500">{row.durationsLabels[i]}</span>
                            )}
                            <div className="flex-1 h-3 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
                                <div className="h-full bg-blue-500/80" style={{ width: `${(d / max) * 100}%` }} />
                            </div>
                            <span className="w-16 text-right">{d} ms</span>
                        </div>
                    ))}
                </div>
            </div>

            <details className="mt-4">
                <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400">raw JSON</summary>
                <pre className="mt-2 rounded bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-900 p-3 text-[10px] overflow-x-auto max-h-64">
                    {JSON.stringify(row, null, 2)}
                </pre>
            </details>
        </section>
    );
}

function Stat({ label, value, className }: { label: string; value: number | string; className?: string }) {
    return (
        <div>
            <p className="text-xs text-gray-500">{label}</p>
            <p className={`font-mono font-medium ${className ?? ""}`}>{value}</p>
        </div>
    );
}

function Pill({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
            {children}
        </span>
    );
}
