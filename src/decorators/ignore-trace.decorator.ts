import { markTraceIgnored } from './metadata';

type IgnoreDecorator = MethodDecorator & ClassDecorator;

export function IgnoreTrace(): IgnoreDecorator {
  return ((target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (propertyKey !== undefined && descriptor?.value && typeof descriptor.value === 'function') {
      markTraceIgnored(descriptor.value);
      return descriptor;
    }
    markTraceIgnored(target);
    return target;
  }) as IgnoreDecorator;
}
