import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface ObserveExporters {
  /** Primarily useful for custom backends and tests. OTLP is used by default. */
  span?: SpanExporter;
  log?: LogRecordExporter;
  metricReader?: MetricReader;
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
  exporters?: ObserveExporters;
}

export interface ObserveHandle {
  readonly started: boolean;
  readonly config: Readonly<ResolvedObserveConfig>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
