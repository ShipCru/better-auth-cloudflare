"use client";

import { Fragment, useEffect, useState } from "react";
import {
    BACKEND_VARIANTS,
    SCENARIOS,
    type BenchRunResponse,
    type BenchScenarioResult,
    type ScenarioId,
    type VariantId,
} from "@/lib/bench-types";

interface MeGeo {
    colo: string | null;
    country: string | null;
    continent: string | null;
    region: string | null;
    regionCode: string | null;
    city: string | null;
    timezone: string | null;
    asn: number | null;
    asOrganization: string | null;
    latitude: string | null;
    longitude: string | null;
}

interface RunRow extends BenchScenarioResult {
    transport: "binding" | "http";
    scenarioLabel: string;
    variantLabel: string;
}

interface RegionalRow {
    variantId: VariantId;
    variantLabel: string;
    op: string;
    n: number;
    ts: string;
    regions: Array<{
        region: string;
        hint: string;
        wallTime: number;
        result: {
            colo: string | null;
            country: string | null;
            n: number;
            ok: number;
            error: number;
            p50: number;
            p95: number;
            p99: number;
            min: number;
            max: number;
        } | null;
        error: string | null;
    }>;
}

export default function BenchPage() {
    const [variantId, setVariantId] = useState<VariantId>("current");
    const [scenarioId, setScenarioId] = useState<ScenarioId>("cold-burst-signup");
    const [n, setN] = useState<number>(5);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rows, setRows] = useState<RunRow[]>([]);
    const [regionalRows, setRegionalRows] = useState<RegionalRow[]>([]);
    const [runningRegional, setRunningRegional] = useState(false);
    const [regionalOp, setRegionalOp] = useState<"signin" | "signup" | "anon" | "get-session">("signin");
    const [me, setMe] = useState<MeGeo | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/bench/me", { cache: "no-store" })
            .then(r => r.json())
            .then((data: MeGeo) => {
                if (!cancelled) setMe(data);
            })
            .catch(() => {
                if (!cancelled) setMe(null);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    async function runRegional() {
        setRunningRegional(true);
        setError(null);
        try {
            const res = await fetch("/api/bench/regional", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ variantId, op: regionalOp, n }),
            });
            const data = await res.json();
            if (data?.error) {
                setError(data.error);
                return;
            }
            setRegionalRows(prev => [
                {
                    ...data,
                    variantId,
                    variantLabel: variant.label,
                },
                ...prev,
            ]);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRunningRegional(false);
        }
    }

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
                {me && (
                    <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40 px-3 py-2 text-xs">
                        <span className="font-semibold text-blue-900 dark:text-blue-200">You are here:</span>
                        {me.colo && <Pill>colo {me.colo}</Pill>}
                        {me.city && me.country && (
                            <Pill>
                                {me.city}, {me.country}
                                {me.continent ? ` (${me.continent})` : ""}
                            </Pill>
                        )}
                        {!me.city && me.country && (
                            <Pill>
                                {me.country}
                                {me.continent ? ` (${me.continent})` : ""}
                            </Pill>
                        )}
                        {me.timezone && <Pill>{me.timezone}</Pill>}
                        {me.asn && (
                            <Pill>
                                ASN {me.asn}
                                {me.asOrganization ? ` (${me.asOrganization})` : ""}
                            </Pill>
                        )}
                    </div>
                )}
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

                <div className="flex items-end gap-3 flex-wrap">
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
                    <div>
                        <label className="block text-sm font-medium mb-1">Regional op</label>
                        <select
                            value={regionalOp}
                            onChange={e => setRegionalOp(e.target.value as typeof regionalOp)}
                            className="rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
                        >
                            <option value="signin">signin (warm, same user)</option>
                            <option value="signup">signup (fresh user each iter)</option>
                            <option value="anon">anon sign-in</option>
                            <option value="get-session">get-session</option>
                        </select>
                    </div>
                    <button
                        onClick={runOne}
                        disabled={running || runningRegional}
                        className="rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium transition-colors"
                    >
                        {running ? "Running…" : "Run (this colo)"}
                    </button>
                    <button
                        onClick={runRegional}
                        disabled={running || runningRegional}
                        title="Fan out to every Cloudflare region via locationHint-pinned Durable Objects"
                        className="rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium transition-colors"
                    >
                        {runningRegional ? "Probing all regions…" : `Run ${regionalOp} from all 9 regions`}
                    </button>
                </div>

                {error && (
                    <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 px-3 py-2 text-sm">
                        {error}
                    </div>
                )}
            </div>

            {regionalRows.length > 0 && (
                <div className="space-y-4">
                    {regionalRows.map((r, idx) => (
                        <RegionalCard key={`reg-${r.ts}-${idx}`} row={r} />
                    ))}
                </div>
            )}

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

function RegionalCard({ row }: { row: RegionalRow }) {
    const successful = row.regions.filter(r => r.result && r.result.ok > 0);
    const maxP50 = Math.max(1, ...successful.map(r => r.result!.p50));
    return (
        <section className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/30 dark:bg-emerald-950/20 p-5 shadow-sm">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold">
                        Regional probe · {row.op} · n={row.n}
                    </h2>
                    <p className="text-xs text-gray-500">{row.variantLabel}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Pill>{row.regions.length} regions</Pill>
                    <span>{new Date(row.ts).toLocaleTimeString()}</span>
                </div>
            </header>

            <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm border-separate border-spacing-0">
                    <thead>
                        <tr className="text-left text-xs uppercase text-gray-500">
                            <th className="pb-2 pr-3 font-medium">Region</th>
                            <th className="pb-2 pr-3 font-medium">Hint</th>
                            <th className="pb-2 pr-3 font-medium">ok / n</th>
                            <th className="pb-2 pr-3 font-medium">p50</th>
                            <th className="pb-2 pr-3 font-medium">p95</th>
                            <th className="pb-2 pr-3 font-medium">p99</th>
                            <th className="pb-2 pr-3 font-medium">min</th>
                            <th className="pb-2 pr-3 font-medium">max</th>
                            <th className="pb-2 pr-3 font-medium">distribution</th>
                        </tr>
                    </thead>
                    <tbody>
                        {row.regions.map(r => {
                            if (r.error || !r.result) {
                                return (
                                    <tr key={r.region} className="border-t border-gray-200 dark:border-gray-800">
                                        <td className="py-2 pr-3 font-mono">{r.region}</td>
                                        <td className="py-2 pr-3 text-xs text-gray-500">{r.hint}</td>
                                        <td colSpan={7} className="py-2 pr-3 text-xs text-red-600 dark:text-red-400">
                                            {r.error ?? "no result"}
                                        </td>
                                    </tr>
                                );
                            }
                            const pct = (r.result.p50 / maxP50) * 100;
                            return (
                                <tr key={r.region} className="border-t border-gray-200 dark:border-gray-800">
                                    <td className="py-2 pr-3 font-mono">{r.region}</td>
                                    <td className="py-2 pr-3 text-xs text-gray-500">{r.hint}</td>
                                    <td className="py-2 pr-3 font-mono">
                                        {r.result.ok}/{r.result.n}
                                    </td>
                                    <td className="py-2 pr-3 font-mono">{r.result.p50} ms</td>
                                    <td className="py-2 pr-3 font-mono">{r.result.p95} ms</td>
                                    <td className="py-2 pr-3 font-mono">{r.result.p99} ms</td>
                                    <td className="py-2 pr-3 font-mono text-gray-500">{r.result.min}</td>
                                    <td className="py-2 pr-3 font-mono text-gray-500">{r.result.max}</td>
                                    <td className="py-2 pr-3">
                                        <div className="h-3 w-32 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
                                            <div className="h-full bg-emerald-500/80" style={{ width: `${pct}%` }} />
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <details className="mt-3">
                <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400">raw JSON</summary>
                <pre className="mt-2 rounded bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-900 p-3 text-[10px] overflow-x-auto max-h-64">
                    {JSON.stringify(row, null, 2)}
                </pre>
            </details>

            <p className="mt-3 text-xs text-gray-500">
                Each row = a Durable Object pinned to that region via <code>locationHint</code>. The DO calls the chosen
                auth backend from its own colo via service binding. Timings reflect real region-to-region latency,
                in-isolate (no HTTP/TLS noise).
            </p>
        </section>
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
                    {row.geo.colo && <Pill>colo {row.geo.colo}</Pill>}
                    {row.geo.country && <Pill>{row.geo.country}</Pill>}
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

            <GeoBlock geo={row.geo} />

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

function GeoBlock({ geo }: { geo: BenchScenarioResult["geo"] }) {
    const rows: Array<[string, string | number | null]> = [
        ["colo", geo.colo],
        ["city", geo.city ? `${geo.city}${geo.regionCode ? `, ${geo.regionCode}` : ""}` : null],
        ["country", geo.country ? `${geo.country}${geo.continent ? ` (${geo.continent})` : ""}` : null],
        ["postal", geo.postalCode],
        ["timezone", geo.timezone],
        ["lat/lng", geo.latitude && geo.longitude ? `${geo.latitude}, ${geo.longitude}` : null],
        ["ASN", geo.asn && geo.asOrganization ? `${geo.asn} (${geo.asOrganization})` : geo.asn],
        ["TLS", geo.tlsVersion && geo.tlsCipher ? `${geo.tlsVersion} / ${geo.tlsCipher}` : null],
    ];
    const visible = rows.filter(([, v]) => v != null);
    if (visible.length === 0) return null;
    return (
        <details className="mt-4">
            <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400">
                geo + network metadata
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
                {visible.map(([k, v]) => (
                    <Fragment key={k}>
                        <dt className="text-gray-500">{k}</dt>
                        <dd>{String(v)}</dd>
                    </Fragment>
                ))}
            </dl>
        </details>
    );
}
