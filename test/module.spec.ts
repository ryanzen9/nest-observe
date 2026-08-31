import 'reflect-metadata';
import { Controller, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { OBSERVE_HANDLE, ObserveModule } from '../src/nest/observe.module';
import type { ObserveRuntime } from '../src/sdk';

describe('ObserveModule', () => {
  it('initializes safely as a dynamic Nest module and preserves business behavior when disabled', async () => {
    @Injectable()
    class AppService { hello() { return 'hello'; } }
    @Module({
      imports: [ObserveModule.forRoot({ enabled: false })],
      providers: [AppService],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(AppService).hello()).toBe('hello');
    await moduleRef.close();
  });

  it('automatically instruments discovered providers and controllers', async () => {
    const spans = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
    @Injectable()
    class OrdersService { list() { return ['one']; } }
    @Controller('orders')
    class OrdersController {
      constructor(@Inject(OrdersService) readonly orders: OrdersService) {}
      list() { return this.orders.list(); }
    }
    @Module({
      imports: [ObserveModule.forRoot({
        serviceName: 'module-test',
        logs: false,
        sampling: 1,
        exporters: { span: spans, metricReader },
      })],
      providers: [OrdersService],
      controllers: [OrdersController],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(OrdersController).list()).toEqual(['one']);
    const handle = moduleRef.get<ObserveRuntime>(OBSERVE_HANDLE);
    await handle.forceFlush();
    expect(spans.getFinishedSpans().map((span) => span.name)).toEqual(expect.arrayContaining([
      'OrdersController.list', 'OrdersService.list',
    ]));
    await moduleRef.close();
  });

  it('exposes exporter failures through the module runtime without breaking providers', async () => {
    const failures: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exporter: LogRecordExporter = {
      export(_records: ReadableLogRecord[], callback: Parameters<LogRecordExporter['export']>[1]) {
        callback({ code: 1, error: new Error('Unauthorized') });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    @Injectable()
    class AppService {
      private readonly logger = new Logger(AppService.name);
      run() { this.logger.log('business continues'); }
    }
    @Module({
      imports: [ObserveModule.forRoot({
        traces: false,
        metrics: false,
        logs: true,
        exporters: { log: exporter },
        onError: (event) => failures.push(`${event.signal}:${event.stage}`),
      })],
      providers: [AppService],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    expect(() => moduleRef.get(AppService).run()).not.toThrow();
    const handle = moduleRef.get<ObserveRuntime>(OBSERVE_HANDLE);
    handle.loggerProvider?.getLogger('module-diagnostics').emit({ body: 'probe' });
    await handle.forceFlush();

    expect(handle.status).toBe('degraded');
    expect(failures).toEqual(['logs:export']);
    await moduleRef.close();
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('does not instrument an external client returned by a Symbol factory provider', async () => {
    const CLIENT = Symbol('REDIS_CLIENT');
    class RedisLikeClient {
      get(key: string) { return `value:${key}`; }
    }
    @Module({
      imports: [ObserveModule.forRoot({ logs: false, metrics: false })],
      providers: [{ provide: CLIENT, useFactory: () => new RedisLikeClient() }],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    expect(moduleRef.get<RedisLikeClient>(CLIENT).get('session')).toBe('value:session');
    await moduleRef.close();
  });
});
