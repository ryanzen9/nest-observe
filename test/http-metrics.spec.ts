import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { HttpMetricsSpanProcessor } from '../src/metrics/http-metrics';

describe('HttpMetricsSpanProcessor', () => {
  it('records count, duration, errors and only low-cardinality route dimensions', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const processor = new HttpMetricsSpanProcessor(provider.getMeter('test'), 'mall-api');

    processor.onEnd({
      kind: SpanKind.SERVER,
      duration: [0, 250_000_000],
      status: { code: SpanStatusCode.ERROR },
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/orders/:id',
        'http.response.status_code': 500,
        'url.full': 'https://example.test/orders/secret-id',
      },
    } as never);
    await provider.forceFlush();

    const metrics = exporter.getMetrics().flatMap((item) => item.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(expect.arrayContaining([
      'http.server.request.count',
      'http.server.request.duration',
      'http.server.error.count',
    ]));
    const count = metrics.find((metric) => metric.descriptor.name === 'http.server.request.count');
    expect(count?.dataPoints[0]?.attributes).toEqual({
      'service.name': 'mall-api',
      'http.route': '/orders/:id',
      'http.request.method': 'GET',
      'http.response.status_code': 500,
    });
    expect(count?.dataPoints[0]?.attributes).not.toHaveProperty('url.full');
    await provider.shutdown();
  });

  it('ignores non-server spans', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const processor = new HttpMetricsSpanProcessor(provider.getMeter('test'), 'service');
    processor.onEnd({ kind: SpanKind.CLIENT, duration: [1, 0], attributes: {}, status: { code: 0 } } as never);
    await provider.forceFlush();
    expect(exporter.getMetrics()).toEqual([]);
    await provider.shutdown();
  });
});
