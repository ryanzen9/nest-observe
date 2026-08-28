const ignoredTargets = new WeakSet<object>();
const tracedTargets = new WeakSet<object>();

export function markTraceIgnored(target: object): void {
  ignoredTargets.add(target);
}

export function markTraceDecorated(target: object): void {
  tracedTargets.add(target);
}

export function isTraceIgnored(method?: object, type?: object): boolean {
  return Boolean((method && ignoredTargets.has(method)) || (type && ignoredTargets.has(type)));
}

export function isTraceDecorated(method?: object): boolean {
  return Boolean(method && tracedTargets.has(method));
}
