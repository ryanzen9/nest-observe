import 'reflect-metadata';
import { Controller, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
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
});
