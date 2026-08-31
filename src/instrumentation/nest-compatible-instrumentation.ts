import {
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  type InstrumentationConfig,
} from '@opentelemetry/instrumentation';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { NestMethodInstrumenter } from '../nest/method-instrumenter';

const SUPPORTED_NEST_VERSIONS = ['>=4.0.0 <13'];

type NestWrapper = {
  instance?: object;
  metatype?: Function;
  name?: unknown;
  inject?: unknown[];
  token?: unknown;
  host?: {
    name?: string;
    controllers?: Map<unknown, unknown>;
  };
};

type InjectorExports = {
  Injector: {
    prototype: {
      instantiateClass: (...args: unknown[]) => Promise<unknown>;
    };
  };
};

export interface CompatibleNestInstrumentationConfig extends InstrumentationConfig {
  providerTracing?: boolean;
  controllerTracing?: boolean;
}

/** Extends upstream Nest support to v12 and instruments DI-created providers. */
export class CompatibleNestInstrumentation extends NestInstrumentation {
  private methodInstrumenter?: NestMethodInstrumenter;

  constructor(private readonly observeConfig: CompatibleNestInstrumentationConfig = {}) {
    super(observeConfig);
  }

  override init(): InstrumentationNodeModuleDefinition {
    const definition = new InstrumentationNodeModuleDefinition('@nestjs/core', SUPPORTED_NEST_VERSIONS);
    definition.files.push(
      this.getNestFactoryFileInstrumentation(SUPPORTED_NEST_VERSIONS),
      this.getRouterExecutionContextFileInstrumentation(SUPPORTED_NEST_VERSIONS),
      new InstrumentationNodeModuleFile(
        '@nestjs/core/injector/injector.js',
        SUPPORTED_NEST_VERSIONS,
        (moduleExports: InjectorExports) => {
          const instrumentation = this;
          this._wrap(moduleExports.Injector.prototype, 'instantiateClass', (original) => {
            return async function (this: unknown, ...args: unknown[]) {
              const instance = await original.apply(this, args);
              try {
                const wrapper = args[1] as NestWrapper | undefined;
                if (!instance || typeof instance !== 'object' || !wrapper?.metatype
                  || wrapper.inject !== undefined) return instance;
                if (['InternalCoreModule', 'ObserveModule', 'DiscoveryModule'].includes(wrapper.host?.name ?? '')) {
                  return instance;
                }
                const isController = wrapper.host?.controllers?.get(wrapper.token) === wrapper;
                if ((isController && instrumentation.observeConfig.controllerTracing === false)
                  || (!isController && instrumentation.observeConfig.providerTracing === false)) {
                  return instance;
                }
                instrumentation.getMethodInstrumenter().instrumentInstance(
                  instance,
                  isController ? 'controller' : 'provider',
                  wrapper.name ?? wrapper.metatype.name,
                );
              } catch {
                // Framework internals vary by Nest version; instrumentation remains best-effort.
              }
              return instance;
            };
          });
          return moduleExports;
        },
        (moduleExports: InjectorExports) => {
          this._unwrap(moduleExports.Injector.prototype, 'instantiateClass');
        },
      ),
    );
    return definition;
  }

  private getMethodInstrumenter(): NestMethodInstrumenter {
    return this.methodInstrumenter ??= new NestMethodInstrumenter(this.tracer, this.meter);
  }
}
