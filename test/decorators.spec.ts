import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstValueFrom, map, of } from 'rxjs';
import { IgnoreTrace, Trace, isTraceIgnored } from '../src/decorators';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

describe('@Trace()', () => {
  it('creates nested spans and records successful async execution', async () => {
    class PaymentService {
      @Trace()
      async pay() { return 'paid'; }
    }
    class OrderService {
      constructor(private readonly payment = new PaymentService()) {}
      @Trace('order.create')
      async create() { return this.payment.pay(); }
    }

    await new OrderService().create();
    const spans = exporter.getFinishedSpans();
    const order = spans.find((span) => span.name === 'order.create');
    const payment = spans.find((span) => span.name === 'PaymentService.pay');
    expect(order).toBeDefined();
    expect(payment?.parentSpanContext?.spanId).toBe(order?.spanContext().spanId);
    expect(order?.attributes['nestjs.method']).toBe('create');
  });

  it('records thrown exceptions and marks the span as error', () => {
    class BrokenService {
      @Trace()
      explode(): never { throw new TypeError('boom'); }
    }

    expect(() => new BrokenService().explode()).toThrow('boom');
    const span = exporter.getFinishedSpans().find((item) => item.name === 'BrokenService.explode');
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('marks ignored methods and classes for automatic instrumentation', () => {
    class HealthController {
      @IgnoreTrace()
      health() { return 'ok'; }
    }
    expect(isTraceIgnored(HealthController.prototype.health, HealthController)).toBe(true);
  });

  it('keeps the active parent context for cold RxJS observables', async () => {
    class StreamService {
      @Trace()
      inner() { return 'value'; }
      @Trace()
      outer() { return of(null).pipe(map(() => this.inner())); }
    }
    await firstValueFrom(new StreamService().outer());
    const spans = exporter.getFinishedSpans();
    const outer = spans.filter((span) => span.name === 'StreamService.outer').at(-1);
    const inner = spans.filter((span) => span.name === 'StreamService.inner').at(-1);
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  });

  it('lets @IgnoreTrace() override a class-level @Trace()', () => {
    @Trace()
    class StatusService {
      run() { return 'run'; }
      @IgnoreTrace()
      health() { return 'ok'; }
    }
    const service = new StatusService();
    service.run();
    service.health();
    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toContain('StatusService.run');
    expect(names).not.toContain('StatusService.health');
  });
});
