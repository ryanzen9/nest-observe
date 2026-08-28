import { SpanKind, SpanStatusCode, type Context, type Meter, type Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

function durationSeconds(duration: readonly [number, number]): number {
  return duration[0] + duration[1] / 1e9;
}

function stringAttribute(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function numberAttribute(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class HttpMetricsSpanProcessor implements SpanProcessor {
  private readonly requestCount;
  private readonly requestDuration;
  private readonly errorCount;

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

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.SERVER) return;
    const attributes = {
      'service.name': this.serviceName,
      'http.route': stringAttribute(span.attributes['http.route'], '<unmatched>'),
      'http.request.method': stringAttribute(
        span.attributes['http.request.method'] ?? span.attributes['http.method'],
        'UNKNOWN',
      ),
      'http.response.status_code': numberAttribute(
        span.attributes['http.response.status_code'] ?? span.attributes['http.status_code'],
      ),
    };
    this.requestCount.add(1, attributes);
    this.requestDuration.record(durationSeconds(span.duration), attributes);
    if (span.status.code === SpanStatusCode.ERROR || attributes['http.response.status_code'] >= 500) {
      this.errorCount.add(1, attributes);
    }
  }

  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}
