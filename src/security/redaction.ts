export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|pass(?:word|wd)?|secret|token|api[-_]?key|phone|mobile)/i;

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}

export function redactText(value: string): string {
  return value
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, REDACTED)
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+|basic\s+)?[^\s,;]+/gi, `$1=${REDACTED}`)
    .replace(/\b(password|passwd|secret|token|access_token|api[-_]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
}

function errorValue(error: Error): Record<string, string> {
  return {
    name: error.name,
    message: redactText(error.message),
    ...(error.stack ? { stack: redactText(error.stack) } : {}),
  };
}

function visit(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return errorValue(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => visit(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : visit(item, seen);
  }
  return output;
}

export function redact<T>(value: T): T {
  return visit(value, new WeakSet()) as T;
}

export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
  allowedHeaders: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowedHeaders.map((header) => header.toLowerCase()));
  const output: Record<string, string> = {};
  for (const [originalName, value] of Object.entries(headers)) {
    const name = originalName.toLowerCase();
    if (!allowed.has(name) || value === undefined) continue;
    output[name] = SENSITIVE_KEY.test(name)
      ? REDACTED
      : Array.isArray(value) ? value.join(', ') : value;
  }
  return output;
}
