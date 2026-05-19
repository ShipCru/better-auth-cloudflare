import type {
  DurableObjectNamespace,
  KVNamespace,
  AnalyticsEngineDataset,
} from '@cloudflare/workers-types';

export interface CloudflareBindings {
  USER_DO: DurableObjectNamespace;
  IDENTITY_DO: DurableObjectNamespace;
  KV: KVNamespace;
  AUTH_ANALYTICS?: AnalyticsEngineDataset;
}
