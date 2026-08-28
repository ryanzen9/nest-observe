import type { Meter, Tracer } from '@opentelemetry/api';
import { invokeWithSpan } from '../decorators/invoke';
import { isTraceDecorated, isTraceIgnored, markTraceDecorated } from '../decorators/metadata';

export type NestComponentKind = 'provider' | 'controller';

export class NestMethodInstrumenter {
  private readonly calls;
  private readonly duration;
  private readonly errors;
  private readonly instrumented = new WeakMap<object, Set<string>>();

  constructor(private readonly tracer: Tracer, meter: Meter) {
    this.calls = meter.createCounter('nestjs.method.calls', { unit: '{call}' });
    this.duration = meter.createHistogram('nestjs.method.duration', {
      unit: 's',
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
    });
    this.errors = meter.createCounter('nestjs.method.errors', { unit: '{error}' });
  }

  instrumentInstance(instance: object, kind: NestComponentKind, componentName?: string): void {
    const type = instance.constructor as Function;
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (!prototype) return;
    this.instrumentTarget(instance, prototype, type, kind, componentName);
  }

  instrumentPrototype(type: Function, kind: NestComponentKind, componentName?: string): void {
    const prototype = (type as { prototype?: object }).prototype;
    if (!prototype) return;
    this.instrumentTarget(prototype, prototype, type, kind, componentName);
  }

  private instrumentTarget(
    target: object,
    prototype: object,
    type: Function,
    kind: NestComponentKind,
    componentName?: string,
  ): void {
    if (isTraceIgnored(type)) return;
    const completed = this.instrumented.get(target) ?? new Set<string>();
    this.instrumented.set(target, completed);
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === 'constructor' || completed.has(methodName) || methodName.startsWith('onModule')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      const original = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
      if (!descriptor || typeof original !== 'function' || isTraceIgnored(original, type) || isTraceDecorated(original)) continue;
      const existing = Reflect.get(target, methodName) as unknown;
      if (typeof existing === 'function' && existing !== original && isTraceDecorated(existing)) continue;
      const name = componentName || type.name || 'Anonymous';
      const attributes: Record<string, string> = {
        [`nestjs.${kind}`]: name,
        'nestjs.method': methodName,
      };
      const instrumenter = this;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        instrumenter.calls.add(1, attributes);
        return invokeWithSpan(
          instrumenter.tracer,
          `${name}.${methodName}`,
          attributes,
          () => original.apply(this, args),
          (seconds, error) => {
            instrumenter.duration.record(seconds, attributes);
            if (error !== undefined) instrumenter.errors.add(1, attributes);
          },
        );
      };
      markTraceDecorated(wrapped);
      try {
        Object.defineProperty(target, methodName, { ...descriptor, value: wrapped });
        completed.add(methodName);
      } catch {
        // Frozen or proxy-managed framework instances are intentionally skipped.
      }
    }
  }
}
