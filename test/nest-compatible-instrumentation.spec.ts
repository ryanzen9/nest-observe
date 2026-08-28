import { describe, expect, it } from 'vitest';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { CompatibleNestInstrumentation } from '../src/instrumentation';

describe('CompatibleNestInstrumentation', () => {
  it('declares Nest 12 support and includes the provider injector hook', () => {
    const instrumentation = new CompatibleNestInstrumentation();
    const [definition] = instrumentation.getModuleDefinitions();
    expect(definition?.supportedVersions).toContain('>=4.0.0 <13');
    expect(definition?.files.map((file) => file.name)).toContain('@nestjs/core/injector/injector.js');
    instrumentation.disable();
  });

  it('instruments providers created by the Nest injector hook without an ObserveModule', async () => {
    const spans = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    const meterProvider = new MeterProvider();
    const instrumentation = new CompatibleNestInstrumentation();
    instrumentation.setTracerProvider(tracerProvider);
    instrumentation.setMeterProvider(meterProvider);
    const [definition] = instrumentation.getModuleDefinitions();
    const injectorFile = definition?.files.find((file) => file.name.endsWith('/injector/injector.js'));
    class Injector {
      async instantiateClass(_dependencies: unknown[], wrapper: { instance: object }) { return wrapper.instance; }
    }
    class InventoryService { reserve() { return 'reserved'; } }
    const service = new InventoryService();
    const wrapper = {
      instance: service,
      metatype: InventoryService,
      name: 'InventoryService',
      token: InventoryService,
      host: { name: 'InventoryModule', controllers: new Map() },
    };
    const moduleExports = { Injector };
    injectorFile?.patch?.(moduleExports, '12.0.1');

    await new Injector().instantiateClass([], wrapper);
    expect(service.reserve()).toBe('reserved');
    await tracerProvider.forceFlush();
    expect(spans.getFinishedSpans().map((span) => span.name)).toContain('InventoryService.reserve');

    injectorFile?.unpatch?.(moduleExports, '12.0.1');
    instrumentation.disable();
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });
});
