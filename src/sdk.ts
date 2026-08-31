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
import { ObserveDiagnostics, toError, withExporterDiagnostics } from './diagnostics';
import { ProcessExceptionCapture } from './exceptions/process-exception-capture';
import { CompatibleNestInstrumentation } from './instrumentation';
import { NestLoggerInstrumentation, OpenTelemetryLogEmitter } from './logs';
import { HttpRequestMetrics, RuntimeMetrics } from './metrics';
import { createObserveResource, SDK_NAME, SDK_VERSION } from './resource';
import { isSensitiveKey } from './security/redaction';
import { SpanRedactionProcessor } from './security/span-redaction-processor';
import type {
  ObserveErrorEvent,
  ObserveHandle,
  ObserveOptions,
  ObserveSignal,
  ObserveStatus,
  ResolvedObserveConfig,
} from './types';

export interface ObserveRuntime extends ObserveHandle {
  readonly tracerProvider: NodeTracerProvider | undefined;
  readonly meterProvider: MeterProvider | undefined;
  readonly loggerProvider: LoggerProvider | undefined;
  readonly httpRequestMetrics: HttpRequestMetrics | undefined;
}

class InactiveObserveHandle implements ObserveRuntime {
  readonly started = false;
  readonly tracerProvider = undefined;
  readonly meterProvider = undefined;
  readonly loggerProvider = undefined;
  readonly httpRequestMetrics = undefined;
  constructor(
    readonly config: Readonly<ResolvedObserveConfig>,
    private readonly diagnostics: ObserveDiagnostics,
  ) {}
  get status(): ObserveStatus { return this.diagnostics.status; }
  get lastError(): ObserveErrorEvent | undefined { return this.diagnostics.lastError; }
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
    readonly httpRequestMetrics: HttpRequestMetrics | undefined,
    private readonly runtimeMetrics: RuntimeMetrics | undefined,
    private readonly loggerInstrumentation: NestLoggerInstrumentation | undefined,
    private readonly exceptionCapture: ProcessExceptionCapture,
    private readonly instrumentations: Instrumentation[],
    private readonly diagnostics: ObserveDiagnostics,
  ) {}

  get status(): ObserveStatus { return this.diagnostics.status; }
  get lastError(): ObserveErrorEvent | undefined { return this.diagnostics.lastError; }

  async forceFlush(): Promise<void> {
    await this.runSafely('forceFlush', [
      ...(this.config.traces && this.tracerProvider
        ? [['traces', () => this.tracerProvider!.forceFlush()] as const]
        : []),
      ...(this.config.metrics && this.meterProvider
        ? [['metrics', () => this.meterProvider!.forceFlush()] as const]
        : []),
      ...(this.config.logs && this.loggerProvider
        ? [['logs', () => this.loggerProvider!.forceFlush({ timeoutMillis: this.config.exportTimeoutMillis })] as const]
        : []),
    ]);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.loggerInstrumentation?.disable();
    this.exceptionCapture.stop();
    for (const instrumentation of this.instrumentations) {
      try { instrumentation.disable(); } catch (error) {
        this.diagnostics.failure('sdk', 'shutdown', error);
      }
    }
    await this.forceFlush();
    this.runtimeMetrics?.stop();
    await this.runSafely('shutdown', [
      ...(this.tracerProvider ? [['traces', () => this.tracerProvider!.shutdown()] as const] : []),
      ...(this.meterProvider ? [['metrics', () => this.meterProvider!.shutdown()] as const] : []),
      ...(this.loggerProvider ? [['logs', () => this.loggerProvider!.shutdown()] as const] : []),
    ]);
    if (activeRuntime === this) activeRuntime = undefined;
    this.diagnostics.stop();
  }

  private async runSafely(
    stage: 'forceFlush' | 'shutdown',
    operations: ReadonlyArray<readonly [ObserveSignal, () => Promise<void>]>,
  ): Promise<void> {
    await Promise.all(operations.map(async ([signal, operation]) => {
      try {
        await operation();
      } catch (error) {
        this.diagnostics.failure(signal, stage, error);
      }
    }));
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
  diagnostics: ObserveDiagnostics,
) {
  if (!config.traces && !config.metrics) return undefined;
  const spanProcessors: SpanProcessor[] = [new SpanRedactionProcessor()];
  if (config.traces) {
    const exporter = config.exporters?.span
      ?? new OTLPTraceExporter(exporterConfig(config.endpoints.traces, config));
    spanProcessors.push(new BatchSpanProcessor(withExporterDiagnostics(
      exporter,
      'traces',
      diagnostics,
    ) as SpanExporter, {
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

function createMeterProvider(
  config: ResolvedObserveConfig,
  resource: ReturnType<typeof createObserveResource>,
  diagnostics: ObserveDiagnostics,
) {
  if (!config.metrics) return undefined;
  let reader: MetricReader;
  if (config.exporters?.metricReader) {
    reader = config.exporters.metricReader;
  } else {
    reader = new PeriodicExportingMetricReader({
      exporter: withExporterDiagnostics(
        new OTLPMetricExporter(exporterConfig(config.endpoints.metrics, config)),
        'metrics',
        diagnostics,
      ),
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

function createLoggerProvider(
  config: ResolvedObserveConfig,
  resource: ReturnType<typeof createObserveResource>,
  diagnostics: ObserveDiagnostics,
) {
  if (!config.logs) return undefined;
  const exporter = config.exporters?.log
    ?? new OTLPLogExporter(exporterConfig(config.endpoints.logs, config));
  const provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({
      exporter: withExporterDiagnostics(exporter, 'logs', diagnostics) as LogRecordExporter,
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
  const diagnostics = new ObserveDiagnostics(config.diagnosticLogging, options.onError);
  if (!config.enabled) {
    diagnostics.inactive();
    return new InactiveObserveHandle(config, diagnostics);
  }
  let tracerProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let runtimeMetrics: RuntimeMetrics | undefined;
  let loggerInstrumentation: NestLoggerInstrumentation | undefined;
  let exceptionCapture: ProcessExceptionCapture | undefined;
  const instrumentations: Instrumentation[] = [];
  try {
    const resource = createObserveResource(config);
    meterProvider = createMeterProvider(config, resource, diagnostics);
    const meter = meterProvider?.getMeter(SDK_NAME, SDK_VERSION);
    const httpRequestMetrics = meter ? new HttpRequestMetrics(meter, config.serviceName) : undefined;
    tracerProvider = createTraceProvider(config, resource, diagnostics);
    loggerProvider = createLoggerProvider(config, resource, diagnostics);
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
      httpRequestMetrics,
      runtimeMetrics,
      loggerInstrumentation,
      exceptionCapture,
      instrumentations,
      diagnostics,
    );
    diagnostics.activate();
    activeRuntime = runtime;
    return runtime;
  } catch (error) {
    diagnostics.failure('sdk', 'initialization', error);
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
    diagnostics.inactive();
    if (config.failFast) throw toError(error);
    return new InactiveObserveHandle(config, diagnostics);
  }
}

export function getObserveRuntime(): ObserveRuntime | undefined {
  return activeRuntime;
}
