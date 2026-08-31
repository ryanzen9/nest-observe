import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface ObserveExporters {
  /** Primarily useful for custom backends and tests. OTLP is used by default. */
  span?: SpanExporter;
  log?: LogRecordExporter;
  metricReader?: MetricReader;
}

export type ObserveSignal = 'sdk' | 'traces' | 'metrics' | 'logs';
export type ObserveErrorStage = 'initialization' | 'export' | 'forceFlush' | 'shutdown';
export type ObserveStatus = 'inactive' | 'starting' | 'active' | 'degraded' | 'stopped';

export interface ObserveErrorEvent {
  signal: ObserveSignal;
  stage: ObserveErrorStage;
  error: Error;
  timestamp: number;
}

export interface ObserveOptions {
  enabled?: boolean;
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  instanceId?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  traces?: boolean;
  logs?: boolean;
  metrics?: boolean;
  providerTracing?: boolean;
  controllerTracing?: boolean;
  sampling?: number;
  allowedHeaders?: string[];
  exportTimeoutMillis?: number;
  metricExportIntervalMillis?: number;
  resourceAttributes?: Record<string, string | number | boolean>;
  /** Writes sanitized, rate-limited SDK/export failures to stderr. Defaults to true. */
  diagnosticLogging?: boolean;
  /** Receives sanitized pipeline failure notifications without affecting the application. */
  onError?: (event: ObserveErrorEvent) => void;
  /** Throws synchronous initialization failures instead of degrading to an inactive handle. */
  failFast?: boolean;
  exporters?: ObserveExporters;
}

export interface ResolvedObserveConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  instanceId: string;
  endpoints: {
    traces: string | undefined;
    metrics: string | undefined;
    logs: string | undefined;
  };
  headers: Record<string, string>;
  traces: boolean;
  logs: boolean;
  metrics: boolean;
  providerTracing: boolean;
  controllerTracing: boolean;
  sampling: number;
  allowedHeaders: string[];
  exportTimeoutMillis: number;
  metricExportIntervalMillis: number;
  resourceAttributes: Record<string, string | number | boolean>;
  diagnosticLogging: boolean;
  failFast: boolean;
  exporters?: ObserveExporters;
}

export interface ObserveHandle {
  readonly started: boolean;
  readonly status: ObserveStatus;
  readonly lastError: ObserveErrorEvent | undefined;
  readonly config: Readonly<ResolvedObserveConfig>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
