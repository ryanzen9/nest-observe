import { DynamicModule, Global, Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { metrics, trace } from '@opentelemetry/api';
import { getObserveRuntime, observe, type ObserveRuntime } from '../sdk';
import type { ObserveOptions } from '../types';
import { SDK_NAME, SDK_VERSION } from '../resource';
import { NestMethodInstrumenter } from './method-instrumenter';

export const OBSERVE_OPTIONS = Symbol('OBSERVE_OPTIONS');
export const OBSERVE_HANDLE = Symbol('OBSERVE_HANDLE');

type DiscoveredWrapper = {
  instance?: object;
  metatype?: Function;
  name?: string;
  host?: { name?: string };
};

@Injectable()
class NestObserveExplorer implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(OBSERVE_OPTIONS) private readonly options: ObserveOptions,
    @Inject(OBSERVE_HANDLE) private readonly handle: ObserveRuntime,
  ) {}

  onModuleInit(): void {
    if (!this.handle.started) return;
    const runtime = getObserveRuntime();
    const tracer = runtime?.tracerProvider?.getTracer(SDK_NAME, SDK_VERSION) ?? trace.getTracer(SDK_NAME, SDK_VERSION);
    const meter = runtime?.meterProvider?.getMeter(SDK_NAME, SDK_VERSION) ?? metrics.getMeter(SDK_NAME, SDK_VERSION);
    const instrumenter = new NestMethodInstrumenter(tracer, meter);
    if (this.options.providerTracing !== false) {
      this.instrument(this.discovery.getProviders() as DiscoveredWrapper[], instrumenter, 'provider');
    }
    if (this.options.controllerTracing !== false) {
      this.instrument(this.discovery.getControllers() as DiscoveredWrapper[], instrumenter, 'controller');
    }
  }

  private instrument(
    wrappers: DiscoveredWrapper[],
    instrumenter: NestMethodInstrumenter,
    kind: 'provider' | 'controller',
  ): void {
    for (const wrapper of wrappers) {
      if (!wrapper.metatype) continue;
      if (['ObserveModule', 'DiscoveryModule', 'InternalCoreModule'].includes(wrapper.host?.name ?? '')) continue;
      if ((wrapper.metatype as Function) === NestObserveExplorer) continue;
      if (wrapper.instance) {
        instrumenter.instrumentInstance(wrapper.instance, kind, wrapper.name ?? wrapper.metatype.name);
      } else {
        instrumenter.instrumentPrototype(wrapper.metatype, kind, wrapper.name ?? wrapper.metatype.name);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.shutdown();
  }
}

@Global()
@Module({})
export class ObserveModule {
  static forRoot(options: ObserveOptions = {}): DynamicModule {
    return {
      module: ObserveModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: OBSERVE_OPTIONS, useValue: options },
        { provide: OBSERVE_HANDLE, useFactory: () => observe(options) },
        NestObserveExplorer,
      ],
      exports: [OBSERVE_HANDLE],
    };
  }
}
