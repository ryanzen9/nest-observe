import { randomUUID } from 'node:crypto';
import type { ObserveOptions, ResolvedObserveConfig } from './types';

type Environment = Record<string, string | undefined>;

const DEFAULT_ALLOWED_HEADERS = ['accept', 'content-type', 'user-agent', 'x-request-id', 'traceparent'];

function booleanValue(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value?.toLowerCase() === 'true') return true;
  if (value?.toLowerCase() === 'false') return false;
  return fallback;
}

function positiveInteger(value: number | string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function samplingValue(value: number | string | undefined): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

function environmentSampling(env: Environment): number {
  const sampler = env.OTEL_TRACES_SAMPLER?.toLowerCase();
  if (sampler === 'always_off' || sampler === 'parentbased_always_off') return 0;
  if (sampler === 'always_on' || sampler === 'parentbased_always_on') return 1;
  return samplingValue(env.OTEL_TRACES_SAMPLER_ARG);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}

export function parseKeyValueList(value?: string): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(',').flatMap((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return [];
    const key = decode(entry.slice(0, separator));
    const itemValue = decode(entry.slice(separator + 1));
    return key ? [[key, itemValue]] : [];
  }));
}

function appendSignalPath(endpoint: string | undefined, signal: 'traces' | 'metrics' | 'logs'): string | undefined {
  if (!endpoint) return undefined;
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

function optionalString(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export function resolveObserveConfig(
  options: ObserveOptions = {},
  env: Environment = process.env,
): ResolvedObserveConfig {
  const otelResources = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES);
  const resourceAttributes = { ...otelResources, ...options.resourceAttributes };
  const genericEndpoint = optionalString(options.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const sampling = options.sampling === undefined
    ? environmentSampling(env)
    : samplingValue(options.sampling);
  const allowedHeaders = Array.from(new Set([
    ...DEFAULT_ALLOWED_HEADERS,
    ...(options.allowedHeaders ?? []),
  ].map((header) => header.toLowerCase().trim()).filter(Boolean)));

  const result: ResolvedObserveConfig = {
    enabled: booleanValue(options.enabled ?? env.OBSERVE_ENABLED, true),
    serviceName: options.serviceName ?? env.OTEL_SERVICE_NAME ?? otelResources['service.name'] ?? 'nest-application',
    serviceVersion: options.serviceVersion ?? env.OTEL_SERVICE_VERSION ?? otelResources['service.version'] ?? 'unknown',
    environment: options.environment
      ?? env.OBSERVE_ENVIRONMENT
      ?? otelResources['deployment.environment.name']
      ?? env.NODE_ENV
      ?? 'development',
    instanceId: options.instanceId
      ?? otelResources['service.instance.id']
      ?? env.OTEL_SERVICE_INSTANCE_ID
      ?? env.HOSTNAME
      ?? randomUUID(),
    endpoints: {
      traces: optionalString(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ?? appendSignalPath(genericEndpoint, 'traces'),
      metrics: optionalString(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ?? appendSignalPath(genericEndpoint, 'metrics'),
      logs: optionalString(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) ?? appendSignalPath(genericEndpoint, 'logs'),
    },
    headers: { ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS), ...options.headers },
    traces: booleanValue(options.traces, true),
    logs: booleanValue(options.logs, true),
    metrics: booleanValue(options.metrics, true),
    providerTracing: booleanValue(options.providerTracing, true),
    controllerTracing: booleanValue(options.controllerTracing, true),
    sampling,
    allowedHeaders,
    exportTimeoutMillis: positiveInteger(options.exportTimeoutMillis ?? env.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000),
    metricExportIntervalMillis: positiveInteger(options.metricExportIntervalMillis ?? env.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
    resourceAttributes,
  };
  if (options.exporters) result.exporters = options.exporters;
  return result;
}
