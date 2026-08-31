import {
  type CallHandler,
  type ExecutionContext,
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { metrics, trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import { getObserveRuntime, observe, type ObserveRuntime } from '../sdk';
import type { ObserveOptions } from '../types';
import { SDK_NAME, SDK_VERSION } from '../resource';
import { NestMethodInstrumenter } from './method-instrumenter';

export const OBSERVE_OPTIONS = Symbol('OBSERVE_OPTIONS');
export const OBSERVE_HANDLE = Symbol('OBSERVE_HANDLE');

type FrameworkResponse = ServerResponse & {
  raw?: ServerResponse;
};

/** Provides inbound HTTP metrics when module-load instrumentation was registered too late. */
@Injectable()
export class NestHttpMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(OBSERVE_HANDLE) private readonly handle: ObserveRuntime) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.handle.started || !this.handle.httpRequestMetrics) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage>();
    const response = http.getResponse<FrameworkResponse>();
    const started = this.handle.httpRequestMetrics.start(request);
    const result = next.handle();
    if (!started) return result;

    const responseEventSource = response.raw ?? response;
    if (typeof responseEventSource.once === 'function') {
      responseEventSource.once('finish', () => {
        this.handle.httpRequestMetrics?.record(request, response);
      });
      return result;
    }
    return result.pipe(finalize(() => {
      this.handle.httpRequestMetrics?.record(request, response);
    }));
  }
}

type DiscoveredWrapper = {
  instance?: object;
  metatype?: Function;
  name?: unknown;
  inject?: unknown[];
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
      // Factory providers may return arbitrary external clients (Redis, queues, SDKs).
      // They are not Nest-owned class instances and must not be monkey-patched.
      if (!wrapper.metatype || wrapper.inject !== undefined) continue;
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
        { provide: APP_INTERCEPTOR, useClass: NestHttpMetricsInterceptor },
        NestObserveExplorer,
      ],
      exports: [OBSERVE_HANDLE],
    };
  }
}
