/**
 * Root-level loading UI. Next.js App Router renders this instantly when
 * navigating into a route segment whose data isn't ready yet — so soft
 * navigations always show something within a frame instead of a brief
 * blank screen.
 *
 * Keep this small and zero-effect: any styling here ships in the static
 * skeleton bundle. No animations beyond a single spinner pulse.
 */
export default function RootLoading() {
    return (
        <div className="flex items-center gap-2 text-sm text-gray-500" role="status" aria-live="polite">
            <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            Loading…
        </div>
    );
}
