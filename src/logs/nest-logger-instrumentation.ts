import { ConsoleLogger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { redact, redactText } from '../security/redaction';
import type { StructuredLogEmitter, StructuredLogRecord } from './types';

type LogMethod = 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal';
type ConsoleLoggerWithContext = ConsoleLogger & { context?: string };

const SEVERITY: Record<LogMethod, StructuredLogRecord['severityText']> = {
  verbose: 'TRACE',
  debug: 'DEBUG',
  log: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

function bodyValue(message: unknown): unknown {
  if (message instanceof Error) return redactText(message.stack ?? `${message.name}: ${message.message}`);
  const sanitized = redact(message);
  if (sanitized === null || typeof sanitized !== 'object') return sanitized;
  try {
    return JSON.stringify(sanitized, (_key, value) => (
      typeof value === 'bigint' ? value.toString() : value
    ));
  } catch {
    return redactText(String(sanitized));
  }
}

export class NestLoggerInstrumentation {
  private originals = new Map<LogMethod, (...args: unknown[]) => void>();
  private enabled = false;

  constructor(
    private readonly emitter: StructuredLogEmitter,
    private readonly resourceAttributes: Record<string, string> = {},
  ) {}

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const prototype = ConsoleLogger.prototype as unknown as Record<LogMethod, (...args: unknown[]) => void>;
    for (const method of Object.keys(SEVERITY) as LogMethod[]) {
      const original = prototype[method];
      if (typeof original !== 'function') continue;
      this.originals.set(method, original);
      const emitter = this.emitter;
      const resourceAttributes = this.resourceAttributes;
      prototype[method] = function (this: ConsoleLoggerWithContext, message: unknown, ...args: unknown[]) {
        try {
          const spanContext = trace.getActiveSpan()?.spanContext();
          const contextName = this.context
            ?? (typeof args.at(-1) === 'string' ? String(args.at(-1)) : undefined);
          const attributes: Record<string, string> = { ...resourceAttributes };
          if (contextName) attributes['nestjs.context'] = contextName;
          if (spanContext?.traceId) attributes.trace_id = spanContext.traceId;
          if (spanContext?.spanId) attributes.span_id = spanContext.spanId;
          emitter.emit({
            body: bodyValue(message),
            severityText: SEVERITY[method],
            attributes,
            timestamp: Date.now(),
          });
        } catch {
          // Telemetry is best-effort and may never alter business logging behavior.
        }
        return original.call(this, message, ...args);
      };
    }
  }

  disable(): void {
    if (!this.enabled) return;
    const prototype = ConsoleLogger.prototype as unknown as Record<LogMethod, (...args: unknown[]) => void>;
    for (const [method, original] of this.originals) prototype[method] = original;
    this.originals.clear();
    this.enabled = false;
  }
}
