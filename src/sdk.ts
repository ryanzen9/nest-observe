import { logs } from '@opentelemetry/api-logs';
import { metrics, trace } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationType, MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { AlwaysOffSampler, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resolveObserveConfig } from './config';
import { ProcessExceptionCapture } from './exceptions/process-exception-capture';
import { CompatibleNestInstrumentation } from './instrumentation';
import { NestLoggerInstrumentation, OpenTelemetryLogEmitter } from './logs';
import { HttpRequestMetrics, RuntimeMetrics } from './metrics';
import { createObserveResource, SDK_NAME, SDK_VERSION } from './resource';
import { isSensitiveKey } from './security/redaction';
import { SpanRedactionProcessor } from './security/span-redaction-processor';
import type { ObserveHandle, ObserveOptions, ResolvedObserveConfig } from './types';

export interface ObserveRuntime extends ObserveHandle {
  readonly tracerProvider: NodeTracerProvider | undefined;
  readonly meterProvider: MeterProvider | undefined;
  readonly loggerProvider: LoggerProvider | undefined;
}

class InactiveObserveHandle implements ObserveRuntime {
  readonly started = false;
  readonly tracerProvider = undefined;
  readonly meterProvider = undefined;
  readonly loggerProvider = undefined;
  constructor(readonly config: Readonly<ResolvedObserveConfig>) {}
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

class ActiveObserveHandle implements ObserveRuntime {
  readonly started = true;
  private stopped = false;

  constructor(
    readonly config: Readonly<ResolvedObserveConfig>,
    readonly tracerProvider: NodeTracerProvider | undefined,
    readonly meterProvider: MeterProvider | undefined,
    readonly loggerProvider: LoggerProvider | undefined,
    private readonly runtimeMetrics: RuntimeMetrics | undefined,
    private readonly loggerInstrumentation: NestLoggerInstrumentation | undefined,
    private readonly exceptionCapture: ProcessExceptionCapture,
    private readonly instrumentations: Instrumentation[],
  ) {}

  async forceFlush(): Promise<void> {
    await Promise.allSettled([
      this.tracerProvider?.forceFlush(),
      this.meterProvider?.forceFlush(),
      this.loggerProvider?.forceFlush({ timeoutMillis: this.config.exportTimeoutMillis }),
    ].filter((item): item is Promise<void> => Boolean(item)));
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.loggerInstrumentation?.disable();
    this.runtimeMetrics?.stop();
    this.exceptionCapture.stop();
    for (const instrumentation of this.instrumentations) {
      try { instrumentation.disable(); } catch { /* best effort */ }
    }
    await this.forceFlush();
    await Promise.allSettled([
      this.tracerProvider?.shutdown(),
      this.meterProvider?.shutdown(),
      this.loggerProvider?.shutdown(),
    ].filter((item): item is Promise<void> => Boolean(item)));
    if (activeRuntime === this) activeRuntime = undefined;
  }
}

let activeRuntime: ObserveRuntime | undefined;

function exporterConfig(url: string | undefined, config: ResolvedObserveConfig) {
  return {
    ...(url ? { url } : {}),
    headers: config.headers,
    timeoutMillis: config.exportTimeoutMillis,
  };
}

function createTraceProvider(
  config: ResolvedObserveConfig,
  resource: ReturnType<typeof createObserveResource>,
) {
  if (!config.traces && !config.metrics) return undefined;
  const spanProcessors: SpanProcessor[] = [new SpanRedactionProcessor()];
  if (config.traces) {
    const exporter: SpanExporter = config.exporters?.span
      ?? new OTLPTraceExporter(exporterConfig(config.endpoints.traces, config));
    spanProcessors.push(new BatchSpanProcessor(exporter, {
      exportTimeoutMillis: config.exportTimeoutMillis,
      maxQueueSize: 2_048,
      maxExportBatchSize: 512,
    }));
  }
  const provider = new NodeTracerProvider({
    resource,
    sampler: config.traces
      ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampling) })
      : new AlwaysOffSampler(),
    spanProcessors,
    spanLimits: { attributeCountLimit: 64, eventCountLimit: 64, linkCountLimit: 16 },
  });
  provider.register();
  return provider;
}

function createMeterProvider(config: ResolvedObserveConfig, resource: ReturnType<typeof createObserveResource>) {
  if (!config.metrics) return undefined;
  let reader: MetricReader;
  if (config.exporters?.metricReader) {
    reader = config.exporters.metricReader;
  } else {
    reader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(exporterConfig(config.endpoints.metrics, config)),
      exportIntervalMillis: config.metricExportIntervalMillis,
      exportTimeoutMillis: Math.min(config.exportTimeoutMillis, config.metricExportIntervalMillis),
      cardinalityLimits: { default: 2_000, histogram: 2_000 },
    });
  }
  const provider = new MeterProvider({
    resource,
    readers: [reader],
    views: [{
      instrumentName: 'http.server.request.duration',
      meterName: '@opentelemetry/instrumentation-http',
      aggregation: { type: AggregationType.DROP },
    }],
  });
  metrics.setGlobalMeterProvider(provider);
  return provider;
}

function createLoggerProvider(config: ResolvedObserveConfig, resource: ReturnType<typeof createObserveResource>) {
  if (!config.logs) return undefined;
  const exporter: LogRecordExporter = config.exporters?.log
    ?? new OTLPLogExporter(exporterConfig(config.endpoints.logs, config));
  const provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({
      exporter,
      exportTimeoutMillis: config.exportTimeoutMillis,
      maxQueueSize: 2_048,
      maxExportBatchSize: 512,
    })],
  });
  logs.setGlobalLoggerProvider(provider);
  return provider;
}

export function observe(options: ObserveOptions = {}): ObserveRuntime {
  if (activeRuntime?.started) return activeRuntime;
  const config = resolveObserveConfig(options);
  if (!config.enabled) return new InactiveObserveHandle(config);
  let tracerProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let runtimeMetrics: RuntimeMetrics | undefined;
  let loggerInstrumentation: NestLoggerInstrumentation | undefined;
  let exceptionCapture: ProcessExceptionCapture | undefined;
  const instrumentations: Instrumentation[] = [];
  try {
    const resource = createObserveResource(config);
    meterProvider = createMeterProvider(config, resource);
    const meter = meterProvider?.getMeter(SDK_NAME, SDK_VERSION);
    tracerProvider = createTraceProvider(config, resource);
    loggerProvider = createLoggerProvider(config, resource);
    runtimeMetrics = meter ? new RuntimeMetrics(meter) : undefined;
    runtimeMetrics?.start();

    const otelLogger = loggerProvider?.getLogger(SDK_NAME, SDK_VERSION);
    const logEmitter = config.logs
      ? new OpenTelemetryLogEmitter(SDK_NAME, SDK_VERSION, otelLogger)
      : undefined;
    loggerInstrumentation = logEmitter
      ? new NestLoggerInstrumentation(logEmitter, {
        'service.name': config.serviceName,
        'service.version': config.serviceVersion,
        'deployment.environment.name': config.environment,
      })
      : undefined;
    loggerInstrumentation?.enable();
    exceptionCapture = new ProcessExceptionCapture(logEmitter);
    exceptionCapture.start();

    if (config.traces || config.metrics) {
      const safeHeaders = config.allowedHeaders.filter((header) => !isSensitiveKey(header));
      const httpRequestMetrics = meter ? new HttpRequestMetrics(meter, config.serviceName) : undefined;
      instrumentations.push(new HttpInstrumentation({
        requireParentforOutgoingSpans: false,
        headersToSpanAttributes: {
          client: { requestHeaders: safeHeaders, responseHeaders: safeHeaders },
          server: { requestHeaders: safeHeaders, responseHeaders: safeHeaders },
        },
        redactedQueryParams: [
          'sig', 'Signature', 'AWSAccessKeyId', 'X-Goog-Signature',
          'password', 'passwd', 'token', 'access_token', 'api_key', 'secret',
        ],
        ...(httpRequestMetrics ? {
          requestHook: (_span, request) => {
            if (!('getHeader' in request)) httpRequestMetrics.start(request as never);
          },
          applyCustomAttributesOnSpan: (_span, request, response) => {
            if ('setHeader' in response) httpRequestMetrics.record(request as never, response as never);
          },
        } : {}),
      }));
      instrumentations.push(new CompatibleNestInstrumentation({
        providerTracing: config.providerTracing,
        controllerTracing: config.controllerTracing,
      }));
      if (config.traces) instrumentations.push(new PrismaInstrumentation() as unknown as Instrumentation);
      registerInstrumentations({
        instrumentations,
        ...(tracerProvider ? { tracerProvider } : {}),
        ...(meterProvider ? { meterProvider } : {}),
      });
    }
    const runtime = new ActiveObserveHandle(
      config,
      tracerProvider,
      meterProvider,
      loggerProvider,
      runtimeMetrics,
      loggerInstrumentation,
      exceptionCapture,
      instrumentations,
    );
    activeRuntime = runtime;
    return runtime;
  } catch {
    loggerInstrumentation?.disable();
    runtimeMetrics?.stop();
    exceptionCapture?.stop();
    for (const instrumentation of instrumentations) {
      try { instrumentation.disable(); } catch { /* best effort */ }
    }
    void Promise.allSettled([
      tracerProvider?.shutdown(),
      meterProvider?.shutdown(),
      loggerProvider?.shutdown(),
    ].filter((item): item is Promise<void> => Boolean(item)));
    return new InactiveObserveHandle(config);
  }
}

export function getObserveRuntime(): ObserveRuntime | undefined {
  return activeRuntime;
}
