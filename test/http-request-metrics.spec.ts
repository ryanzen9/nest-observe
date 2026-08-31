import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { HttpRequestMetrics } from '../src/metrics/http-request-metrics';
import { NestHttpMetricsInterceptor } from '../src/nest/observe.module';

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
    recorder.start(request);
    recorder.record(request, { statusCode: 503 } as ServerResponse);
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
    const count = metrics.find((metric) => metric.descriptor.name === 'http.server.request.count');
    expect((count?.dataPoints[0] as { value?: number } | undefined)?.value).toBe(1);
    await provider.shutdown();
  });

  it('records HTTP metrics at response finish when Nest was loaded before instrumentation', () => {
    const request = { method: 'GET', route: { path: '/orders/:id' } } as unknown as IncomingMessage;
    const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as ServerResponse;
    const metrics = { start: vi.fn(() => true), record: vi.fn(() => true) };
    const interceptor = new NestHttpMetricsInterceptor({
      started: true,
      httpRequestMetrics: metrics,
    } as never);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    };
    const result = of('ok');

    expect(interceptor.intercept(context as never, { handle: () => result })).toBe(result);
    expect(metrics.start).toHaveBeenCalledWith(request);
    response.emit('finish');
    expect(metrics.record).toHaveBeenCalledWith(request, response);
  });
});
