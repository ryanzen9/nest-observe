import { trace } from "@opentelemetry/api";
import { invokeWithSpan } from "./invoke";
import { isTraceIgnored, markTraceDecorated } from "./metadata";

export interface TraceOptions {
  name?: string;
  attributes?: Record<string, string>;
}

type TraceDecorator = MethodDecorator & ClassDecorator;

function decorateMethod(
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
  options: TraceOptions,
): void {
  const original = descriptor.value as (...args: unknown[]) => unknown;
  if (
    typeof original !== "function" ||
    isTraceIgnored(original, target.constructor)
  )
    return;
  const className = target.constructor?.name || "Anonymous";
  const methodName = String(propertyKey);
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const tracer = trace.getTracer("@ryanzeng/nest-observe");
    return invokeWithSpan(
      tracer,
      options.name ?? `${className}.${methodName}`,
      {
        "code.function.name": methodName,
        "nestjs.class": className,
        "nestjs.method": methodName,
        ...options.attributes,
      },
      () => original.apply(this, args),
    );
  };
  Object.defineProperty(wrapped, "name", {
    value: original.name,
    configurable: true,
  });
  markTraceDecorated(wrapped);
  descriptor.value = wrapped;
}

export function Trace(
  nameOrOptions: string | TraceOptions = {},
): TraceDecorator {
  const options =
    typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;
  return ((
    target: object | Function,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (propertyKey !== undefined && descriptor) {
      decorateMethod(target as object, propertyKey, descriptor, options);
      return descriptor;
    }
    const prototype = (target as { prototype?: object }).prototype;
    if (!prototype) return target;
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === "constructor") continue;
      const item = Object.getOwnPropertyDescriptor(prototype, key);
      if (!item || typeof item.value !== "function") continue;
      decorateMethod(prototype, key, item, options);
      Object.defineProperty(prototype, key, item);
    }
    return target;
  }) as TraceDecorator;
}
