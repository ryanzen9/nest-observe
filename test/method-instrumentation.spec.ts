import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { IgnoreTrace } from '../src/decorators';
import { NestMethodInstrumenter } from '../src/nest/method-instrumenter';

describe('NestMethodInstrumenter', () => {
  it('wraps provider methods with spans and method metrics, including failures', async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });
    const instrumenter = new NestMethodInstrumenter(
      tracerProvider.getTracer('test'),
      meterProvider.getMeter('test'),
    );
    class Orders {
      async create() { return 'ok'; }
      fail() { throw new Error('no inventory'); }
      @IgnoreTrace()
      health() { return 'ok'; }
    }
    const service = new Orders();
    instrumenter.instrumentInstance(service, 'provider', 'Orders');

    await service.create();
    expect(() => service.fail()).toThrow('no inventory');
    service.health();
    await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);

    const spans = spanExporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(['Orders.create', 'Orders.fail']));
    expect(spans.map((span) => span.name)).not.toContain('Orders.health');
    expect(spans.find((span) => span.name === 'Orders.fail')?.status.code).toBe(SpanStatusCode.ERROR);
    const metrics = metricExporter.getMetrics().flatMap((item) => item.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(expect.arrayContaining([
      'nestjs.method.calls', 'nestjs.method.duration', 'nestjs.method.errors',
    ]));
    const calls = metrics.find((metric) => metric.descriptor.name === 'nestjs.method.calls');
    expect(calls?.dataPoints.some((point) => point.attributes['nestjs.provider'] === 'Orders')).toBe(true);
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });

  it('can instrument a prototype before request-scoped instances exist', async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    const meterProvider = new MeterProvider();
    const instrumenter = new NestMethodInstrumenter(
      tracerProvider.getTracer('test'),
      meterProvider.getMeter('test'),
    );
    class RequestScopedService { run() { return 42; } }
    instrumenter.instrumentPrototype(RequestScopedService, 'provider', 'RequestScopedService');
    expect(new RequestScopedService().run()).toBe(42);
    await tracerProvider.forceFlush();
    expect(spanExporter.getFinishedSpans().map((span) => span.name)).toContain('RequestScopedService.run');
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });

  it('safely normalizes a Symbol provider token used as the component name', async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
    const meterProvider = new MeterProvider();
    const instrumenter = new NestMethodInstrumenter(
      tracerProvider.getTracer('test'),
      meterProvider.getMeter('test'),
    );
    class SymbolProvider { get() { return 'value'; } }
    const service = new SymbolProvider();

    instrumenter.instrumentInstance(
      service,
      'provider',
      Symbol('REDIS') as unknown as string,
    );

    expect(service.get()).toBe('value');
    await tracerProvider.forceFlush();
    expect(spanExporter.getFinishedSpans().map((span) => span.name)).toContain('Symbol(REDIS).get');
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });
});
