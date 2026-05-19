import type { AnalyticsEngineDataset } from '@cloudflare/workers-types';

/**
 * Lightweight telemetry helper for testing, debugging, and observability.
 *
 * Writes one Analytics Engine data point per adapter operation when an
 * AE dataset binding is provided. Useful for:
 *
 *   - per-operation latency tracking (signup, signin, session refresh)
 *   - per-jurisdiction throughput counters
 *   - active-DO heatmaps for the admin dashboard
 *   - regression detection when the adapter behaviour changes
 *
 * Indexed by operation name so queries like
 * `SELECT * WHERE index1 = 'do.user.create'` are cheap.
 *
 * AE indexes are limited to 20 blob columns. Schema:
 *   blobs:   [operation, model, jurisdiction, objectIdShort]
 *   doubles: [durationMs, ok]
 *   indexes: [operation]
 */
export interface AnalyticsRecorder {
  record(event: AdapterEvent): void;
}

export interface AdapterEvent {
  operation: string;
  model?: string;
  jurisdiction?: string;
  objectIdShort?: string;
  durationMs?: number;
  ok: boolean;
}

export function createNoopRecorder(): AnalyticsRecorder {
  return { record: () => {} };
}

export function createAnalyticsRecorder(dataset: AnalyticsEngineDataset | undefined): AnalyticsRecorder {
  if (!dataset) return createNoopRecorder();
  return {
    record(event) {
      try {
        dataset.writeDataPoint({
          blobs: [
            event.operation,
            event.model ?? 'unknown',
            event.jurisdiction ?? 'default',
            event.objectIdShort ?? '',
          ],
          doubles: [event.durationMs ?? 0, event.ok ? 1 : 0],
          indexes: [event.operation],
        });
      } catch {
        // Telemetry must never fail an auth operation. Swallow.
      }
    },
  };
}

/** Helper: time an async operation and emit a telemetry event. */
export async function recordAdapterEvent<T>(
  recorder: AnalyticsRecorder,
  base: Omit<AdapterEvent, 'durationMs' | 'ok'>,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    recorder.record({ ...base, durationMs: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    recorder.record({ ...base, durationMs: Date.now() - t0, ok: false });
    throw err;
  }
}
