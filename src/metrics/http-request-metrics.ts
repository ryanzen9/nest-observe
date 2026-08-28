import type { Meter } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';

type FrameworkRequest = IncomingMessage & {
  baseUrl?: string;
  route?: { path?: string };
  routerPath?: string;
  routeOptions?: { url?: string };
};

function routeFor(request: FrameworkRequest): string {
  const route = request.route?.path ?? request.routerPath ?? request.routeOptions?.url;
  if (!route) return '<unmatched>';
  return `${request.baseUrl ?? ''}${route}` || '<unmatched>';
}

export class HttpRequestMetrics {
  private readonly requestCount;
  private readonly requestDuration;
  private readonly errorCount;
  private readonly startedAt = new WeakMap<IncomingMessage, bigint>();

  constructor(meter: Meter, private readonly serviceName: string) {
    this.requestCount = meter.createCounter('http.server.request.count', {
      description: 'Number of completed inbound HTTP requests',
      unit: '{request}',
    });
    this.requestDuration = meter.createHistogram('http.server.request.duration', {
      description: 'Inbound HTTP request duration',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
    });
    this.errorCount = meter.createCounter('http.server.error.count', {
      description: 'Number of failed inbound HTTP requests',
      unit: '{error}',
    });
  }

  start(request: IncomingMessage): void {
    this.startedAt.set(request, process.hrtime.bigint());
  }

  record(request: IncomingMessage, response: ServerResponse): void {
    const statusCode = Number.isFinite(response.statusCode) ? response.statusCode : 0;
    const attributes = {
      'service.name': this.serviceName,
      'http.route': routeFor(request as FrameworkRequest),
      'http.request.method': request.method ?? 'UNKNOWN',
      'http.response.status_code': statusCode,
    };
    this.requestCount.add(1, attributes);
    const started = this.startedAt.get(request);
    if (started !== undefined) {
      this.requestDuration.record(Number(process.hrtime.bigint() - started) / 1e9, attributes);
      this.startedAt.delete(request);
    }
    if (statusCode >= 500) this.errorCount.add(1, attributes);
  }
}
