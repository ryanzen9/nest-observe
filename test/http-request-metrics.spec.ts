import type { IncomingMessage, ServerResponse } from 'node:http';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { HttpRequestMetrics } from '../src/metrics/http-request-metrics';

describe('HttpRequestMetrics', () => {
  it('records low-cardinality route counts and errors independently of spans', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const recorder = new HttpRequestMetrics(provider.getMeter('test'), 'mall-api');
    const request = {
      method: 'POST',
      baseUrl: '/api',
      route: { path: '/orders/:id' },
    } as unknown as IncomingMessage;
    recorder.start(request);
    recorder.record(request, { statusCode: 503 } as ServerResponse);
    await provider.forceFlush();

    const metrics = exporter.getMetrics().flatMap((item) => item.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(expect.arrayContaining([
      'http.server.request.count', 'http.server.request.duration', 'http.server.error.count',
    ]));
    expect(metrics[0]?.dataPoints[0]?.attributes).toMatchObject({
      'http.route': '/api/orders/:id',
      'http.request.method': 'POST',
      'http.response.status_code': 503,
    });
    await provider.shutdown();
  });
});
